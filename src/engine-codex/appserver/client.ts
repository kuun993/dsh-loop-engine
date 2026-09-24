/**
 * JSON-RPC client over stdio for the codex app-server. Spawns
 * `codex app-server` as a child process, sends JSON-RPC 2.0 requests over
 * stdin, and reads newline-delimited JSON responses/notifications from stdout.
 *
 * @module dsh-loop-engine/engine-codex/appserver/client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcRequest,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResult,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResult,
} from './types.ts'

/** Callback for receiving server notifications. */
export type NotificationHandler = (method: string, params: unknown) => void

/** A JSON-RPC reply the client writes back for one inbound server request. */
export type RequestOutcome =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }

/** Callback answering one server-initiated JSON-RPC request. */
export type RequestHandler = (
  method: string,
  params: unknown,
  id: number | string,
) => RequestOutcome | Promise<RequestOutcome>

/** Callback for receiving raw stderr lines from the server process. */
export type StderrHandler = (line: string) => void

const require = createRequire(import.meta.url)

/** Resolve the CLI entrypoint from this package's pinned `@openai/codex` dependency. */
function codexCliEntrypoint(): string {
  return join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js')
}

/** JSON-RPC client for the codex app-server. */
export class AppServerClient {
  private process: ChildProcess
  private rl: Interface
  private reqId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private notificationHandler: NotificationHandler | undefined
  private requestHandler: RequestHandler | undefined
  private stderrHandler: StderrHandler | undefined
  private disposed = false

  /** Whether this client was disposed or its server process exited. */
  get closed(): boolean {
    return this.disposed
  }

  /** Create a client by spawning `codex app-server`. */
  private constructor(process: ChildProcess) {
    this.process = process
    this.rl = createInterface({ input: process.stdout! })
    this.rl.on('line', (line) => this.handleLine(line))
    process.stderr!.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        this.stderrHandler?.(line)
      }
    })
    process.on('exit', () => {
      this.disposed = true
      const err = new Error('codex app-server process exited unexpectedly')
      for (const { reject } of this.pending.values()) {
        reject(err)
      }
      this.pending.clear()
    })
  }

  /**
   * Spawn the pinned app-server dependency and initialize the client.
   *
   * `argv` appends the driver's own overrides to the bare `app-server`
   * subcommand (codex's `-c key=value` configuration), and `env` layers the
   * driver's explicit entries over the ambient environment — the child still
   * needs `PATH` and, under a user's own codex setup, the ambient auth facts its
   * configuration reads, so this is an overlay, not a replacement. Both default
   * to nothing, which is the bare `codex app-server` the driver used before a
   * dsh endpoint was ever handed over.
   * @param argv - extra arguments after the `app-server` subcommand.
   * @param env - explicit environment entries layered over the ambient one.
   * @returns the initialized client.
   */
  static async create(
    argv: readonly string[] = [],
    env: NodeJS.ProcessEnv = {},
  ): Promise<AppServerClient> {
    const proc = spawn(process.execPath, [codexCliEntrypoint(), 'app-server', ...argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    const client = new AppServerClient(proc)
    await client.initialize()
    return client
  }

  /** Set the notification handler for streaming events. */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  /** Set the handler for server-initiated requests (e.g. approvals). */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /** Set the stderr handler for server log lines. */
  onStderr(handler: StderrHandler): void {
    this.stderrHandler = handler
  }

  /** Send the initialize handshake. */
  async initialize(): Promise<InitializeResult> {
    const params: InitializeParams = {
      clientInfo: {
        name: 'dsh-loop-engine',
        title: null,
        version: '1.0.0-rc13',
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }
    return this.request('initialize', params) as Promise<InitializeResult>
  }

  /** Create a new thread. */
  async threadStart(params: ThreadStartParams): Promise<ThreadStartResult> {
    return this.request('thread/start', params) as Promise<ThreadStartResult>
  }

  /** Resume an existing thread. */
  async threadResume(params: ThreadResumeParams): Promise<ThreadStartResult> {
    return this.request('thread/resume', params) as Promise<ThreadStartResult>
  }

  /** Start a turn with the given input. */
  async turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    return this.request('turn/start', params) as Promise<TurnStartResult>
  }

  /** Interrupt an active turn. */
  async turnInterrupt(params: TurnInterruptParams): Promise<unknown> {
    return this.request('turn/interrupt', params)
  }

  /** Dispose the client and kill the server process. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rl.close()
    this.process.stdin?.end()
    this.process.kill()
  }

  /** Send a JSON-RPC request and wait for the response. */
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error('app-server client is disposed'))
    }
    const id = this.reqId++
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.process.stdin!.write(JSON.stringify(msg) + '\n')
    })
  }

  /** Handle one line of stdout from the server. */
  private handleLine(line: string): void {
    if (!line.trim()) return
    let obj: {
      id?: number | string
      method?: string
      result?: unknown
      error?: { code: number; message: string }
      params?: unknown
    }
    try {
      obj = JSON.parse(line)
    } catch {
      return // non-JSON line, ignore
    }
    if (obj.id !== undefined && obj.method !== undefined) {
      // Server -> client request: it expects a reply, never a notification.
      void this.answerRequest(obj.method, obj.params, obj.id)
      return
    }
    if (obj.id !== undefined) {
      // Response to one of our requests. Our request ids are numbers only.
      if (typeof obj.id !== 'number') return
      const pending = this.pending.get(obj.id)
      if (pending) {
        this.pending.delete(obj.id)
        if (obj.error) {
          pending.reject(new Error(obj.error.message))
        } else {
          pending.resolve(obj.result)
        }
      }
      return
    }
    if (obj.method !== undefined) {
      // Notification
      this.notificationHandler?.(obj.method, obj.params)
    }
  }

  /** Resolve one inbound server request and write the JSON-RPC reply to stdin. */
  private async answerRequest(method: string, params: unknown, id: number | string): Promise<void> {
    let outcome: RequestOutcome
    try {
      outcome = this.requestHandler !== undefined
        ? await this.requestHandler(method, params, id)
        : { error: { code: -32601, message: 'Method not found' } }
    } catch (error: unknown) {
      outcome = { error: { code: -32603, message: error instanceof Error ? error.message : 'internal error' } }
    }
    if (this.disposed) return
    const reply = 'result' in outcome
      ? { id, result: outcome.result }
      : { id, error: outcome.error }
    this.process.stdin?.write(JSON.stringify(reply) + '\n')
  }
}
