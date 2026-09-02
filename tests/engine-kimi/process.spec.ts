/**
 * Unit tests for the Kimi CLI process projection: the executable resolver, the
 * persistent `kimi acp` argv builder, the subprocess-spec projection, and the
 * handle → transport projection.
 * @module tests/engine-kimi/process
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { join } from 'node:path'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  fromSubprocess,
  kimiAcpArgv,
  kimiBinResolver,
  kimiHomeDir,
  kimiSubprocessSpec,
  type KimiSpawnSpec,
} from '../../src/engine-kimi/process.ts'

vi.mock('node:os', () => ({ homedir: () => '/home/tester' }))
vi.mock('node:fs', () => ({ existsSync: vi.fn() }))

import { existsSync } from 'node:fs'

const mockedExistsSync = vi.mocked(existsSync)

beforeEach(() => {
  mockedExistsSync.mockReset()
  delete process.env.KIMI_CODE_HOME
})

/** The Kimi executable suffix for the current platform. */
const EXE = process.platform === 'win32' ? 'kimi.exe' : 'kimi'

describe('kimiHomeDir', () => {
  it('prefers the KIMI_CODE_HOME environment override', () => {
    process.env.KIMI_CODE_HOME = '/custom/home'
    expect(kimiHomeDir()).toBe('/custom/home')
  })

  it('falls back to the user home when KIMI_CODE_HOME is empty', () => {
    process.env.KIMI_CODE_HOME = ''
    expect(kimiHomeDir()).toBe(join('/home/tester', '.kimi-code'))
  })
})

describe('kimiBinResolver', () => {
  it('returns an explicit config path verbatim', () => {
    expect(kimiBinResolver('C:\\tools\\kimi.exe')).toBe('C:\\tools\\kimi.exe')
  })

  it('resolves the standard install location when it exists', () => {
    process.env.KIMI_CODE_HOME = '/kimi-home'
    mockedExistsSync.mockReturnValue(true)
    const expected = join('/kimi-home', 'bin', EXE)
    expect(kimiBinResolver('')).toBe(expected)
    expect(mockedExistsSync).toHaveBeenCalledWith(expected)
  })

  it('falls back to the bare kimi command when the standard location is absent', () => {
    process.env.KIMI_CODE_HOME = '/kimi-home'
    mockedExistsSync.mockReturnValue(false)
    expect(kimiBinResolver(undefined)).toBe('kimi')
  })
})

describe('kimiAcpArgv', () => {
  it('builds the persistent acp argv with no prompt (the request body carries it)', () => {
    expect(kimiAcpArgv('/bin/kimi')).toEqual(['/bin/kimi', 'acp'])
  })
})

describe('kimiSubprocessSpec', () => {
  const spec: KimiSpawnSpec = { argv: ['/bin/kimi', 'acp'], cwd: '/w', env: { A: '1' } }

  it('projects the request plus piped stdio and grace', () => {
    expect(kimiSubprocessSpec(spec, 3000)).toEqual({
      argv: ['/bin/kimi', 'acp'],
      cwd: '/w',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
      env: { A: '1' },
    })
  })

  it('forwards an abort signal when present and copies argv otherwise', () => {
    const signal = new AbortController().signal
    const projected = kimiSubprocessSpec({ ...spec, signal }, 3000)
    expect(projected.signal).toBe(signal)
    projected.argv.push('extra')
    expect(spec.argv).toHaveLength(2)
  })
})

describe('fromSubprocess', () => {
  function fakeHandle(overrides?: Partial<SubprocessHandle>): SubprocessHandle {
    return {
      pid: 1,
      stdin: new Writable({ write: (_c, _e, cb) => { cb() } }),
      stdout: new Readable({ read: () => {} }),
      stderr: new Readable({ read: () => {} }),
      collected: {} as SubprocessHandle['collected'],
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => true),
      ...overrides,
    } as SubprocessHandle
  }

  it('projects a handle onto the Kimi process transport including stdin', () => {
    const handle = fakeHandle()
    const process = fromSubprocess(handle)
    expect(process.stdin).toBe(handle.stdin)
    expect(process.stdout).toBe(handle.stdout)
    expect(process.stderr).toBe(handle.stderr)
    expect(process.done).toBe(handle.done)
    process.terminate()
    expect(handle.terminate).toHaveBeenCalledTimes(1)
  })

  it('throws on a handle without piped stdio streams', () => {
    expect(() => fromSubprocess(fakeHandle({ stdin: undefined, stdout: undefined, stderr: undefined }))).toThrow('must pipe stdin/stdout/stderr')
  })
})
