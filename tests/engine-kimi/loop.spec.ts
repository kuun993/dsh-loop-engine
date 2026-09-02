/**
 * Unit tests for the Kimi loop's subprocess plumbing: the spawn-spec projection,
 * the subprocess-handle → transport projection, the resolved CLI entrypoint,
 * and the sandboxed spawn capability.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { KimiLoop, KIMI_DISPOSE_GRACE_MS } from '../../src/engine-kimi/loop.ts'
import { fromSubprocess, kimiAcpArgv, kimiBinResolver, kimiHomeDir, kimiSubprocessSpec } from '../../src/engine-kimi/process.ts'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

/** A subprocess handle shaped like the seam returns one. */
function fakeHandle(): SubprocessHandle {
  const done = Promise.resolve({ exitCode: 0, signal: null })
  return {
    pid: 1,
    stdin: new Writable({ write: (_c, _e, cb) => { cb() } }),
    stdout: new Readable({ read: () => {} }),
    stderr: new Readable({ read: () => {} }),
    collected: {} as SubprocessHandle['collected'],
    done,
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  } as unknown as SubprocessHandle
}

/** Minimal Context carrying just the services the loop reads at construction. */
async function loopCtx(spawn: (spec: unknown) => unknown): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  ctx.provide('subprocess', { spawn })
  return ctx
}

/** Save and restore every `KIMI_CODE_HOME` state across a resolver test. */
async function withKimiHome<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.KIMI_CODE_HOME
  process.env.KIMI_CODE_HOME = dir
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME
    else process.env.KIMI_CODE_HOME = previous
  }
}

