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
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { LlmError, createAssistantMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { query as officialQuery, type SDKResultError } from '@anthropic-ai/claude-agent-sdk'
import type { ResolvedConfig } from './types.ts'
import {
  mapAssistantMessage,
  mapStreamEvent,
  mapToolResults,
  type StreamToolCall,
} from './mapping.ts'
import { serializeHistory } from '../driver-core/prompt.ts'
import { approvalReason, resolveSessionPermission } from './permission.ts'
import { DEFAULT_PERMISSION_MODE, claudeQueryOptions, type ClaudeCodeQuerySpec } from './sdk.ts'
import {
  invokedSkillNames,
  isSkillName,
  renderSkillContent,
  type SkillDefinition,
  type SkillsService,
} from '../driver-core/skill-inject.ts'

/** Provider route label used for logged header snapshots and message provenance. */
const PROVIDER = 'claude-code'
/**
 * Model label logged when the deployment pins no model: Claude Code owns its
 * model natively, so the web session's advisory model selection is deliberately
 * not mirrored into the header (it never drives a query).
 */
const NATIVE_MODEL_LABEL = 'claude-code-native'

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
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly config: ResolvedConfig,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
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
    const permission = resolveSessionPermission(this.session.events)
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
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          const stepEnd = await this.step()
          if (turnEnds === null) turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
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

  /** Model label recorded in the request header for one lifecycle. */
  private modelLabel(): string {
    return this.config.model ?? NATIVE_MODEL_LABEL
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
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    const cwd = this.session.header.cwd
    if (cwd === undefined || cwd.length === 0) {
      throw new Error(`agent "${this.id}": no working directory — start the session with cwd metadata`)
    }
    const history: Message[] = this.session.deriveMessages()
    const prompt = serializeHistory(history)
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
    try {
      const options = claudeQueryOptions({
        cwd,
        ...this.queryPermission(),
        env: this.config.env,
        backend: this.config.backend,
        disposeGraceMs: this.config.disposeGraceMs,
        ...this.config.model === undefined ? {} : { model: this.config.model },
        ...this.config.maxTurns === undefined ? {} : { maxTurns: this.config.maxTurns },
        spawn: spec => this.loopCtx.subprocess.spawn(spec),
        onUnattended: (line) => { diagnostics.push(line) },
      }, controller)
      const query = officialQuery({ prompt, options })
      let finished = false
      /** Seq numbers of the `assistant/chunk` events that streamed one message, for replay linking. */
      const chunkSeqs: number[] = []
      /** Per-block-index tool identity, seeded by `mapStreamEvent` at a tool `content_block_start`. */
      const toolCalls = new Map<number, StreamToolCall>()
      /** Accumulated reasoning per block index, for the durable-message fallback below. */
      const reasoningByIndex = new Map<number, string>()
      /** Usage stashed from a suppressed reasoning-only message, used when the next message lacks its own. */
      let pendingUsage: TokenUsage | undefined
      signal.throwIfAborted()
      for await (const message of query) {
        signal.throwIfAborted()
        switch (message.type) {
          case 'stream_event': {
            for (const chunk of mapStreamEvent(message.event, toolCalls)) {
              chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
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
              pendingUsage = mapped.usage
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
            if (content.length > 0) {
              // The message just appended is authoritative for its thinking:
              // drop the chunk accumulation so a later message cannot
              // synthesize a duplicate.
              reasoningByIndex.clear()
              const usage = mapped.usage ?? pendingUsage
              pendingUsage = undefined
              this.session.append('assistant/message', {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: { provider: PROVIDER, model: mapped.model },
                }),
                ...usage === undefined ? {} : { usage },
              }, {
                surfaceOp: 'append',
                // Link the durable message to the chunks that streamed it, so
                // replay can reconstruct the partial exactly as shown.
                ...chunkSeqs.length === 0 ? {} : { sourceEventSeqs: chunkSeqs },
              })
            }
            for (const call of mapped.toolCalls) {
              this.session.append('tool/call', {
                turn, step, callId: call.callId, name: call.name, arguments: call.arguments,
              })
            }
            break
          }
          case 'user': {
            for (const result of mapToolResults(message.message)) {
              this.session.append('tool/result', { turn, step, message: result }, { surfaceOp: 'append' })
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
              this.session.append('assistant/message', {
                turn,
                step,
                message: createAssistantMessage({
                  content: trailing,
                  source: { provider: PROVIDER, model: NATIVE_MODEL_LABEL },
                }),
                ...pendingUsage === undefined ? {} : { usage: pendingUsage },
              }, { surfaceOp: 'append' })
              pendingUsage = undefined
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
      signal.removeEventListener('abort', cancel)
      controller.abort()
      for (const line of diagnostics) this.ctx.logger.warn('%s', line)
    }
  }
}
/* jscpd:ignore-end */
