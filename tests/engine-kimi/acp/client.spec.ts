/**
 * Unit tests for the `kimi acp` JSON-RPC client: request/response correlation,
 * `session/update` buffering, reverse-RPC permission answers, disposal, and
 * child-exit handling. The transport is a fake {@link KimiProcess}; no real
 * `kimi` subprocess is spawned. Responses are pushed only after the request's
 * pending entry is registered (the Pi RPC client pattern).
 * @module tests/engine-kimi/acp/client
 */

import { describe, expect, it, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { AcpClient } from '../../../src/engine-kimi/acp/client.ts'
import type { KimiProcess } from '../../../src/engine-kimi/process.ts'

/** Hoisted native-spawn mock for the default `AcpClient.create` path. */
const childMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => childMock.spawn(...args) }))

/** A controllable fake KimiProcess recording stdin writes. */
function fakeProcess(): { process: KimiProcess; writes: string[]; resolveExit: (value?: unknown) => void; rejectExit: (error: Error) => void; push: (line: string) => void } {
  const writes: string[] = []
  const stdin = new Writable({ write: (chunk, _e, cb) => { writes.push(chunk.toString()); cb() } })
  const stdout = new Readable({ read: () => {} })
  const stderr = new Readable({ read: () => {} })
  const exit = Promise.withResolvers<unknown>()
  return {
    process: { stdin, stdout, stderr, done: exit.promise, terminate: vi.fn() },
    writes,
    resolveExit: (value) => exit.resolve(value),
    rejectExit: (error) => exit.reject(error),
    push: (line) => { stdout.push(line + '\n') },
  }
}

/** Let the stream feed process before asserting. */
const queue = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const INIT_ID = 1

describe('request/response correlation', () => {
  it('resolves initialize with the returned result and sends a numeric protocol version', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const promise = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{"agentInfo":{"name":"Kimi Code CLI"}}}`)
    await expect(promise).resolves.toEqual({ agentInfo: { name: 'Kimi Code CLI' } })
    const sent = JSON.parse(fake.writes[0]!) as { method: string; params: { protocolVersion: number } }
    expect(sent.method).toBe('initialize')
    expect(sent.params.protocolVersion).toBe(1.0)
    client.dispose()
  })

  it('rejects a request whose response carries an error', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const promise = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"error":{"code":-32602,"message":"Invalid params"}}`)
    await expect(promise).rejects.toThrow('Invalid params')
    client.dispose()
  })

  it('falls back to a generic message for an error response that omits the text', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const promise = client.initialize()
    fake.push('{"jsonrpc":"2.0","id":1,"error":{"code":-32602}}')
    await expect(promise).rejects.toThrow('kimi acp request failed')
    client.dispose()
  })

  it('drops a response with no matching pending id', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    fake.push('{"jsonrpc":"2.0","id":99,"result":{}}')
    await queue()
    expect(fake.writes).toHaveLength(0)
    client.dispose()
  })
})

describe('session lifecycle', () => {
  it('newSession resolves the session id', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const init = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}`)
    await init
    const next = client.newSession('/w')
    fake.push(`{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess_1"}}`)
    await expect(next).resolves.toBe('sess_1')
    client.dispose()
  })

  it('throws when session/new returns no session id', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const init = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}`)
    await init
    const next = client.newSession('/w')
    fake.push('{"jsonrpc":"2.0","id":2,"result":{}}')
    await expect(next).rejects.toThrow('no session id')
    client.dispose()
  })

  it('sends the session/prompt body shape', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const init = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}`)
    await init
    const ns = client.newSession('/w')
    fake.push(`{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s_1"}}`)
    await ns
    const prompt = client.prompt('s_1', 'hello')
    fake.push('{"jsonrpc":"2.0","id":3,"result":{}}')
    await expect(prompt).resolves.toEqual({})
    const sent = JSON.parse(fake.writes[2]!) as { method: string; params: { sessionId: string; prompt: Array<{ type: string; text: string }> } }
    expect(sent.method).toBe('session/prompt')
    expect(sent.params.sessionId).toBe('s_1')
    expect(sent.params.prompt).toEqual([{ type: 'text', text: 'hello' }])
    client.dispose()
  })

  it('cancel sends session/cancel and swallows a rejection', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const init = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}`)
    await init
    client.cancel('s_1')
    await queue()
    expect(JSON.parse(fake.writes[1]!) as { method: string }).toMatchObject({ method: 'session/cancel' })
    client.dispose()
  })
})

describe('session/update notifications', () => {
  it('yields updates to the async generator and the onUpdate callback', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const onUpdate = vi.fn()
    client.onUpdate(onUpdate)
    fake.push(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s_1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}`)
    const first = await client.updates().next()
    expect(first.value).toMatchObject({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('buffers multiple updates in order', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    fake.push(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s_1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"t"}}}}`)
    fake.push(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s_1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"m"}}}}`)
    await queue()
    const gen = client.updates()
    const a = await gen.next()
    const b = await gen.next()
    expect(a.value).toMatchObject({ sessionUpdate: 'agent_thought_chunk' })
    expect(b.value).toMatchObject({ sessionUpdate: 'agent_message_chunk' })
    client.dispose()
  })
})

