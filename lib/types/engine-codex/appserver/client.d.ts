/**
 * JSON-RPC client over stdio for the codex app-server. Spawns
 * `codex app-server` as a child process, sends JSON-RPC 2.0 requests over
 * stdin, and reads newline-delimited JSON responses/notifications from stdout.
 *
 * @module dsh-loop-engine/engine-codex/appserver/client
 */
import type { InitializeResult, ThreadResumeParams, ThreadStartParams, ThreadStartResult, TurnInterruptParams, TurnStartParams, TurnStartResult } from './types.ts';
/** Callback for receiving server notifications. */
export type NotificationHandler = (method: string, params: unknown) => void;
/** Callback for receiving raw stderr lines from the server process. */
export type StderrHandler = (line: string) => void;
/** JSON-RPC client for the codex app-server. */
export declare class AppServerClient {
    private process;
    private rl;
    private reqId;
    private pending;
    private notificationHandler;
    private stderrHandler;
    private disposed;
    /** Whether this client was disposed or its server process exited. */
    get closed(): boolean;
    /** Create a client by spawning `codex app-server`. */
    private constructor();
    /** Spawn the pinned app-server dependency and initialize the client. */
    static create(): Promise<AppServerClient>;
    /** Set the notification handler for streaming events. */
    onNotification(handler: NotificationHandler): void;
    /** Set the stderr handler for server log lines. */
    onStderr(handler: StderrHandler): void;
    /** Send the initialize handshake. */
    initialize(): Promise<InitializeResult>;
    /** Create a new thread. */
    threadStart(params: ThreadStartParams): Promise<ThreadStartResult>;
    /** Resume an existing thread. */
    threadResume(params: ThreadResumeParams): Promise<ThreadStartResult>;
    /** Start a turn with the given input. */
    turnStart(params: TurnStartParams): Promise<TurnStartResult>;
    /** Interrupt an active turn. */
    turnInterrupt(params: TurnInterruptParams): Promise<unknown>;
    /** Dispose the client and kill the server process. */
    dispose(): void;
    /** Send a JSON-RPC request and wait for the response. */
    private request;
    /** Handle one line of stdout from the server. */
    private handleLine;
}
//# sourceMappingURL=client.d.ts.map