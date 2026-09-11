/**
 * Unit tests for AppServerClient: JSON-RPC request/response handling,
 * notification dispatch, disposal, and error handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

// We test the client by spawning a fake process that reads JSON-RPC from stdin
// and writes responses/notifications to stdout.

interface FakeProcess extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: () => void
}

let fakeProcess: FakeProcess
const written: string[] = []

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => fakeProcess),
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

import { AppServerClient } from '../../../src/engine-codex/appserver/client.ts'

beforeEach(() => {
  mocks.spawn.mockClear()
  written.length = 0
  const proc = new EventEmitter() as FakeProcess
  proc.stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      written.push(chunk.toString())
      // Parse the request and auto-respond with a mock result
      try {
        const msg = JSON.parse(chunk.toString().trim())
        const response = buildResponse(msg.id, msg.method)
        if (response !== undefined) {
          setImmediate(() => proc.stdout.push(JSON.stringify(response) + '\n'))
        }
      } catch { /* ignore */ }
      callback()
    },
  })
  proc.stdout = new Readable({ read: () => {} })
  proc.stderr = new Readable({ read: () => {} })
  proc.kill = vi.fn()
  fakeProcess = proc
})

function buildResponse(id: number, method: string): unknown {
  switch (method) {
    case 'initialize':
      return { id, result: { userAgent: 'test/1.0', codexHome: '/tmp/.codex', platformFamily: 'windows', platformOs: 'windows' } }
    case 'thread/start':
      return { id, result: { thread: { id: 'thread-abc' } } }
    case 'thread/resume':
      return { id, result: { thread: { id: 'thread-abc' } } }
    case 'turn/start':
      return { id, result: { turn: { id: 'turn-xyz', status: 'inProgress' } } }
    case 'turn/interrupt':
      return { id, result: {} }
    default:
      return undefined
  }
}