describe('reverse-RPC permission', () => {
  it('answers session/request_permission from the handler', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    client.onPermission(() => true)
    fake.push('{"jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{"sessionId":"s_1"}}')
    await queue()
    expect(JSON.parse(fake.writes[0]!)).toEqual({ jsonrpc: '2.0', id: 42, result: { approved: true } })
    client.dispose()
  })

  it('answers a denial when the handler returns false', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    client.onPermission(() => false)
    fake.push('{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}}')
    await queue()
    expect(JSON.parse(fake.writes[0]!)).toEqual({ jsonrpc: '2.0', id: 7, result: { approved: false } })
    client.dispose()
  })

  it('answers an unknown reverse-RPC request with methodNotFound', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    fake.push('{"jsonrpc":"2.0","id":9,"method":"session/something_unknown","params":{}}')
    await queue()
    expect(JSON.parse(fake.writes[0]!)).toMatchObject({ id: 9, error: { code: -32601 } })
    client.dispose()
  })

  it('denies a permission request when no handler is registered (fail closed)', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    fake.push('{"jsonrpc":"2.0","id":12,"method":"session/request_permission","params":{}}')
    await queue()
    expect(JSON.parse(fake.writes[0]!)).toEqual({ jsonrpc: '2.0', id: 12, result: { approved: false } })
    client.dispose()
  })
})

describe('create', () => {
  it('honors an injected spawn capability and registers requests on it', async () => {
    const fake = fakeProcess()
    const spawn = vi.fn(() => fake.process)
    const client = AcpClient.create({ argv: ['kimi', 'acp'], cwd: '/w', env: { A: '1' } }, spawn)
    expect(spawn).toHaveBeenCalledWith({ argv: ['kimi', 'acp'], cwd: '/w', env: { A: '1' } })
    const init = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}`)
    await expect(init).resolves.toEqual({})
    client.dispose()
  })

  it('falls back to the default native spawn for the kimi acp argv', async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: Readable; stderr: Readable; kill: ReturnType<typeof vi.fn> }
    child.stdin = new Writable({ write: (_c, _e, cb) => { cb() } })
    child.stdout = new Readable({ read: () => {} })
    child.stderr = new Readable({ read: () => {} })
    child.kill = vi.fn()
    childMock.spawn.mockReturnValue(child)
    const client = AcpClient.create({ argv: ['/bin/kimi', 'acp'], cwd: '/w', env: {} })
    expect(childMock.spawn).toHaveBeenCalledWith('/bin/kimi', ['acp'], { cwd: '/w', env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
    const init = client.initialize()
    ;(child.stdout as Readable).push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}\n`)
    await expect(init).resolves.toEqual({})
    client.dispose()
    expect(child.kill).toHaveBeenCalledTimes(1)
    // The native child's exit reconciles the seam `done` (a no-op once sealed).
    child.emit('exit')
    await queue()
    expect(client.closed).toBe(true)
  })
})

describe('notify', () => {
  it('writes a fire-and-forget notification', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    client.notify('session/foo', { a: 1 })
    expect(JSON.parse(fake.writes[0]!)).toEqual({ jsonrpc: '2.0', method: 'session/foo', params: { a: 1 } })
    client.dispose()
  })

  it('is a no-op once sealed', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    client.dispose()
    client.notify('session/foo', { a: 1 })
    expect(fake.writes).toHaveLength(0)
  })
})

describe('framing robustness and lifecycle', () => {
  it('strips a single trailing carriage return', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const promise = client.initialize()
    fake.process.stdout.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}\r\n`)
    await expect(promise).resolves.toEqual({})
    client.dispose()
  })

  it('ignores blank and non-JSON lines', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    fake.push('')
    fake.push('not json')
    await queue()
    expect(fake.writes).toHaveLength(0)
    client.dispose()
  })

  it('drains stderr without surfacing an error', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    ;(fake.process.stderr as Readable).push('diagnostic log line\n')
    await queue()
    expect(client.closed).toBe(false)
    client.dispose()
  })

  it('is a no-op on feed once sealed', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    client.dispose()
    fake.push('{"jsonrpc":"2.0","id":1,"result":{}}')
    await queue()
    expect(client.closed).toBe(true)
  })

  it('frames a string chunk (utf-8 stream) correctly', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    ;(fake.process.stdout as Readable).setEncoding('utf8')
    const promise = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{"ok":true}}`)
    await expect(promise).resolves.toEqual({ ok: true })
    client.dispose()
  })

  it('ignores a request frame whose method is not a string', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    fake.push('{"jsonrpc":"2.0","id":9,"method":123}')
    await queue()
    expect(fake.writes).toHaveLength(0)
    client.dispose()
  })

  it('rejects a request made after the client is sealed', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    client.dispose()
    await expect(client.initialize()).rejects.toThrow('sealed')
  })

  it('dispose rejects pending requests and terminates the child', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const init = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}`)
    await init
    const pending = client.prompt('s_1', 'x')
    client.dispose()
    await expect(pending).rejects.toThrow('sealed')
    expect(fake.process.terminate).toHaveBeenCalledTimes(1)
  })

  it('rejects pending requests when the child exits unexpectedly', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    const init = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}`)
    await init
    const pending = client.prompt('s_1', 'x')
    fake.resolveExit()
    await expect(pending).rejects.toThrow('exited unexpectedly')
    expect(client.closed).toBe(true)
  })

  it('seals the client when the done promise rejects', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    // The rejection handler seals the client without rejecting pendings; a
    // subsequent dispose is a no-op. The in-flight prompt stays pending (never
    // settles) — assert only the sealed fact to cover the onRejected arm.
    const init = client.initialize()
    fake.push(`{"jsonrpc":"2.0","id":${INIT_ID},"result":{}}`)
    await init
    client.prompt('s_1', 'x')
    fake.rejectExit(new Error('boom'))
    await queue()
    expect(client.closed).toBe(true)
    client.dispose()
  })

  it('returns from the updates generator once the client is sealed', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process)
    client.dispose()
    const collected: unknown[] = []
    for await (const update of client.updates()) {
      collected.push(update)
    }
    expect(collected).toHaveLength(0)
  })
})
