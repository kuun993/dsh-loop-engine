/**
 * Shared factory ownership and abort-race machinery for the hosted engines.
 * Both the Claude Code and Codex loop drivers run the same lifecycle: exactly
 * one factory owns the AgentFactory slot, every live agent's teardown is
 * tracked until it settles, and setup awaits are raced against a fused abort
 * signal. These helpers are engine-free — they only touch the fiber state,
 * the session id type, and an AbortController — so the two loop modules share
 * them verbatim.
 *
 * @module dsh-loop-engine/driver-core/ownership
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
/** Fiber states that cannot own or serve a new lifecycle. */
export declare const INACTIVE_STATES: ReadonlySet<number>;
/** Factory-level ownership: live agent teardowns plus load-time tracking. */
export declare class FactoryOwnership {
    private readonly fiber;
    private accepting;
    private readonly teardown;
    private readonly inactive;
    private readonly liveAgents;
    private startupTasks;
    constructor(fiber: Context['fiber']);
    /** Aborts (reason: `agent loop is not active` error) when factory teardown begins. */
    get signal(): AbortSignal;
    isActive(): boolean;
    /** Track one live agent's shared teardown until it has run. */
    track(dispose: () => Promise<void>): () => void;
    /** Join config startup work that begins before an agent exists. */
    trackStartup(job: Promise<void>): void;
    /** Join one public create/resume continuation; factory dispose awaits its settlement. */
    trackWrapper(job: Promise<unknown>): void;
    dispose(): Promise<void>;
}
/** Await `operation`, or throw the signal's reason as soon as it aborts. */
export declare function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T>;
/** Start an abortable operation and release a value that arrives after cancellation. */
export declare function raceAbortCall<T>(operation: () => PromiseLike<T> | T, signal: AbortSignal, id: SessionId, releaseAbandoned?: (value: T) => void): Promise<T>;
//# sourceMappingURL=ownership.d.ts.map