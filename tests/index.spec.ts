/**
 * Node-half suite: patch path resolution, atomic file writes, the
 * settings-selection → managed-block pipeline, and apply wiring.
 * @module tests/index
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  apply,
  resolvePatchPath,
  syncManagedBlock,
  writePatchFile,
} from '../src/index.ts'
import { applyManagedBlock, currentEngineOf } from '../src/patch-manager.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../src/namespace.ts'

// Partial mocks so a non-ENOENT read failure is reproducible on every host.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => actual.readFileSync(...args)) }
})

const mockedReadFile = vi.mocked(readFile)
const mockedReadFileSync = vi.mocked(readFileSync)

const NS = LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL

/** In-memory settings provider (same shape as the shared test fixture). */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, doc?: Record<string, unknown>) {
    super(ctx)
    this.doc = structuredClone(doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function boot(doc?: Record<string, unknown>) {
  const ctx = new Context()
  // The claude-code managed block hosts the Claude Code factory in apply(),
  // which requires the agent/session/system-prompt/subprocess services.
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = ctx.plugin(MemorySettings, doc)
  await fiber
  return { ctx, provider: ctx.get('settings') as MemorySettings, fiber }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const dispose = cleanups.pop()!
    await dispose()
  }
  vi.restoreAllMocks()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-test-'))
  cleanups.push(async () => {
    // Renaming a just-written file can leave the Windows directory entry stale;
    // Node's built-in retry handles ENOTEMPTY/EBUSY/EPERM.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

describe('resolvePatchPath', () => {
  it('defaults to the web profile cordis.patch.yml under the dsh home', () => {
    expect(resolvePatchPath({})).toBe(join(resolveDshHome(), 'profiles', 'web', 'cordis.patch.yml'))
  })

  it('honors a custom profile and patch filename', () => {
    expect(resolvePatchPath({ profile: 'claude-loop', patchFilename: 'patches.yml' }))
      .toBe(join(resolveDshHome(), 'profiles', 'claude-loop', 'patches.yml'))
  })

  it('prefers an explicit patchPath over profile derivation', () => {
    expect(resolvePatchPath({ patchPath: '/tmp/x.yml', profile: 'web' })).toBe('/tmp/x.yml')
  })

  it('treats an empty patchPath as absent', () => {
    expect(resolvePatchPath({ patchPath: '' })).toBe(join(resolveDshHome(), 'profiles', 'web', 'cordis.patch.yml'))
  })
})

describe('writePatchFile', () => {
  it('creates parent directories and writes the text', async () => {
    const dir = await tempDir()
    const path = join(dir, 'a', 'b', 'cordis.patch.yml')
    await writePatchFile(path, '# hello\n')
    expect(await readFile(path, 'utf8')).toBe('# hello\n')
  })

  it('leaves no temporary files behind', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writePatchFile(path, 'x\n')
    const leftover = (await readdir(dir)).filter(name => name.includes('.tmp-'))
    expect(leftover).toEqual([])
  })

  it('overwrites an existing file', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, 'old\n')
    await writePatchFile(path, 'new\n')
    expect(await readFile(path, 'utf8')).toBe('new\n')
  })
})

describe('syncManagedBlock', () => {
  it('creates a missing file with the claude-code block', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const changed = await syncManagedBlock(path, 'claude-code')
    expect(changed).toBe(true)
    const text = await readFile(path, 'utf8')
    expect(currentEngineOf(text)).toBe('claude-code')
    expect(text).toContain('- id: agent-loop\n  disabled: true')
  })

  it('reports no change when the file already matches', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n', 'claude-code'))
    const changed = await syncManagedBlock(path, 'claude-code')
    expect(changed).toBe(false)
  })

  it('switches an existing block to in-process, preserving surrounding lines', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const seed = '# my patches\n- id: tool-x\n'
    await writeFile(path, applyManagedBlock(seed, 'claude-code'))
    const changed = await syncManagedBlock(path, 'in-process')
    expect(changed).toBe(true)
    const text = await readFile(path, 'utf8')
    expect(text).toBe(seed)
    expect(currentEngineOf(text)).toBe('in-process')
  })

  it('leaves a matching in-process file untouched', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '# seed\n')
    const changed = await syncManagedBlock(path, 'in-process')
    expect(changed).toBe(false)
  })

  it('rejects a non-ENOENT read failure instead of swallowing it', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    mockedReadFile.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    await expect(syncManagedBlock(path, 'in-process')).rejects.toThrow('EACCES')
  })
})

describe('apply', () => {
  it('seeds the section from the file and rewrites the block on a settings commit', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    apply(ctx, { patchPath: path })

    // Attach: entry seeded from the absent file (in-process), no write.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await safeRead(path)).toBeUndefined()

    // Committed settings change drives the managed block into the file.
    await ctx.settings.update(NS, { engine: 'claude-code' })
    await vi.waitFor(async () => {
      const text = await safeRead(path)
      expect(text).toBeDefined()
      expect(currentEngineOf(text ?? '')).toBe('claude-code')
    })
    // Let the fire-and-forget rename settle before teardown touches the dir.
    await new Promise(resolve => setTimeout(resolve, 30))

    await fiber.dispose()
  })

  it('is idempotent: attach does not write when the file already matches', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const seed = applyManagedBlock('# seed\n', 'claude-code')
    await writeFile(path, seed)
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    apply(ctx, { patchPath: path })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await readFile(path, 'utf8')).toBe(seed)

    await fiber.dispose()
  })

  it('forwards the engine-driver configuration to the hosted Claude Code factory', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const seed = applyManagedBlock('# seed\n', 'claude-code')
    await writeFile(path, seed)
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    apply(ctx, {
      patchPath: path,
      permissionMode: 'plan',
      env: { ANTHROPIC_AUTH_TOKEN: 'x' },
      model: 'claude-opus-4-6',
      disposeGraceMs: 1000,
      maxTurns: 4,
    })
    const loop = ctx.get('agentLoopClaudeCode')
    expect(loop).toBeDefined()
    expect(loop!.config).toMatchObject({
      permissionMode: 'plan',
      env: { ANTHROPIC_AUTH_TOKEN: 'x' },
      model: 'claude-opus-4-6',
      disposeGraceMs: 1000,
      maxTurns: 4,
    })

    await fiber.dispose()
  })

  it('logs and keeps the old engine when the write fails', async () => {
    const dir = await tempDir()
    // Point the file write at a path whose parent is a file: mkdir and rename
    // both fail, so the block write rejects and the plugin reports it.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'x')
    const badPath = join(blocker, 'cordis.patch.yml')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    apply(ctx, { patchPath: badPath })
    await new Promise(resolve => setTimeout(resolve, 20))
    await ctx.settings.update(NS, { engine: 'claude-code' })
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled()
    })

    await fiber.dispose()
  })

  it('propagates a non-ENOENT failure from the startup read', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    mockedReadFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    const { ctx, fiber } = await boot()
    expect(() => apply(ctx, { patchPath: path })).toThrow('EACCES')
    await fiber.dispose()
  })
})

async function safeRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}