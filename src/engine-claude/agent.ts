/**
 * Claude Code loop Agent: drives one session through turn and step boundaries
 * with one Claude Agent SDK query per step. Claude Code owns its prompt,
 * tools, and permissions; the durable session log remains the source of truth
 * and the query prompt is a pure serialization of it.
 *
 * @module dsh-loop-engine/engine-claude/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
} from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  AssistantStreamAccumulator,
  LlmError,
  createAssistantMessage,
  createUserMessage,
  errorChain,
} from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { query as officialQuery, type SDKResultError } from '@anthropic-ai/claude-agent-sdk'
import { HOSTED_DEFAULT_MODEL, HOSTED_ROUTE_LABEL } from '../agent-preset-ids.ts'
import type { ResolvedConfig } from './types.ts'
import {
  mapAssistantMessage,
  mapStreamEvent,
  mapToolResults,
  mapUsage,
  meaningfulUsage,
  type StreamToolCall,
} from './mapping.ts'
import { engineSlashPrompt, serializeHistory } from '../driver-core/prompt.ts'
import { DriverInbox } from '../driver-core/inbox.ts'
import { appendSystemHeadIfMissing } from '../driver-core/system-head.ts'
import { sessionModelOverrideOf } from '../driver-core/session-model.ts'
import { resolveModelHandover } from '../driver-core/model-handover.ts'
import { DriverAssistantStream } from '../driver-core/assistant-stream.ts'
import { normalizeHostedToolCall, planTodosOfHostedTool } from '../driver-core/hosted-tool-vocabulary.ts'
import { approvalReason, resolveSessionPermission } from './permission.ts'
import { DEFAULT_PERMISSION_MODE, claudeQueryOptions, type ClaudeCodeQuerySpec, type SpawnCapability } from './sdk.ts'
import {
  invokedSkillNames,
  isSkillName,
  renderSkillContent,
  type SkillDefinition,
  type SkillsService,
} from '../driver-core/skill-inject.ts'

/**
 * Provider route label this driver logs into request/header snapshots and
 * message provenance — the ONE route every hosted engine shares
 * ({@link HOSTED_ROUTE_LABEL}), so all four engines select `external/default`
 * and the model menu carries a single group instead of one per engine.
 */
export const PROVIDER = HOSTED_ROUTE_LABEL
/**
 * Model label logged when the deployment pins no model: Claude Code owns its
 * model natively, so the web session's model selection is deliberately not
 * mirrored into the header — it reaches the engine separately, as the
 * `Options.model` the driver resolves each step (`sessionModelOverrideOf`). It is
 * {@link HOSTED_DEFAULT_MODEL} — the one entry this engine's provider route
 * advertises (`provider-route.ts`) — so the session's `(provider, model)`
 * resolves to that entry and the model seat renders "default" instead of a
 * composite string naming a model no adapter serves.
 */

