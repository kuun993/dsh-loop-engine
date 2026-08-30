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
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
/** Default spawn: launch the Pi CLI under the current node runtime. */
function defaultSpawn(spec) {
    const child = spawn(process.execPath, [...spec.argv], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return fromChildProcess(child);
}
/** Project a `node:child_process` child onto the Pi protocol transport. */
export function fromChildProcess(child) {
    return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        onExit: (handler) => { child.once('exit', handler); },
        terminate: () => child.kill(),
    };
}
/** Prompt the agent and stream its events. */
export class PiRpcClient {
    process;
    reqId = 1;
    pending = new Map();
    eventBuffer = [];
    eventWake;
    eventHandler;
    disposed = false;
    decoder = new StringDecoder('utf8');
    buffer = '';
    onStderr = (chunk) => {
        // Stderr is informational; the driver records diagnostics through other
        // seams. Drain it so a verbose child never blocks on a full pipe.
        void this.consumeStderr(chunk);
    };
    /** Whether this client was disposed or its process exited. */
    get closed() {
        return this.disposed;
    }
    /** Mount a client over an already-spawned Pi RPC process. */
    constructor(process) {
        this.process = process;
        this.process.stdout.on('data', (chunk) => this.feed(chunk));
        this.process.stderr.on('data', this.onStderr);
        this.process.onExit(() => {
            this.disposed = true;
            const err = new Error('pi RPC process exited unexpectedly');
            for (const { reject } of this.pending.values())
                reject(err);
            this.pending.clear();
            this.eventWake?.();
        });
    }
    /**
     * Create a client, spawning the Pi RPC child through the supplied capability
     * (or the default node-runtime spawn when none is given).
     * @param spec - the Pi CLI argv/cwd/env the child should run with.
     * @param spawn - optional process-spawn capability (the subprocess seam);
     *   absent falls back to the plain node child spawn.
     * @returns the connected client.
     */
    static create(spec, spawn) {
        const process = spawn === undefined ? defaultSpawn(spec) : spawn(spec);
        return new PiRpcClient(process);
    }
    /** Register the event dispatch handler. */
    onEvent(handler) {
        this.eventHandler = handler;
    }
    /** Drop any events still buffered from a previous step (stateless per-step sessions). */
    clearEvents() {
        this.eventBuffer.length = 0;
    }
    /** Start a fresh Pi session. */
    async newSession() {
        const command = { type: 'new_session' };
        return this.request(command);
    }
    /** Prompt the agent and await the acceptance response. */
    async prompt(message, options = {}) {
        const command = { type: 'prompt', message, ...options };
        return this.request(command);
    }
    /** Abort the current agent operation. */
    async abort() {
        const command = { type: 'abort' };
        return this.request(command);
    }
    /** Query session stats. */
    async getSessionStats() {
        const command = { type: 'get_session_stats' };
        return this.request(command);
    }
    /** Send a command without awaiting its response (fire-and-forget). */
    send(command) {
        if (this.disposed)
            return;
        this.process.stdin.write(`${JSON.stringify(command)}\n`);
    }
    /**
     * Send a command and await the correlated response. Assigns a fresh `id`
     * when the command carries none, so responses always round-trip.
     */
    async request(command) {
        if (this.disposed)
            throw new Error('pi RPC client is disposed');
        const id = command.id ?? this.reqId++;
        const wire = { ...command, id };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.process.stdin.write(`${JSON.stringify(wire)}\n`);
        });
    }
    /**
     * Consume every buffered event as an async generator, waking as fresh lines
     * arrive. The caller bounds the iteration by a terminal event; unmatched
     * lines stay buffered for a later iteration.
     */
    async *events() {
        while (true) {
            if (this.eventBuffer.length > 0) {
                yield this.eventBuffer.shift();
                continue;
            }
            if (this.disposed)
                return;
            await new Promise((resolve) => { this.eventWake = resolve; });
            this.eventWake = undefined;
        }
    }
    /** Dispose the client and request child termination. */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.process.terminate();
        const err = new Error('pi RPC client is disposed');
        for (const { reject } of this.pending.values())
            reject(err);
        this.pending.clear();
        this.eventWake?.();
    }
    /** Feed one chunk of stdout into the framing state machine. */
    feed(chunk) {
        if (this.disposed)
            return;
        const text = typeof chunk === 'string'
            ? this.buffer + chunk
            : this.buffer + this.decoder.write(chunk);
        this.buffer = text;
        while (true) {
            const newline = this.buffer.indexOf('\n');
            if (newline === -1)
                break;
            let line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (line.endsWith('\r'))
                line = line.slice(0, -1);
            this.dispatch(line);
        }
    }
    /** Dispatch one parsed line to the pending map or the event queue. */
    dispatch(line) {
        if (line.trim().length === 0)
            return;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            return; // non-JSON line — ignore
        }
        if (obj.type === 'response') {
            if (obj.id !== undefined) {
                const pending = this.pending.get(obj.id);
                if (pending !== undefined) {
                    this.pending.delete(obj.id);
                    if (obj.success)
                        pending.resolve(obj);
                    else
                        pending.reject(new Error(obj.error ?? `pi RPC command "${obj.command ?? ''}" failed`));
                }
            }
            return;
        }
        const event = obj;
        this.eventHandler?.(event);
        this.eventBuffer.push(event);
        this.eventWake?.();
    }
    /** Drain decoded stderr bytes (no-op consumer keeps the pipe flowing). */
    consumeStderr(_chunk) {
        // Intentionally empty; bound the pipe so a very talky child never blocks.
    }
}
//# sourceMappingURL=client.js.map