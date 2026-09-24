/**
 * Codex loop Agent: drives one session through turn and step boundaries by
 * spawning a `codex app-server` child process and speaking JSON-RPC over stdio.
 * Codex owns its prompt, tools, and sandbox; the durable session log remains
 * the source of truth and the thread input is a pure serialization of it.
 * The app-server streams token-level deltas via `item/agentMessage/delta` and
 * `item/reasoning/summaryTextDelta`, so the visible partial paints
 * progressively as the model generates — not all at once at the end. Native
 * approval requests (the `item/…/requestApproval` family) are server-initiated
 * requests, not notifications: the client answers them through the dsh approval
 * seam (`agent/requestPermission` → `ctx.approval`), while the thread still
 * starts with a declarative `sandboxMode`/`approvalPolicy` stance.
 *
 * @module dsh-loop-engine/engine-codex/agent
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
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { LlmError, ToolCallId, createAssistantMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { HOSTED_DEFAULT_MODEL, HOSTED_ROUTE_LABEL } from '../agent-preset-ids.ts'
import type { ResolvedConfig } from './types.ts'
import { serializeHistory } from '../driver-core/prompt.ts'
import { DriverInbox } from '../driver-core/inbox.ts'
import { sessionModelOverrideOf } from '../driver-core/session-model.ts'
import { resolveModelHandover, type DshModelHandover } from '../driver-core/model-handover.ts'
import { codexModelConfig } from './model-handover.ts'
import { DriverAssistantStream } from '../driver-core/assistant-stream.ts'
import { normalizeHostedToolCall } from '../driver-core/hosted-tool-vocabulary.ts'
import {
  approvalReason,
  approvalToolName,
  elicitationResponse,
  resolveApprovalRequest,
  resolveSessionPermission,
  userInputQuestions,
  userInputResponse,
  type ApprovalOutcome,
  type CodexPermission,
  type UserQuestionAnswer,
  type UserQuestionItem,
} from './permission.ts'
import { AppServerClient, type RequestOutcome } from './appserver/client.ts'
import { AppServerThread } from './appserver/thread.ts'
import { mapCommandExecution, mapFileChange, mapMcpToolCall, mapUsage } from './appserver/mapping.ts'
import type { ThreadStartParams, TurnInput } from './appserver/types.ts'
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
 * Model label logged when the deployment pins no model: Codex owns its model
 * natively, so the web session's model selection is deliberately not mirrored
 * into the header — it reaches the engine separately, as the `model` the driver
 * resolves each step (`sessionModelOverrideOf`). It is
 * {@link HOSTED_DEFAULT_MODEL} — the one entry this engine's provider route
 * advertises (`provider-route.ts`) — so the session's `(provider, model)`
 * resolves to that entry and the model seat renders "default" instead of a
 * composite string naming a model no adapter serves.
 */

/** Minimal shape of the approval service (inline to avoid a peer dep on @deepseek-ai/dsh-user-approval). */
interface ApprovalService {
  request(req: { agent: Agent; toolName: string; reason?: string; signal?: AbortSignal }): Promise<ApprovalOutcome>
}

/** Minimal shape of the user-questions seam (inline to avoid a peer dep on @deepseek-ai/dsh-user-questions). */
interface UserQuestionsService {
  ask(req: { questions: UserQuestionItem[]; agent: Agent; signal?: AbortSignal }): Promise<UserQuestionAnswer>
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

/** An assistant message held until the step knows whether turn usage attaches to it. */
interface HeldMessage {
  readonly content: ContentBlock[]
  /** The exact timed chunks this message's own content streamed. */
  readonly stream: AssistantStreamRecord[]
}

/** First of the given arrays that actually carries text, joined; undefined when none does. */
function nonEmptyText(parts: readonly string[] | undefined): string | undefined {
  return parts !== undefined && parts.some(part => part.length > 0) ? parts.join('\n') : undefined
}

/** Drives one session through turn and step boundaries on Codex. */
export class CodexAgent implements Agent {
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
  }

