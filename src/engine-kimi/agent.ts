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
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, LlmError, createAssistantMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './types.ts'
import { serializeHistory } from '../driver-core/prompt.ts'
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

/** Provider route label used for logged header snapshots and message provenance. */
export const PROVIDER = 'kimi'
/**
 * Model label logged when the deployment pins no model: Kimi owns its model
 * natively, so the web session's advisory model selection is deliberately not
 * mirrored into the header (it never drives a query).
 */
const NATIVE_MODEL_LABEL = 'kimi-native'

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

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }

/** One opened assistant content block (text or reasoning) awaiting its deltas. */
interface OpenBlock {
  readonly index: number
  readonly type: 'text' | 'reasoning'
  text: string
  readonly refs: SessionSeq[]
}

/** Drives one session through turn and step boundaries on Kimi Code. */
export class KimiAgent implements Agent {
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

  /** Lazily created ACP client, reused across steps and released on scope teardown. */
  private acp: AcpClient | undefined
  /** The spawn spec the cached client was built from; a change forces a respawn. */
  private lastSpec: KimiSpawnSpec | undefined

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
    this.inbox = new Inbox(session, {
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
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          const stepEnd = await this.step()
          if (turnEnds === null) turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
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
  private async acpClient(cwd: string): Promise<AcpClient> {
    const spec = this.spawnSpec(cwd)
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
  private spawnSpec(cwd: string): KimiSpawnSpec {
    return {
      argv: kimiAcpArgv(this.bin),
      cwd,
      env: this.config.env,
    }
  }

  /** Run one `kimi acp` step for the current session history and map the streamed updates. */
  private async step(): Promise<StepEndReason | null> {
    /* v8 ignore start -- private callers establish the running phase before executing a step */
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)    /* v8 ignore stop */
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    // Step-local state: multiple steps run within one turn (steering), so each
    // step starts with a clean assistant-blocks/tool accumulator.
    this.blocks = []
    this.emittedToolCalls = new Set()
    this.toolText = new Map()

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

    const client = await this.acpClient(cwd)
    signal.throwIfAborted()
    // Answer ACP tool-approval requests from the session's dsh approval knobs.
    client.onPermission(() => resolveToolApproval(this.session.snapshotEvents()))
    const acpSessionId = await client.newSession(cwd)
    signal.throwIfAborted()

    // Consume streamed updates via the callback as they arrive. The prompt
    // response frame is dispatched after the turn's updates, so every update is
    // applied before it resolves — no EOF or "finished" race. (The ACP child
    // stays open between steps, so its stream never ends on its own.)
    client.onUpdate((update) => this.applyUpdate(turn, step, update))

    const cancel = (): void => { client.cancel(acpSessionId) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await raceAbort(client.prompt(acpSessionId, prompt), signal, this.id)
    } finally {
      signal.removeEventListener('abort', cancel)
    }

    this.flushAssistant(turn, step)
    if (this.blocks.length === 0 && this.emittedToolCalls.size === 0) {
      throw new LlmError(
        `agent "${this.id}": kimi query produced no assistant output`,
        'KIMI_NO_RESULT',
      )
    }
    return { kind: 'completed' }
  }

  /** Per-step accumulation state for streamed assistant blocks and tool calls. */
  private blocks: OpenBlock[] = []
  private emittedToolCalls = new Set<string>()
  private toolText = new Map<string, string>()

  private blockRef(type: 'text' | 'reasoning'): OpenBlock | undefined {
    return this.blocks.find(block => block.type === type)
  }

  private ensureBlock(type: 'text' | 'reasoning'): OpenBlock {
    const existing = this.blockRef(type)
    if (existing !== undefined) return existing
    // Reasoning leads the assistant message; text follows. Indexes stay
    // contiguous in the order blocks first appear.
    const index = this.blocks.length
    const block: OpenBlock = { index, type, text: '', refs: [] }
    this.blocks.push(block)
    return block
  }

  /** Append one streamed update's durable effect for the current step. */
  private applyUpdate(turn: number, step: number, update: AcpUpdate): void {
    if (isThoughtChunk(update)) {
      const delta = chunkDelta(update)
      if (delta === '') return
      const block = this.ensureBlock('reasoning')
      const started = block.refs.length === 0
      if (started) block.refs.push(this.appendChunk(turn, step, { type: 'block-start', index: block.index, blockType: 'reasoning' }))
      block.refs.push(this.appendChunk(turn, step, { type: 'reasoning-delta', index: block.index, text: delta }))
      block.text += delta
      return
    }
    if (isTextChunk(update)) {
      const delta = chunkDelta(update)
      if (delta === '') return
      const block = this.ensureBlock('text')
      const started = block.refs.length === 0
      if (started) block.refs.push(this.appendChunk(turn, step, { type: 'block-start', index: block.index, blockType: 'text' }))
      block.refs.push(this.appendChunk(turn, step, { type: 'text-delta', index: block.index, text: delta }))
      block.text += delta
      return
    }
    if (isToolCall(update)) {
      const callId = toolCallIdOf(update)
      if (callId === '' || this.emittedToolCalls.has(callId)) return
      this.emittedToolCalls.add(callId)
      const name = toolCallName(update)
      this.session.append('tool/call', { turn, step, callId: ToolCallId(callId), name, arguments: '{}' })
      this.toolText.set(callId, '')
      return
    }
    if (isToolCallUpdate(update)) {
      const callId = toolCallIdOf(update)
      if (callId === '' || !this.toolText.has(callId)) return
      const delta = toolContentText(update)
      // The has() guard above guarantees the entry exists, so a bare get() is
      // defined and needs no `?? ''` fallback.
      const accumulated = `${this.toolText.get(callId)!}${delta}`
      this.toolText.set(callId, accumulated)
      const status = (update as { status?: unknown }).status as string
      if (isToolSettledStatus(status)) {
        const message = toolResult(callId, accumulated, isToolErrorStatus(status))
        this.session.append('tool/result', { turn, step, message }, { surfaceOp: 'append' })
        this.toolText.delete(callId)
      }
      return
    }
    // Unknown update kinds (available_commands_update, config_option_update,
    // plan, …) are not part of the faithful model context projection.
  }

  /** Append one live chunk and return its durable seq. */
  private appendChunk(turn: number, step: number, chunk: StreamChunk): SessionSeq {
    return this.session.append('assistant/chunk', { turn, step, chunk }).seq
  }

  /** Flush the accumulated assistant blocks into one durable assistant/message. */
  private flushAssistant(turn: number, step: number): void {
    // A step with no assistant content and no tool activity produced nothing to
    // publish; tool-only steps still emit an (possibly empty) assistant message so
    // the `tool/call` + `tool/result` events have a parent message to pair with.
    if (this.blocks.length === 0 && this.emittedToolCalls.size === 0) return
    const content: ContentBlock[] = []
    const refs: SessionSeq[] = []
    for (const block of this.blocks) {
      // Blocks are created only when a non-empty delta arrives, so block.text is
      // always non-empty here — no `if (delta !== '')` guard needed.
      const delta = block.text
      content.push(block.type === 'text' ? { type: 'text', text: delta } : { type: 'reasoning', text: delta })
      block.refs.push(this.appendChunk(turn, step, { type: 'block-end', index: block.index, block: block.type === 'text' ? { type: 'text', text: delta } : { type: 'reasoning', text: delta } }))
      refs.push(...block.refs)
    }
    this.session.append('assistant/message', {
      turn,
      step,
      message: createAssistantMessage({
        content,
        source: { provider: PROVIDER, model: this.modelLabel() },
      }),
    }, {
      surfaceOp: 'append',
      sourceEventSeqs: refs,
    })
  }
}
/* jscpd:ignore-end */
