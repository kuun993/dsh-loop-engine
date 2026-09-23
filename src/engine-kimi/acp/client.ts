/**
 * JSON-RPC client for the `kimi acp` subprocess (Agent Client Protocol over
 * stdio).
 *
 * The driver hands the client a process handle carrying its stdin/stdout/stderr
 * (projected from the dsh subprocess seam). The client frames JSON-RPC 2.0
 * records on a bare `\n` (via a byte decoder, tolerating a trailing `\r`),
 * correlates request responses by `id`, dispatches every `session/update`
 * notification to a buffered event stream, and answers the reverse-RPC
 * `session/request_permission` requests the agent publishes. The child is
 * long-lived (one per factory) and stepped over via `newSession` + `prompt`.
 *
 * @module dsh-loop-engine/engine-kimi/acp/client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { KimiProcess, KimiSpawnCapability, KimiSpawnSpec } from '../process.ts'
import {
  isPermissionRequestFrame,
  isUpdateFrame,
  type AcpFrame,
  type AcpPermissionOption,
  type AcpPermissionResponse,
  type AcpUpdate,
} from './types.ts'

/** How the client answers one `session/request_permission`. */
export type AcpPermissionHandler = (request: AcpFrame) => boolean | Promise<boolean>

/**
 * The answerable options of one `session/request_permission` frame. The wire is
 * untrusted, so entries without a usable `optionId` are dropped rather than
 * echoed back.
 * @param frame - the reverse-RPC request frame.
 * @returns the options the client may answer with.
 */
export function permissionOptionsOf(frame: AcpFrame): readonly AcpPermissionOption[] {
  const params = frame.params as { options?: unknown } | undefined
  if (params === undefined || !Array.isArray(params.options)) return []
  return params.options.filter((option): option is AcpPermissionOption =>
    typeof option === 'object' && option !== null && typeof (option as { optionId?: unknown }).optionId === 'string')
}

/**
 * Encode one approval decision as the ACP `RequestPermissionResponse` the agent
 * correlates against the options it advertised. The agent reads a terminal
 * *option*, never a boolean: an outcome it cannot resolve (or a response that
 * fails to parse at all) is reported to the model as a user rejection, so a
 * decision that no single option expresses becomes `cancelled` — the honest
 * "this client has no answer". Kimi re-uses this RPC for its question and
 * plan-review bridges, which offer one `allow_once` option per choice; picking
 * one of those would answer a question no human was asked, so any ambiguous
 * set (zero or several `allow_once`/`reject_once` candidates) cancels instead.
 * `allow_once` is preferred over `allow_always` because the decision is re-read
 * from the session knobs on every request: letting the agent cache a session
 * grant would outlive a mid-session switch back to `ask`.
 * @param approved - whether the driver approves the request.
 * @param options - the options the agent advertised for this request.
 * @returns the result payload to send back.
 */
export function permissionResponse(approved: boolean, options: readonly AcpPermissionOption[]): AcpPermissionResponse {
  const candidates = options.filter(option => option.kind === (approved ? 'allow_once' : 'reject_once'))
  const match = candidates.length === 1 ? candidates[0] : undefined
  if (match === undefined) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: match.optionId } }
}

/** Callback receiving every non-response event line. */
export type AcpUpdateHandler = (update: AcpUpdate) => void

/** Default spawn: launch `kimi acp` under the current node runtime, projecting a native child. */
function defaultSpawn(spec: KimiSpawnSpec): KimiProcess {
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return fromNativeChild(child)
}

/** Project a `node:child_process` child onto the Kimi process transport. */
function fromNativeChild(child: ChildProcess): KimiProcess {
  // A ChildProcess has no seam `done`; reconcile the native close event into one.
  const done = Promise.withResolvers<unknown>()
  child.once('exit', () => done.resolve(undefined))
  child.once('error', done.reject)
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    done: done.promise,
    terminate: () => child.kill(),
  }
}

/**
 * ACP client over one `kimi acp` child. Created once per driver scope and reused
 * across steps, matching the Pi RPC client's lifecycle.
 */
export class AcpClient {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly updateBuffer: AcpUpdate[] = []
  private updateWake: (() => void) | undefined
  private updateHandler: AcpUpdateHandler | undefined
  private permissionHandler: AcpPermissionHandler | undefined
  private sealed = false
  private nextId = 1
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''

  /** Whether this client was sealed or its process exited. */
  get closed(): boolean {
    return this.sealed
  }

  /** Mount a client over an already-spawned `kimi acp` process. */
  constructor(private readonly process: KimiProcess) {
    this.process.stdout.on('data', (chunk) => this.feed(chunk))
    this.process.stderr.on('data', () => {
      // Diagnostics are drained through other seams; keeping this pipe flowing
      // prevents a talky child from blocking on a full stderr.
    })
    this.process.done.then(() => {
      this.sealed = true
      const error = new Error('kimi acp process exited unexpectedly')
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
      this.updateWake?.()
    }, () => {
      this.sealed = true
      this.updateWake?.()
    })
  }

