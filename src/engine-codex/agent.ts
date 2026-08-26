/**
 * Codex loop Agent: drives one session through turn and step boundaries with
 * one Codex SDK thread per step. Codex owns its prompt, tools, and sandbox;
 * the durable session log remains the source of truth and the thread input is
 * a pure serialization of it. Codex streams at item granularity (no
 * incremental text deltas) and offers no interactive approval callback, so
 * permissions are folded declaratively into each thread's
 * `sandboxMode`/`approvalPolicy`.
 *
 * @module @deepseek-ai/dsh-loop-engine/engine-codex/agent
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
import { Codex } from '@openai/codex-sdk'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './types.ts'
import {
  mapAgentMessage,
  mapCommandExecution,
  mapFileChange,
  mapMcpToolCall,
  mapReasoning,
  mapUsage,
} from './mapping.ts'
import { serializeHistory } from '../engine/prompt.ts'
import { resolveSessionPermission, type CodexPermission } from './permission.ts'
import { codexQueryOptions, type CodexQuerySpec } from './sdk.ts'

/** Provider route label used for logged header snapshots and message provenance. */
const PROVIDER = 'codex'
/**
 * Model label logged when the deployment pins no model: Codex owns its model
 * natively, so the web session's advisory model selection is deliberately not
 * mirrored into the header (it never drives a query).
 */
const NATIVE_MODEL_LABEL = 'codex-native'

// ── Skill-injection helpers (inline to avoid a peer dep on @deepseek-ai/dsh-skill) ──

/** Kebab-case skill name regex. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whitespace-bounded `/name` gesture in user text. */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

function isSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name)
}

/** Minimal shape of a loaded skill definition. */
interface SkillDefinition {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly content: string
  readonly path?: string
  readonly resourceBase?: { readonly kind: string; readonly path: string }
}

/** Durable source for an injected user-explicit skill invocation (mirrors dsh-skill's). */
interface SkillInvocationSource {
  readonly kind: 'skill-invocation'
  readonly name: string
  readonly form: 'instructions'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A user-explicit skill invocation injected by this driver. */
    'skill-invocation': SkillInvocationSource
  }
}

/** Minimal shape of the SkillRegistry service. */
interface SkillsService {
  get(name: string, options: { cwd?: string; signal?: AbortSignal; scope?: unknown }): Promise<SkillDefinition | undefined>
}

/** Escape text for inclusion in XML-like skill markup. */
function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Escape an XML-like attribute value. */
function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** Render the `<skill_content>` block for a loaded skill. */
function renderSkillContent(skill: SkillDefinition): string {
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    skill.resourceBase !== undefined && skill.resourceBase.kind === 'directory'
      ? `Base directory for this skill: ${escapeText(skill.resourceBase.path)}. Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.`
      : `Resources for this skill are managed by provider "${escapeText(skill.provider)}". Load referenced resources only as needed.`,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** Collect `/name` gesture tokens from direct user messages, in first-seen order. */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}

/* jscpd:ignore-start -- mirrors the Claude Code driver; the two engines share the default agent-loop driver's phase machine. */
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
  readonly chunks: StreamChunk[]
}