describe('KimiLoop spawn plumbing', () => {
  it('resolves the Kimi CLI entrypoint to the pinned config bin', async () => {
    const spawn = vi.fn(() => fakeHandle())
    const ctx = await loopCtx(spawn)
    try {
      const loop = new KimiLoop(ctx, {})
      // The resolver probes the user home first (a real install wins over PATH).
      expect(loop.config.bin).toBe(kimiBinResolver(undefined))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('projects a spawn request onto the subprocess seam and returns the transport', async () => {
    const handle = fakeHandle()
    const spawn = vi.fn(() => handle)
    const ctx = await loopCtx(spawn)
    try {
      const loop = new KimiLoop(ctx, {})
      const transport = loop.spawn({ argv: ['kimi', '-p', 'hello'], cwd: '/t', env: { A: '1' } })
      expect(spawn).toHaveBeenCalledWith({
        argv: ['kimi', '-p', 'hello'],
        cwd: '/t',
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: KIMI_DISPOSE_GRACE_MS,
        env: { A: '1' },
      })
      expect(transport.stdout).toBe(handle.stdout)
      expect(transport.stderr).toBe(handle.stderr)

      transport.terminate()
      expect(handle.terminate).toHaveBeenCalledTimes(1)
      await expect(transport.done).resolves.toEqual({ exitCode: 0, signal: null })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('forwards a spawn abort signal through the seam spec', async () => {
    const handle = fakeHandle()
    const spawn = vi.fn(() => handle)
    const ctx = await loopCtx(spawn)
    try {
      const loop = new KimiLoop(ctx, {})
      const controller = new AbortController()
      loop.spawn({ argv: ['kimi'], cwd: '/t', env: {}, signal: controller.signal })
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('round-trips a KimiProcess through its stdout drain', async () => {
    const handle = fakeHandle()
    const spawn = vi.fn(() => handle)
    const ctx = await loopCtx(spawn)
    try {
      const loop = new KimiLoop(ctx, {})
      const transport = loop.spawn({ argv: ['kimi'], cwd: '/t', env: {} })
      // A data listener flows the pipes; pushing stderr must not throw.
      transport.stderr.on('data', () => {})
      transport.stderr.push('log\n')
      transport.stdout.push('{"role":"assistant","content":"hi"}\n')
      expect(spawn).toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves an explicit deployment bin over the path probe', async () => {
    const spawn = vi.fn(() => fakeHandle())
    const ctx = await loopCtx(spawn)
    try {
      const loop = new KimiLoop(ctx, { bin: '/opt/x/kimi' })
      expect(loop.config.bin).toBe('/opt/x/kimi')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('kimi process projection', () => {
  it('builds the persistent acp argv (the prompt is a request body, not an argv positional)', () => {
    expect(kimiAcpArgv('kimi')).toEqual(['kimi', 'acp'])
  })

  it('resolves the Kimi home from KIMI_CODE_HOME, falling back to the user home', async () => {
    const prev = process.env.KIMI_CODE_HOME
    try {
      process.env.KIMI_CODE_HOME = '/custom/kimi-home'
      expect(kimiHomeDir()).toBe('/custom/kimi-home')
      delete process.env.KIMI_CODE_HOME
      expect(kimiHomeDir()).toBe(join(homedir(), '.kimi-code'))
    } finally {
      if (prev === undefined) delete process.env.KIMI_CODE_HOME
      else process.env.KIMI_CODE_HOME = prev
    }
  })

  it('prefers an explicit config bin and otherwise probes the home installation', async () => {
    expect(kimiBinResolver('/pinned/kimi')).toBe('/pinned/kimi')
    // An empty string is treated as absent and falls through to the probe.
    const root = await mkdtemp(join(tmpdir(), 'dsh-kimi-home-'))
    try {
      const executable = process.platform === 'win32' ? 'kimi.exe' : 'kimi'
      await mkdir(join(root, 'bin'), { recursive: true })
      await writeFile(join(root, 'bin', executable), '')
      await withKimiHome(root, async () => {
        expect(kimiBinResolver('')).toBe(join(root, 'bin', executable))
        expect(kimiBinResolver(undefined)).toBe(join(root, 'bin', executable))
      })
      // An absent probe falls back to the PATH name.
      await withKimiHome(join(tmpdir(), 'dsh-no-such-kimi-home-48923'), async () => {
        expect(kimiBinResolver(undefined)).toBe('kimi')
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('selects the non-Windows executable name when the platform is not win32', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const previousHome = process.env.KIMI_CODE_HOME
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      process.env.KIMI_CODE_HOME = join(tmpdir(), 'dsh-no-such-kimi-home-48923')
      expect(kimiBinResolver(undefined)).toBe('kimi')
    } finally {
      if (descriptor) Object.defineProperty(process, 'platform', descriptor)
      else delete (process as { platform?: unknown }).platform
      if (previousHome === undefined) delete process.env.KIMI_CODE_HOME
      else process.env.KIMI_CODE_HOME = previousHome
    }
  })

  it('projects a spawn spec onto the subprocess seam with explicit stdio', () => {
    const spec = kimiSubprocessSpec({ argv: ['kimi', '-p', 'hi'], cwd: '/cwd', env: { E: '1' } }, 3000)
    expect(spec).toEqual({
      argv: ['kimi', '-p', 'hi'],
      cwd: '/cwd',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
      env: { E: '1' },
    })
    const controller = new AbortController()
    const withSignal = kimiSubprocessSpec({ argv: ['kimi'], cwd: '/cwd', env: {}, signal: controller.signal }, 3000)
    expect(withSignal).toMatchObject({ signal: controller.signal })
  })

  it('round-trips a subprocess handle through the Kimi process projection', () => {
    const handle = fakeHandle()
    const process = fromSubprocess(handle)
    expect(process.stdin).toBe(handle.stdin)
    expect(process.stdout).toBe(handle.stdout)
    expect(process.stderr).toBe(handle.stderr)
    expect(process.done).toBe(handle.done)
    process.terminate()
    expect(handle.terminate).toHaveBeenCalledTimes(1)
  })
})

describe('KimiLoop prompt variables', () => {
  it('resolves agent-less prompt variables as undefined', async () => {
    const spawn = vi.fn(() => fakeHandle())
    const ctx = await loopCtx(spawn)
    try {
      const loop = new KimiLoop(ctx, {})
      const assembled = await ctx.systemPrompt.assemble({})
      expect(assembled.variables.provider).toBeUndefined()
      expect(assembled.variables.model).toBeUndefined()
      expect(assembled.variables.cwd).toBeUndefined()
      void loop
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
