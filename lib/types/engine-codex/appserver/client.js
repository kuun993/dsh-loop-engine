/**
 * JSON-RPC client over stdio for the codex app-server. Spawns
 * `codex app-server` as a child process, sends JSON-RPC 2.0 requests over
 * stdin, and reads newline-delimited JSON responses/notifications from stdout.
 *
 * @module dsh-loop-engine/engine-codex/appserver/client
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const require = createRequire(import.meta.url);
/** Resolve the CLI entrypoint from this package's pinned `@openai/codex` dependency. */
function codexCliEntrypoint() {
    return join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
}
/** JSON-RPC client for the codex app-server. */
export class AppServerClient {
    process;
    rl;
    reqId = 1;
    pending = new Map();
    notificationHandler;
    stderrHandler;
    disposed = false;
    /** Whether this client was disposed or its server process exited. */
    get closed() {
        return this.disposed;
    }
    /** Create a client by spawning `codex app-server`. */
    constructor(process) {
        this.process = process;
        this.rl = createInterface({ input: process.stdout });
        this.rl.on('line', (line) => this.handleLine(line));
        process.stderr.on('data', (chunk) => {
            const lines = chunk.toString().split('\n').filter(Boolean);
            for (const line of lines) {
                this.stderrHandler?.(line);
            }
        });
        process.on('exit', () => {
            this.disposed = true;
            const err = new Error('codex app-server process exited unexpectedly');
            for (const { reject } of this.pending.values()) {
                reject(err);
            }
            this.pending.clear();
        });
    }
    /** Spawn the pinned app-server dependency and initialize the client. */
    static async create() {
        const proc = spawn(process.execPath, [codexCliEntrypoint(), 'app-server'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const client = new AppServerClient(proc);
        await client.initialize();
        return client;
    }
    /** Set the notification handler for streaming events. */
    onNotification(handler) {
        this.notificationHandler = handler;
    }
    /** Set the stderr handler for server log lines. */
    onStderr(handler) {
        this.stderrHandler = handler;
    }
    /** Send the initialize handshake. */
    async initialize() {
        const params = {
            clientInfo: {
                name: 'dsh-loop-engine',
                title: null,
                version: '0.1.1-rc.2',
            },
            capabilities: { experimentalApi: true, requestAttestation: false },
        };
        return this.request('initialize', params);
    }
    /** Create a new thread. */
    async threadStart(params) {
        return this.request('thread/start', params);
    }
    /** Resume an existing thread. */
    async threadResume(params) {
        return this.request('thread/resume', params);
    }
    /** Start a turn with the given input. */
    async turnStart(params) {
        return this.request('turn/start', params);
    }
    /** Interrupt an active turn. */
    async turnInterrupt(params) {
        return this.request('turn/interrupt', params);
    }
    /** Dispose the client and kill the server process. */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.rl.close();
        this.process.stdin?.end();
        this.process.kill();
    }
    /** Send a JSON-RPC request and wait for the response. */
    request(method, params) {
        if (this.disposed) {
            return Promise.reject(new Error('app-server client is disposed'));
        }
        const id = this.reqId++;
        const msg = { jsonrpc: '2.0', id, method, params };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.process.stdin.write(JSON.stringify(msg) + '\n');
        });
    }
    /** Handle one line of stdout from the server. */
    handleLine(line) {
        if (!line.trim())
            return;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            return; // non-JSON line, ignore
        }
        if (obj.id !== undefined) {
            // Response to a request
            const pending = this.pending.get(obj.id);
            if (pending) {
                this.pending.delete(obj.id);
                if (obj.error) {
                    pending.reject(new Error(obj.error.message));
                }
                else {
                    pending.resolve(obj.result);
                }
            }
        }
        if (obj.method !== undefined) {
            // Notification
            this.notificationHandler?.(obj.method, obj.params);
        }
    }
}
//# sourceMappingURL=client.js.map