/**
 * Unit tests for PiRpcClient: strict-LF JSONL framing (no Unicode-separator
 * splits, trailing `\r` tolerated, partial-line buffering), response/event
 * dispatch by `id`, exit and disposal hygiene, and the default spawn.
 * @module tests/engine-pi/rpc/client
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

/** Process-shaped handle the client treats as the Pi RPC child. */
interface FakeProcess extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  onExit(handler: () => void): void
  terminate: () => void
  emitExit(): void
}

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

import { PiRpcClient, fromChildProcess } from '../../../src/engine-pi/rpc/client.ts'

function makeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess
  const exitHandlers: Array<() => void> = []
  proc.stdin = new Writable({ write: (_chunk, _encoding, callback) => { callback() } })
  proc.stdout = new Readable({ read: () => {} })
  proc.stderr = new Readable({ read: () => {} })
  proc.onExit = (handler) => { exitHandlers.push(handler) }
  proc.terminate = vi.fn()
  proc.emitExit = () => { for (const handler of [...exitHandlers]) handler() }
  return proc
}

/** A child-shaped object the default spawn path returns. */
function makeChild(): EventEmitter & { stdin: Writable; stdout: Readable; stderr: Readable; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: Readable; stderr: Readable; kill: () => void }
  child.stdin = new Writable({ write: (_c, _e, cb) => { cb() } })
  child.stdout = new Readable({ read: () => {} })
  child.stderr = new Readable({ read: () => {} })
  child.kill = vi.fn()
  return child
}

