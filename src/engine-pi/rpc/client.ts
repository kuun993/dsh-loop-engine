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
 * @module @kuun993/dsh-loop-engine/engine-pi/rpc/client
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type {
  PiAbortCommand,
  PiCommand,
  PiEvent,
  PiGetSessionStatsCommand,
  PiNewSessionCommand,
  PiPromptCommand,
  PiResponse,
} from './types.ts'

/** A spawned Pi RPC process as the protocol transport needs it. */
export interface PiProcess {
  /** Child stdin (command JSON lines). */
  readonly stdin: Writable
  /** Child stdout (response + event JSON lines). */
  readonly stdout: Readable
  /** Child stderr (diagnostics; buffered and dropped). */
  readonly stderr: Readable
  /** Register a single human-readable termination callback. */
  onExit(handler: () => void): void
  /** Request process-tree termination. */
  terminate(): void
}

/** The exact argv/cwd/env the driver requests for one `pi --mode rpc` child. */
export interface PiSpawnSpec {
  /** The program plus its flags; `argv[0]` is the Pi CLI entrypoint. */
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
}

/** Spawns one Pi RPC process over the given spec (the driver's spawn capability). */
export type PiSpawnCapability = (spec: PiSpawnSpec) => PiProcess

/** Callback receiving every non-response event line. */
export type PiEventHandler = (event: PiEvent) => void

/** Options for one `prompt` command. */
export interface PiPromptOptions {
  readonly streamingBehavior?: 'steer' | 'followUp'
}

/** Default spawn: launch the Pi CLI under the current node runtime. */
function defaultSpawn(spec: PiSpawnSpec): PiProcess {
  const child = spawn(process.execPath, [...spec.argv], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return fromChildProcess(child)
}

/** Project a `node:child_process` child onto the Pi protocol transport. */
export function fromChildProcess(child: ChildProcess): PiProcess {
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    onExit: (handler) => { child.once('exit', handler) },
    terminate: () => child.kill(),
  }
}

/** Prompt the agent and stream its events. */
export class PiRpcClient {
  private reqId = 1
  private pending = new Map<number, { resolve: (value: PiResponse) => void; reject: (error: Error) => void }>()
  private readonly eventBuffer: PiEvent[] = []
  private eventWake: (() => void) | undefined
  private eventHandler: PiEventHandler | undefined
  private disposed = false
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private readonly onStderr = (chunk: Buffer): void => {
    // Stderr is informational; the driver records diagnostics through other
    // seams. Drain it so a verbose child never blocks on a full pipe.
    void this.consumeStderr(chunk)
  }

  /** Whether this client was disposed or its process exited. */
  get closed(): boolean {
    return this.disposed
  }

  /** Mount a client over an already-spawned Pi RPC process. */
  constructor(private readonly process: PiProcess) {
    this.process.stdout.on('data', (chunk: Buffer | string) => this.feed(chunk))
    this.process.stderr.on('data', this.onStderr)
    this.process.onExit(() => {
      this.disposed = true
      const err = new Error('pi RPC process exited unexpectedly')
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
      this.eventWake?.()
    })
  }

  /**
   * Create a client, spawning the Pi RPC child through the supplied capability
   * (or the default node-runtime spawn when none is given).
   * @param spec - the Pi CLI argv/cwd/env the child should run with.
   * @param spawn - optional process-spawn capability (the subprocess seam);
   *   absent falls back to the plain node child spawn.
   * @returns the connected client.
   */
  static create(spec: PiSpawnSpec, spawn?: PiSpawnCapability): PiRpcClient {
    const process = spawn === undefined ? defaultSpawn(spec) : spawn(spec)
    return new PiRpcClient(process)
  }

  /** Register the event dispatch handler. */
  onEvent(handler: PiEventHandler): void {
    this.eventHandler = handler
  }

  /** Drop any events still buffered from a previous step (stateless per-step sessions). */
  clearEvents(): void {
    this.eventBuffer.length = 0
  }

  /** Start a fresh Pi session. */
  async newSession(): Promise<PiResponse> {
    const command: PiNewSessionCommand = { type: 'new_session' }
    return this.request(command)
  }

  /** Prompt the agent and await the acceptance response. */
  async prompt(message: string, options: PiPromptOptions = {}): Promise<PiResponse> {
    const command: PiPromptCommand = { type: 'prompt', message, ...options }
    return this.request(command)
  }

  /** Abort the current agent operation. */
  async abort(): Promise<PiResponse> {
    const command: PiAbortCommand = { type: 'abort' }
    return this.request(command)
  }

  /** Query session stats. */
  async getSessionStats(): Promise<PiResponse> {
    const command: PiGetSessionStatsCommand = { type: 'get_session_stats' }
    return this.request(command)
  }

  /** Send a command without awaiting its response (fire-and-forget). */
  send(command: PiCommand): void {
    if (this.disposed) return
    this.process.stdin.write(`${JSON.stringify(command)}\n`)
  }

  /**
   * Send a command and await the correlated response. Assigns a fresh `id`
   * when the command carries none, so responses always round-trip.
   */
  async request(command: PiCommand): Promise<PiResponse> {
    if (this.disposed) throw new Error('pi RPC client is disposed')
    const id = command.id ?? this.reqId++
    const wire: PiCommand = { ...command, id } as PiCommand
    return new Promise<PiResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.process.stdin.write(`${JSON.stringify(wire)}\n`)
    })
  }

  /**
   * Consume every buffered event as an async generator, waking as fresh lines
   * arrive. The caller bounds the iteration by a terminal event; unmatched
   * lines stay buffered for a later iteration.
   */
  async *events(): AsyncGenerator<PiEvent, void, void> {
    while (true) {
      if (this.eventBuffer.length > 0) {
        yield this.eventBuffer.shift()!
        continue
      }
      if (this.disposed) return
      await new Promise<void>((resolve) => { this.eventWake = resolve })
      this.eventWake = undefined
    }
  }

  /** Dispose the client and request child termination. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.process.terminate()
    const err = new Error('pi RPC client is disposed')
    for (const { reject } of this.pending.values()) reject(err)
    this.pending.clear()
    this.eventWake?.()
  }

  /** Feed one chunk of stdout into the framing state machine. */
  private feed(chunk: Buffer | string): void {
    if (this.disposed) return
    const text = typeof chunk === 'string'
      ? this.buffer + chunk
      : this.buffer + this.decoder.write(chunk)
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

  /** Dispatch one parsed line to the pending map or the event queue. */
  private dispatch(line: string): void {
    if (line.trim().length === 0) return
    let obj: PiResponse & PiEvent
    try {
      obj = JSON.parse(line) as PiResponse & PiEvent
    } catch {
      return // non-JSON line — ignore
    }
    if (obj.type === 'response') {
      if (obj.id !== undefined) {
        const pending = this.pending.get(obj.id)
        if (pending !== undefined) {
          this.pending.delete(obj.id)
          if (obj.success) pending.resolve(obj)
          else pending.reject(new Error(obj.error ?? `pi RPC command "${obj.command ?? ''}" failed`))
        }
      }
      return
    }
    const event = obj as PiEvent
    this.eventHandler?.(event)
    this.eventBuffer.push(event)
    this.eventWake?.()
  }

  /** Drain decoded stderr bytes (no-op consumer keeps the pipe flowing). */
  private consumeStderr(_chunk: Buffer): void {
    // Intentionally empty; bound the pipe so a very talky child never blocks.
  }
}
