/**
 * Codex loop Agent: drives one session through turn and step boundaries by
 * spawning a `codex app-server` child process and speaking JSON-RPC over stdio.
 * Codex owns its prompt, tools, and sandbox; the durable session log remains
 * the source of truth and the thread input is a pure serialization of it.
 * The app-server streams token-level deltas via `item/agentMessage/delta` and
 * `item/reasoning/summaryTextDelta`, so the visible partial paints
 * progressively as the model generates — not all at once at the end. It offers
 * no interactive approval callback, so permissions are folded declaratively
 * into each thread's `sandboxMode`/`approvalPolicy`.
 *
 * @module dsh-loop-engine/engine-codex/agent
 */
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent';
import { LlmError, createAssistantMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import { canonicalHeader } from '@deepseek-ai/dsh-session';
import { serializeHistory } from "../driver-core/prompt.js";
import { resolveSessionPermission } from "./permission.js";
import { AppServerClient } from "./appserver/client.js";
import { AppServerThread } from "./appserver/thread.js";
import { mapCommandExecution, mapFileChange, mapMcpToolCall, mapUsage } from "./appserver/mapping.js";
import { invokedSkillNames, isSkillName, renderSkillContent, } from "../driver-core/skill-inject.js";
/** Provider route label used for logged header snapshots and message provenance. */
const PROVIDER = 'codex';
/**
 * Model label logged when the deployment pins no model: Codex owns its model
 * natively, so the web session's advisory model selection is deliberately not
 * mirrored into the header (it never drives a query).
 */
const NATIVE_MODEL_LABEL = 'codex-native';
/** Drives one session through turn and step boundaries on Codex. */
export class CodexAgent {
    loopCtx;
    id;
    options;
    session;
    config;
    inbox;
    phase;
    activityDone = Promise.resolve();
    /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
    scope;
    ctx;
    /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
    dispatch;
    /** Whether this loop instance has appended its initial/resume request anchor. */
    requestHeaderLogged = false;
    /** Lazily created app-server client, reused across steps and released on scope teardown. */
    appServer;
    constructor(loopCtx, id, options, session, config) {
        this.loopCtx = loopCtx;
        this.id = id;
        this.options = options;
        this.session = session;
        this.config = config;
        this.dispatch = agentEvents(loopCtx, this);
        this.inbox = new Inbox(session, {
            inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }); },
            discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }); },
            claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }); },
        });
        const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0;
        this.phase = { kind: 'idle', lastTurn };
        this.scope = createScope(loopCtx, this);
        this.ctx = this.scope.ctx.extend({ agent: this });
        // Release the shared app-server client when the agent scope is unwound.
        this.scope.ctx.effect(() => () => {
            this.appServer?.dispose();
            this.appServer = undefined;
        }, 'codex.appServerClient()');
    }
    /** Return the cached app-server client, spawning one on first use or after a dead process. */
    async appServerClient() {
        if (this.appServer !== undefined && !this.appServer.closed)
            return this.appServer;
        this.appServer = await AppServerClient.create();
        return this.appServer;
    }
    get status() {
        return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running';
    }
    /** Commit a phase and publish its externally visible status transition. */
    setPhase(next) {
        const previousStatus = this.status;
        this.phase = next;
        const status = this.status;
        if (status !== previousStatus) {
            this.dispatch.emit('agent/status', { status });
        }
    }
    send(message, target, wakeup) {
        const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted;
        const resolvedTarget = wakingAfterAbort ? 'next-turn' : target;
        this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
        if (wakeup)
            this.wakeDriver(wakingAfterAbort);
    }
    /**
     * Queue a message for the next turn and wake the driver.
     * @param input - the user message to deliver.
     */
    followup(input) {
        this.send(input, 'next-turn', true);
    }
    /**
     * Queue a message for the running step and wake the driver.
     * @param input - the user message to deliver.
     */
    steer(input) {
        this.send(input, 'next-step', true);
    }
    /**
     * Queue a message for the running step without waking the driver.
     * @param input - the user message to deliver.
     */
    inject(input) {
        this.send(input, 'next-step', false);
    }
    cancel(cause, options = {}) {
        if (!options.keepInbox) {
            this.inbox.clear();
            if (this.phase.kind !== 'idle')
                this.phase.wakeRequested = false;
        }
        if (this.phase.kind !== 'idle')
            this.phase.abort.abort(cause);
    }
    /**
     * Run a maintenance job while the agent is idle.
     * @param job - the maintenance operation, receiving the phase abort signal.
     * @returns the maintenance result.
     */
    runMaintenance(job) {
        if (this.phase.kind !== 'idle')
            throw new Error(`agent "${this.id}" already has active work`);
        const done = Promise.withResolvers();
        const maintenance = {
            kind: 'maintenance',
            abort: new AbortController(),
            lastTurn: this.phase.lastTurn,
            wakeRequested: false,
        };
        this.setPhase(maintenance);
        this.activityDone = done.promise;
        return (async () => {
            try {
                return await job(maintenance.abort.signal);
            }
            finally {
                this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn });
                if (maintenance.wakeRequested && this.inbox.hasPending)
                    this.wakeDriver();
                done.resolve();
            }
        })();
    }
    /**
     * Start one driver, or latch its wake behind maintenance or an aborted
     * activity. A wake sent while idle always opens its turn boundary, even
     * when its message was cleared; only a latched replay is suppressed when
     * the queue no longer holds the wake.
     * @param wakeAfterAbort - the {@link send} classification, captured before
     *   the inbox insertion so a reentrant cancel cannot reclassify it.
     */
    wakeDriver(wakeAfterAbort = false) {
        if (this.phase.kind !== 'idle') {
            const reason = this.phase.abort.signal.reason;
            if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
                this.phase.wakeRequested = true;
            }
            return;
        }
        const driver = Promise.withResolvers();
        this.activityDone = driver.promise;
        this.setPhase({
            kind: 'running',
            abort: new AbortController(),
            turn: this.phase.lastTurn,
            step: 0,
            wakeRequested: false,
        });
        this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
    }
    async whenIdle() {
        let activity;
        do {
            await (activity = this.activityDone);
        } while (activity !== this.activityDone);
    }
    /** Report one failure at its live boundary, then preserve it for driver containment. */
    throwError(error) {
        const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn;
        const step = this.phase.kind === 'running' ? this.phase.step : 0;
        this.dispatch.emit('agent/error', { turn, step, error });
        throw error;
    }
    async kick() {
        try {
            while (await this.turn()) { }
        }
        catch (_error) {
            // Reported failures and cancellation are contained at the driver boundary.
        }
        finally {
            /* v8 ignore start -- kick owns a running phase until this driver boundary */
            /* v8 ignore next -- kick owns a running phase until this driver boundary */
            if (this.phase.kind === 'running') {
                const { turn, wakeRequested } = this.phase;
                this.setPhase({ kind: 'idle', lastTurn: turn });
                if (wakeRequested && this.inbox.hasPending)
                    this.wakeDriver();
            } /* v8 ignore stop */
        }
    }
    async preStep(target, position) {
        /* v8 ignore start -- private callers establish the running phase before proposing a step */
        /* v8 ignore next -- private callers establish the running phase before proposing a step */
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": pre-step outside running phase`); /* v8 ignore stop */
        const signal = this.phase.abort.signal;
        const claimed = this.inbox.claim(target, position.turn);
        const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, ...position, signal }, () => Promise.resolve({ kind: 'enter', messages: claimed }));
        signal.throwIfAborted();
        if (decision.kind === 'reject')
            return decision;
        // Inject skill content for user-invoked skills.  The dsh-tool-skill
        // handler that normally does this lives on the agent-preset context
        // chain, which the Codex agent's context does not descend from, so we
        // replicate the gesture-scan and injection here.
        const injected = await this.injectSkills(decision.messages, signal);
        signal.throwIfAborted();
        return injected !== decision.messages
            ? { kind: 'enter', messages: [...injected] }
            : { ...decision };
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
    async injectSkills(messages, signal) {
        const names = invokedSkillNames(messages);
        if (names.length === 0)
            return messages;
        const skills = this.loopCtx.get('skills');
        if (skills === undefined)
            return messages;
        const cwd = this.session.header.cwd;
        const injections = [];
        for (const name of names) {
            /* v8 ignore start -- SKILL_GESTURE only captures kebab-case names, so this guard never fires */
            /* v8 ignore next -- SKILL_GESTURE only captures kebab-case names, so this guard never fires */
            if (!isSkillName(name))
                continue;
            /* v8 ignore stop */
            let skill;
            try {
                skill = await skills.get(name, { signal, scope: this, ...(cwd === undefined ? {} : { cwd }) });
            }
            catch {
                continue; // load failure → silently skip
            }
            if (skill === undefined || !skill.invocation.userInvocable)
                continue;
            if (signal.aborted)
                return messages;
            injections.push(createUserMessage({
                content: [{ type: 'text', text: renderSkillContent(skill) }],
                source: { kind: 'skill-invocation', name, form: 'instructions' },
            }));
        }
        return injections.length > 0 ? [...messages, ...injections] : messages;
    }
    /**
     * Resolve the declarative permission stance for one query. Deployment-pinned
     * fields win per field; anything unpinned follows the session's durable dsh
     * permission knobs, re-folded per query so mid-session preset switches take
     * effect on the next step.
     * @returns the permission fields of the query spec.
     */
    queryPermission() {
        const fold = resolveSessionPermission(this.session.events);
        return {
            sandboxMode: this.config.sandboxMode ?? fold.sandboxMode,
            approvalPolicy: this.config.approvalPolicy ?? fold.approvalPolicy,
        };
    }
    /** Open one turn before claiming its first proposed step. */
    async turn() {
        if (this.phase.kind !== 'running') {
            this.throwError(new Error(`agent "${this.id}": turn without driver reservation`));
        }
        const phase = this.phase;
        const { signal } = phase.abort;
        signal.throwIfAborted();
        const turn = phase.turn + 1;
        try {
            this.session.append('turn/start', { turn });
        }
        catch (error) {
            this.throwError(error);
        }
        phase.turn = turn;
        let turnEnds = null;
        let target = 'next-turn';
        try {
            while (true) {
                signal.throwIfAborted();
                const step = phase.step + 1;
                const decision = await this.preStep(target, { turn, step });
                if (decision.kind === 'reject') {
                    turnEnds = { kind: 'blocked' };
                    return false;
                }
                if (turnEnds && decision.messages.length === 0)
                    break;
                if (phase.step === 0 && decision.messages.length === 0) {
                    turnEnds = { kind: 'completed' };
                    return false;
                }
                signal.throwIfAborted();
                this.session.append('step/start', { turn, step });
                phase.step = step;
                try {
                    for (const message of decision.messages) {
                        this.session.append('user/message', message, { surfaceOp: 'append' });
                    }
                    const stepEnd = await this.step();
                    if (turnEnds === null)
                        turnEnds = stepEnd;
                }
                finally {
                    this.session.append('step/end', { turn, step });
                }
                signal.throwIfAborted();
                if (turnEnds && this.inbox.nextStep.length === 0) {
                    await this.dispatch.serial('agent/turn-stopping', { turn, signal });
                    signal.throwIfAborted();
                }
                if (turnEnds && this.inbox.nextStep.length === 0)
                    break;
                target = 'next-step';
            }
        }
        catch (error) {
            if (signal.aborted) {
                turnEnds = { kind: 'aborted', reason: signal.reason };
                throw error;
            }
            turnEnds = {
                kind: 'error',
                error: error instanceof LlmError
                    ? error.failure
                    : { message: errorChain(error), code: 'UNKNOWN' },
            };
            this.throwError(error);
        }
        finally {
            try {
                // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
                this.session.append('turn/end', { turn, reason: turnEnds });
            }
            catch (error) {
                this.throwError(error);
            }
        }
        if (!this.inbox.hasPending)
            return false;
        phase.abort = new AbortController();
        phase.wakeRequested = false;
        phase.step = 0;
        return true;
    }
    /** Model label recorded in the request header for one lifecycle. */
    modelLabel() {
        return this.config.model ?? NATIVE_MODEL_LABEL;
    }
    /** Append the request header snapshot once per loop instance. */
    assertRequestHeader() {
        if (this.requestHeaderLogged)
            return;
        const header = canonicalHeader({
            config: { provider: PROVIDER, model: this.modelLabel() },
        });
        const baseline = this.session.requestHeader();
        this.session.append('request/header', {
            header,
            reason: baseline === undefined ? 'initial' : 'resume',
        });
        this.requestHeaderLogged = true;
    }
    /** Run one Codex thread for the current step and map its transcript into the session log. */
    async step() {
        /* v8 ignore start -- private callers establish the running phase before executing a step */
        /* v8 ignore next -- private callers establish the running phase before executing a step */
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": step outside running phase`); /* v8 ignore stop */
        const { turn, step, abort: { signal } } = this.phase;
        signal.throwIfAborted();
        const cwd = this.session.header.cwd;
        if (cwd === undefined || cwd.length === 0) {
            throw new Error(`agent "${this.id}": no working directory — start the session with cwd metadata`);
        }
        const history = this.session.deriveMessages();
        const prompt = serializeHistory(history);
        /* v8 ignore start -- a step only runs after claiming and durably appending at least one user message */
        if (prompt.length === 0) {
            throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`);
        }
        /* v8 ignore stop */
        this.assertRequestHeader();
        signal.throwIfAborted();
        const controller = new AbortController();
        const cancel = () => {
            /* v8 ignore start -- a phase signal fires once; the controller cannot already be aborted when its single listener runs */
            /* v8 ignore next -- a phase signal fires once; the controller cannot already be aborted when its single listener runs */
            if (!controller.signal.aborted) {
                /* v8 ignore next -- the phase signal aborts with AgentCancelCause values only, which the durable log can record */
                controller.abort(signal.reason instanceof Error ? signal.reason : new Error(`agent "${this.id}" query aborted`));
            } /* v8 ignore stop */
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
            const permission = this.queryPermission();
            const client = await this.appServerClient();
            const threadParams = {
                cwd,
                sandbox: permission.sandboxMode,
                approvalPolicy: permission.approvalPolicy,
                ...this.config.model === undefined ? {} : { model: this.config.model },
            };
            const thread = await AppServerThread.create(client, threadParams);
            const input = [{ type: 'text', text: prompt }];
            const events = thread.turn(input, {
                signal: controller.signal,
                params: {
                    approvalPolicy: permission.approvalPolicy,
                    ...this.config.model === undefined ? {} : { model: this.config.model },
                },
            });
            let finished = false;
            /** Reasoning texts accumulated since the last flush, folded into the next agent message or flushed as a trailing reasoning message. */
            const pendingReasoning = [];
            /** Seq refs of reasoning chunks already streamed for {@link pendingReasoning}. */
            const pendingReasoningSeqs = [];
            /** Seq refs of text chunks already streamed for the current agent message. */
            const textSeqs = [];
            /** The assistant message being assembled; its chunks stream live as items complete. */
            let held;
            /** Whether a reasoning block has been started (block-start emitted). */
            let reasoningBlockStarted = false;
            /** Whether a text block has been started (block-start emitted). */
            let textBlockStarted = false;
            /** Block index for the current text block. */
            let textBlockIndex = 0;
            /** Emit one live partial chunk and return its durable seq. */
            const emitChunk = (chunk) => this.session.append('assistant/chunk', { turn, step, chunk }).seq;
            /** Append the held assistant message, optionally carrying the turn's usage. */
            const flushHeld = (usage) => {
                if (held === undefined)
                    return;
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
                });
                held = undefined;
            };
            /** Flush accumulated reasoning as its own durable message; an agent message folds it instead. */
            const flushReasoning = (usage) => {
                if (pendingReasoning.length === 0)
                    return;
                flushHeld();
                held = {
                    content: pendingReasoning.map(text => ({ type: 'reasoning', text })),
                    refs: [...pendingReasoningSeqs],
                };
                pendingReasoning.length = 0;
                pendingReasoningSeqs.length = 0;
                flushHeld(usage);
            };
            signal.throwIfAborted();
            for await (const event of events) {
                signal.throwIfAborted();
                switch (event.kind) {
                    case 'turn-started':
                        break;
                    case 'item-started': {
                        // item-started carries the item type; block-start is emitted on the first delta.
                        if (event.itemType === 'agentMessage') {
                            textBlockStarted = false;
                            textBlockIndex = pendingReasoning.length;
                        }
                        break;
                    }
                    case 'agent-delta': {
                        // Token-level streaming of the agent's reply — live.
                        if (!textBlockStarted) {
                            textBlockStarted = true;
                            textSeqs.push(emitChunk({ type: 'block-start', index: textBlockIndex, blockType: 'text' }));
                        }
                        textSeqs.push(emitChunk({ type: 'text-delta', index: textBlockIndex, text: event.delta }));
                        break;
                    }
                    case 'reasoning-summary-delta':
                    case 'reasoning-text-delta':
                    case 'plan-delta': {
                        // Token-level streaming of the model's thinking — live.
                        const index = pendingReasoning.length;
                        if (!reasoningBlockStarted) {
                            reasoningBlockStarted = true;
                            pendingReasoningSeqs.push(emitChunk({ type: 'block-start', index, blockType: 'reasoning' }));
                        }
                        pendingReasoningSeqs.push(emitChunk({ type: 'reasoning-delta', index, text: event.delta }));
                        break;
                    }
                    case 'item-completed': {
                        const item = event.item;
                        if (item.type === 'reasoning') {
                            // Reasoning item completed — accumulate for the fold.
                            const summary = item.summary;
                            const content = item.content;
                            const text = summary?.join('\n') ?? content?.join('\n') ?? '';
                            pendingReasoning.push(text);
                            reasoningBlockStarted = false;
                        }
                        else if (item.type === 'agentMessage') {
                            // Agent message completed — fold reasoning + text into one message.
                            flushHeld();
                            held = {
                                content: [
                                    ...pendingReasoning.map(text => ({ type: 'reasoning', text })),
                                    { type: 'text', text: item.text ?? '' },
                                ],
                                refs: [...pendingReasoningSeqs, ...textSeqs],
                            };
                            pendingReasoning.length = 0;
                            pendingReasoningSeqs.length = 0;
                            textSeqs.length = 0;
                            reasoningBlockStarted = false;
                            textBlockStarted = false;
                        }
                        else if (item.type === 'commandExecution') {
                            flushReasoning();
                            flushHeld();
                            const activity = mapCommandExecution(item);
                            this.session.append('tool/call', {
                                turn, step, callId: activity.call.callId, name: activity.call.name, arguments: activity.call.arguments,
                            });
                            this.session.append('tool/result', { turn, step, message: activity.result }, { surfaceOp: 'append' });
                        }
                        else if (item.type === 'fileChange') {
                            flushReasoning();
                            flushHeld();
                            const activity = mapFileChange(item);
                            this.session.append('tool/call', {
                                turn, step, callId: activity.call.callId, name: activity.call.name, arguments: activity.call.arguments,
                            });
                            this.session.append('tool/result', { turn, step, message: activity.result }, { surfaceOp: 'append' });
                        }
                        else if (item.type === 'mcpToolCall') {
                            flushReasoning();
                            flushHeld();
                            const activity = mapMcpToolCall(item);
                            this.session.append('tool/call', {
                                turn, step, callId: activity.call.callId, name: activity.call.name, arguments: activity.call.arguments,
                            });
                            this.session.append('tool/result', { turn, step, message: activity.result }, { surfaceOp: 'append' });
                        }
                        break;
                    }
                    case 'turn-completed': {
                        const usage = event.turn.usage
                            ? mapUsage(event.turn.usage)
                            : undefined;
                        // Turn usage attaches to the step's final durable message: the
                        // trailing reasoning-only message when thinking closed the turn,
                        // otherwise the last held agent message.
                        if (pendingReasoning.length > 0)
                            flushReasoning(usage);
                        else
                            flushHeld(usage);
                        finished = true;
                        break;
                    }
                    case 'error':
                        flushReasoning();
                        flushHeld();
                        throw new LlmError(event.error.message, 'CODEX_ERROR');
                    /* v8 ignore next -- AppServerEvent is a closed union; no unknown kinds */
                    default:
                        break;
                }
            }
            flushReasoning();
            flushHeld();
            if (!finished) {
                throw new LlmError(`agent "${this.id}": codex query ended without a completed turn`, 'CODEX_NO_RESULT');
            }
            return { kind: 'completed' };
        }
        finally {
            signal.removeEventListener('abort', cancel);
            controller.abort();
        }
    }
}
/* jscpd:ignore-end */
//# sourceMappingURL=agent.js.map