function queue(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

describe('PiRpcClient response correlation', () => {
  let proc: FakeProcess

  beforeEach(() => {
    proc = makeProcess()
    mocks.spawn.mockClear()
  })

  it('correlates a response to its request by id and resolves', async () => {
    const client = new PiRpcClient(proc)
    const promise = client.newSession()
    proc.stdout.push(`${JSON.stringify({ type: 'response', command: 'new_session', success: true, id: 1 })}\n`)
    await expect(promise).resolves.toMatchObject({ command: 'new_session', success: true })
    client.dispose()
  })

  it('rejects a failed response bearing its error message', async () => {
    const client = new PiRpcClient(proc)
    const promise = client.prompt('hi')
    proc.stdout.push(`${JSON.stringify({ type: 'response', command: 'prompt', success: false, id: 1, error: 'agent busy' })}\n`)
    await expect(promise).rejects.toThrow('agent busy')
    client.dispose()
  })

  it('drops a response with no matching pending id and rejects on disposal', async () => {
    const client = new PiRpcClient(proc)
    const promise = client.prompt('hi')
    proc.stdout.push(`${JSON.stringify({ type: 'response', command: 'prompt', success: true, id: 99 })}\n`)
    await queue() // let the orphan response dispatch before disposal
    client.dispose()
    await expect(promise).rejects.toThrow('pi RPC client is disposed')
  })

  it('surfaces a generic error for a failed response that omits the error text', async () => {
    const client = new PiRpcClient(proc)
    const promise = client.prompt('hi')
    proc.stdout.push(`${JSON.stringify({ type: 'response', success: false, id: 1 })}\n`)
    await expect(promise).rejects.toThrow('pi RPC command "" failed')
    client.dispose()
  })

  it('ignores a response with no id instead of dispatching it as an event', async () => {
    const client = new PiRpcClient(proc)
    const events: unknown[] = []
    client.onEvent((event) => { events.push(event) })
    proc.stdout.push(`${JSON.stringify({ type: 'response', command: 'abort', success: true })}\n`)
    await queue()
    expect(events).toHaveLength(0)
    client.dispose()
  })

  it('frames a string chunk (utf-8 stream) correctly', async () => {
    const client = new PiRpcClient(proc)
    proc.stdout.setEncoding('utf8')
    const events: unknown[] = []
    client.onEvent((event) => { events.push(event) })
    proc.stdout.push('{"type":"agent_start"}\n')
    await queue()
    expect(events).toEqual([{ type: 'agent_start' }])
    client.dispose()
  })

  it('drops any late stdout after disposal', async () => {
    const client = new PiRpcClient(proc)
    client.dispose()
    proc.stdout.push('{"type":"agent_start"}\n') // synchronous push before any data listener processes it
    await queue()
    expect(client.closed).toBe(true)
  })
})

describe('PiRpcClient framing', () => {
  it('does not split on Unicode separators inside a JSON string', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    const events: Array<{ assistantMessageEvent: { delta: string } }> = []
    client.onEvent((event) => { events.push(event as { assistantMessageEvent: { delta: string } }) })
    const delta = 'a\u2028b\u2029c'
    proc.stdout.push(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } })}\n`)
    await queue()
    expect(events).toHaveLength(1)
    expect(events[0]?.assistantMessageEvent.delta).toBe(delta)
    client.dispose()
  })

  it('strips a single trailing carriage return', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    const events: unknown[] = []
    client.onEvent((event) => { events.push(event) })
    proc.stdout.push('{"type":"turn_start"}\r\n')
    await queue()
    expect(events).toEqual([{ type: 'turn_start' }])
    client.dispose()
  })

  it('buffers a partial line until the newline arrives', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    const events: unknown[] = []
    client.onEvent((event) => { events.push(event) })
    proc.stdout.push('{"type":"turn')
    await queue()
    expect(events).toHaveLength(0)
    proc.stdout.push('_start"}\n')
    await queue()
    expect(events).toEqual([{ type: 'turn_start' }])
    client.dispose()
  })

  it('ignores blank and non-JSON lines', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    const events: unknown[] = []
    client.onEvent((event) => { events.push(event) })
    proc.stdout.push('not json\n')
    proc.stdout.push('\n')
    proc.stdout.push('{"type":"agent_start"}\n')
    await queue()
    expect(events).toEqual([{ type: 'agent_start' }])
    client.dispose()
  })

  it('yields buffered events through the async generator', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    proc.stdout.push('{"type":"agent_start"}\n')
    const collected: unknown[] = []
    for await (const event of client.events()) {
      collected.push(event)
      break
    }
    expect(collected).toEqual([{ type: 'agent_start' }])
    client.dispose()
  })

  it('handles the process exit while iterating events', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    proc.emitExit()
    expect(client.closed).toBe(true)
    client.dispose() // guard: double dispose after exit is a no-op
  })
})

describe('PiRpcClient lifecycle', () => {
  it('rejects pending requests when the process exits', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    const promise = client.prompt('hi')
    proc.emitExit()
    expect(client.closed).toBe(true)
    await expect(promise).rejects.toThrow('pi RPC process exited unexpectedly')
  })

  it('rejects requests after disposal and is idempotent', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    client.dispose()
    client.dispose()
    expect(client.closed).toBe(true)
    expect(proc.terminate).toHaveBeenCalledTimes(1)
    await expect(client.prompt('hi')).rejects.toThrow('pi RPC client is disposed')
  })

  it('abort and getSessionStats correlate their responses', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    const abortPromise = client.abort()
    proc.stdout.push(`${JSON.stringify({ type: 'response', command: 'abort', success: true, id: 1 })}\n`)
    await expect(abortPromise).resolves.toMatchObject({ command: 'abort' })
    const statsPromise = client.getSessionStats()
    proc.stdout.push(`${JSON.stringify({ type: 'response', command: 'get_session_stats', success: true, id: 2 })}\n`)
    await expect(statsPromise).resolves.toMatchObject({ command: 'get_session_stats' })
    client.dispose()
  })
})

describe('PiRpcClient send and buffer', () => {
  it('send writes a fire-and-forget command and is a no-op once disposed', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    const writeSpy = vi.spyOn(proc.stdin, 'write')
    client.send({ type: 'abort' })
    expect(writeSpy).toHaveBeenCalledWith('{"type":"abort"}\n')
    client.dispose()
    client.send({ type: 'abort' }) // no-op after disposal
    expect(writeSpy).toHaveBeenCalledTimes(1)
  })

  it('clearEvents discards buffered events but keeps later ones', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    proc.stdout.push('{"type":"agent_start"}\n')
    await queue()
    client.clearEvents()
    proc.stdout.push('{"type":"turn_start"}\n')
    const collected: unknown[] = []
    for await (const event of client.events()) {
      collected.push(event)
      break
    }
    expect(collected).toEqual([{ type: 'turn_start' }])
    client.dispose()
  })

  it('drains stderr without surfacing an error', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    proc.stderr.push('diagnostic log line\n')
    await queue()
    expect(client.closed).toBe(false)
    client.dispose()
  })

  it('yields multiple buffered events across the generator', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    proc.stdout.push('{"type":"agent_start"}\n{"type":"turn_start"}\n')
    const collected: unknown[] = []
    for await (const event of client.events()) {
      collected.push(event)
      if (collected.length === 2) break
    }
    expect(collected).toEqual([{ type: 'agent_start' }, { type: 'turn_start' }])
    client.dispose()
  })

  it('returns from the generator when disposed with an empty buffer', async () => {
    const proc = makeProcess()
    const client = new PiRpcClient(proc)
    client.dispose()
    const collected: unknown[] = []
    for await (const event of client.events()) {
      collected.push(event)
    }
    expect(collected).toHaveLength(0)
  })
})

describe('PiRpcClient default spawn', () => {
  it('spawns the Pi CLI under the current node runtime', () => {
    const child = makeChild()
    mocks.spawn.mockReturnValue(child)
    const client = PiRpcClient.create({ argv: ['cli.js', '--mode', 'rpc'], cwd: '/tmp', env: { A: '1' } })
    expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, ['cli.js', '--mode', 'rpc'], {
      cwd: '/tmp', env: { A: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    client.dispose()
  })

  it('honors an injected spawn capability', () => {
    const proc = makeProcess()
    const spawn = vi.fn(() => proc)
    const client = PiRpcClient.create({ argv: ['cli.js'], cwd: '/t', env: {} }, spawn as never)
    expect(spawn).toHaveBeenCalledTimes(1)
    client.dispose()
  })
})

describe('fromChildProcess', () => {
  it('projects a child process onto the Pi process interface', () => {
    const child = makeChild()
    const process = fromChildProcess(child as never)
    expect(process.stdin).toBe(child.stdin)
    expect(process.stdout).toBe(child.stdout)
    expect(process.stderr).toBe(child.stderr)
    process.terminate()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
