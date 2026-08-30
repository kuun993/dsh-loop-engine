/**
 * Pi loop engine module: hosts the AgentFactory that drives every session
 * through the Pi CLI (`@earendil-works/pi-coding-agent`) over its JSONL RPC
 * mode, one stateless session per dsh step, with the durable session log as the
 * sole source of model context. dsh-loop-engine constructs this factory when
 * the Pi engine is selected; this module is a library, not a Cordis plugin
 * entry. Pi has no permission system, so the entire `pi --mode rpc` child is
 * spawned through the dsh subprocess seam — the only available privilege
 * boundary — and its `--tools` are pruned to the resolved sandbox stance.
 *
 * @module dsh-loop-engine/engine-pi
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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { SessionPreparation } from '@deepseek-ai/dsh-session';
import { PiAgent } from "./agent.js";
import { FactoryOwnership, raceAbort, raceAbortCall } from "../driver-core/ownership.js";
/** Pi CLI sandbox modes a deployment may pin. */
export const PI_SANDBOX_MODES = [
    'read-only',
    'workspace-write',
    'danger-full-access',
];
/** Grace in milliseconds for Pi process-tree termination. */
export const PI_DISPOSE_GRACE_MS = 3000;
/** Schema of the Pi loop plugin configuration. */
export const Config = z.object({
    sandboxMode: z.union([...PI_SANDBOX_MODES]),
    provider: z.string(),
    model: z.string(),
    thinkingLevel: z.string(),
    env: z.dict(z.string()).default({}),
});
/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config) {
    return {
        sandboxMode: config.sandboxMode,
        provider: config.provider,
        model: config.model,
        thinkingLevel: config.thinkingLevel,
        env: config.env ?? {},
    };
}
/** Resolve the Pi CLI entrypoint from the package's pinned `bin` field. */
function piCliEntrypoint() {
    // The package is ESM-only (its `exports` exposes no `require` condition), so
    // resolve the import entry and walk back to the package root to read `bin`.
    const mainUrl = import.meta
        .resolve('@earendil-works/pi-coding-agent');
    const root = dirname(dirname(fileURLToPath(mainUrl)));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const bin = pkg.bin;
    /* v8 ignore start -- the pinned dependency's bin is an object map; the string-arm and fallbacks are a defensive unreachable layout */
    /* v8 ignore next -- see above */
    const rel = typeof bin === 'string'
        ? bin
        : bin?.['pi'] ?? Object.values(bin ?? {})[0] ?? 'bin/pi.js'; /* v8 ignore stop */
    return join(root, rel);
}
/** Project the driver's spawn request onto the dsh subprocess seam. */
function piSubprocessSpec(spec, graceMs) {
    return {
        // `spec.argv[0]` is the Pi CLI entrypoint; run it under the current node.
        argv: [process.execPath, ...spec.argv],
        cwd: spec.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs,
        env: spec.env,
    };
}
/** Project a dsh subprocess handle onto the Pi protocol transport. */
function fromSubprocess(handle) {
    const { stdin, stdout, stderr } = handle;
    /* v8 ignore start -- the Pi spawn spec always requests piped stdio, so a missing stream is a wiring hole */
    /* v8 ignore next -- see above */
    if (stdin === undefined || stdout === undefined || stderr === undefined) {
        throw new Error('agent-loop-pi: spawned child must pipe stdin/stdout/stderr');
    }
    /* v8 ignore stop */
    return {
        stdin,
        stdout,
        stderr,
        onExit: (handler) => { void handle.done.then(handler, handler); },
        terminate: () => handle.terminate(),
    };
}
/**
 * Concrete AgentFactory and driver service of the Pi loop. Creation and resume
 * follow the registry factory contract and the shared publication transaction:
 * prepare, run setup, then publish through both registries, announce, and emit
 * `agent/session-start`.
 */
export class PiLoop extends Service {
    /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
    static inject = ['agents', 'sessions', 'systemPrompt', 'subprocess'];
    /** Validated configuration owned by the loop plugin. */
    config;
    ownership;
    /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
    runtime;
    /** Process-tree spawn capability handed to every agent, sandboxed by the subprocess seam. */
    spawn;
    /** Resolved Pi CLI entrypoint; `argv[0]` of every Pi RPC child. */
    bin;
    constructor(ctx, config) {
        super(ctx, 'agentLoopPi');
        this.config = resolveConfig(config);
        this.ownership = new FactoryOwnership(ctx.fiber);
        this.runtime = { ctx };
        this.bin = piCliEntrypoint();
        this.spawn = (spec) => fromSubprocess(this.runtime.ctx.subprocess.spawn(piSubprocessSpec(spec, PI_DISPOSE_GRACE_MS)));
        ctx.effect(() => () => this.ownership.dispose(), 'agentLoopPi.transactions()');
        ctx.effect(() => ctx.agents.setFactory(this), 'agentLoopPi.setFactory()');
        // Pi owns its prompt natively, so these variables feed only downstream
        // consumers of the dsh system prompt assembly, mirroring the default loop's
        // registrations.
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
    /* jscpd:ignore-start -- ownership/transaction machinery mirrors the Claude Code loop factory. */
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
            }, `agentLoopPi.lifecycle(${id})`);
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
            const agent = machine = new PiAgent(loopCtx, id, options, session, this.config, this.spawn, this.bin);
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
            }, `agentLoopPi.resume-load(${id})`);
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