/** Drives one session through turn and step boundaries on Codex. */
export class CodexAgent implements Agent {
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
    // chain, which the Codex agent's context does not descend from, so we
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
   * Resolve the declarative permission stance for one query. Deployment-pinned
   * fields win per field; anything unpinned follows the session's durable dsh
   * permission knobs, re-folded per query so mid-session preset switches take
   * effect on the next step.
   * @returns the permission fields of the query spec.
   */
  private queryPermission(): CodexPermission {
    const fold = resolveSessionPermission(this.session.events)
    return {
      sandboxMode: this.config.sandboxMode ?? fold.sandboxMode,
      approvalPolicy: this.config.approvalPolicy ?? fold.approvalPolicy,
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

  /** Run one Codex thread for the current step and map its transcript into the session log. */
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
    try {
      const spec: CodexQuerySpec = {
        cwd,
        permission: this.queryPermission(),
        env: this.config.env,
        ...this.config.model === undefined ? {} : { model: this.config.model },
        ...this.config.apiKey === undefined ? {} : { apiKey: this.config.apiKey },
        ...this.config.baseUrl === undefined ? {} : { baseUrl: this.config.baseUrl },
        ...this.config.networkAccessEnabled === undefined
          ? {}
          : { networkAccessEnabled: this.config.networkAccessEnabled },
      }
      const options = codexQueryOptions(spec, controller.signal)
      const thread = new Codex(options.codexOptions).startThread(options.threadOptions)
      const streamed = await thread.runStreamed(prompt, { signal: options.signal })
      let finished = false
      /** The latest agent message, held until the step knows whether turn usage attaches to it. */
      let held: HeldMessage | undefined
      /** Reasoning texts accumulated since the last agent message, folded into the next one. */
      const pendingReasoning: string[] = []
      /** Reasoning chunks accumulated alongside {@link pendingReasoning}, for replay linking. */
      const pendingReasoningChunks: StreamChunk[] = []
      /** Item ids whose tool/call already streamed at `item.started`. */
      const seenCalls = new Set<string>()

      /** Append the held assistant message (plus its chunks) with optional turn usage. */
      const flushHeld = (usage?: TokenUsage): void => {
        if (held === undefined) return
        const chunkSeqs = held.chunks.map(chunk => this.session.append('assistant/chunk', { turn, step, chunk }).seq)
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
          sourceEventSeqs: chunkSeqs,
        })
        held = undefined
      }
      /** Flush trailing accumulated reasoning as its own durable message. */
      const flushReasoning = (usage?: TokenUsage): void => {
        if (pendingReasoning.length === 0) return
        flushHeld()
        held = {
          content: pendingReasoning.map(text => ({ type: 'reasoning' as const, text })),
          chunks: [...pendingReasoningChunks],
        }
        pendingReasoning.length = 0
        pendingReasoningChunks.length = 0
        flushHeld(usage)
      }

      signal.throwIfAborted()
      for await (const event of streamed.events) {
        signal.throwIfAborted()
        switch (event.type) {
          case 'item.started': {
            const item = event.item
            if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
              flushReasoning()
              flushHeld()
              seenCalls.add(item.id)
              const call = item.type === 'command_execution'
                ? mapCommandExecution(item).call
                : mapMcpToolCall(item).call
              this.session.append('tool/call', {
                turn, step, callId: call.callId, name: call.name, arguments: call.arguments,
              })
            }
            break
          }
          case 'item.completed': {
            const item = event.item
            switch (item.type) {
              case 'reasoning': {
                const index = pendingReasoning.length
                pendingReasoning.push(mapReasoning(item))
                pendingReasoningChunks.push(
                  { type: 'block-start', index, blockType: 'reasoning' },
                  { type: 'reasoning-delta', index, text: item.text },
                )
                break
              }
              case 'agent_message': {
                flushHeld()
                const textIndex = pendingReasoning.length
                held = {
                  content: [...pendingReasoning.map(text => ({ type: 'reasoning' as const, text })), ...mapAgentMessage(item)],
                  chunks: [
                    ...pendingReasoningChunks,
                    { type: 'block-start', index: textIndex, blockType: 'text' },
                    { type: 'text-delta', index: textIndex, text: item.text },
                  ],
                }
                pendingReasoning.length = 0
                pendingReasoningChunks.length = 0
                break
              }
              case 'command_execution':
              case 'mcp_tool_call':
              case 'file_change': {
                flushReasoning()
                flushHeld()
                const activity = item.type === 'command_execution'
                  ? mapCommandExecution(item)
                  : item.type === 'mcp_tool_call'
                    ? mapMcpToolCall(item)
                    : mapFileChange(item)
                if (!seenCalls.has(item.id)) {
                  this.session.append('tool/call', {
                    turn, step, callId: activity.call.callId, name: activity.call.name, arguments: activity.call.arguments,
                  })
                }
                this.session.append('tool/result', { turn, step, message: activity.result }, { surfaceOp: 'append' })
                break
              }
              default:
                // web_search, todo_list, and non-fatal error items carry no
                // model-visible transcript content for the durable log.
                break
            }
            break
          }
          case 'turn.completed': {
            const usage = mapUsage(event.usage)
            // Turn usage attaches to the step's final durable message: the
            // trailing reasoning-only message when thinking closed the turn,
            // otherwise the last held agent message.
            if (pendingReasoning.length > 0) flushReasoning(usage)
            else flushHeld(usage)
            finished = true
            break
          }
          case 'turn.failed':
            flushReasoning()
            flushHeld()
            throw new LlmError(event.error.message, 'CODEX_TURN_FAILED')
          case 'error':
            flushReasoning()
            flushHeld()
            throw new LlmError(event.message, 'CODEX_ERROR')
          default:
            // thread.started / turn.started / item.updated are transport
            // progress; the durable log records only the model-visible
            // transcript (there are no incremental deltas to forward).
            break
        }
      }
      flushReasoning()
      flushHeld()
      if (!finished) {
        throw new LlmError(
          `agent "${this.id}": codex query ended without a completed turn`,
          'CODEX_NO_RESULT',
        )
      }
      return { kind: 'completed' }
    } finally {
      signal.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
}
/* jscpd:ignore-end */
