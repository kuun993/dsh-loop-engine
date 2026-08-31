/**
 * Claude Code loop engine module: hosts the AgentFactory that drives every
 * session through the official Claude Agent SDK, one stateless query per dsh
 * step, with the durable session log as the sole source of model context.
 * dsh-loop-engine constructs this factory when the Claude Code engine is
 * selected; this module is a library, not a Cordis plugin entry.
 *
 * @module dsh-loop-engine/engine-claude
 */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { SessionPreparation } from '@deepseek-ai/dsh-session';
import { ClaudeCodeAgent } from "./agent.js";
import { DEFAULT_DISPOSE_GRACE_MS } from "./sdk.js";
import { FactoryOwnership, raceAbort, raceAbortCall } from "../driver-core/ownership.js";
/** Deployment-selectable non-interactive Claude Code permission modes. */
export const CLAUDE_CODE_PERMISSION_MODES = [
    'dontAsk',
    'acceptEdits',
    'auto',
    'plan',
    'bypassPermissions',
];
/** Provider backends the deployment can pin for the CLI child. */
export const CLAUDE_CODE_BACKENDS = [
    'auto',
    'relay',
    'bedrock',
    'vertex',
    'anthropic',
];
/** Schema of the Claude Code loop plugin configuration. */
export const Config = z.object({
    permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES]),
    env: z.dict(z.string()).default({}),
    model: z.string(),
    backend: z.union([...CLAUDE_CODE_BACKENDS]).default('auto'),
    disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
    maxTurns: z.number().step(1).min(1),
});
/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config) {
    const disposeGraceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
    if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0) {
        throw new Error('agent-loop-claude-code: disposeGraceMs must be a positive finite number');
    }
    if (disposeGraceMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`agent-loop-claude-code: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
    }
    return {
        permissionMode: config.permissionMode,
        env: config.env ?? {},
        model: config.model,
        backend: config.backend ?? 'auto',
        disposeGraceMs,
        maxTurns: config.maxTurns,
    };
}
/**
 * Concrete AgentFactory and driver service of the Claude Code loop. Creation
 * and resume follow the registry factory contract and the shared publication
 * transaction: prepare, run setup, then publish through both registries,
 * announce, and emit `agent/session-start`.
 */
export class ClaudeCodeLoop extends Service {
    /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
    static inject = ['agents', 'sessions', 'systemPrompt', 'subprocess'];
    /** Validated configuration owned by the loop plugin. */
    config;
    ownership;
    /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
    runtime;
    constructor(ctx, config) {
        super(ctx, 'agentLoopClaudeCode');
        this.config = resolveConfig(config);
        this.ownership = new FactoryOwnership(ctx.fiber);
        this.runtime = { ctx };
        ctx.effect(() => () => this.ownership.dispose(), 'agentLoopClaudeCode.transactions()');
        ctx.effect(() => ctx.agents.setFactory(this), 'agentLoopClaudeCode.setFactory()');
        // Claude Code owns its prompt, so these variables feed only downstream
        // consumers of the (unused) dsh system prompt assembly, mirroring the
        // default loop's registrations.
        ctx.systemPrompt.variable('provider', context => context.agent?.options.provider);
        ctx.systemPrompt.variable('model', context => context.agent?.options.model);
        ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd);
    }
    /**
     * Construct the driver, scope, and one memoized reverse teardown for a new
     * agent. The teardown is registered with the factory and the owner fiber
     * BEFORE publication, so a mid-setup unload rolls everything back; `signal`
     * fuses caller cancellation with lifecycle teardown for setup awaits.
     */
    /* jscpd:ignore-start -- ownership/transaction machinery mirrors the default agent-loop factory; depending on agent-loop is forbidden. */
    prepare(ownerCtx, id, options, session, callerSignal) {
        ownerCtx.fiber.assertActive();
        /* v8 ignore start -- unreachable backstop, see above */
        /* v8 ignore next -- unreachable backstop, see above */
        if (!this.ownership.isActive())
            throw new Error('agent loop is not active'); /* v8 ignore stop */
        if (callerSignal?.aborted) {
            throw callerSignal.reason instanceof Error
                ? callerSignal.reason
                : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason });
        }
        const loopCtx = this.runtime.ctx;
        // Deactivation fuses three owners, each with its own reason: the caller's
        // cancellation signal, the owner fiber's unload, and factory teardown.
        const abort = new AbortController();
        const onCallerAbort = () => {
            abort.abort(callerSignal?.reason instanceof Error
                ? callerSignal.reason
                : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }));
        };
        const onFactoryTeardown = () => { abort.abort(this.ownership.signal.reason); };
        callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
        this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true });
        let machine;
        let detachSession;
        let detachAgent;
        let disposing;
        const machineReady = Promise.withResolvers();
        const dispose = (ownerTriggered = false) => (disposing ??= (async () => {
            abort.abort(new Error(`agent "${id}" lifecycle disposed`));
            callerSignal?.removeEventListener('abort', onCallerAbort);
            this.ownership.signal.removeEventListener('abort', onFactoryTeardown);
            try {
                /* v8 ignore start -- disposal runs only after the constructor publishes the machine, so it is never undefined here */
                /* v8 ignore next -- disposal runs only after the constructor publishes the machine, so it is never undefined here */
                if (machine === undefined)
                    await machineReady.promise;
                /* v8 ignore next -- the undefined-machine arm is reachable only through the unreachable catch below */
                if (machine !== undefined) {
                    machine.cancel({ kind: 'disposed' });
                    await machine.whenIdle();
                    await machine.scope.dispose();
                } /* v8 ignore stop */
            }
            finally {
                try {
                    detachAgent?.();
                    detachSession?.();
                }
                finally {
                    untrack();
                    if (!ownerTriggered)
                        await unfollowOwner();
                }
            }
        })());
        const untrack = this.ownership.track(dispose);
        let unfollowOwner;
        try {
            unfollowOwner = ownerCtx.effect(() => () => {
                if (disposing !== undefined)
                    return;
                abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
                return dispose(true);
            }, `agentLoopClaudeCode.lifecycle(${id})`);
            /* v8 ignore start -- ctx.effect throws only on an inactive fiber, which assertActive() above already rejected */
        }
        catch (error) {
            untrack();
            callerSignal?.removeEventListener('abort', onCallerAbort);
            this.ownership.signal.removeEventListener('abort', onFactoryTeardown);
            throw error;
        }
        /* v8 ignore stop */
        const assertLive = () => {
            if (!abort.signal.aborted)
                return;
            /* v8 ignore start -- unreachable String() arm, see above */
            /* v8 ignore next -- unreachable String() arm, see above */
            throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason)); /* v8 ignore stop */
        };
        try {
            const agent = machine = new ClaudeCodeAgent(loopCtx, id, options, session, this.config);
            machineReady.resolve();
            assertLive();
            return {
                agent,
                signal: abort.signal,
                publish: (source) => {
                    assertLive();
                    detachSession = agent.ctx.sessions.enter(session);
                    detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent);
                    agent.ctx.sessions.announce(session);
                    assertLive();
                    loopCtx.agents.announce(agent);
                    assertLive();
                    emitAgentEvent(loopCtx, agent, 'agent/session-start', { source });
                    assertLive();
                    return { agent, dispose };
                },
                dispose,
            };
            /* v8 ignore start -- assertLive() runs synchronously where the fused signal cannot abort mid-window, so this catch never fires */
        }
        catch (error) {
            machineReady.resolve();
            void dispose();
            throw error;
        }
        /* v8 ignore stop */
    }
    /** Prepare one Agent around an acquired Session, run setup, and publish it. */
    async setupAndPublish(ownerCtx, id, preparation, agentOptions, setup, signal, source) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const ownedPreparation = __addDisposableResource(env_1, preparation, false);
            const session = ownedPreparation.session;
            const prepared = this.prepare(ownerCtx, id, agentOptions, session, signal);
            try {
                const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id);
                setupCommit?.commit();
                return prepared.publish(source);
            }
            catch (error) {
                await prepared.dispose();
                throw error;
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    /**
     * Create an agent and session under one caller-supplied identity, owned by
     * the accessing fiber.
     * @param ownerCtx - caller context that structurally owns the lifecycle.
     * @param options - identities, session seed/metadata, loop options, setup, and cancellation.
     * @returns the published handle.
     */
    async createAgent(ownerCtx, options) {
        const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
            ...options.seed === undefined ? {} : { seed: options.seed },
            ...options.meta === undefined ? {} : { meta: options.meta },
        }));
        const published = this.setupAndPublish(ownerCtx, options.sessionId, preparation, options.agentOptions ?? {}, options.setup, options.signal, 'startup');
        this.ownership.trackWrapper(published);
        return published;
    }
    /**
     * Resume an owned agent from the configured persistence service.
     * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
     * @param options - persisted identity, loop options, setup, and cancellation.
     * @returns the published handle.
     */
    async resume(ownerCtx, options) {
        const persistence = this.runtime.ctx.get('sessionPersistence');
        if (persistence === undefined) {
            throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)');
        }
        return this.resumeWith(ownerCtx, persistence, options);
    }
    /** Resume through an explicit persistence handle. */
    async resumeWith(ownerCtx, persistence, options) {
        const id = options.resumeSessionId;
        let preparation;
        try {
            const ownerAbort = new AbortController();
            const unfollowOwner = ownerCtx.effect(() => () => {
                ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
            }, `agentLoopClaudeCode.resume-load(${id})`);
            const fused = AbortSignal.any([
                ...options.signal === undefined ? [] : [options.signal],
                ownerAbort.signal,
                this.ownership.signal,
            ]);
            try {
                preparation = await raceAbortCall(() => persistence.prepare(id, fused), fused, id, (abandoned) => { abandoned[Symbol.dispose](); });
            }
            finally {
                await unfollowOwner();
            }
            ownerCtx.fiber.assertActive();
            if (!this.ownership.isActive())
                throw new Error('agent loop is not active');
            return await this.setupAndPublish(ownerCtx, id, preparation, options.agentOptions ?? {}, options.setup, options.signal, 'resume');
        }
        finally {
            preparation?.[Symbol.dispose]();
        }
    }
}
/* jscpd:ignore-end */
//# sourceMappingURL=loop.js.map