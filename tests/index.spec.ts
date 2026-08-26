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
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  apply,
  resolvePatchPath,
  syncManagedBlock,
  writePatchFile,
} from '../src/index.ts'
import { applyManagedBlock, currentEngineOf } from '../src/patch-manager.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../src/namespace.ts'
import { CLAUDE_CODE_COMMANDS, type CommandDefinition } from '../src/commands.ts'
import { ClaudeCodeSkillProvider, type SkillProvider, type SkillProviderControl } from '../src/skills.ts'

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
    // The Claude Code factory mounts as a plugin fiber, which starts
    // asynchronously after apply() returns.
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })
    const loop = ctx.get('agentLoopClaudeCode')!
    expect(loop.config).toMatchObject({
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

/** The loop-engine namespace branded for settings writes (the bare literal is not a SettingsNamespace). */
const NS_BRANDED = NS as SettingsNamespace

/** A stand-in for the base agent-loop's factory while it owns the slot. */
function fakeAgentFactory(): AgentFactory {
  return {
    createAgent: vi.fn(async () => { throw new Error('base factory must not serve claude sessions') }),
    resume: vi.fn(async () => { throw new Error('base factory must not serve claude sessions') }),
  } as unknown as AgentFactory
}

/** Fake host commands service: records registrations and hands out recording disposers. */
function fakeCommandsService() {
  const registered: CommandDefinition[] = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const register = vi.fn((def: CommandDefinition) => {
    registered.push(def)
    const dispose = vi.fn()
    disposers.push(dispose)
    return dispose
  })
  return { registered, disposers, register }
}

/** Fake host skills service: records provider factories and hands out a recording disposer. */
function fakeSkillsService() {
  const creates: Array<(control: SkillProviderControl) => SkillProvider> = []
  const disposer = vi.fn()
  const registerProvider = vi.fn((create: (control: SkillProviderControl) => SkillProvider) => {
    creates.push(create)
    return disposer
  })
  return { creates, disposer, registerProvider }
}

describe('apply mount registrations', () => {
  it('registers commands and the skill provider while claude-code is mounted, and disposes them on unmount', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n', 'claude-code'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    const commands = fakeCommandsService()
    const skills = fakeSkillsService()
    ctx.provide('commands', commands)
    ctx.provide('skills', skills)
    apply(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(commands.registered.map(def => def.name)).toEqual(CLAUDE_CODE_COMMANDS.map(def => def.name))
    expect(skills.creates).toHaveLength(1)
    const control: SkillProviderControl = { signal: new AbortController().signal, invalidate: () => {} }
    expect(skills.creates[0]!(control)).toBeInstanceOf(ClaudeCodeSkillProvider)

    await ctx.settings.update(NS_BRANDED, { engine: 'in-process' })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()
    })
    expect(commands.disposers).toHaveLength(CLAUDE_CODE_COMMANDS.length)
    for (const dispose of commands.disposers) expect(dispose).toHaveBeenCalledTimes(1)
    expect(skills.disposer).toHaveBeenCalledTimes(1)

    await fiber.dispose()
  })

  it('cleans up registrations when the factory fails to start, and tolerates a later unmount', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n', 'claude-code'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    const commands = fakeCommandsService()
    const skills = fakeSkillsService()
    ctx.provide('commands', commands)
    ctx.provide('skills', skills)
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    // A non-finite grace makes the loop's config boundary throw, so the
    // plugin fiber rejects and mountClaude rolls its registrations back.
    apply(ctx, { patchPath: path, disposeGraceMs: Number.NaN })

    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('claude-code factory failed to start'))).toBe(true)
    })
    for (const dispose of commands.disposers) expect(dispose).toHaveBeenCalledTimes(1)
    expect(skills.disposer).toHaveBeenCalledTimes(1)

    // The failed mount cleared its slot: a later switch back to in-process
    // runs the unmount path with nothing left to tear down.
    await ctx.settings.update(NS_BRANDED, { engine: 'in-process' })
    await vi.waitFor(async () => {
      expect(currentEngineOf((await safeRead(path)) ?? '')).toBe('in-process')
    })

    await fiber.dispose()
  })

  it('reports the failure when the factory fails to start without host services', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n', 'claude-code'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    apply(ctx, { patchPath: path, disposeGraceMs: Number.NaN })

    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('claude-code factory failed to start'))).toBe(true)
    })
    expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()

    await fiber.dispose()
  })

  it('keeps the mounted factory when a failed block write re-enters the mount path', async () => {
    const dir = await tempDir()
    // Point the file write at a path whose parent is a file: the managed
    // block write keeps failing, so fileEngine stays pinned to in-process.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'x')
    const badPath = join(blocker, 'cordis.patch.yml')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    apply(ctx, { patchPath: badPath })
    await new Promise(resolve => setTimeout(resolve, 20))

    // First switch mounts the factory but cannot persist the selection.
    await ctx.settings.update(NS_BRANDED, { engine: 'claude-code' })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })
    // Bouncing the settings value re-enters the mount path while the fiber
    // is already mounted: the second mount must be a no-op, not a duplicate.
    await ctx.settings.update(NS_BRANDED, { engine: 'in-process' })
    await ctx.settings.update(NS_BRANDED, { engine: 'claude-code' })
    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.filter(call => String(call[0]).includes('managed block write failed'))).toHaveLength(2)
    })
    expect(ctx.get('agentLoopClaudeCode')).toBeDefined()

    await fiber.dispose()
  })

  it('recovers the factory slot when a runtime switch races the base loop disposal', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    // Boot with the base row active (in-process): the plugin mounts nothing.
    await writeFile(path, '# seed\n')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    // The base agent-loop owns the single AgentFactory slot, like a real boot.
    const releaseBase = ctx.agents.setFactory(fakeAgentFactory())
    apply(ctx, { patchPath: path })
    // installSettingsSection registers the namespace inside a dependency
    // inject callback; settle it before driving the settings scope.
    await new Promise(resolve => setTimeout(resolve, 20))

    // Switching to claude-code mounts the factory while the base still owns
    // the slot: setFactory rejects, so the hosted factory stays unmounted
    // until the patch-layer reload (which disables the base row) releases it.
    await ctx.settings.update(NS_BRANDED, { engine: 'claude-code' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()

    // The reload lands: the base loop's factory is released, and the bounded
    // retry registers the Claude Code factory in its place.
    releaseBase()
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })

    // The slot is served again: a create reaches the Claude Code factory
    // instead of failing with "no agent factory registered".
    const handle = await ctx.agents.create({
      sessionId: SessionId('runtime-switch-s'),
      meta: { cwd: process.cwd() },
    })
    expect(handle.agent).toBeDefined()
    await handle.dispose()

    await fiber.dispose()
  })

  it('clears a pending slot retry when the plugin is disposed', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '# seed\n')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } })
    ctx.agents.setFactory(fakeAgentFactory()) // never released
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    apply(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 20))

    await ctx.settings.update(NS_BRANDED, { engine: 'claude-code' })
    // Let the first collision land and the retry be scheduled, then tear the
    // plugin down while the retry is still pending.
    await new Promise(resolve => setTimeout(resolve, 30))
    await ctx.fiber.dispose()

    // The pending retry was cleared: no late failure log after disposal.
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(errorSpy.mock.calls.some(call => String(call[0]).includes('claude-code factory failed to start'))).toBe(false)
  })

  it('fails loud when the base loop never releases the factory slot', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '# seed\n')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    const releaseBase = ctx.agents.setFactory(fakeAgentFactory())
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    apply(ctx, { patchPath: path })
    // Settle the settings-section registration before driving the switch.
    await new Promise(resolve => setTimeout(resolve, 20))

    await ctx.settings.update(NS_BRANDED, { engine: 'claude-code' })
    // The retry window exhausts without the slot ever freeing: one loud
    // failure instead of an endless mount loop.
    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('claude-code factory failed to start'))).toBe(true)
    }, { timeout: 5000 })
    expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()
    releaseBase()

    await fiber.dispose()
  })
})

