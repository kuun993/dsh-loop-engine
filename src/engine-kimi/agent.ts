/**
 * Kimi Code loop Agent: drives one session through turn and step boundaries over
 * a persistent `kimi acp` child (Agent Client Protocol over stdio), speaking one
 * stateless `session/new` + `session/prompt` per dsh step. The dsh session log is
 * the sole source of model context and the prompt is a pure serialization of the
 * durable history, so the transcript stays Model-visible ⟺ logged. Kimi owns its
 * system prompt and tools natively; the ACP child is spawned through the dsh
 * subprocess seam (the only available privilege boundary) and tool approvals are
 * answered from the session's dsh approval knobs.
 *
 * @module dsh-loop-engine/engine-kimi/agent
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
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { ToolCallId, LlmError, createAssistantMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { HOSTED_DEFAULT_MODEL, HOSTED_ROUTE_LABEL } from '../agent-preset-ids.ts'
import type { ResolvedConfig } from './types.ts'
import { engineSlashPrompt, serializeHistory } from '../driver-core/prompt.ts'
import { DriverInbox } from '../driver-core/inbox.ts'
import { appendSystemHeadIfMissing } from '../driver-core/system-head.ts'
import { sessionModelOverrideOf } from '../driver-core/session-model.ts'
import { resolveModelHandover, type DshModelHandover } from '../driver-core/model-handover.ts'
import { kimiModelEnv } from './model-handover.ts'
import { DriverAssistantStream } from '../driver-core/assistant-stream.ts'
import { normalizeHostedToolCall } from '../driver-core/hosted-tool-vocabulary.ts'
import type { KimiSpawnCapability, KimiSpawnSpec } from './process.ts'
import { kimiAcpArgv } from './process.ts'
import { AcpClient } from './acp/client.ts'
import type { AcpUpdate } from './acp/types.ts'
import {
  chunkDelta,
  isTextChunk,
  isThoughtChunk,
  isToolCall,
  isToolCallUpdate,
  isToolErrorStatus,
  isToolSettledStatus,
  toolCallIdOf,
  toolCallName,
  toolContentText,
  toolRawInput,
  toolResult,
} from './acp/mapping.ts'
import { resolveToolApproval } from './permission.ts'
import { raceAbort } from '../driver-core/ownership.ts'
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
 * Model label logged when the deployment pins no model: Kimi owns its model
 * natively, so the web session's model selection is deliberately not mirrored
 * into the header — it reaches the engine separately, as the ACP
 * `session/set_model` the driver resolves each step (`sessionModelOverrideOf`). It is
 * {@link HOSTED_DEFAULT_MODEL} — the one entry this engine's provider route
 * advertises (`provider-route.ts`) — so the session's `(provider, model)`
 * resolves to that entry and the model seat renders "default" instead of a
 * composite string naming a model no adapter serves.
 */

/* jscpd:ignore-start -- mirrors the Pi/Codex drivers; the engines share the default agent-loop driver's phase machine. */
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

/**
 * The running phase. Its `turn`/`step` are the position of the step currently
 * open: rotating a step mutates them in place, so every holder of the phase
 * (the turn loop's fail-safe close, `agent/error` reporting) sees the step that
 * is actually open rather than the one the ACP prompt was started under.
 */
type RunningPhase = Extract<Phase, { kind: 'running' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }

/** One opened assistant content block (text or reasoning) awaiting its deltas. */
interface OpenBlock {
  readonly index: number
  readonly type: 'text' | 'reasoning'
  text: string
}

/** Drives one session through turn and step boundaries on Kimi Code. */
export class KimiAgent implements Agent {
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