/** Minimal shape of the approval service (inline to avoid a peer dep on @deepseek-ai/dsh-user-approval). */
interface ApprovalService {
  request(req: { agent: Agent; toolName: string; reason?: string; signal?: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/* jscpd:ignore-start -- mirrors default agent-loop driver; depending on agent-loop is forbidden. */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/**
 * The running phase. Its `turn`/`step` are the position of the step currently
 * open: rotating a step mutates them in place, so every holder of the phase
 * (the turn loop's fail-safe close, `agent/error` reporting) sees the step that
 * is actually open rather than the one the query was started under.
 */
type RunningPhase = Extract<Phase, { kind: 'running' }>

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }

/** Map one SDK result failure subtype to a stable provider-neutral code. */
function failureCode(subtype: SDKResultError['subtype']): string {
  switch (subtype) {
    case 'error_during_execution':
    case 'error_max_turns':
    case 'error_max_budget_usd':
    case 'error_max_structured_output_retries':
      return `CLAUDE_CODE_${subtype.toUpperCase()}`
    default:
      return 'CLAUDE_CODE_ERROR'
  }
}

/** Drives one session through turn and step boundaries on Claude Code. */
export class ClaudeCodeAgent implements Agent {
  readonly inbox: DriverInbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false

  /** Agent-lifecycle-local counter naming each streamed attempt. */
  private streamAttempts = 0

  /**
   * Tool results logged into the currently open step. A result means the
   * segment that requested the call is finished, so the next assistant content
   * opens the next step (see {@link beginSegment}).
   */
  private stepSettledTools = 0

  /**
   * Whether the current query has rotated into a second step. The query-total
   * usage record is only meaningful while one step holds the whole query.
   */
  private rotated = false

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly config: ResolvedConfig,
    /**
     * Process-spawn capability handed down from the engine, which resolves it
     * from the host's subprocess service. Held as a capability rather than read
     * off the context because a service PROPERTY read requires the reading
     * fiber to have injected it, and this agent's context is the engine's.
     */
    private readonly spawn: SpawnCapability,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new DriverInbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  /**
   * Queue a message for the next turn and wake the driver.
   * @param input - the user message to deliver.
   */
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  /**
   * Queue a message for the running step and wake the driver.
   * @param input - the user message to deliver.
   */
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  /**
   * Queue a message for the running step without waking the driver.
   * @param input - the user message to deliver.
   */
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  /**
   * Run a maintenance job while the agent is idle.
   * @param job - the maintenance operation, receiving the phase abort signal.
   * @returns the maintenance result.
   */
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore start -- kick owns a running phase until this driver boundary */
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }      /* v8 ignore stop */
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore start -- private callers establish the running phase before proposing a step */
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)    /* v8 ignore stop */
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: claimed }),
    )
    signal.throwIfAborted()
    if (decision.kind === 'reject') return decision
    // Inject skill content for user-invoked skills.  The dsh-tool-skill
    // handler that normally does this lives on the agent-preset context
    // chain, which the Claude Code agent's context does not descend from,
    // so we replicate the gesture-scan and injection here.
    const injected = await this.injectSkills(decision.messages, signal)
    signal.throwIfAborted()
    return injected !== decision.messages
      ? { kind: 'enter', messages: [...injected] }
      : { ...decision }
  }

  /**
   * Scan the step's user messages for `/name` skill gestures, load each
   * matching skill, and inject the rendered skill content into the message
   * batch.  This mirrors what dsh-tool-skill does for the in-process engine.
   * @param messages - the current step's message batch.
   * @param signal - cancellation signal (aborted loads are silently dropped).
   * @returns the original batch when no skill was invoked, or an extended
   *   batch with injected skill-content messages appended.
   */
  private async injectSkills(messages: readonly UserMessage[], signal: AbortSignal): Promise<readonly UserMessage[]> {
    const names = invokedSkillNames(messages)
    if (names.length === 0) return messages
    const skills = this.loopCtx.get('skills') as SkillsService | undefined
    if (skills === undefined) return messages
    const cwd = this.session.header.cwd
    const injections: UserMessage[] = []
    for (const name of names) {
      /* v8 ignore start -- SKILL_GESTURE only captures kebab-case names, so this guard never fires */
      /* v8 ignore next -- SKILL_GESTURE only captures kebab-case names, so this guard never fires */
      if (!isSkillName(name)) continue
      /* v8 ignore stop */
      let skill: SkillDefinition | undefined
      try {
        skill = await skills.get(name, { signal, scope: this, ...(cwd === undefined ? {} : { cwd }) })
      } catch {
        continue // load failure → silently skip
      }
      if (skill === undefined || !skill.invocation.userInvocable) continue
      if (signal.aborted) return messages
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source: { kind: 'skill-invocation', name, form: 'instructions' },
      }))
    }
    return injections.length > 0 ? [...messages, ...injections] : messages
  }

  /**
   * Resolve the native permission handling for one query. A deployment-pinned
   * mode wins outright; otherwise the session's durable dsh permission knobs
   * decide per query (mid-session preset switches included): full access
   * bypasses native checks, an `ask` policy forwards each native permission
   * request to the dsh approval seam, and anything else fails closed with the
   * unattended deny-all stance.
   * @returns the permission fields of the query spec.
   */
  private queryPermission(): Pick<ClaudeCodeQuerySpec, 'permissionMode' | 'onToolPermission'> {
    if (this.config.permissionMode !== undefined) return { permissionMode: this.config.permissionMode }
    const permission = resolveSessionPermission(this.session.snapshotEvents())
    if (permission.kind === 'bypass') return { permissionMode: 'bypassPermissions' }
    if (permission.kind === 'ask') {
      const approval = this.loopCtx.get('approval') as ApprovalService | undefined
      if (approval !== undefined) {
        return {
          permissionMode: 'default',
          onToolPermission: async (toolName, input, signal) => {
            const outcome = await approval.request({
              agent: this,
              toolName,
              reason: approvalReason(toolName, input),
              signal,
            })
            return outcome === 'allowed-once' ? 'allow' : 'deny'
          },
        }
      }
    }
    return { permissionMode: DEFAULT_PERMISSION_MODE }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          appendSystemHeadIfMissing(this.session, turn, step)
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          const stepEnd = await this.step()
          if (turnEnds === null) turnEnds = stepEnd
        } finally {
          // The driver rotates steps as the query's segments complete, so
          // `phase.step` — not the step this iteration opened — is the one still
          // open here.
          this.session.append('step/end', { turn, step: phase.step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /**
   * Rotate to the next step when the segment that ran a tool has finished, so
   * each assistant segment lands in its own step.
   *
   * Called as new assistant content begins. A step holding a settled tool
   * result means the previous segment is complete, and the content about to be
   * written belongs to the next one. Rotating here (rather than when a call is
   * announced) keeps calls announced together — one model turn — in one step.
   * @param phase - the running phase carrying the open step's position.
   */
  private beginSegment(phase: RunningPhase): void {
    if (this.stepSettledTools === 0) return
    this.session.append('step/end', { turn: phase.turn, step: phase.step })
    phase.step += 1
    this.session.append('step/start', { turn: phase.turn, step: phase.step })
    this.stepSettledTools = 0
    this.rotated = true
  }

  /** Model label recorded in the request header for one lifecycle. */
  private modelLabel(): string {
    return this.config.model ?? HOSTED_DEFAULT_MODEL
  }

  /** Append the request header snapshot once per loop instance. */
  private assertRequestHeader(): void {
    if (this.requestHeaderLogged) return
    const header = canonicalHeader({
      config: { provider: PROVIDER, model: this.modelLabel() },
    })
    const baseline = this.session.requestHeader()
    this.session.append('request/header', {
      header,
      reason: baseline === undefined ? 'initial' : 'resume',
    })
    this.requestHeaderLogged = true
  }

  /** Run one Claude Code query for the current step and map its transcript into the session log. */
  private async step(): Promise<StepEndReason | null> {
    /* v8 ignore start -- private callers establish the running phase before executing a step */
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)    /* v8 ignore stop */
    const phase = this.phase
    const { abort: { signal } } = phase
    signal.throwIfAborted()
    this.stepSettledTools = 0
    this.rotated = false

    const cwd = this.session.header.cwd
    if (cwd === undefined || cwd.length === 0) {
      throw new Error(`agent "${this.id}": no working directory — start the session with cwd metadata`)
    }
    const history: Message[] = this.session.deriveMessages()
    // A live slash command is the engine's own control line: send it verbatim
    // (the transcript framing would hide it from Claude Code's local-command
    // dispatch, which only inspects the head of the prompt).
    const prompt = engineSlashPrompt(history) ?? serializeHistory(history)
    /* v8 ignore start -- a step only runs after claiming and durably appending at least one user message */
    if (prompt.length === 0) {
      throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`)
    }
    /* v8 ignore stop */
    this.assertRequestHeader()
    signal.throwIfAborted()

    const controller = new AbortController()
    const cancel = (): void => {
      /* v8 ignore start -- a phase signal fires once; the controller cannot already be aborted when its single listener runs */
      /* v8 ignore next -- a phase signal fires once; the controller cannot already be aborted when its single listener runs */
      if (!controller.signal.aborted) {
        /* v8 ignore next -- the phase signal aborts with AgentCancelCause values only, which the durable log can record */
        controller.abort(signal.reason instanceof Error ? signal.reason : new Error(`agent "${this.id}" query aborted`))
      }      /* v8 ignore stop */
    }
    signal.addEventListener('abort', cancel, { once: true })
    const diagnostics: string[] = []
    /**
     * The live attempt for the current streamed segment. Chunks open one; the
     * durable assistant message they built settles it and the next chunk
     * opens a fresh attempt, so every message carries exactly its own stream.
     */
    let live: DriverAssistantStream | undefined
    try {
      // The session's own pick wins over the deployment's pin, read every step
      // so a model changed mid-conversation reaches the next query. Claude Code
      // takes a bare model id/alias (`Options.model`), so only the model half of
      // the override travels; the provider is a dsh routing fact it does not
      // speak. When dsh discloses that model's ENDPOINT, the driver hands it over
      // too — `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` in `Options.env` (the
      // SDK's documented way to point Claude Code at a gateway), so the query
      // runs on dsh's endpoint with dsh's credential. A selection dsh cannot
      // resolve injects nothing and Claude Code keeps its own configuration.
      const override = sessionModelOverrideOf(this.loopCtx, this.session)
      const handover = await resolveModelHandover(this.loopCtx, override)
      const model = handover?.model ?? override?.model ?? this.config.model
      const options = claudeQueryOptions({
        cwd,
        ...this.queryPermission(),
        env: handover === undefined ? this.config.env : {
          ...this.config.env,
          ANTHROPIC_BASE_URL: handover.baseURL,
          ANTHROPIC_AUTH_TOKEN: handover.apiKey,
        },
        disposeGraceMs: this.config.disposeGraceMs,
        ...model === undefined ? {} : { model },
        ...this.config.maxTurns === undefined ? {} : { maxTurns: this.config.maxTurns },
        spawn: this.spawn,
        onUnattended: (line) => { diagnostics.push(line) },
      }, controller)
      const query = officialQuery({ prompt, options })
      let finished = false
      const currentStream = (): DriverAssistantStream => {
        if (live === undefined) {
          live = new DriverAssistantStream(
            this.id,
            ++this.streamAttempts,
            phase.turn,
            phase.step,
            frame => this.dispatch.emit('agent/assistant-stream', { frame }),
          )
          live.start()
        }
        return live
      }
          /** Per-block-index tool identity, seeded by `mapStreamEvent` at a tool `content_block_start`. */
      const toolCalls = new Map<number, StreamToolCall>()
      /** Accumulated reasoning per block index, for the durable-message fallback below. */
      const reasoningByIndex = new Map<number, string>()
      /** Usage stashed from a suppressed reasoning-only message, used when the next message lacks its own. */
      let pendingUsage: TokenUsage | undefined
      /**
       * Usage the in-flight request reported on its `message_delta`. The SDK
       * zero-fills `usage` on the assistant message itself for gateway-fronted
       * models, so this is the only per-request accounting available before the
       * query's `result` totals it — and it is what the message that ends the
       * request is tagged with.
       */
      let requestUsage: TokenUsage | undefined
      signal.throwIfAborted()
      for await (const message of query) {
        signal.throwIfAborted()
        switch (message.type) {
          case 'stream_event': {
            const event = message.event
            // A request opens with `message_start` and reports its counters
            // cumulatively on `message_delta`; the last one before the next
            // start is that request's total.
            if (event.type === 'message_start') requestUsage = undefined
            else if (event.type === 'message_delta' && event.usage !== undefined) {
              requestUsage = meaningfulUsage(mapUsage(event.usage))
            }
            for (const chunk of mapStreamEvent(message.event, toolCalls)) {
              currentStream().push(chunk)
              if (chunk.type === 'reasoning-delta') {
                reasoningByIndex.set(chunk.index, (reasoningByIndex.get(chunk.index) ?? '') + chunk.text)
              }
            }
            break
          }
          case 'assistant': {
            const mapped = mapAssistantMessage(message.message)
            const isReasoningOnly = mapped.content.length > 0
              && mapped.content.every(block => block.type === 'reasoning')
            if (isReasoningOnly) {
              // Providers may split thinking into its own assistant message:
              // hold it instead of appending, and fold it into the following
              // message — otherwise the step's final projection (the last
              // assistant message wins) would drop the thinking entirely.
              // isReasoningOnly proved every block is reasoning; the cast is that proof.
              const reasoning = mapped.content as readonly { type: 'reasoning'; text: string }[]
              reasoningByIndex.clear()
              reasoning.forEach((block, index) => { reasoningByIndex.set(index, block.text) })
              pendingUsage = meaningfulUsage(mapped.usage) ?? requestUsage
              break
            }
            // Thinking fallback: some providers stream thinking deltas but
            // omit thinking blocks from the final assistant message. Retain
            // the streamed reasoning as content blocks so it survives the
            // step's final projection.
            let content = mapped.content
            if (reasoningByIndex.size > 0 && !content.some(block => block.type === 'reasoning')) {
              const synthesized: ContentBlock[] = [...reasoningByIndex.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, text]) => ({ type: 'reasoning' as const, text }))
              content = [...synthesized, ...content]
            }
            // Project each tool call onto dsh's vocabulary exactly once and
            // feed the SAME values to both writers: the assistant message's
            // `tool-call` block and the `tool/call` event must carry
            // byte-identical name and arguments for the same id, or Session V4
            // refuses the log on load. `mapAssistantMessage` builds `content`
            // and `toolCalls` in one pass, so every tool-call block's id
            // resolves in `toolCalls`. dsh's spelling wins on both sides.
            const normalizedCalls = new Map(mapped.toolCalls.map(call => [
              call.callId,
              normalizeHostedToolCall('claude-code', call.name, call.arguments),
            ]))
            content = content.map(block => {
              if (block.type !== 'tool-call') return block
              // `mapAssistantMessage` builds `content` and `toolCalls` in one
              // pass, so a tool-call block's id always has a projected call.
              const normalized = normalizedCalls.get(block.id)!
              return { ...block, name: normalized.name, arguments: normalized.arguments }
            })
            if (content.length > 0) {
              // This message begins the next assistant segment.
              this.beginSegment(phase)
              // The message just appended is authoritative for its thinking:
              // drop the chunk accumulation so a later message cannot
              // synthesize a duplicate.
              reasoningByIndex.clear()
              // The message's own usage wins when the SDK reported real
              // counters; otherwise the request's streamed sample stands in.
              const usage = meaningfulUsage(mapped.usage) ?? requestUsage ?? pendingUsage
              pendingUsage = undefined
              const attempt = live
              const data = {
                turn: phase.turn,
                step: phase.step,
                message: createAssistantMessage({
                  content,
                  source: { provider: PROVIDER, model: mapped.model },
                }),
                ...usage === undefined ? {} : { usage },
                // The attempt's exact timed stream travels with its message.
                stream: attempt?.stream ?? [],
              }
              if (attempt === undefined) {
                this.session.append('assistant/message', data, { surfaceOp: 'append' })
              } else {
                attempt.settle(() => this.session.append('assistant/message', data, { surfaceOp: 'append' }).seq)
                live = undefined
              }
            }
            for (const call of mapped.toolCalls) {
              const normalized = normalizedCalls.get(call.callId)!
              this.session.append('tool/call', {
                turn: phase.turn,
                step: phase.step,
                callId: call.callId,
                name: normalized.name,
                arguments: normalized.arguments,
              })
              // `TodoWrite` is a plan, not a tool row: the dsh todo panel reads
              // the `todo/write` event, which the in-process tool handler would
              // have appended. Its `tool-call` block in the assistant message
              // carries the same projected name and arguments as this event.
              const todos = planTodosOfHostedTool('claude-code', call.name, call.arguments)
              if (todos !== undefined) this.session.append('todo/write', { todos: [...todos] })
            }
            break
          }
          case 'user': {
            for (const result of mapToolResults(message.message)) {
              this.session.append('tool/result', { turn: phase.turn, step: phase.step, message: result }, { surfaceOp: 'append' })
              this.stepSettledTools += 1
            }
            break
          }
          case 'result': {
            // A step that ends on a reasoning-only message: flush the held
            // thinking as its own durable message so trailing thinking is
            // not lost.
            if (reasoningByIndex.size > 0) {
              const trailing: ContentBlock[] = [...reasoningByIndex.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, text]) => ({ type: 'reasoning' as const, text }))
              reasoningByIndex.clear()
              // Trailing thinking is its own segment when a tool already ran.
              this.beginSegment(phase)
              const attempt = live
              const data = {
                turn: phase.turn,
                step: phase.step,
                message: createAssistantMessage({
                  content: trailing,
                  source: { provider: PROVIDER, model: HOSTED_DEFAULT_MODEL },
                }),
                ...pendingUsage === undefined ? {} : { usage: pendingUsage },
                stream: attempt?.stream ?? [],
              }
              if (attempt === undefined) {
                this.session.append('assistant/message', data, { surfaceOp: 'append' })
              } else {
                attempt.settle(() => this.session.append('assistant/message', data, { surfaceOp: 'append' }).seq)
                live = undefined
              }
              pendingUsage = undefined
            }
            // A query that stayed in ONE step has that step's token total equal
            // to the query's, and per-step projections replace a step's earlier
            // samples with its latest — so the query total is appended as a
            // usage-only attempt record (it carries no content, and so renders
            // nothing, leaving every message's own usage untouched). Once the
            // query has rotated into several steps no single step owns the
            // total, and each segment's message already carries its own
            // request usage, so the record is skipped.
            const stepUsage = meaningfulUsage(mapUsage(message.usage))
            if (stepUsage !== undefined && !this.rotated) {
              const accumulator = new AssistantStreamAccumulator()
              accumulator.push({ time: Date.now(), chunk: { type: 'usage', usage: stepUsage } })
              this.session.append('assistant/attempt', {
                turn: phase.turn,
                step: phase.step,
                stream: [...accumulator.snapshot()],
              })
            }
            if (message.subtype === 'success') {
              finished = true
            } else {
              const summary = message.errors[0] ?? `claude code query failed (${message.subtype})`
              throw new LlmError(summary, failureCode(message.subtype))
            }
            break
          }
          default:
            // init/status/permission/control messages are SDK transport; the
            // durable log records only the model-visible transcript.
            break
        }
      }
      if (!finished) {
        throw new LlmError(
          `agent "${this.id}": claude-code query ended without a result message`,
          'CLAUDE_CODE_NO_RESULT',
        )
      }
      return { kind: 'completed' }
    } finally {
      // A segment that streamed without committing a durable message closes its
      // live frames, so the client stops painting an abandoned partial.
      if (live !== undefined && !live.ended) live.abandon()
      signal.removeEventListener('abort', cancel)
      controller.abort()
      for (const line of diagnostics) this.ctx.logger.warn('%s', line)
    }
  }
}
/* jscpd:ignore-end */
