/**
 * Strict-LF JSONL client for the Pi RPC subprocess (`pi --mode rpc`).
 *
 * The driver hands the client a process handle carrying its stdin/stdout/stderr
 * (projected from the dsh subprocess seam, so the whole `pi` child is sandboxed
 * by the harness). The client frames records on a bare `\n` only — not on
 * Unicode separators — using a byte decoder, tolerates a trailing `\r`, and
 * correlates command responses by the optional `id` field while dispatching
 * every non-response line to a buffered event stream.
 *
 * @module dsh-loop-engine/engine-pi/rpc/client
 */
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { PiCommand, PiEvent, PiResponse } from './types.ts';
/** A spawned Pi RPC process as the protocol transport needs it. */
export interface PiProcess {
    /** Child stdin (command JSON lines). */
    readonly stdin: Writable;
    /** Child stdout (response + event JSON lines). */
    readonly stdout: Readable;
    /** Child stderr (diagnostics; buffered and dropped). */
    readonly stderr: Readable;
    /** Register a single human-readable termination callback. */
    onExit(handler: () => void): void;
    /** Request process-tree termination. */
    terminate(): void;
}
/** The exact argv/cwd/env the driver requests for one `pi --mode rpc` child. */
export interface PiSpawnSpec {
    /** The program plus its flags; `argv[0]` is the Pi CLI entrypoint. */
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
}
/** Spawns one Pi RPC process over the given spec (the driver's spawn capability). */
export type PiSpawnCapability = (spec: PiSpawnSpec) => PiProcess;
/** Callback receiving every non-response event line. */
export type PiEventHandler = (event: PiEvent) => void;
/** Options for one `prompt` command. */
export interface PiPromptOptions {
    readonly streamingBehavior?: 'steer' | 'followUp';
}
/** Project a `node:child_process` child onto the Pi protocol transport. */
export declare function fromChildProcess(child: ChildProcess): PiProcess;
/** Prompt the agent and stream its events. */
export declare class PiRpcClient {
    private readonly process;
    private reqId;
    private pending;
    private readonly eventBuffer;
    private eventWake;
    private eventHandler;
    private disposed;
    private readonly decoder;
    private buffer;
    private readonly onStderr;
    /** Whether this client was disposed or its process exited. */
    get closed(): boolean;
    /** Mount a client over an already-spawned Pi RPC process. */
    constructor(process: PiProcess);
    /**
     * Create a client, spawning the Pi RPC child through the supplied capability
     * (or the default node-runtime spawn when none is given).
     * @param spec - the Pi CLI argv/cwd/env the child should run with.
     * @param spawn - optional process-spawn capability (the subprocess seam);
     *   absent falls back to the plain node child spawn.
     * @returns the connected client.
     */
    static create(spec: PiSpawnSpec, spawn?: PiSpawnCapability): PiRpcClient;
    /** Register the event dispatch handler. */
    onEvent(handler: PiEventHandler): void;
    /** Drop any events still buffered from a previous step (stateless per-step sessions). */
    clearEvents(): void;
    /** Start a fresh Pi session. */
    newSession(): Promise<PiResponse>;
    /** Prompt the agent and await the acceptance response. */
    prompt(message: string, options?: PiPromptOptions): Promise<PiResponse>;
    /** Abort the current agent operation. */
    abort(): Promise<PiResponse>;
    /** Query session stats. */
    getSessionStats(): Promise<PiResponse>;
    /** Send a command without awaiting its response (fire-and-forget). */
    send(command: PiCommand): void;
    /**
     * Send a command and await the correlated response. Assigns a fresh `id`
     * when the command carries none, so responses always round-trip.
     */
    request(command: PiCommand): Promise<PiResponse>;
    /**
     * Consume every buffered event as an async generator, waking as fresh lines
     * arrive. The caller bounds the iteration by a terminal event; unmatched
     * lines stay buffered for a later iteration.
     */
    events(): AsyncGenerator<PiEvent, void, void>;
    /** Dispose the client and request child termination. */
    dispose(): void;
    /** Feed one chunk of stdout into the framing state machine. */
    private feed;
    /** Dispatch one parsed line to the pending map or the event queue. */
    private dispatch;
    /** Drain decoded stderr bytes (no-op consumer keeps the pipe flowing). */
    private consumeStderr;
}
//# sourceMappingURL=client.d.ts.map