  /** Lazily created ACP client, reused across steps and released on scope teardown. */
  private acp: AcpClient | undefined
  /** The spawn spec the cached client was built from; a change forces a respawn. */
  private lastSpec: KimiSpawnSpec | undefined
  /**
   * The environment the last handover produced, memoized by its own content so
   * an unchanged endpoint reuses ONE object: `specsEqual` compares environments
   * by reference, and a fresh object per step would otherwise respawn the child
   * every step.
   */
  private handoverEnvCache: { key: string; env: Record<string, string> } | undefined

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly config: ResolvedConfig,
    private readonly spawn: KimiSpawnCapability,
    private readonly bin: string,
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
    // Release the shared ACP client when the agent scope is unwound.
    this.scope.ctx.effect(() => () => {
      this.acp?.dispose()
      this.acp = undefined
    }, 'kimi.acpClient()')
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
    /* v8 ignore start -- throwError is only reached from a running phase, so the idle-arm ternaries are a defensive backstop */
    /* v8 ignore next -- see above */
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    /* v8 ignore next -- see above */
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    /* v8 ignore stop */
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
    // Inject skill content for user-invoked skills. The dsh-tool-skill handler
    // that normally does this lives on the agent-preset context chain, which
    // the Kimi agent's context does not descend from, so we replicate the
    // gesture-scan and injection here.
    const injected = await this.injectSkills(decision.messages, signal)
    signal.throwIfAborted()
    return injected !== decision.messages
      ? { kind: 'enter', messages: [...injected] }
      : { ...decision }
  }

  /**
   * Scan the step's user messages for `/name` skill gestures, load each
   * matching skill, and inject the rendered skill content into the message
   * batch. This mirrors what dsh-tool-skill does for the in-process engine.
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

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    /* v8 ignore start -- kick() establishes the running phase before calling turn(), so this guard is a defensive backstop */
    /* v8 ignore next -- see above */
    if (this.phase.kind !== 'running') {
      /* v8 ignore next -- see above */
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    /* v8 ignore stop */
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
          // The driver rotates steps as kimi's internal segments complete, so
          // `phase.step` — not the step this iteration opened — is the one still
          // open here.
          this.session.append('step/end', { turn, step: phase.step })
        }
        signal.throwIfAborted()
        /* v8 ignore start -- every step() completes, so turnEnds is always set here; the short-circuit arm is a defensive backstop */
        /* v8 ignore next -- see above */
        if (turnEnds && this.inbox.nextStep.length === 0) {      /* v8 ignore stop */
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

  /** Whether two spawn specs describe the same `kimi acp` child. */
  private specsEqual(a: KimiSpawnSpec | undefined, b: KimiSpawnSpec): boolean {
    /* v8 ignore start -- specsEqual only runs once a client exists, so its lastSpec is always set */
    /* v8 ignore next -- see above */
    if (a === undefined) return false      /* v8 ignore stop */
    return a.cwd === b.cwd
      && a.env === b.env
      && a.argv.length === b.argv.length
      && a.argv.every((value, index) => value === b.argv[index])
  }

  /** Return the cached ACP client, respawning when the spec or process changed. */
  private async acpClient(cwd: string, handover: DshModelHandover | undefined): Promise<AcpClient> {
    const spec = this.spawnSpec(cwd, handover)
    if (this.acp !== undefined && !this.acp.closed && this.specsEqual(this.lastSpec, spec)) return this.acp
    this.acp?.dispose()
    const client = AcpClient.create(spec, this.spawn)
    this.acp = client
    this.lastSpec = spec
    try {
      await client.initialize()
    } catch (error: unknown) {
      this.acp = undefined
      this.lastSpec = undefined
      client.dispose()
      throw error
    }
    return client
  }

  /** Build the `kimi acp` argv/cwd/env for the persistent child. */
  private spawnSpec(cwd: string, handover: DshModelHandover | undefined): KimiSpawnSpec {
    return {
      argv: kimiAcpArgv(this.bin),
      cwd,
      env: this.handoverEnv(handover),
    }
  }

  /**
   * The child environment for one handover, memoized by content so an unchanged
   * endpoint yields the SAME object across steps (see {@link handoverEnvCache}).
   */
  private handoverEnv(handover: DshModelHandover | undefined): Record<string, string> {
    if (handover === undefined) return this.config.env
    const key = JSON.stringify(handover)
    if (this.handoverEnvCache?.key === key) return this.handoverEnvCache.env
    const env = { ...this.config.env, ...kimiModelEnv(handover) }
    this.handoverEnvCache = { key, env }
    return env
  }

  /** Run one `kimi acp` step for the current session history and map the streamed updates. */
  private async step(): Promise<StepEndReason | null> {
    /* v8 ignore start -- private callers establish the running phase before executing a step */
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)    /* v8 ignore stop */
    const phase = this.phase
    const { abort: { signal } } = phase
    signal.throwIfAborted()
    // Step-local state: multiple steps run within one turn (steering), so each
    // step starts with a clean assistant-blocks/tool accumulator.
    this.blocks = []
    this.pendingCalls = new Map()
    this.segmentCalls = []
    this.toolContent = new Map()
    this.producedOutput = false
    this.stepSettledTools = 0

    const cwd = this.session.header.cwd
    if (cwd === undefined || cwd.length === 0) {
      throw new Error(`agent "${this.id}": no working directory — start the session with cwd metadata`)
    }
    const history: Message[] = this.session.deriveMessages()
    // A live slash command is the engine's own control line: send it verbatim
    // (the transcript framing would hide it from Kimi's ACP command surface).
    const prompt = engineSlashPrompt(history) ?? serializeHistory(history)
    /* v8 ignore start -- a step only runs after claiming and durably appending at least one user message */
    if (prompt.length === 0) {
      throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`)
    }
    /* v8 ignore stop */
    this.assertRequestHeader()
    signal.throwIfAborted()

    // The session's model selection, and — when dsh discloses it — that model's
    // endpoint and credential, resolved fresh on every step so a mid-session
    // change reaches the next child (and a changed endpoint respawns it).
    const override = sessionModelOverrideOf(this.loopCtx, this.session)
    const handover = await resolveModelHandover(this.loopCtx, override)
    const client = await this.acpClient(cwd, handover)
    signal.throwIfAborted()
    // Answer ACP tool-approval requests from the session's dsh approval knobs.
    client.onPermission(() => resolveToolApproval(this.session.snapshotEvents()))
    const acpSessionId = await client.newSession(cwd)
    signal.throwIfAborted()

    // The session's own pick wins over the deployment's pin, read every step so
    // a model changed mid-conversation reaches the next session. Kimi selects a
    // model per ACP session through `session/set_model`, and the client rejects
    // on an error frame — so a model Kimi refuses fails this step loud rather
    // than leaving the default in place. When dsh handed over an ENDPOINT, the
    // child's environment already names that model as kimi's default
    // (KIMI_MODEL_NAME via kimi's own env-model path), so `set_model` is
    // deliberately skipped: it would ask kimi for the raw dsh model id as a
    // model ALIAS, which the env model is not.
    const model = override?.model ?? this.config.model
    if (handover === undefined && model !== undefined) await client.setModel(acpSessionId, model)
    signal.throwIfAborted()

    try {
      // Consume streamed updates via the callback as they arrive. The prompt
      // response frame is dispatched after the turn's updates, so every update is
      // applied before it resolves — no EOF or "finished" race. (The ACP child
      // stays open between steps, so its stream never ends on its own.)
      client.onUpdate((update) => this.applyUpdate(phase, update))

      const cancel = (): void => { client.cancel(acpSessionId) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        await raceAbort(client.prompt(acpSessionId, prompt), signal, this.id)
      } finally {
        signal.removeEventListener('abort', cancel)
      }

      // Close the final segment: trailing blocks plus every call the engine
      // announced without ever supplying its input, folded into the segment's
      // single assistant message so the transcript keeps every request the
      // model made.
      for (const [callId, call] of this.pendingCalls) {
        this.segmentCalls.push({ callId, name: call.name, arguments: '{}' })
      }
      this.pendingCalls.clear()
      this.flushSegment(phase)
      if (!this.producedOutput) {
        throw new LlmError(
          `agent "${this.id}": kimi query produced no assistant output`,
          'KIMI_NO_RESULT',
        )
      }
      return { kind: 'completed' }
    } finally {
      // A step that streamed without committing a durable message closes its
      // live frames, so the client stops painting an abandoned partial.
      if (this.live !== undefined && !this.live.ended) this.live.abandon()
      this.live = undefined
    }
  }

  /** Per-step accumulation state for streamed assistant blocks and tool calls. */
  private blocks: OpenBlock[] = []
  /**
   * Announced calls still waiting for the update that carries their input,
   * keyed by call id, holding the latest content snapshot seen meanwhile (a
   * frame can report output before it reports input). `toolContent` holds the
   * calls already logged, so a call is in exactly one of the two.
   */
  private pendingCalls = new Map<string, { name: string; content?: string }>()
  /** Whether the current step published any assistant message at all. */
  private producedOutput = false
  /**
   * Tool results logged into the currently open step. A result means the
   * segment that requested the call is finished, so the next assistant content
   * opens the next step (see {@link beginSegment}).
   */
  private stepSettledTools = 0
  /**
   * Tool calls the current segment has already received input for, awaiting the
   * segment's single assistant message. A model turn that announces several
   * calls before any result must land them all in ONE message — the chat node
   * keys by `${turn}:${step}` and replaces blocks on every message, so a second
   * message would overwrite the first one's reasoning/text (and tool-call head).
   * The list is flushed once, when the segment closes (its first settled result).
   */
  private segmentCalls: { callId: string; name: string; arguments: string }[] = []
  /** Latest content snapshot per logged tool call (see {@link applyUpdate}). */
  private toolContent = new Map<string, string>()
  /** The live attempt framing the assistant message being assembled right now. */
  private live: DriverAssistantStream | undefined

  private blockRef(type: 'text' | 'reasoning'): OpenBlock | undefined {
    return this.blocks.find(block => block.type === type)
  }

  private ensureBlock(type: 'text' | 'reasoning'): OpenBlock {
    const existing = this.blockRef(type)
    if (existing !== undefined) return existing
    // Reasoning leads the assistant message; text follows. Indexes stay
    // contiguous in the order blocks first appear.
    const index = this.blocks.length
    const block: OpenBlock = { index, type, text: '' }
    this.blocks.push(block)
    return block
  }

  /**
   * Rotate to the next step when the segment that ran a tool has finished, so
   * each assistant segment lands in its own step.
   *
   * Called as new assistant content begins. A step holding a settled tool
   * result means the previous segment is complete, and the content about to be
   * applied belongs to the next one. Rotating here (rather than when a call is
   * announced) keeps calls that were announced before any result — one model
   * turn — in a single step.
   */
  private beginSegment(phase: RunningPhase): void {
    if (this.stepSettledTools === 0) return
    this.session.append('step/end', { turn: phase.turn, step: phase.step })
    phase.step += 1
    this.session.append('step/start', { turn: phase.turn, step: phase.step })
    this.stepSettledTools = 0
  }

  /** Apply one streamed update to the open step's blocks and stream. */
  private applyUpdate(phase: RunningPhase, update: AcpUpdate): void {
    if (isThoughtChunk(update)) {
      const delta = chunkDelta(update)
      if (delta === '') return
      this.beginSegment(phase)
      const block = this.ensureBlock('reasoning')
      // An empty block has published nothing yet, so it opens with a block-start.
      if (block.text === '') this.currentStream(phase).push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
      this.currentStream(phase).push({ type: 'reasoning-delta', index: block.index, text: delta })
      block.text += delta
      return
    }
    if (isTextChunk(update)) {
      const delta = chunkDelta(update)
      if (delta === '') return
      this.beginSegment(phase)
      const block = this.ensureBlock('text')
      // An empty block has published nothing yet, so it opens with a block-start.
      if (block.text === '') this.currentStream(phase).push({ type: 'block-start', index: block.index, blockType: 'text' })
      this.currentStream(phase).push({ type: 'text-delta', index: block.index, text: delta })
      block.text += delta
      return
    }
    if (isToolCall(update)) {
      const callId = toolCallIdOf(update)
      if (callId === '' || this.pendingCalls.has(callId) || this.toolContent.has(callId)) return
      this.beginSegment(phase)
      // The announcement names the call but never carries its input, so the
      // call is logged only once an update supplies `rawInput` — or when it
      // settles (see the update branch below).
      this.pendingCalls.set(callId, { name: toolCallName(update) })
      return
    }
    if (isToolCallUpdate(update)) {
      const callId = toolCallIdOf(update)
      if (callId === '') return
      const status = (update as { status?: unknown }).status as string
      const settled = isToolSettledStatus(status)
      // Kimi re-sends the whole content on every update, so this replaces the
      // stored snapshot rather than extending it (see acp/mapping.ts). An update
      // with no content field leaves the last snapshot standing, so a settling
      // frame that only carries the status still reports the real output.
      const snapshot = toolContentText(update)
      const pending = this.pendingCalls.get(callId)
      if (pending !== undefined) {
        if (snapshot !== undefined) pending.content = snapshot
        const args = toolRawInput(update)
        // Wait for the frame that carries the input; a settling call is logged
        // with empty arguments rather than dropped, so every announced call
        // still reaches the transcript.
        if (args === undefined && !settled) return
        this.pendingCalls.delete(callId)
        // A call whose input arrived after a prior result is the next segment,
        // so rotate the step before accumulating it (see {@link beginSegment}).
        this.beginSegment(phase)
        this.segmentCalls.push({ callId, name: pending.name, arguments: args ?? '{}' })
        this.toolContent.set(callId, pending.content ?? '')
      } else if (!this.toolContent.has(callId)) {
        return
      } else if (snapshot !== undefined) {
        this.toolContent.set(callId, snapshot)
      }
      if (settled) {
        // The first settled result closes the segment: flush its ONE assistant
        // message carrying every accumulated tool-call block, then each
        // `tool/call`, so the durable order stays assistant/message → tool/call
        // → tool/result. That order is load-bearing for result pairing, and a
        // single message per step is what the chat view renders (it keys an
        // assistant node by `${turn}:${step}` and replaces blocks per message).
        this.flushSegment(phase)
        // The branch guards above guarantee the entry exists, so a bare get() is
        // defined and needs no `?? ''` fallback.
        const message = toolResult(callId, this.toolContent.get(callId)!, isToolErrorStatus(status))
        this.session.append('tool/result', { turn: phase.turn, step: phase.step, message }, { surfaceOp: 'append' })
        this.toolContent.delete(callId)
        this.stepSettledTools += 1
      }
      return
    }
    // Unknown update kinds (available_commands_update, config_option_update,
    // plan, …) are not part of the faithful model context projection.
  }

  /** The live attempt framing the current segment, opened on its first chunk. */
  private currentStream(phase: RunningPhase): DriverAssistantStream {
    if (this.live === undefined) {
      this.live = new DriverAssistantStream(
        this.id,
        ++this.streamAttempts,
        phase.turn,
        phase.step,
        frame => this.dispatch.emit('agent/assistant-stream', { frame }),
      )
      this.live.start()
    }
    return this.live
  }

  /**
   * Flush the open segment's single assistant message and every `tool/call` it
   * accumulated, in the load-bearing order assistant/message → tool/call. One
   * segment produces exactly ONE message even when the model announced several
   * calls before any result, because the chat view keys an assistant node by
   * `${turn}:${step}` and replaces its blocks on every message — a second
   * message in the same step would overwrite the first one's reasoning/text and
   * leave only the last bare tool-call head visible.
   * @param phase - the open step the segment belongs to.
   */
  private flushSegment(phase: RunningPhase): void {
    const calls = this.segmentCalls
    this.segmentCalls = []
    // Normalize each call exactly once and feed the SAME values to both
    // writers: the assistant message's `tool-call` block and the `tool/call`
    // event must carry byte-identical name and arguments for the same id, or
    // Session V4 refuses the log on load. dsh's spelling wins on both sides.
    const normalized = calls.map(call => {
      const projection = normalizeHostedToolCall('kimi', call.name, call.arguments)
      return { callId: call.callId, name: projection.name, arguments: projection.arguments }
    })
    this.flushAssistant(phase, normalized)
    for (const call of normalized) {
      this.session.append('tool/call', { turn: phase.turn, step: phase.step, callId: ToolCallId(call.callId), name: call.name, arguments: call.arguments })
    }
  }

  /**
   * Flush the accumulated assistant blocks into one durable assistant/message
   * carrying the exact stream the attempt published live, optionally closing it
   * with the tool-call block(s) that ended the segment.
   *
   * Every flush settles its own attempt (and so its own live `end` frame): a
   * step emits one message per assistant segment, and the client pairs a durable
   * message with the attempt whose `end` cites it, so two messages may not share
   * one attempt.
   * @param phase - the open step the message belongs to.
   * @param toolCalls - the calls that closed this segment, rendered as trailing
   *   `tool-call` content blocks. A segment with no blocks of its own — a step
   *   whose only activity was a tool call — still emits this message, so its
   *   `tool/call` and `tool/result` events have a parent to pair with.
   */
  private flushAssistant(
    phase: RunningPhase,
    toolCalls: readonly { callId: string; name: string; arguments: string }[] = [],
  ): void {
    if (this.blocks.length === 0 && toolCalls.length === 0) return
    const content: ContentBlock[] = []
    this.producedOutput = true
    // A segment with no text/reasoning published no live chunks, so it has no
    // attempt to settle and its message is appended directly.
    const attempt = this.blocks.length === 0 ? undefined : this.currentStream(phase)
    for (const block of this.blocks) {
      // Blocks are created only when a non-empty delta arrives, so block.text is
      // always non-empty here — no `if (delta !== '')` guard needed.
      const delta = block.text
      content.push(block.type === 'text' ? { type: 'text', text: delta } : { type: 'reasoning', text: delta })
      attempt?.push({ type: 'block-end', index: block.index, block: block.type === 'text' ? { type: 'text', text: delta } : { type: 'reasoning', text: delta } })
    }
    for (const call of toolCalls) {
      content.push({ type: 'tool-call', id: ToolCallId(call.callId), name: call.name, arguments: call.arguments })
    }
    const data = {
      turn: phase.turn,
      step: phase.step,
      message: createAssistantMessage({
        content,
        source: { provider: PROVIDER, model: this.modelLabel() },
      }),
      // The attempt's exact timed stream travels with its message.
      stream: attempt?.stream ?? [],
    }
    if (attempt === undefined) {
      this.session.append('assistant/message', data, { surfaceOp: 'append' })
    } else {
      attempt.settle(() => this.session.append('assistant/message', data, { surfaceOp: 'append' }).seq)
      // The next segment opens a fresh attempt, so this message keeps exactly
      // the chunks its own content produced.
      this.live = undefined
    }
    this.blocks = []
  }
}
/* jscpd:ignore-end */