describe('apply codex engine', () => {
  it('mounts the codex factory and forwards the codex driver configuration', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n', 'codex'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'codex' } })
    const commands = fakeCommandsService()
    const skills = fakeSkillsService()
    ctx.provide('commands', commands)
    ctx.provide('skills', skills)
    apply(ctx, {
      patchPath: path,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
      env: { CX_ENV: '1' },
      model: 'gpt-5.2-codex',
      apiKey: 'sk-x',
      baseUrl: 'https://codex.example.test/v1',
      networkAccessEnabled: true,
      disposeGraceMs: 1000,
      maxTurns: 4,
    })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })
    const loop = ctx.get('agentLoopCodex')!
    expect(loop.config).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
      env: { CX_ENV: '1' },
      model: 'gpt-5.2-codex',
      apiKey: 'sk-x',
      baseUrl: 'https://codex.example.test/v1',
      networkAccessEnabled: true,
      disposeGraceMs: 1000,
      maxTurns: 4,
    })
    // The codex engine registers no commands or skill provider in this version.
    expect(commands.registered).toHaveLength(0)
    expect(skills.creates).toHaveLength(0)
    expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()

    await fiber.dispose()
  })

  it('switches between hosted engines in the same process', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n', 'claude-code'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    apply(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })

    // claude-code -> codex: the claude fiber unmounts and the codex fiber mounts.
    await ctx.settings.update(NS_BRANDED, { engine: 'codex' })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()
    })
    expect(currentEngineOf(await readFile(path, 'utf8'))).toBe('codex')

    // codex -> in-process: the codex fiber unmounts and the block leaves the file.
    await ctx.settings.update(NS_BRANDED, { engine: 'in-process' })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeUndefined()
    })
    expect(currentEngineOf(await readFile(path, 'utf8'))).toBe('in-process')

    await fiber.dispose()
  })

  it('reports the failure when the codex factory fails to start', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n', 'codex'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'codex' } })
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    apply(ctx, { patchPath: path, disposeGraceMs: Number.NaN })

    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('codex factory failed to start'))).toBe(true)
    })
    expect(ctx.get('agentLoopCodex')).toBeUndefined()

    await fiber.dispose()
  })
})
