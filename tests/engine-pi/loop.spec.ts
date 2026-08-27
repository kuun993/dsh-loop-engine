/**
 * Unit tests for the Pi loop's subprocess plumbing: the spawn-spec projection,
 * the subprocess-handle → transport projection, the resolved CLI entrypoint,
 * and the sandboxed spawn capability.
 */

import { describe, expect, it, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { PiLoop, PI_SANDBOX_MODES, PI_DISPOSE_GRACE_MS } from '../../src/engine-pi/loop.ts'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { PiProcess } from '../../src/engine-pi/rpc/client.ts'

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
  } as SubprocessHandle
}

/** Minimal Context carrying just the services the loop reads at construction. */
async function loopCtx(spawn: (spec: unknown) => unknown): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  ctx.provide('subprocess', { spawn })
  return ctx
}

describe('PiLoop spawn plumbing', () => {
  it('resolves the Pi CLI entrypoint to a real path', async () => {
    const spawn = vi.fn(() => fakeHandle())
    const ctx = await loopCtx(spawn)
    try {
      const loop = new PiLoop(ctx, {})
      expect(loop.bin).toContain('@earendil-works')
      expect(loop.bin).toMatch(/pi-coding-agent[\\/].*[\\/]cli\.js$/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('projects a spawn request onto the subprocess seam and returns the transport', async () => {
    const handle = fakeHandle()
    const spawn = vi.fn(() => handle)
    const ctx = await loopCtx(spawn)
    try {
      const loop = new PiLoop(ctx, {})
      const transport = loop.spawn({ argv: ['cli.js', '--mode', 'rpc'], cwd: '/t', env: { A: '1' } })
      expect(spawn).toHaveBeenCalledWith({
        argv: [process.execPath, 'cli.js', '--mode', 'rpc'],
        cwd: '/t',
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: PI_DISPOSE_GRACE_MS,
        env: { A: '1' },
      })
      expect(transport.stdin).toBe(handle.stdin)
      expect(transport.stdout).toBe(handle.stdout)
      expect(transport.stderr).toBe(handle.stderr)

      transport.terminate()
      expect(handle.terminate).toHaveBeenCalledTimes(1)

      // The exit hook is wired to the seam outcome.
      const ended = new Promise<boolean>((resolve) => { transport.onExit(() => resolve(true)) })
      await expect(ended).resolves.toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('round-trips a PiProcess through its event emitter hooks', async () => {
    const handle = fakeHandle()
    const spawn = vi.fn(() => handle)
    const ctx = await loopCtx(spawn)
    try {
      const loop = new PiLoop(ctx, {})
      const transport = loop.spawn({ argv: ['cli.js'], cwd: '/t', env: {} }) as PiProcess & { stderr: Readable }
      // A data listener flows the pipes; pushing stderr must not throw.
      transport.stderr.on('data', () => {})
      transport.stderr.push('log\n')
      expect(spawn).toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('exposes the accepted sandbox modes', () => {
    expect(PI_SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })
})
