/**
 * Projection from the shared managed-process handle to the official Claude
 * Agent SDK's custom-spawn process interface.
 *
 * @module dsh-loop-engine/engine-claude/process
 */
import { EventEmitter } from 'node:events';
import { scrubbedParentEnv, } from '@deepseek-ai/dsh-subprocess';
/* jscpd:ignore-start -- mirrors the subagent-claude-code SDK process projection. */
function thrown(value) {
    /* v8 ignore start -- the subprocess seam rejects with Error, so the wrapper arm is unreachable. */
    return value instanceof Error ? value : new Error(String(value));
    /* v8 ignore stop */
}
/**
 * Encode the SDK's complete child environment as a subprocess overlay.
 * @param env - SDK-composed child environment after its removals and replacements.
 * @returns explicit values plus tombstones for surviving ambient names the SDK removed.
 */
export function sdkEnvironmentOverlay(env) {
    const overlay = { ...env };
    for (const name of Object.keys(scrubbedParentEnv())) {
        if (!(name in env))
            overlay[name] = undefined;
    }
    return overlay;
}
/**
 * Translate one official SDK spawn request to the shared process owner.
 * @param options - command, arguments, workspace, environment, and forwarded signal from the SDK.
 * @param graceMs - process-tree termination grace.
 * @returns the fully explicit shared subprocess request.
 */
export function claudeSpawnSpec(options, graceMs) {
    if (options.cwd === undefined || options.cwd.length === 0) {
        throw new Error('agent-loop-claude-code: SDK spawn request omitted its workspace');
    }
    return {
        argv: [options.command, ...options.args],
        cwd: options.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
        graceMs,
        signal: options.signal,
        env: sdkEnvironmentOverlay(options.env),
    };
}
/**
 * SDK-facing view of one shared managed process. Protocol transport remains
 * in the official SDK; this adapter only projects streams and exit events.
 */
export class ManagedClaudeCodeProcess {
    child;
    stdin;
    stdout;
    events = new EventEmitter();
    outcomeValue;
    killRequested = false;
    /**
     * Project a managed process with piped stdin and stdout.
     * @param child - shared handle that remains the process-tree authority.
     */
    constructor(child) {
        this.child = child;
        this.stdin = child.stdin;
        this.stdout = child.stdout;
        // EventEmitter gives `error` special throw semantics without a listener.
        // The SDK attaches its listener synchronously after custom spawn returns,
        // while this no-op also contains an already-rejected spawn handle.
        this.events.on('error', () => { });
        void child.done.then((outcome) => {
            this.outcomeValue = outcome;
            this.events.emit('exit', outcome.exitCode, outcome.signal);
        }, (error) => {
            this.events.emit('error', thrown(error));
        });
    }
    /** Whether the SDK has requested managed tree termination. */
    get killed() {
        return this.killRequested;
    }
    /** Direct-child exit code, or null while running or after signal exit. */
    get exitCode() {
        return this.outcomeValue?.exitCode ?? null;
    }
    /** Direct-child terminating signal, if any. */
    get signalCode() {
        return this.outcomeValue?.signal ?? null;
    }
    /** Exact managed-process outcome after exit, or undefined while running. */
    get outcome() {
        return this.outcomeValue;
    }
    /**
     * Route the SDK's termination request to the tree-scoped process owner.
     * @param _signal - SDK-selected signal; the shared seam owns its escalation ladder.
     * @returns false only after exit or a previous termination request.
     */
    kill(_signal) {
        if (this.killRequested
            || this.outcomeValue !== undefined) {
            return false;
        }
        this.killRequested = true;
        this.child.terminate();
        return true;
    }
    /** Register a persistent process lifecycle listener. */
    on(event, listener) {
        this.events.on(event, listener);
    }
    /** Register a one-shot process lifecycle listener. */
    once(event, listener) {
        this.events.once(event, listener);
    }
    /** Remove a process lifecycle listener. */
    off(event, listener) {
        this.events.off(event, listener);
    }
}
/* jscpd:ignore-end */
//# sourceMappingURL=process.js.map