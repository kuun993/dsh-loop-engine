import { describe, expect, it, vi } from 'vitest'
import { parsePiModelList, probePiModels } from '../../src/engine-pi/probe.ts'
import type { PiProcess, PiSpawnSpec } from '../../src/engine-pi/rpc/client.ts'
import type { PiModelEntry } from '../../src/engine-pi/probe.ts'

describe('parsePiModelList', () => {
  it('parses the provider/model columns of the aligned table', () => {
    const output = [
      'provider   model                                   context  max-out  thinking  images',
      'anthropic  claude-sonnet-4-6                       1M       128K     yes       yes',
      'deepseek   deepseek-v4-pro                         1M       384K     yes       no',
      'meicloud   6dd28e9b/custom_openai/deepseek-v4-flash-0731-aliyun-tokenplan-chenbk7  1M  384K  yes  no',
      '',
    ].join('\n')
    const entries = parsePiModelList(output)
    expect(entries).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
      {
        provider: 'meicloud',
        model: '6dd28e9b/custom_openai/deepseek-v4-flash-0731-aliyun-tokenplan-chenbk7',
      },
    ])
  })

  it('skips the header row and blank lines', () => {
    const entries = parsePiModelList('provider   model\nanthropic  claude-opus-4-7\n')
    expect(entries).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-7' }])
  })

  it('returns an empty array for an empty or header-only stream', () => {
    expect(parsePiModelList('')).toEqual([])
    expect(parsePiModelList('provider   model\n')).toEqual([])
  })
})

describe('probePiModels', () => {
  it('spawns pi --list-models, reads stdout, and parses it', async () => {
    const spawn = vi.fn((): PiProcess => {
      const process: PiProcess = {
        stdin: { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream,
        stdout: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        stderr: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        onExit: (handler: (code: number | null) => void) => { void handler(0) },
        terminate: vi.fn(),
      }
      // Drive data + end/close so the collector settles.
      const handlers = new Map<string, (arg: unknown) => void>()
      ;(process.stdout as unknown as {
        on: (event: string, cb: (arg?: unknown) => void) => void
      }).on = (event: string, cb: (arg?: unknown) => void) => {
        if (event === 'data') handlers.set('data', cb as (arg: unknown) => void)
        if (event === 'end' || event === 'close') handlers.set('end', cb as (arg: unknown) => void)
      }
      // collectStdout subscribes before the probe awaits exit; feed it now.
      queueMicrotask(() => {
        handlers.get('data')?.('provider   model\n')
        handlers.get('data')?.('anthropic  claude-opus-4-7\n')
        handlers.get('end')?.(undefined)
      })
      return process
    })

    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-7' }])

    const spec = spawn.mock.calls[0]![0] as PiSpawnSpec
    expect(spec.argv).toContain('/abs/path/pi')
    expect(spec.argv).toContain('--list-models')
    expect(spec.argv).toContain('--mode')
    expect(spec.argv).toContain('rpc')
    expect(spec.argv).not.toContain(process.execPath) // node prefix added by piSubprocessSpec, not here
    expect(spec.env).toEqual({})
  })

  it('returns an empty array when the probe fails (non-zero exit) without throwing', async () => {
    const spawn = vi.fn((): PiProcess => {
      const process: PiProcess = {
        stdin: { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream,
        stdout: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        stderr: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        onExit: (handler: (code: number | null) => void) => { void handler(1) },
        terminate: vi.fn(),
      }
      return process
    })

    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toEqual([])
  })

  it('returns an empty array when the child emits nothing before exit', async () => {
    const spawn = vi.fn((): PiProcess => {
      const process: PiProcess = {
        stdin: { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream,
        stdout: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        stderr: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        onExit: (handler: (code: number | null) => void) => { void handler(0) },
        terminate: vi.fn(),
      }
      // No 'data' events, but emit 'end' so the collector settles with ''.
      const close = new Map<string, (arg: unknown) => void>()
      ;(process.stdout as unknown as { on: (e: string, cb: (arg?: unknown) => void) => void }).on =
        (event: string, cb: (arg?: unknown) => void) => {
          if (event === 'end' || event === 'close') close.set('end', cb as (arg: unknown) => void)
        }
      queueMicrotask(() => { close.get('end')?.(undefined) })
      return process
    })

    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toEqual([])
  })
})