  /** Lazily created app-server client, reused across steps and released on scope teardown. */
  private appServer: AppServerClient | undefined
  /**
   * The spawn configuration (`argv` + `env`) the cached client was built from.
   * Codex's endpoint lives in the child's own command line, so a handover change
   * must respawn the child rather than reuse one configured for another endpoint.
   */
  private appServerConfig: string | undefined

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly config: ResolvedConfig,
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
    // Release the shared app-server client when the agent scope is unwound.
    this.scope.ctx.effect(() => () => {
      this.appServer?.dispose()
      this.appServer = undefined
    }, 'codex.appServerClient()')
  }

  /**
   * Return the cached app-server client, spawning one on first use, after a dead
   * process, or when the resolved dsh endpoint changed since the last spawn.
   *
   * A handover is codex's own `-c` configuration for a dsh provider, so a
   * different endpoint (different provider, base URL, protocol, or credential)
   * needs a different child — the config is fixed when the process starts.
   * @param handover - the session's resolved dsh endpoint, or undefined to leave codex to its own configuration.
   */
  private async appServerClient(handover: DshModelHandover | undefined): Promise<AppServerClient> {
    const modeled = handover === undefined ? { argv: [], env: {} } : codexModelConfig(handover)
    const config = JSON.stringify(modeled)
    if (this.appServer !== undefined && !this.appServer.closed && this.appServerConfig === config) {
      return this.appServer
    }
    this.appServer?.dispose()
    this.appServer = await AppServerClient.create(modeled.argv, { ...this.config.env, ...modeled.env })
    this.appServerConfig = config
    // Answer server-initiated requests (Codex approvals under an `ask` policy,
    // user-input questions, MCP elicitations) through their dsh seams; a request
    // with no answer stalls the turn.
    this.appServer.onRequest((method, params) => this.answerRequest(method, params))
    return this.appServer
  }

  /**
   * Answer one server-initiated interaction. Approvals go through the dsh
   * approval seam; a `request_user_input` question goes to the user-questions
   * seam (both fail closed when their seam is absent), and an MCP elicitation is
   * declined outright. Anything else is a protocol error.
   * @param method - the server request method.
   * @param params - the server request params.
   * @returns the JSON-RPC outcome to send back.
   */
  private async answerRequest(method: string, params: unknown): Promise<RequestOutcome> {
    if (method === 'item/tool/requestUserInput') return this.answerUserInput(params)
    if (method === 'mcpServer/elicitation/request') return { result: elicitationResponse() }
    return this.answerApproval(method, params)
  }

  /** Resolve one native Codex approval request through the dsh approval seam. */
  private async answerApproval(method: string, params: unknown): Promise<RequestOutcome> {
    const outcome = await this.requestApproval(method, params)
    return resolveApprovalRequest(method, params, outcome)
  }

  /**
   * Put one `request_user_input` question to the human through the dsh
   * user-questions seam. The seam itself fails closed (`NO_PROVIDER`) when no
   * answerer is composed, so a refusal degrades to "no answers given" and the
   * turn continues; asking is never silently skipped, and the degradation is
   * logged rather than swallowed.
   * @param params - the request params carrying the questions.
   * @returns the response payload (or the empty answer when nobody answered).
   */
  private async answerUserInput(params: unknown): Promise<RequestOutcome> {
    const questions = userInputQuestions(params)
    const service = this.loopCtx.get('userQuestions') as UserQuestionsService | undefined
    if (questions.length === 0) {
      return { result: userInputResponse(undefined) }
    }
    if (service === undefined) {
      this.loopCtx.logger.warn('loop-engine: codex asked for user input, but the user-questions service is not composed; answering with no answers')
      return { result: userInputResponse(undefined) }
    }
    const phase = this.phase
    const signal = phase.kind === 'running' ? phase.abort.signal : undefined
    try {
      const answer = await service.ask({
        questions,
        agent: this,
        ...(signal === undefined ? {} : { signal }),
      })
      return { result: userInputResponse(answer) }
    } catch (error: unknown) {
      this.loopCtx.logger.warn(`loop-engine: codex user-input request went unanswered: ${String(error)}`)
      return { result: userInputResponse(undefined) }
    }
  }

  /** Ask the dsh approval seam; fail closed to a denial when it is absent. */
  private async requestApproval(method: string, params: unknown): Promise<ApprovalOutcome> {
    const approval = this.loopCtx.get('approval') as ApprovalService | undefined
    if (approval === undefined) return 'unavailable'
    const phase = this.phase
    const signal = phase.kind === 'running' ? phase.abort.signal : undefined
    return approval.request({
      agent: this,
      toolName: approvalToolName(method),
      reason: approvalReason(method, params),
      ...(signal === undefined ? {} : { signal }),
    })
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
    const fold = resolveSessionPermission(this.session.snapshotEvents())
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
          // The driver rotates steps as the turn's segments complete, so
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

  /** Run one Codex thread for the current step and map its transcript into the session log. */
  private async step(): Promise<StepEndReason | null> {
    /* v8 ignore start -- private callers establish the running phase before executing a step */
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)    /* v8 ignore stop */
    const phase = this.phase
    const { abort: { signal } } = phase
    signal.throwIfAborted()
    this.stepSettledTools = 0

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
    /**
     * The live attempt for the current streamed segment. Chunks open one; the
     * durable assistant message they built settles it and the next chunk
     * opens a fresh attempt, so every message carries exactly its own stream.
     */
    let live: DriverAssistantStream | undefined
    try {
      const permission = this.queryPermission()
      // The session's model selection, and — when dsh discloses it — that
      // model's endpoint, protocol, and credential, resolved fresh on every step
      // so a mid-session change reaches the next thread (and a changed endpoint
      // respawns the app-server).
      const override = sessionModelOverrideOf(this.loopCtx, this.session)
      const handover = await resolveModelHandover(this.loopCtx, override)
      const client = await this.appServerClient(handover)
      // The session's own pick wins over the deployment's pin, read every step
      // so a model changed mid-conversation reaches the next thread. Codex takes
      // a bare model slug, so only the model half of the override travels; the
      // provider is a dsh routing fact it does not speak.
      const model = override?.model ?? this.config.model
      const threadParams: ThreadStartParams = {
          cwd,
          sandbox: permission.sandboxMode,
          approvalPolicy: permission.approvalPolicy,
          ...model === undefined ? {} : { model },
        }
        const thread = await AppServerThread.create(client, threadParams)
        const input: TurnInput[] = [{ type: 'text', text: prompt }]
        const events = thread.turn(input, {
          signal: controller.signal,
          params: {
            approvalPolicy: permission.approvalPolicy,
            ...model === undefined ? {} : { model },
          },
        })

        let finished = false
        /** Reasoning texts accumulated since the last flush, folded into the next agent message or flushed as a trailing reasoning message. */
        const pendingReasoning: string[] = []
        /** The exact timed chunks the pending reasoning streamed, carried by whichever message folds them in. */
        const pendingReasoningStream: AssistantStreamRecord[] = []
        /**
         * Reasoning text seen streaming, keyed by item id. The terminal item's
         * `summary`/`content` arrays are authoritative, but either can arrive
         * empty; this keeps the thinking the user already watched from being
         * logged as nothing.
         */
        const streamedReasoning = new Map<string, string>()
        /** The assistant message being assembled; its chunks stream live as items complete. */
        let held: HeldMessage | undefined
        /** Whether a reasoning block has been started (block-start emitted). */
        let reasoningBlockStarted = false
        /** Whether a text block has been started (block-start emitted). */
        let textBlockStarted = false
        /** Block index for the current text block. */
        let textBlockIndex = 0

        /** Open the live attempt on first use, publishing its opening frame before any chunk. */
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

        /** Fold accumulated reasoning into the open message (synthesizing one when none is open). */
        const foldReasoning = (): void => {
          if (pendingReasoning.length === 0) return
          const reasoningBlocks = pendingReasoning.map(text => ({ type: 'reasoning' as const, text }))
          held = held === undefined
            ? { content: reasoningBlocks, stream: [...pendingReasoningStream] }
            : { ...held, content: [...held.content, ...reasoningBlocks], stream: [...held.stream, ...pendingReasoningStream] }
          pendingReasoning.length = 0
          pendingReasoningStream.length = 0
          reasoningBlockStarted = false
        }

        /** Append the held assistant message, optionally carrying the turn's usage. */
        const flushHeld = (usage?: TokenUsage): void => {
          // Trailing reasoning that no agent message claimed folds into this
          // message instead of being dropped or split into a bare follow-up.
          foldReasoning()
          if (held === undefined) return
          const attempt = live
          const data = {
            turn: phase.turn,
            step: phase.step,
            message: createAssistantMessage({
              content: held.content,
              source: { provider: PROVIDER, model: this.modelLabel() },
            }),
            ...usage === undefined ? {} : { usage },
            // Exactly the chunks this message's own content streamed.
            stream: held.stream,
          }
          if (attempt === undefined) {
            this.session.append('assistant/message', data, { surfaceOp: 'append' })
          } else {
            attempt.settle(() => this.session.append('assistant/message', data, { surfaceOp: 'append' }).seq)
            live = undefined
          }
          held = undefined
        }

        /**
         * Fold one completed tool call into the open assistant message, so the
         * message that requested it carries its `tool-call` block. Any trailing
         * reasoning that no agent message claimed is folded first, so the
         * tool-call block joins that same message instead of a bare follow-up.
         * @param call - the call's identity and JSON arguments string.
         */
        const foldToolCall = (call: { callId: ToolCallId; name: string; arguments: string }): void => {
          foldReasoning()
          const block: ContentBlock = { type: 'tool-call', id: call.callId, name: call.name, arguments: call.arguments }
          held = held === undefined
            ? { content: [block], stream: [] }
            : { ...held, content: [...held.content, block] }
        }

        signal.throwIfAborted()
        for await (const event of events) {
          signal.throwIfAborted()
          switch (event.kind) {
            case 'turn-started':
              break
            case 'item-started': {
              // item-started carries the item type; block-start is emitted on the first delta.
              if (event.itemType === 'agentMessage') {
                textBlockStarted = false
                // The text block opens after every block already folded into the
                // held message plus the reasoning items completed since — the
                // position the merge at `item-completed` will give it.
                textBlockIndex = (held?.content.length ?? 0) + pendingReasoning.length
              }
              break
            }
            case 'agent-delta': {
              // Token-level streaming of the agent's reply — live.
              if (!textBlockStarted) {
                textBlockStarted = true
                currentStream().push({ type: 'block-start', index: textBlockIndex, blockType: 'text' })
              }
              currentStream().push({ type: 'text-delta', index: textBlockIndex, text: event.delta })
              break
            }
            case 'reasoning-summary-delta':
            case 'reasoning-text-delta':
            case 'plan-delta': {
              // Reasoning streams before its item completes, so the step has to
              // rotate here — otherwise live reasoning frames would paint into
              // the finished step and only the durable message would move.
              this.beginSegment(phase)
              // Token-level streaming of the model's thinking — live. The block
              // index is its position in the held message: every block already
              // folded in, plus the reasoning items completed before this one.
              const index = (held?.content.length ?? 0) + pendingReasoning.length
              if (!reasoningBlockStarted) {
                reasoningBlockStarted = true
                currentStream().push({ type: 'block-start', index, blockType: 'reasoning' })
              }
              currentStream().push({ type: 'reasoning-delta', index, text: event.delta })
              // A plan's text is not reasoning, so it is excluded from the durable
              // fallback below even though it paints through the same block.
              if (event.kind !== 'plan-delta') {
                streamedReasoning.set(event.itemId, (streamedReasoning.get(event.itemId) ?? '') + event.delta)
              }
              break
            }
            case 'item-completed': {
              const item = event.item
              if (item.type === 'reasoning') {
                // Reasoning item completed — accumulate for the fold. The item
                // always carries an id, and both terminal arrays are always
                // present though either may be empty, so take the first one that
                // carries text; when neither does, fall back to what streamed, so
                // the durable thinking cannot be emptier than what the user
                // already watched.
                const terminal = item as { id: string; summary?: string[]; content?: string[] }
                const text = nonEmptyText(terminal.summary)
                  ?? nonEmptyText(terminal.content)
                  ?? streamedReasoning.get(terminal.id)
                  ?? ''
                streamedReasoning.delete(terminal.id)
                pendingReasoning.push(text)
                // Cut the chunks this reasoning streamed: they belong to the
                // message that folds them in, not to the one before it.
                pendingReasoningStream.push(...(live?.takeStream() ?? []))
                reasoningBlockStarted = false
              } else if (item.type === 'plan') {
                // A plan item streams through the reasoning block but carries no
                // durable content block of its own. Cut its chunks at the item
                // boundary — the segment has no message to belong to — so no
                // later message embeds chunks that are not its own, and close the
                // block framing its deltas opened.
                live?.takeStream()
                reasoningBlockStarted = false
              } else if (item.type === 'agentMessage') {
                // A completed agent message that follows settled tool work is
                // the next segment; a plan/reasoning-only item is not.
                this.beginSegment(phase)
                // Agent message completed — fold reasoning + text into one message.
                // Cut before flushing: a committed earlier message ends the
                // attempt, and the cut must observe the live one.
                const textStream = live?.takeStream() ?? []
                const reasoningBlocks = pendingReasoning.map(text => ({ type: 'reasoning' as const, text }))
                const textBlock: ContentBlock = { type: 'text', text: item.text ?? '' }
                // Consecutive agent messages in one segment (no tool result
                // settled) merge into the SAME message; a message that follows
                // settled tool work begins a fresh one (the tool item already
                // flushed `held`, and `beginSegment` above rotated the step).
                if (held === undefined) {
                  held = { content: [...reasoningBlocks, textBlock], stream: [...pendingReasoningStream, ...textStream] }
                } else {
                  held = {
                    ...held,
                    content: [...held.content, ...reasoningBlocks, textBlock],
                    stream: [...held.stream, ...pendingReasoningStream, ...textStream],
                  }
                }
                pendingReasoning.length = 0
                pendingReasoningStream.length = 0
                reasoningBlockStarted = false
                textBlockStarted = false
              } else if (item.type === 'commandExecution') {
                // A tool that follows a settled tool in this step is the next
                // segment, so rotate first — each tool's assistant message lands
                // in its own step, matching the in-process one-message-per-step
                // shape.
                this.beginSegment(phase)
                const activity = mapCommandExecution(item as { id: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string })
                foldToolCall(activity.call)
                flushHeld()
                const normalizedCall = normalizeHostedToolCall('codex', activity.call.name, activity.call.arguments)
                this.session.append('tool/call', {
                  turn: phase.turn, step: phase.step, callId: activity.call.callId, name: normalizedCall.name, arguments: normalizedCall.arguments,
                })
                this.session.append('tool/result', { turn: phase.turn, step: phase.step, message: activity.result }, { surfaceOp: 'append' })
                this.stepSettledTools += 1
              } else if (item.type === 'fileChange') {
                this.beginSegment(phase)
                const activity = mapFileChange(item as { id: string; changes?: unknown[]; status?: string })
                foldToolCall(activity.call)
                flushHeld()
                const normalizedCall = normalizeHostedToolCall('codex', activity.call.name, activity.call.arguments)
                this.session.append('tool/call', {
                  turn: phase.turn, step: phase.step, callId: activity.call.callId, name: normalizedCall.name, arguments: normalizedCall.arguments,
                })
                this.session.append('tool/result', { turn: phase.turn, step: phase.step, message: activity.result }, { surfaceOp: 'append' })
                this.stepSettledTools += 1
              } else if (item.type === 'mcpToolCall') {
                this.beginSegment(phase)
                const activity = mapMcpToolCall(item as { id: string; server?: string; tool?: string; arguments?: unknown; result?: { content?: unknown[] }; error?: { message?: string } })
                foldToolCall(activity.call)
                flushHeld()
                const normalizedCall = normalizeHostedToolCall('codex', activity.call.name, activity.call.arguments)
                this.session.append('tool/call', {
                  turn: phase.turn, step: phase.step, callId: activity.call.callId, name: normalizedCall.name, arguments: normalizedCall.arguments,
                })
                this.session.append('tool/result', { turn: phase.turn, step: phase.step, message: activity.result }, { surfaceOp: 'append' })
                this.stepSettledTools += 1
              }
              break
            }
            case 'turn-completed': {
              const usage = event.turn.usage
                ? mapUsage(event.turn.usage)
                : undefined
              // Turn usage attaches to the step's final durable message, which
              // folds in any trailing reasoning (flushHeld does that folding).
              flushHeld(usage)
              finished = true
              break
            }
            case 'error':
              flushHeld()
              throw new LlmError(event.error.message, 'CODEX_ERROR')
            /* v8 ignore next -- AppServerEvent is a closed union; no unknown kinds */
            default:
              break
          }
        }
        flushHeld()
        if (!finished) {
          throw new LlmError(
            `agent "${this.id}": codex query ended without a completed turn`,
            'CODEX_NO_RESULT',
          )
        }
        return { kind: 'completed' }
    } finally {
      // A segment that streamed without committing a durable message closes its
      // live frames, so the client stops painting an abandoned partial.
      if (live !== undefined && !live.ended) live.abandon()
      signal.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
}
/* jscpd:ignore-end */
