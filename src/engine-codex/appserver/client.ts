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

  /** Spawn the pinned app-server dependency and initialize the client. */
  static async create(): Promise<AppServerClient> {
    const proc = spawn(process.execPath, [codexCliEntrypoint(), 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = new AppServerClient(proc)
    await client.initialize()
    return client
  }

  /** Set the notification handler for streaming events. */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
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
        version: '0.1.1-rc.2',
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
    let obj: { id?: number; method?: string; result?: unknown; error?: { code: number; message: string }; params?: unknown }
    try {
      obj = JSON.parse(line)
    } catch {
      return // non-JSON line, ignore
    }
    if (obj.id !== undefined) {
      // Response to a request
      const pending = this.pending.get(obj.id)
      if (pending) {
        this.pending.delete(obj.id)
        if (obj.error) {
          pending.reject(new Error(obj.error.message))
        } else {
          pending.resolve(obj.result)
        }
      }
    }
    if (obj.method !== undefined) {
      // Notification
      this.notificationHandler?.(obj.method, obj.params)
    }
  }
}
