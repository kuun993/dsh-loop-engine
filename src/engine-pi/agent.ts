/**
 * Pi loop Agent: drives one session through turn and step boundaries by
 * spawning a `pi --mode rpc` child process and speaking strict-LF JSONL over
 * stdio. The dsh session log is the sole source of truth and each step runs one
 * stateless Pi session (a fresh `new_session` + a single `prompt`), so the
 * prompt is a pure serialization of the durable history plus the assembled dsh
 * system prompt. Pi owns its tools natively but has no permission system, so
 * the whole child is sandboxed by the dsh subprocess seam and its `--tools`
 * are pruned to the resolved stance.
 *
 * @module dsh-loop-engine/engine-pi/agent
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
import { CallId, LlmError, createAssistantMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './types.ts'
import { serializeHistory } from '../driver-core/prompt.ts'
import { resolveSessionPermission, toolsForSandbox, type PiPermission } from './permission.ts'
import {
  PiRpcClient,
  type PiSpawnCapability,
  type PiSpawnSpec,
} from './rpc/client.ts'
import { mapToolResult, mapUsage } from './rpc/mapping.ts'
import type { PiMessage, PiToolResult } from './rpc/types.ts'
import {
  invokedSkillNames,
  isSkillName,
  renderSkillContent,
  type SkillDefinition,
  type SkillsService,
} from '../driver-core/skill-inject.ts'

/** Provider route label used for logged header snapshots and message provenance. */
export const PROVIDER = 'pi'
/**
 * Model label logged when the deployment pins no model: Pi owns its model
 * natively, so the web session's advisory model selection is deliberately not
 * mirrored into the header (it never drives a query).
 */
const NATIVE_MODEL_LABEL = 'pi-native'

/** CLI flag for the tool allowlist, derived from the resolved sandbox stance. */
const TOOLS_FLAG = '--tools'

/** Whether two spawn specs describe the same Pi child (so the client can be reused). */
function specsEqual(a: PiSpawnSpec | undefined, b: PiSpawnSpec): boolean {
  /* v8 ignore start -- specsEqual only runs once a client exists, so its lastSpec is always set */
  /* v8 ignore next -- see above */
  if (a === undefined) return false      /* v8 ignore stop */
  return a.cwd === b.cwd
    && a.env === b.env
    && a.argv.length === b.argv.length
    && a.argv.every((value, index) => value === b.argv[index])
}

/* jscpd:ignore-start -- mirrors the Codex driver; the two engines share the default agent-loop driver's phase machine. */
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

/** An assistant message held until the step knows whether turn usage attaches to it. */
interface HeldMessage {
  readonly content: ContentBlock[]
  /** Durable seqs of the chunks that already streamed this message's live partial. */
  readonly refs: number[]
}

/** Drives one session through turn and step boundaries on Pi. */
export class PiAgent implements Agent {
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