describe('AppServerClient', () => {
  it('sends initialize and receives the result', async () => {
    const client = await AppServerClient.create()
    const result = await client.initialize()
    expect(result.userAgent).toBe('test/1.0')
    expect(result.codexHome).toBe('/tmp/.codex')
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/@openai[\\/]codex[\\/]bin[\\/]codex\.js$/), 'app-server'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    client.dispose()
  })

  it('sends threadStart and receives the thread id', async () => {
    const client = await AppServerClient.create()
    const result = await client.threadStart({ cwd: '/tmp', sandbox: 'read-only' })
    expect(result.thread.id).toBe('thread-abc')
    client.dispose()
  })

  it('sends turnStart and receives the turn id', async () => {
    const client = await AppServerClient.create()
    const result = await client.turnStart({
      threadId: 'thread-abc',
      input: [{ type: 'text', text: 'hello' }],
    })
    expect(result.turn.id).toBe('turn-xyz')
    client.dispose()
  })

  it('dispatches notifications to the handler', async () => {
    const client = await AppServerClient.create()
    const notifications: Array<{ method: string; params: unknown }> = []
    client.onNotification((method, params) => {
      notifications.push({ method, params })
    })

    fakeProcess.stdout.push(JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 't-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'hi' },
    }) + '\n')

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      method: 'item/agentMessage/delta',
      params: { itemId: 'msg-1', delta: 'hi' },
    })
    client.dispose()
  })

  it('answers a server-initiated request through the registered handler', async () => {
    const client = await AppServerClient.create()
    const handled: Array<{ method: string; params: unknown; id: number | string }> = []
    client.onRequest((method, params, id) => {
      handled.push({ method, params, id })
      return { result: { decision: 'accept' } }
    })

    fakeProcess.stdout.push(JSON.stringify({
      id: 'req-1',
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-1', command: 'ls -la' },
    }) + '\n')

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(handled).toEqual([{
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-1', command: 'ls -la' },
      id: 'req-1',
    }])
    expect(written.some(line => line.trim() === JSON.stringify({ id: 'req-1', result: { decision: 'accept' } }))).toBe(true)
    client.dispose()
  })

  it('answers an unhandled server request with method not found', async () => {
    const client = await AppServerClient.create()
    fakeProcess.stdout.push(JSON.stringify({ id: 7, method: 'unknown/method', params: {} }) + '\n')

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(written.some(line => line.trim() === JSON.stringify({
      id: 7,
      error: { code: -32601, message: 'Method not found' },
    }))).toBe(true)
    client.dispose()
  })

  it('answers with an internal error when the request handler throws', async () => {
    const client = await AppServerClient.create()
    client.onRequest(() => { throw new Error('boom') })
    fakeProcess.stdout.push(JSON.stringify({ id: 'req-x', method: 'x', params: {} }) + '\n')

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(written.some(line => line.trim() === JSON.stringify({
      id: 'req-x',
      error: { code: -32603, message: 'boom' },
    }))).toBe(true)
    client.dispose()
  })

  it('answers with a generic internal error when the handler throws a non-Error', async () => {
    const client = await AppServerClient.create()
    client.onRequest(() => { throw 'plain string' })
    fakeProcess.stdout.push(JSON.stringify({ id: 'req-y', method: 'y', params: {} }) + '\n')

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(written.some(line => line.trim() === JSON.stringify({
      id: 'req-y',
      error: { code: -32603, message: 'internal error' },
    }))).toBe(true)
    client.dispose()
  })

  it('ignores an id-only message with a non-number id', async () => {
    const client = await AppServerClient.create()
    fakeProcess.stdout.push(JSON.stringify({ id: 'not-ours', result: {} }) + '\n')

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(written.some(line => line.includes('not-ours'))).toBe(false)
    client.dispose()
  })

  it('ignores a line that is neither a request, response, nor notification', async () => {
    const client = await AppServerClient.create()
    const notifications: unknown[] = []
    client.onNotification((method, params) => { notifications.push({ method, params }) })
    fakeProcess.stdout.push(JSON.stringify({ unrelated: true }) + '\n')

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(notifications).toHaveLength(0)
    client.dispose()
  })

  it('does not write a reply when the client is disposed before the handler resolves', async () => {
    const client = await AppServerClient.create()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    client.onRequest(async () => {
      await gate
      return { result: {} }
    })
    fakeProcess.stdout.push(JSON.stringify({ id: 'late', method: 'm', params: {} }) + '\n')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    client.dispose()
    release()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(written.some(line => line.includes('late'))).toBe(false)
  })

  it('rejects pending requests when the process exits', async () => {
    const client = await AppServerClient.create()
    expect(client.closed).toBe(false)
    const promise = client.threadStart({ cwd: '/tmp' })
    fakeProcess.emit('exit')
    expect(client.closed).toBe(true)
    await expect(promise).rejects.toThrow('codex app-server process exited unexpectedly')
  })

  it('rejects requests after disposal', async () => {
    const client = await AppServerClient.create()
    client.dispose()
    expect(client.closed).toBe(true)
    await expect(client.threadStart({ cwd: '/tmp' })).rejects.toThrow('app-server client is disposed')
  })

  it('handles error responses', async () => {
    const client = await AppServerClient.create()
    const promise = client.threadStart({ cwd: '/tmp' })
    fakeProcess.stdout.push(JSON.stringify({
      id: 2,
      error: { code: -32600, message: 'invalid thread id' },
    }) + '\n')
    await expect(promise).rejects.toThrow('invalid thread id')
    client.dispose()
  })

  it('ignores non-JSON lines', async () => {
    const client = await AppServerClient.create()
    const notifications: Array<{ method: string; params: unknown }> = []
    client.onNotification((method, params) => {
      notifications.push({ method, params })
    })

    fakeProcess.stdout.push('not json\n')
    fakeProcess.stdout.push('{"method":"test","params":{}}\n')
    fakeProcess.stdout.push('\n')

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(notifications).toHaveLength(1)
    client.dispose()
  })

  it('sends threadResume', async () => {
    const client = await AppServerClient.create()
    const result = await client.threadResume({ threadId: 'thread-abc' })
    expect(result.thread.id).toBe('thread-abc')
    client.dispose()
  })

  it('sends turnInterrupt', async () => {
    const client = await AppServerClient.create()
    await client.turnInterrupt({ threadId: 'thread-abc', turnId: 'turn-xyz' })
    client.dispose()
  })

  it('dispatches stderr lines to the stderr handler', async () => {
    const client = await AppServerClient.create()
    const stderrLines: string[] = []
    client.onStderr((line) => { stderrLines.push(line) })

    // Simulate stderr output from the process
    const proc = (client as unknown as { process: EventEmitter & { stderr: Readable } }).process
    proc.stderr.push('server log line 1\nserver log line 2\n')

    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(stderrLines).toEqual(['server log line 1', 'server log line 2'])
    client.dispose()
  })

  it('disposes the process and readline', async () => {
    const client = await AppServerClient.create()
    const proc = (client as unknown as { process: EventEmitter & { kill: () => void; stdin: Writable } }).process
    client.dispose()
    expect(proc.kill).toHaveBeenCalled()
  })

  it('dispose is idempotent', async () => {
    const client = await AppServerClient.create()
    client.dispose()
    client.dispose() // second call should be a no-op
    const proc = (client as unknown as { process: EventEmitter & { kill: () => void } }).process
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })
})
