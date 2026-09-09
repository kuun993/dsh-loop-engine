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

  it('skips lines without a two-space-separated provider/model pair', () => {
    expect(parsePiModelList('stray\n')).toEqual([])
    expect(parsePiModelList('one   two\nstray\n')).toEqual([{ provider: 'one', model: 'two' }])
  })
})

describe('probePiModels', () => {
  /** A mock PiProcess that emits `output` on STDERR (pi dumps --list-models
   *  there), closes both streams, and resolves exit with `exitCode`. */
  function mockProcess({ exitCode, output }: { exitCode: number | null; output: string }): PiProcess {
    const streams = new Map<string, (arg: unknown) => void>()
    const process: PiProcess = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream,
      stdout: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
      stderr: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
      onExit: (handler: (code: number | null) => void) => { void handler(exitCode) },
      terminate: vi.fn(),
    }
    const hook = (stream: unknown): void => {
      ;(stream as unknown as { on: (e: string, cb: (arg?: unknown) => void) => void }).on =
        (event: string, cb: (arg?: unknown) => void) => { streams.set(event, cb as (arg: unknown) => void) }
    }
    hook(process.stdout)
    hook(process.stderr)
    queueMicrotask(() => {
      if (output.length > 0) streams.get('data')?.(output)
      streams.get('close')?.(undefined) // arrives per stream; two closes settle collectOutput
      // a single subscriber map means the same handler is registered on both
      // streams; call it twice to close both.
      streams.get('close')?.(undefined)
    })
    return process
  }

  it('spawns pi --list-models, reads STDERR (where pi dumps the table), and parses it', async () => {
    const spawn = vi.fn((): PiProcess => mockProcess({
      exitCode: 0,
      output: 'provider   model\nanthropic  claude-opus-4-7\n',
    }))

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

  it('merges models written across stdout and stderr', async () => {
    const spawn = vi.fn((): PiProcess => {
      const streams = new Map<string, (arg: unknown) => void>()
      const process: PiProcess = {
        stdin: { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream,
        stdout: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        stderr: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        onExit: (handler: (code: number | null) => void) => { void handler(0) },
        terminate: vi.fn(),
      }
      for (const stream of [process.stdout, process.stderr]) {
        ;(stream as unknown as { on: (e: string, cb: (arg?: unknown) => void) => void }).on =
          (event: string, cb: (arg?: unknown) => void) => { streams.set(event, cb as (arg: unknown) => void) }
      }
      queueMicrotask(() => {
        streams.get('data')?.('stdout-model  one\n')
        streams.get('data')?.('stderr-model  two\n')
        streams.get('close')?.(undefined)
        streams.get('close')?.(undefined)
      })
      return process
    })

    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toContainEqual({ provider: 'stdout-model', model: 'one' })
    expect(models).toContainEqual({ provider: 'stderr-model', model: 'two' })
  })

  it('returns an empty array when the probe fails (non-zero exit) without throwing', async () => {
    const spawn = vi.fn((): PiProcess => mockProcess({ exitCode: 1, output: '' }))
    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toEqual([])
  })

  it('returns an empty array when the child emits nothing before exit', async () => {
    const spawn = vi.fn((): PiProcess => mockProcess({ exitCode: 0, output: '' }))
    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toEqual([])
  })

  it('treats a null exit code as success and parses STDERR', async () => {
    const spawn = vi.fn((): PiProcess => mockProcess({
      exitCode: null,
      output: 'provider   model\nanthropic  claude-opus-4-7\n',
    }))
    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-7' }])
  })

  it('returns an empty array (not a throw) when spawn throws synchronously', async () => {
    const spawn = vi.fn((): PiProcess => {
      throw new Error('spawn boom')
    })

    await expect(probePiModels('/abs/path/pi', spawn)).resolves.toEqual([])
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