  /** Lazily created RPC client, reused across steps and released on scope teardown. */
  private rpc: PiRpcClient | undefined
  /** The spawn spec the cached client was built from; a change forces a respawn. */
  private lastSpec: PiSpawnSpec | undefined

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly config: ResolvedConfig,
    private readonly spawn: PiSpawnCapability,
    private readonly bin: string,
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
    // Release the shared RPC client when the agent scope is unwound.
    this.scope.ctx.effect(() => () => {
      this.rpc?.dispose()
      this.rpc = undefined
    }, 'pi.rpcClient()')
  }

  /** Return the cached RPC client, respawning when the spec or process changed. */
  private async rpcClient(cwd: string): Promise<PiRpcClient> {
    const spec = this.spawnSpec(cwd)
    if (this.rpc !== undefined && !this.rpc.closed && specsEqual(this.lastSpec, spec)) return this.rpc
    this.rpc?.dispose()
    const client = PiRpcClient.create(spec, this.spawn)
    this.rpc = client
    this.lastSpec = spec
    return client
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
    // chain, which the Pi agent's context does not descend from, so we
    // replicate the gesture-scan and injection here.
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
   * Resolve the runtime permission stance for one query. Deployment-pinned
   * fields win; anything unpinned follows the session's durable dsh permission
   * knobs, re-folded per query so mid-session preset switches take effect on the
   * next step.
   * @returns the permission fields of the query spec.
   */
  private queryPermission(): PiPermission {
    const fold = resolveSessionPermission(this.session.events)
    const sandboxMode = this.config.sandboxMode ?? fold.sandboxMode
    return {
      sandboxMode,
      tools: this.config.sandboxMode === undefined ? fold.tools : toolsForSandbox(sandboxMode),
    }
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

  /** Build the `pi --mode rpc` argv/cwd/env for one step's child process. */
  private spawnSpec(cwd: string): PiSpawnSpec {
    const argv: string[] = []
    if (this.config.provider !== undefined) argv.push('--provider', this.config.provider)
    if (this.config.model !== undefined && this.config.thinkingLevel !== undefined) {
      argv.push('--model', `${this.config.model}:${this.config.thinkingLevel}`)
    } else if (this.config.model !== undefined) {
      argv.push('--model', this.config.model)
    } else if (this.config.thinkingLevel !== undefined) {
      argv.push('--model', `:${this.config.thinkingLevel}`)
    }
    const permission = this.queryPermission()
    if (permission.tools.length > 0) argv.push(TOOLS_FLAG, permission.tools.join(','))
    return {
      argv: [
        this.bin,
        '--mode', 'rpc',
        '--no-session',
        ...argv,
      ],
      cwd,
      env: this.config.env,
    }
  }

  /**
   * Run one Pi RPC query for the current step and map its event stream into the
   * session log. The step opens a fresh Pi session (`new_session`) and sends the
   * serialized session history as one prompt, then consumes events until the
   * agent settles. Like the Codex/Claude drivers, Pi owns its own system prompt
   * natively, so the dsh system-prompt assembly (which pulls dsh tool schemas
   * and `agent.ctx.tools`) is deliberately not run — the durable session log is
   * the sole source of model context.
   */
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
        // Best-effort abort: the RPC child may already be tearing down (engine
        // switch / scope dispose), in which case the in-flight `abort` command
        // is rejected by `PiRpcClient.dispose()`. The request is fire-and-forget,
        // so swallow the rejection — an unhandled one would otherwise crash the
        // process with "pi RPC client is disposed" during teardown.
        void this.rpc?.abort().catch(() => undefined)
      }      /* v8 ignore stop */
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const client = await this.rpcClient(cwd)
      signal.throwIfAborted()
      await client.newSession()
      client.clearEvents()
      await client.prompt(prompt)

      let finished = false
      /**
       * Whether the agent has fully settled for this step. Unlike {@link finished}
       * (set on any terminal-ish event, including a mid-run `turn_end`), this
       * becomes true only on `agent_settled` (or a non-retrying `agent_end`), and
       * it is what actually ends the event loop — because the Pi RPC child stays
       * alive between steps, the `events()` generator never returns on its own, so
       * the loop must break on the settle signal or `step()` hangs after the
       * reply has already streamed.
       */
      let settled = false
      /** Seq refs of chunks already streamed for the current agent message. */
      const chunkSeqs: number[] = []
      /** The assistant message being assembled; its chunks stream live as items complete. */
      let held: HeldMessage | undefined
      /** Text blocks already block-start-ed, by message content index. */
      const startedText = new Set<number>()
      /** Reasoning blocks already block-start-ed, by message content index. */
      const startedReasoning = new Set<number>()
      /** Accumulated thinking by content index (for providers that omit thinking blocks). */
      const thinkingByIndex = new Map<number, string>()
      /** Tool call ids already written to the log (prevents duplicate tool/call). */
      const emittedToolCalls = new Set<string>()
      /** Last usage snapshot, folded onto the message that closes a turn. */
      let lastUsage: TokenUsage | undefined
      /** Whether an assistant message already flushed for this turn (message_end). */
      let assistantFlushed = false

      /** Emit one live partial chunk and return its durable seq. */
      const emitChunk = (chunk: StreamChunk): number => {
        const seq = this.session.append('assistant/chunk', { turn, step, chunk }).seq
        chunkSeqs.push(seq)
        return seq
      }

      /** Append the held assistant message, optionally carrying turn usage. */
      const flushHeld = (usage?: TokenUsage): void => {
        if (held === undefined) return
        this.session.append('assistant/message', {
          turn,
          step,
          message: createAssistantMessage({
            content: held.content,
            source: { provider: PROVIDER, model: this.modelLabel() },
          }),
          ...usage === undefined ? {} : { usage },
        }, {
          surfaceOp: 'append',
          // Link the durable message to the chunks that streamed it, so replay
          // can reconstruct the partial exactly as shown.
          sourceEventSeqs: held.refs,
        })
        held = undefined
      }

      /** Ensure a text block has been block-start-ed at the given index. */
      const ensureTextBlock = (index: number): void => {
        if (startedText.has(index)) return
        startedText.add(index)
        emitChunk({ type: 'block-start', index, blockType: 'text' })
      }

      /** Ensure a reasoning block has been block-start-ed at the given index. */
      const ensureReasoningBlock = (index: number): void => {
        if (startedReasoning.has(index)) return
        startedReasoning.add(index)
        emitChunk({ type: 'block-start', index, blockType: 'reasoning' })
      }

      /** Emit a durable tool/call unless the call id was already written. */
      const emitToolCall = (callId: string, name: string, rawArguments: unknown): void => {
        if (emittedToolCalls.has(callId)) return
        emittedToolCalls.add(callId)
        const argumentsValue = typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {})
        this.session.append('tool/call', {
          turn, step, callId: CallId(callId), name, arguments: argumentsValue,
        })
      }

      /** Build an assistant message's content blocks from the authoritative message or buffers. */
      const contentOf = (message: PiMessage): ContentBlock[] => {
        let blocks: ContentBlock[] = []
        const content = Array.isArray(message.content)
          ? message.content
          : typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            /* v8 ignore next -- Pi message content is always a string or array, so this arm is a defensive backstop */
            : []
        for (const block of content) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text })
          } else if (block.type === 'thinking') {
            blocks.push({ type: 'reasoning', text: block.thinking })
          }
        }
        // Some providers emit only streaming thinking deltas; fold any that the
        // authoritative message omits so thinking never disappears from the log.
        // Thinking is folded before the text, matching the reasoning-then-answer
        // ordering the default loop produces.
        if (!blocks.some(block => block.type === 'reasoning') && thinkingByIndex.size > 0) {
          const folded: ContentBlock[] = [...thinkingByIndex.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, text]) => ({ type: 'reasoning', text }))
          blocks = [...folded, ...blocks]
        }
        return blocks
      }

      signal.throwIfAborted()
      for await (const event of client.events()) {
        signal.throwIfAborted()
        switch (event.type) {
          case 'agent_start':
          case 'compaction_start':
          case 'compaction_end':
          case 'auto_retry_start':
          case 'auto_retry_end':
          case 'queue_update':
          case 'bash_execution_update':
          case 'extension_ui_request':
            break
          case 'message_start':
            if (event.message.role === 'assistant') {
              chunkSeqs.length = 0
              startedText.clear()
              startedReasoning.clear()
              thinkingByIndex.clear()
            }
            break
          case 'message_update': {
            if (event.usage !== undefined) lastUsage = mapUsage(event.usage)
            const delta = event.assistantMessageEvent
            switch (delta.type) {
              case 'text_start':
              case 'thinking_start':
                break
              case 'text_delta':
                ensureTextBlock(delta.contentIndex)
                emitChunk({ type: 'text-delta', index: delta.contentIndex, text: delta.delta })
                break
              case 'thinking_delta':
                ensureReasoningBlock(delta.contentIndex)
                emitChunk({ type: 'reasoning-delta', index: delta.contentIndex, text: delta.delta })
                thinkingByIndex.set(delta.contentIndex, (thinkingByIndex.get(delta.contentIndex) ?? '') + delta.delta)
                break
              case 'toolcall_start':
                break
              case 'toolcall_delta':
                break
              case 'toolcall_end':
                emitToolCall(delta.toolCall.id, delta.toolCall.name, delta.toolCall.arguments)
                break
              case 'text_end':
              case 'thinking_end':
                break
            }
            break
          }
          case 'message_end': {
            if (event.message.role === 'assistant') {
              if (event.message.usage !== undefined) lastUsage = mapUsage(event.message.usage)
              flushHeld()
              held = { content: contentOf(event.message), refs: [...chunkSeqs] }
              chunkSeqs.length = 0
              flushHeld(lastUsage)
              assistantFlushed = true
            }
            break
          }
          case 'tool_execution_start':
            emitToolCall(event.toolCallId, event.toolName, event.args)
            break
          case 'tool_execution_update':
            break
          case 'tool_execution_end':
            emitToolCall(event.toolCallId, event.toolName, undefined)
            this.session.append('tool/result', {
              turn,
              step,
              message: mapToolResult({ toolCallId: event.toolCallId, result: event.result, isError: event.isError }),
            }, { surfaceOp: 'append' })
            break
          case 'turn_end': {
            if (!assistantFlushed && event.message !== undefined) {
              if (event.message.usage !== undefined) lastUsage = mapUsage(event.message.usage)
              held = { content: contentOf(event.message), refs: [...chunkSeqs] }
              chunkSeqs.length = 0
            }
            for (const toolResult of event.toolResults ?? []) {
              this.appendToolResult(turn, step, toolResult)
            }
            flushHeld(lastUsage)
            finished = true
            break
          }
          case 'agent_end':
            flushHeld(lastUsage)
            finished = true
            // `agent_end` carries `willRetry`; a retrying run keeps emitting (auto-retry /
            // compaction), so only a non-retrying `agent_end` concludes the step.
            if (!event.willRetry) settled = true
            break
          case 'agent_settled':
            flushHeld(lastUsage)
            finished = true
            settled = true
            break
        }
        // The Pi child persists across steps, so the RPC event generator never
        // ends on its own: once the agent has settled, stop consuming and let the
        // step return, otherwise `step()` hangs after the final reply streams.
        if (settled) break
      }
      flushHeld(lastUsage)
      if (!finished) {
        throw new LlmError(
          `agent "${this.id}": pi query ended without an agent settle`,
          'PI_NO_RESULT',
        )
      }
      return { kind: 'completed' }
    } finally {
      signal.removeEventListener('abort', cancel)
      controller.abort()
    }
  }

  /** Append one Pi tool result to the durable log as a `tool/result` message. */
  private appendToolResult(turn: number, step: number, toolResult: PiToolResult): void {
    const text = typeof toolResult.content === 'string'
      ? toolResult.content
      : toolResult.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter((segment) => segment !== '')
        .join('\n\n')
    this.session.append('tool/result', {
      turn,
      step,
      message: mapToolResult({
        toolCallId: toolResult.toolCallId,
        result: { content: [{ type: 'text', text }] },
        isError: toolResult.isError === true,
      }),
    }, { surfaceOp: 'append' })
  }
}
/* jscpd:ignore-end */