  /**
   * Create a client, spawning the `kimi acp` child through the supplied
   * capability (or the default node spawn when none is given).
   * @param spec - the `kimi acp` argv/cwd/env the child should run with.
   * @param spawn - optional process-spawn capability (the subprocess seam).
   * @returns the connected client.
   */
  static create(spec: KimiSpawnSpec, spawn?: KimiSpawnCapability): AcpClient {
    const process = spawn === undefined ? defaultSpawn(spec) : spawn(spec)
    return new AcpClient(process)
  }

  /** Register the event dispatch handler. */
  onUpdate(handler: AcpUpdateHandler): void {
    this.updateHandler = handler
  }

  /** Register the permission-approval handler (reverse-RPC answers). */
  onPermission(handler: AcpPermissionHandler): void {
    this.permissionHandler = handler
  }

  /** Send one request and await the correlated response. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.sealed) return Promise.reject(new Error('kimi acp client is sealed'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /** Send a notification (no correlated response awaited). */
  notify(method: string, params: unknown): void {
    if (this.sealed) return
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /** Open the protocol handshake. */
  initialize(): Promise<unknown> {
    return this.request('initialize', { protocolVersion: 1.0, clientCapabilities: {}, clientInfo: { name: 'dsh-loop-engine', version: '1.0.0' } })
  }

  /** Start a fresh ACP session and resolve to its session id. */
  async newSession(cwd: string): Promise<string> {
    const result = (await this.request('session/new', { cwd, mcpServers: [] })) as { sessionId?: string }
    const sessionId = result?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('kimi acp session/new returned no session id')
    }
    return sessionId
  }

  /**
   * Select the model for one ACP session. The agent answers with an error frame
   * when it cannot serve the id, and {@link request} rejects on that frame — so
   * an engine that refuses the model fails the step loud rather than silently
   * running its own default.
   * @param sessionId - the ACP session the model applies to.
   * @param modelId - the model id to select.
   * @returns the agent's response to `session/set_model`.
   */
  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.request('session/set_model', { sessionId, modelId })
  }

  /** Prompt the agent in a session and resolve when the turn completes. */
  prompt(sessionId: string, text: string): Promise<unknown> {
    return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  }

  /** Cancel the active turn in a session (fire-and-forget). */
  cancel(sessionId: string): void {
    this.request('session/cancel', { sessionId }).catch(() => undefined)
  }

  /**
   * Answer a pending `session/request_permission`.
   * @param id - the reverse-RPC request id.
   * @param response - the ACP outcome to answer with.
   */
  respondPermission(id: number, response: AcpPermissionResponse): void {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: response })}\n`)
  }

  /** Consume every buffered update as an async generator. */
  async *updates(): AsyncGenerator<AcpUpdate, void, void> {
    while (true) {
      if (this.updateBuffer.length > 0) {
        yield this.updateBuffer.shift()!
        continue
      }
      if (this.sealed) return
      await new Promise<void>((resolve) => { this.updateWake = resolve })
      this.updateWake = undefined
    }
  }

  /** Seal the client and request child termination. */
  dispose(): void {
    if (this.sealed) return
    this.sealed = true
    this.process.terminate()
    const error = new Error('kimi acp client is sealed')
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
    this.updateWake?.()
  }

  private feed(chunk: Buffer | string): void {
    if (this.sealed) return
    const text = typeof chunk === 'string' ? this.buffer + chunk : this.buffer + this.decoder.write(chunk)
    this.buffer = text
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) break
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.dispatch(line)
    }
  }

  /** Dispatch one parsed line: a response, an update notification, or a reverse-RPC request. */
  private dispatch(line: string): void {
    if (line.trim().length === 0) return
    let frame: AcpFrame
    try {
      frame = JSON.parse(line) as AcpFrame
    } catch {
      return // non-JSON line — ignore
    }
    // Reverse-RPC request needing an answer.
    if (isPermissionRequestFrame(frame)) {
      void this.handlePermission(frame.id, frame)
      return
    }
    // Response to one of our requests (result or error).
    if (typeof frame.id === 'number' && frame.method === undefined) {
      this.settle(frame)
      return
    }
    // session/update notification → buffered event stream.
    if (isUpdateFrame(frame)) {
      const update = frame.params.update as AcpUpdate
      this.updateHandler?.(update)
      this.updateBuffer.push(update)
      this.updateWake?.()
      return
    }
    // Unknown reverse-RPC → answer methodNotFound so the agent does not hang.
    if (typeof frame.id === 'number' && typeof frame.method === 'string') {
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } })}\n`)
    }
  }

  private settle(frame: AcpFrame): void {
    const id = frame.id!
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (frame.error !== undefined) {
      pending.reject(new Error(frame.error.message ?? 'kimi acp request failed'))
    } else {
      pending.resolve(frame.result)
    }
  }

  private async handlePermission(id: number, frame: AcpFrame): Promise<void> {
    const approved = this.permissionHandler === undefined ? false : await this.permissionHandler(frame)
    this.respondPermission(id, permissionResponse(approved, permissionOptionsOf(frame)))
  }
}
