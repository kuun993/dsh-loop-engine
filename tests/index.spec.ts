/**
 * Node-half suite: patch path resolution, atomic patch writes, the managed
 * block, and `apply`'s composition-time wiring — the router mount, the
 * per-engine agent presets, the hosted-engine provider routes, and the default
 * engine the settings section steers.
 * @module tests/index
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  apply,
  resolvePatchPath,
  syncManagedBlock,
  writePatchFile,
  writePatchFileSync,
  type Config,
} from '../src/index.ts'
import {
  applyManagedBlock,
  legacyBlockEngineOf,
  LEGACY_MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
} from '../src/patch-manager.ts'
import { HOSTED_ROUTE_LABEL } from '../src/agent-preset-ids.ts'
import { HostedEngineRouteAdapter } from '../src/provider-route.ts'
import { fakeToolRuntime } from './helpers/tool-runtime.ts'
import { ClaudeCodeSkillProvider, type SkillProvider, type SkillProviderControl } from '../src/skills.ts'
import { CodexSkillProvider } from '../src/engine-codex/skills.ts'
import { PiSkillProvider } from '../src/engine-pi/skills.ts'
import { KimiSkillProvider } from '../src/engine-kimi/skills.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../src/namespace.ts'
import {
  COMPOSITION_FILE,
  enginePresetId,
  HOSTED_PRESET_IDS,
  METADATA_FILE,
  SOURCE_PRESET_ID,
  USER_PRESET_DIR,
} from '../src/preset.ts'

// Partial mocks so a non-ENOENT read failure and a write failure are
// reproducible on every host, and so the atomic-write temp path is observable.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => actual.writeFile(...args)),
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => actual.readFileSync(...args)),
    // Wrapped so a single synchronous block write can be made to fail.
    writeFileSync: vi.fn((...args: unknown[]) => (actual.writeFileSync as (...a: unknown[]) => void)(...args)),
  }
})

const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)
const mockedReadFileSync = vi.mocked(readFileSync)
const mockedWriteFileSync = vi.mocked(writeFileSync)

/**
 * Hoisted home path so the os homedir mock can return it. Every test gets a
 * fresh empty home, which keeps `resolveDshHome()` — and therefore the user
 * preset root the plugin authors into — inside the test's temp directory
 * instead of the developer's real `~/.dsh`.
 */
const mockHome = vi.hoisted(() => ({ path: '' }))

vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>()
  return { ...mod, homedir: () => mockHome.path }
})

beforeEach(async () => {
  mockHome.path = await tempDir()
})

const NS = LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL
const NS_BRANDED = NS as SettingsNamespace

/** The resolved loop-engine section, as `apply` seeds it. */
interface Section {
  engine: string
  showInComposer: boolean
}

/** Read the loop-engine settings section; `undefined` before it attaches. */
function sectionOf(ctx: Context): Section | undefined {
  return ctx.settings.get(NS_BRANDED) as Section | undefined
}

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

/**
 * Minimal stand-in for the host session-projection registry.
 *
 * The router extends the harness `AgentLoop`, whose constructor and agent
 * register `turnBoundary`/`inbox` units through `ctx.sessionProjections`. That
 * registry is not a dependency of this package (a minimal profile may compose
 * none), so the suite supplies a structural stand-in: registrations are
 * recorded and a session's cell is folded to the definition's `init`, which is
 * all the loop reads back before a turn runs.
 */
function fakeSessionProjections() {
  const definitions = new Map<string, { init: () => unknown }>()
  const cells = new WeakMap<object, Map<string, unknown>>()
  return {
    register: vi.fn((definition: { key: string; init: () => unknown }) => {
      definitions.set(definition.key, definition)
      return () => { definitions.delete(definition.key) }
    }),
    stateOf: (session: object, key: string): unknown => {
      let byKey = cells.get(session)
      if (byKey === undefined) {
        byKey = new Map()
        cells.set(session, byKey)
      }
      if (!byKey.has(key)) {
        const definition = definitions.get(key)
        if (definition === undefined) return undefined
        byKey.set(key, definition.init())
      }
      return byKey.get(key)
    },
  }
}

async function boot(doc?: Record<string, unknown>, opts?: { llm?: boolean; projections?: boolean }) {
  const ctx = new Context()
  // Unload the whole root last, so every service and fiber this test composed is
  // torn down instead of leaving a `process` exit listener per test behind.
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  // The real llm registry, present in the web profile: the plugin serves its
  // hosted-engine provider route placeholders from it. Tests for the attach
  // race pass { llm: false } and plugin the registry themselves later.
  if (opts?.llm !== false) await ctx.plugin(LlmRuntime)
  // Mounting the router needs every service the harness loop declares — the
  // projection registry it folds its own units through, and the tool registry
  // its turn machinery reads. Every other test leaves both out, so no factory
  // slot is taken and the test drives one concern at a time.
  if (opts?.projections === true) {
    ctx.provide('sessionProjections', fakeSessionProjections())
    ctx.provide('tools', fakeToolRuntime())
  }
  const settingsFiber = ctx.plugin(MemorySettings, doc)
  await settingsFiber
  cleanups.push(async () => { await settingsFiber.dispose() })
  return { ctx, provider: ctx.get('settings') as MemorySettings, settingsFiber }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const dispose = cleanups.pop()!
    await dispose()
  }
  vi.unstubAllEnvs()
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

/** Mount the plugin as its own fiber, the way its composition row does. */
async function mountPlugin(ctx: Context, config: Config): Promise<Fiber> {
  const fiber = ctx.plugin({
    name: 'loop-engine-under-test',
    apply: (pluginCtx: Context) => { apply(pluginCtx, config) },
  })
  await fiber
  cleanups.push(async () => { await fiber.dispose() })
  return fiber
}

/** A patch file carrying the pre-routing block form that named one engine. */
function legacyBlockFile(engine: string): string {
  return [
    '# seed',
    '',
    `${LEGACY_MANAGED_BLOCK_BEGIN}${engine} --`,
    '- id: agent-loop',
    '  disabled: true',
    '- id: command-goal',
    '  disabled: true',
    MANAGED_BLOCK_END,
    '',
  ].join('\n')
}

/** A path whose parent is a regular file, so every write under it fails. */
async function blockedWritePath(dir: string): Promise<string> {
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'x')
  return join(blocker, 'cordis.patch.yml')
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

  it('writes through a temporary file in the target directory, then renames it over the target', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writePatchFile(path, 'x\n')

    const tmp = mockedWriteFile.mock.calls.at(-1)?.[0] as string
    expect(dirname(tmp)).toBe(dir)
    expect(tmp).not.toBe(path)
    expect(tmp).toContain('.tmp-')
    expect(await readFile(path, 'utf8')).toBe('x\n')
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

  it('rejects instead of reporting success when the write path is unusable', async () => {
    const dir = await tempDir()
    await expect(writePatchFile(await blockedWritePath(dir), 'x\n')).rejects.toThrow()
  })
})

describe('writePatchFileSync', () => {
  it('creates parent directories and writes the text', async () => {
    const dir = await tempDir()
    const path = join(dir, 'a', 'b', 'cordis.patch.yml')
    writePatchFileSync(path, '# hello\n')
    expect(await readFile(path, 'utf8')).toBe('# hello\n')
  })

  it('writes through a temporary file in the target directory, then renames it over the target', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    writePatchFileSync(path, 'x\n')

    const tmp = mockedWriteFileSync.mock.calls.at(-1)?.[0] as string
    expect(dirname(tmp)).toBe(dir)
    expect(tmp).not.toBe(path)
    expect(readFileSync(path, 'utf8')).toBe('x\n')
    expect((await readdir(dir)).filter(name => name.includes('.tmp-'))).toEqual([])
  })

  it('propagates a write failure and leaves the target untouched', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, 'old\n')
    mockedWriteFileSync.mockImplementationOnce(() => { throw new Error('read-only') })
    expect(() => writePatchFileSync(path, 'new\n')).toThrow('read-only')
    expect(await readFile(path, 'utf8')).toBe('old\n')
  })

  it('throws when the write path is unusable', async () => {
    const dir = await tempDir()
    const path = await blockedWritePath(dir)
    expect(() => writePatchFileSync(path, 'x\n')).toThrow()
  })
})

describe('syncManagedBlock', () => {
  it('creates a missing file carrying the constant block', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    expect(await syncManagedBlock(path)).toBe(true)
    const text = await readFile(path, 'utf8')
    expect(text).toContain(MANAGED_BLOCK_BEGIN)
    expect(text).toContain('- id: agent-loop\n  disabled: true')
    expect(text).toContain('- id: command-goal\n  disabled: true')
    expect(text).toContain(MANAGED_BLOCK_END)
    expect(legacyBlockEngineOf(text)).toBeUndefined()
  })

  it('seeds an empty file with a loadable top-level array', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '')
    expect(await syncManagedBlock(path)).toBe(true)
    expect(await readFile(path, 'utf8')).toContain(MANAGED_BLOCK_BEGIN)
  })

  it('reports no write when the file already carries the current block', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const seed = applyManagedBlock('# seed\n')
    await writeFile(path, seed)
    expect(await syncManagedBlock(path)).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(seed)
  })

  it('rewrites a legacy block, preserving the surrounding text', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, legacyBlockFile('pi'))
    expect(await syncManagedBlock(path)).toBe(true)

    const text = await readFile(path, 'utf8')
    expect(text).toContain(MANAGED_BLOCK_BEGIN)
    expect(text).not.toContain(LEGACY_MANAGED_BLOCK_BEGIN)
    expect(legacyBlockEngineOf(text)).toBeUndefined()
    expect(text).toContain('# seed')
    expect(text).toContain('- id: agent-loop\n  disabled: true')
  })

  it('rewrites a legacy block naming an engine this build does not know', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, legacyBlockFile('future-engine'))
    // `hasManagedBlock` recognizes that form (it is the current marker plus a
    // suffix), but `legacyBlockEngineOf` can read no engine out of it — and the
    // routing model does not read an engine out of the patch file at all, so an
    // unrecognized name is simply a legacy span: it is migrated to the current
    // engine-agnostic block, like any other.
    expect(await syncManagedBlock(path)).toBe(true)

    const text = await readFile(path, 'utf8')
    expect(text).toContain(MANAGED_BLOCK_BEGIN)
    expect(text).not.toContain(LEGACY_MANAGED_BLOCK_BEGIN)
    expect(legacyBlockEngineOf(text)).toBeUndefined()
    // The user's own bytes around the span survive the rewrite.
    expect(text).toContain('# seed')
    expect(text).toContain('- id: agent-loop\n  disabled: true')
  })

  it('rejects a non-ENOENT read failure instead of swallowing it', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    mockedReadFile.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    await expect(syncManagedBlock(path)).rejects.toThrow('EACCES')
  })
})

describe('apply managed block', () => {
  it('writes the constant managed block into the patch file', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } })
    await mountPlugin(ctx, { patchPath: path })

    const text = await readFile(path, 'utf8')
    expect(text).toContain(MANAGED_BLOCK_BEGIN)
    expect(text).toContain('- id: agent-loop\n  disabled: true')
    expect(text).toContain(MANAGED_BLOCK_END)
    expect(text).not.toContain(LEGACY_MANAGED_BLOCK_BEGIN)
    await vi.waitFor(() => {
      expect(sectionOf(ctx)).toMatchObject({ engine: 'in-process', showInComposer: true })
    })
  })

  it('leaves a file that already carries the block byte for byte intact', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const seed = applyManagedBlock('# my patches\n- id: tool-x\n')
    await writeFile(path, seed)
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } })
    await mountPlugin(ctx, { patchPath: path })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await readFile(path, 'utf8')).toBe(seed)
  })

  it('migrates a legacy block and seeds the section with the engine it named', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, legacyBlockFile('pi'))
    const { ctx } = await boot({})
    await mountPlugin(ctx, { patchPath: path })

    const text = await readFile(path, 'utf8')
    expect(text).not.toContain(LEGACY_MANAGED_BLOCK_BEGIN)
    expect(text).toContain(MANAGED_BLOCK_BEGIN)
    expect(legacyBlockEngineOf(text)).toBeUndefined()
    expect(text).toContain('# seed')
    // The engine the deployment was pinned to survives the upgrade as the
    // default for new sessions.
    await vi.waitFor(() => {
      expect(sectionOf(ctx)?.engine).toBe('pi')
    })
  })

  it('rewrites a legacy block naming an unknown engine and seeds in-process', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, legacyBlockFile('future-engine'))
    const { ctx } = await boot({})
    await mountPlugin(ctx, { patchPath: path })

    // The unrecognized name migrates to the current block like any other
    // legacy span — the router needs the block, not a readable engine.
    const text = await readFile(path, 'utf8')
    expect(text).toContain(MANAGED_BLOCK_BEGIN)
    expect(text).not.toContain(LEGACY_MANAGED_BLOCK_BEGIN)
    expect(legacyBlockEngineOf(text)).toBeUndefined()
    expect(text).toContain('# seed')
    // No engine can be read out of that name, so the deployment keeps running
    // the in-process engine by default.
    await vi.waitFor(() => {
      expect(sectionOf(ctx)?.engine).toBe('in-process')
    })
  })

  it('logs a failed block write instead of throwing', async () => {
    const dir = await tempDir()
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } })
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await mountPlugin(ctx, { patchPath: await blockedWritePath(dir) })

    expect(errorSpy.mock.calls.some(call => String(call[0]).includes('could not write the managed block'))).toBe(true)
  })

  it('propagates a non-ENOENT failure from the startup read', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    mockedReadFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    const { ctx } = await boot()
    expect(() => apply(ctx, { patchPath: path })).toThrow('EACCES')
  })
})

/** Minimal standard-preset composition fixture carrying one stripped row. */
const PRESET_FIXTURE = [
  '# header',
  '',
  '- id: persona',
  `  name: '@deepseek-ai/dsh-persona'`,
  '',
  '# skills',
  '',
  '- id: skill-filesystem',
  `  name: '@deepseek-ai/dsh-skill-filesystem'`,
  '',
  '- id: tool-bash',
  `  name: '@deepseek-ai/dsh-tool-bash'`,
  '',
].join('\n')

interface RosterScope {
  get(): { default?: string }
}

/**
 * Fake agent-presets roster: `defaultId` mirrors the registered settings scope
 * exactly like the real service (`settings?.get().default ?? config.default`).
 */
function fakeRoster(scopeRef: { current: RosterScope | undefined }, composition = PRESET_FIXTURE) {
  return {
    get defaultId() {
      return scopeRef.current?.get().default ?? SOURCE_PRESET_ID
    },
    read: vi.fn(async (id: string) => {
      if (id !== SOURCE_PRESET_ID) throw new Error(`unknown preset "${id}"`)
      return composition
    }),
  }
}

const AGENT_PRESETS_NS = 'agent-presets' as SettingsNamespace
const AGENT_PRESETS_SCHEMA = z.object({ default: z.string() })

/** Register the roster's settings namespace the way dsh-agent-presets does. */
function registerRosterNamespace(ctx: Context): RosterScope {
  return ctx.settings.register(AGENT_PRESETS_NS, AGENT_PRESETS_SCHEMA, { base: { default: SOURCE_PRESET_ID } })
}

/** One managed preset's directory under a stubbed DSH_HOME. */
function presetDir(home: string, preset: string): string {
  return join(home, USER_PRESET_DIR, preset)
}

/**
 * Wait for the boot-time authoring to land on disk.
 *
 * `apply` authors the presets when it mounts, and a LATER default-engine switch
 * shares that same memoized pass instead of authoring again, so this only has to
 * wait the boot-time run out before a test reads the files off disk.
 */
async function waitForEnginePresets(home: string): Promise<void> {
  await vi.waitFor(async () => {
    for (const preset of HOSTED_PRESET_IDS) {
      expect(await readFile(join(presetDir(home, preset), COMPOSITION_FILE), 'utf8'))
        .toContain('Managed by dsh-loop-engine')
      expect(await readFile(join(presetDir(home, preset), METADATA_FILE), 'utf8')).toContain('name: ')
    }
  })
}

describe('apply engine presets', () => {
  it('authors one preset per hosted engine and points the roster default at the switched engine', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx } = await boot()
    const scopeRef = { current: registerRosterNamespace(ctx) }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    await mountPlugin(ctx, { patchPath: path })

    await waitForEnginePresets(home)
    for (const preset of HOSTED_PRESET_IDS) {
      const composition = await readFile(join(presetDir(home, preset), COMPOSITION_FILE), 'utf8')
      expect(composition).toContain('Managed by dsh-loop-engine')
      expect(composition).not.toContain('skill-filesystem')
      expect(composition).toContain('- id: tool-bash')
    }
    expect(await readFile(join(presetDir(home, enginePresetId('kimi')), METADATA_FILE), 'utf8'))
      .toContain('name: Kimi Code')

    // The engine the section names is the default NEW sessions open on.
    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await vi.waitFor(() => {
      expect(scopeRef.current.get().default).toBe(enginePresetId('kimi'))
    })

    // A later commit that leaves the engine alone re-judges nothing: the
    // picker's visibility is a presentation knob, not an engine selection.
    await ctx.settings.update(NS_BRANDED, { showInComposer: false })
    await vi.waitFor(() => {
      expect(sectionOf(ctx)?.showInComposer).toBe(false)
    })
    expect(scopeRef.current.get().default).toBe(enginePresetId('kimi'))
  })

  it('does not author the presets again when a later switch steers the roster', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx } = await boot()
    const scopeRef = { current: registerRosterNamespace(ctx) }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    // The module-level write mock keeps every test's calls, so count from here.
    const start = mockedWriteFile.mock.calls.length
    /** Preset-file writes this test has issued so far. */
    const presetWrites = (): number =>
      mockedWriteFile.mock.calls.slice(start).filter(([file]) => String(file).includes(USER_PRESET_DIR)).length
    await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)

    // The boot-time pass wrote one composition and one metadata file per engine.
    const authored = presetWrites()
    expect(authored).toBe(HOSTED_PRESET_IDS.length * 2)

    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await vi.waitFor(() => {
      expect(scopeRef.current.get().default).toBe(enginePresetId('kimi'))
    })
    // The switch shares the boot-time pass instead of walking the same eight
    // paths again: two concurrent walks of one path lose a `rename` to EPERM on
    // Windows, which would abort the default switch this test asserts.
    expect(presetWrites()).toBe(authored)
  })

  it('authors the presets once the roster service appears', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx } = await boot({ [NS]: { engine: 'kimi' } })
    await mountPlugin(ctx, { patchPath: path })
    // Settle past one retry tick: the roster is not up yet, so there is nothing
    // to author the presets from.
    await new Promise(resolve => setTimeout(resolve, 150))

    const scopeRef = { current: registerRosterNamespace(ctx) }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    await waitForEnginePresets(home)
  })

  it('reports an engine preset that cannot be authored and leaves the roster default alone', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    vi.stubEnv('DSH_HOME', await tempDir())
    const { ctx, provider } = await boot({ [NS]: { engine: 'kimi' } })
    const scopeRef = { current: registerRosterNamespace(ctx) }
    const roster = fakeRoster(scopeRef)
    roster.read.mockRejectedValue(new Error(`unknown preset "${SOURCE_PRESET_ID}"`))
    ctx.provide('agentPresets', roster)
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const persistOf = provider as unknown as {
      persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void>
    }
    const persistSpy = vi.spyOn(persistOf, 'persist')
    await mountPlugin(ctx, { patchPath: path })

    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('engine preset authoring failed'))).toBe(true)
    })
    // A later switch re-attempts the authoring — a failed pass is not memoized —
    // and must not point the roster at a preset that is not on disk: pointing
    // there fails every new session loud, so the steered default waits for an
    // authoring that succeeded.
    await ctx.settings.update(NS_BRANDED, { engine: 'codex' })
    await vi.waitFor(() => {
      expect(roster.read.mock.calls.length).toBeGreaterThan(1)
    })
    expect(persistSpy.mock.calls.filter(call => call[0] === AGENT_PRESETS_NS)).toEqual([])
    expect(scopeRef.current.get().default).toBe(SOURCE_PRESET_ID)
  })

  it('still authors the presets when the profile has no settings service', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    // A settings-less boot: the section install defers and the default write
    // skips quietly, but the presets a session may select still land on disk.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    ctx.provide('agentPresets', fakeRoster({ current: undefined }))
    apply(ctx, { patchPath: path })

    await waitForEnginePresets(home)
    await ctx.fiber.dispose()
  })
})

describe('apply provider routes', () => {
  /** Live provider ids in the booted llm registry. */
  const providerIds = (ctx: Context): string[] =>
    (ctx.get('llm') as LlmRuntime).listProviders().map(provider => provider.id).sort()

  it('serves the one shared label and withdraws it on unload', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } })
    const fiber = await mountPlugin(ctx, { patchPath: path })

    // Registration is synchronous once the llm registry is up. ONE route, not
    // four: all engines log the same label, and the model catalog is per Host
    // generation, so a route per engine would show four identical groups.
    expect(providerIds(ctx)).toEqual([HOSTED_ROUTE_LABEL])
    // The placeholder advertises the one `default` entry every engine logs into
    // a session's request/header — the pair the picker resolves
    // (`tests/provider-route.spec.ts`).
    await expect((ctx.get('llm') as LlmRuntime).listModels(HOSTED_ROUTE_LABEL)).resolves.toEqual([
      { id: 'default', provider: HOSTED_ROUTE_LABEL, name: 'default' },
    ])

    await fiber.dispose()
    expect(providerIds(ctx)).toEqual([])
  })

  it('warns and leaves a deployment-owned route alone when the label is already served', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } })
    // A deployment adapter already serving the label needs no placeholder.
    ;(ctx.get('llm') as LlmRuntime).registerAdapter([HOSTED_ROUTE_LABEL], new HostedEngineRouteAdapter())
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = await mountPlugin(ctx, { patchPath: path })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`provider route "${HOSTED_ROUTE_LABEL}" is already served`))
    expect(providerIds(ctx)).toEqual([HOSTED_ROUTE_LABEL])

    // Unloading must not withdraw a route the plugin does not own.
    await fiber.dispose()
    expect(providerIds(ctx)).toEqual([HOSTED_ROUTE_LABEL])
  })

  it('treats a duplicate adapter by its error code when the message has been reworded', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { llm: false })
    // The registry's structured duplicate signal, with a message that says
    // nothing about being "already registered".
    const duplicate = Object.assign(new Error('that provider id is taken'), { code: 'DUPLICATE_ADAPTER' })
    ctx.provide('llm', { registerAdapter: () => { throw duplicate } })
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await mountPlugin(ctx, { patchPath: path })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`provider route "${HOSTED_ROUTE_LABEL}" is already served`))
    expect(errorSpy.mock.calls.some(call => String(call[0]).includes('registration failed'))).toBe(false)
  })

  it('reports a registration failure that is not a duplicate', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { llm: false })
    ctx.provide('llm', { registerAdapter: () => { throw new Error('registry read-only') } })
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await mountPlugin(ctx, { patchPath: path })

    expect(errorSpy)
      .toHaveBeenCalledWith(expect.stringContaining(`provider route "${HOSTED_ROUTE_LABEL}" registration failed: Error: registry read-only`))
  })

  it('registers once the llm service appears within the retry window', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { llm: false })
    await mountPlugin(ctx, { patchPath: path })
    // Settle past one retry tick: nothing to register into yet.
    await new Promise(resolve => setTimeout(resolve, 150))

    await ctx.plugin(LlmRuntime)
    await vi.waitFor(() => {
      expect(providerIds(ctx)).toEqual([HOSTED_ROUTE_LABEL])
    })
  })

  it('stops retrying when the plugin is unloaded before the llm service appears', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { llm: false })
    const fiber = await mountPlugin(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 20))
    await fiber.dispose()

    // The pending retry was cleared: the registry arriving later serves nothing.
    await ctx.plugin(LlmRuntime)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(providerIds(ctx)).toEqual([])
  })

  it('gives up on both bounded retry windows when the services never appear', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { llm: false })
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await mountPlugin(ctx, { patchPath: path })

    // 30 attempts x 100ms each: both the provider-route window and the engine
    // preset window close before either service shows up. Giving up is quiet —
    // a composition without the llm registry or the roster has nothing to
    // serve, and a loud failure would only cry wolf on a minimal profile.
    //
    // The wait carries a wide margin over that nominal 3s: these are real
    // timers, and a loaded machine (this suite runs in parallel with the rest)
    // stretches them. Waiting long enough is what makes "the window HAS closed"
    // a fact rather than a guess — with too short a wait the assertion below
    // would be measuring the machine's speed instead of the plugin's give-up.
    await new Promise(resolve => setTimeout(resolve, 8000))
    expect(await readdir(home)).toEqual([])
    expect(errorSpy).not.toHaveBeenCalled()

    await ctx.plugin(LlmRuntime)
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(providerIds(ctx)).toEqual([])
  }, 20000)
})

describe('apply engine remote', () => {
  it('publishes the per-session engine Remote and reports an unreadable session as unset', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } })
    // A durable read that fails. The Remote must still answer "not recorded"
    // rather than throw at the page that asked, and it says so on the host log.
    ctx.provide('sessionQuery', {
      observeSession: async () => { throw new Error('persistence is gone') },
    })
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = await mountPlugin(ctx, { patchPath: path })

    // The service is the browser half's whole read path: `remote.loopEngine`.
    const remote = ctx.get('loopEngine') as { engine(request: { sessionId: string }): Promise<unknown> }
    expect(remote).toBeDefined()
    await expect(remote.engine({ sessionId: 's1' })).resolves.toEqual({ engine: { kind: 'unset' } })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not read the engine of session "s1": Error: persistence is gone'),
    )

    // Registered on the plugin's own fiber, so unloading withdraws it.
    await fiber.dispose()
    expect(ctx.get('loopEngine')).toBeUndefined()
  })

  it('wires the switching endpoint to the router that owns the live agents', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { projections: true })
    const fiber = await mountPlugin(ctx, { patchPath: path })
    await vi.waitFor(() => { expect(ctx.get('agentLoop')).toBeDefined() })

    const remote = ctx.get('loopEngine') as {
      select(request: { sessionId: string; engine: string }): Promise<unknown>
    }
    // The decision is the router's, not the endpoint's: that is what makes the
    // engine a page asks for and the engine the routing read answers one thing.
    // A session nobody has open is refused in the router's own words, under the
    // code the browser half localizes.
    await expect(remote.select({ sessionId: 'never-opened', engine: 'kimi' }))
      .resolves.toEqual({
        ok: false,
        code: 'session-closed',
        reason: 'session "never-opened" is not open; open it first, then switch its engine',
      })

    await fiber.dispose()
  })
})

describe('apply preset steering', () => {
  it('restores the replaced deployment default when the setting returns to in-process', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx, provider } = await boot()
    const scopeRef = { current: registerRosterNamespace(ctx) }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)

    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await vi.waitFor(() => {
      expect(scopeRef.current.get().default).toBe(enginePresetId('kimi'))
    })

    await ctx.settings.update(NS_BRANDED, { engine: 'in-process' })
    // The default the plugin replaced is restored as an explicit value.
    await vi.waitFor(() => {
      expect(scopeRef.current.get().default).toBe(SOURCE_PRESET_ID)
    })
    expect(provider.doc[AGENT_PRESETS_NS]).toEqual({ default: SOURCE_PRESET_ID })
  })

  it('keeps the deployment default across a hosted-to-hosted switch', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx, provider } = await boot({ 'agent-presets': { default: 'deployment-preset' } })
    const scopeRef = { current: registerRosterNamespace(ctx) }
    expect(scopeRef.current.get().default).toBe('deployment-preset')
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)

    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await vi.waitFor(() => {
      expect(scopeRef.current.get().default).toBe(enginePresetId('kimi'))
    })
    // Switching between managed presets never overwrites what the deployment
    // itself had chosen.
    await ctx.settings.update(NS_BRANDED, { engine: 'codex' })
    await vi.waitFor(() => {
      expect(scopeRef.current.get().default).toBe(enginePresetId('codex'))
    })
    await ctx.settings.update(NS_BRANDED, { engine: 'in-process' })
    await vi.waitFor(() => {
      expect(scopeRef.current.get().default).toBe('deployment-preset')
    })
    expect(provider.doc[AGENT_PRESETS_NS]).toEqual({ default: 'deployment-preset' })
  })

  it('does not touch the roster when its default already names the engine preset', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    // A deployment whose roster default already points at the managed preset.
    const { ctx, provider } = await boot({ 'agent-presets': { default: enginePresetId('kimi') } })
    const scopeRef = { current: registerRosterNamespace(ctx) }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)

    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await vi.waitFor(() => {
      expect(sectionOf(ctx)?.engine).toBe('kimi')
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    // No switch was needed: the doc is exactly what the seed carried.
    expect(provider.doc[AGENT_PRESETS_NS]).toEqual({ default: enginePresetId('kimi') })
  })

  it('retries the default switch until the roster namespace registers', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx } = await boot()
    // The roster service is up but its settings namespace is not — the attach
    // race the retry window exists for.
    const scopeRef: { current: RosterScope | undefined } = { current: undefined }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)

    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await new Promise(resolve => setTimeout(resolve, 150))
    scopeRef.current = registerRosterNamespace(ctx)

    await vi.waitFor(() => {
      expect(scopeRef.current!.get().default).toBe(enginePresetId('kimi'))
    })
  })

  it('retries on the settings write itself when the provider cannot enumerate namespaces', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx, provider } = await boot()
    // A provider that cannot enumerate namespaces leaves the write itself as the
    // only signal of the roster's attach race, so the retry rides the message.
    ;(provider as unknown as { describe?: unknown }).describe = undefined
    const scopeRef: { current: RosterScope | undefined } = { current: undefined }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)

    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await new Promise(resolve => setTimeout(resolve, 150))
    scopeRef.current = registerRosterNamespace(ctx)

    await vi.waitFor(() => {
      expect(scopeRef.current!.get().default).toBe(enginePresetId('kimi'))
    })
  })

  it('gives up the default switch when the roster namespace never registers', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx } = await boot()
    const scopeRef: { current: RosterScope | undefined } = { current: undefined }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)

    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    // 30 attempts at 100ms: the retry window exhausts and fails loud once.
    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('preset default switch failed'))).toBe(true)
    }, { timeout: 8000 })
  }, 10000)

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx, settingsFiber } = await boot()
    const scopeRef = { current: registerRosterNamespace(ctx) }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)
    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await vi.waitFor(() => {
      expect(scopeRef.current.get().default).toBe(enginePresetId('kimi'))
    })

    // A profile reload drops the provider: the section falls back to the
    // composition entry, which asks for the in-process engine again. There is
    // no settings service left to write a restore through, so the managed
    // default stays where it was rather than failing the teardown.
    await settingsFiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(ctx.get('settings')).toBeUndefined()
    expect(scopeRef.current.get().default).toBe(enginePresetId('kimi'))
  })

  it('fails loud when the settings write itself rejects', async () => {
    /**
     * A provider whose persist fails for the roster's namespace. Only that one
     * namespace fails: the engine selection itself has to be committed for the
     * plugin to reach the default switch this test is about.
     */
    class FailingPersist extends MemorySettings {
      protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
        return ns === AGENT_PRESETS_NS
          ? Promise.reject(new Error('disk full'))
          : super.persist(ns, section)
      }
    }
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    const settingsFiber = ctx.plugin(FailingPersist)
    await settingsFiber
    cleanups.push(async () => { await settingsFiber.dispose() })
    const scopeRef = { current: registerRosterNamespace(ctx) }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)

    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('preset default switch failed'))).toBe(true)
    })
  })

  it('ignores a retry that was armed after disposal', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const { ctx, provider } = await boot()
    const scopeRef = { current: registerRosterNamespace(ctx) }
    ctx.provide('agentPresets', fakeRoster(scopeRef))
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})

    // Hold the roster mutation open so its rejection — and the retry it arms —
    // land only after the plugin is gone. Clearing pending timers cannot catch
    // this one, because it is armed from that late continuation. Only the
    // roster's namespace is held: the engine selection itself must commit.
    let failMutation!: (error: unknown) => void
    const held = new Promise<never>((_resolve, reject) => { failMutation = reject })
    held.catch(() => {})
    const persistOf = provider as unknown as {
      persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void>
    }
    const realPersist = persistOf.persist.bind(provider)
    const persistSpy = vi
      .spyOn(persistOf, 'persist')
      .mockImplementation((ns, section) => (ns === AGENT_PRESETS_NS ? held : realPersist(ns, section)))
    /** Roster-default writes the plugin has made. */
    const rosterWrites = (): number =>
      persistSpy.mock.calls.filter(call => call[0] === AGENT_PRESETS_NS).length

    const fiber = await mountPlugin(ctx, { patchPath: path })
    await waitForEnginePresets(home)
    await ctx.settings.update(NS_BRANDED, { engine: 'kimi' })
    await vi.waitFor(() => { expect(rosterWrites()).toBe(1) })
    await fiber.dispose()

    failMutation(new Error(`settings namespace "${AGENT_PRESETS_NS}" is not registered`))
    await new Promise(resolve => setTimeout(resolve, 300))

    // The armed retry did not run: no second mutation, and no late loud error.
    expect(rosterWrites()).toBe(1)
    expect(errorSpy.mock.calls.some(call => String(call[0]).includes('preset default switch failed'))).toBe(false)
  })
})

describe('apply router mount', () => {
  it('routes an in-process session through the base loop', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { projections: true })
    await mountPlugin(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoop')).toBeDefined()
    })

    const handle = await ctx.agents.create({
      sessionId: SessionId('router-in-process'),
      meta: { agentPreset: SOURCE_PRESET_ID },
    })
    expect(handle.agent).toBeDefined()
    // The preset names no hosted engine, so no engine runtime was built: the
    // session ran on the loop the router extends.
    expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()
    expect(ctx.get('agentLoopCodex')).toBeUndefined()
    expect(ctx.get('agentLoopPi')).toBeUndefined()
    expect(ctx.get('agentLoopKimi')).toBeUndefined()

    await handle.dispose()
  })

  it('reports a router that cannot take the factory slot, and keeps the plugin up', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { projections: true })
    // A composition that already owns the single slot (the base bundle's
    // `agent-loop` row still active, say) refuses the router's registration.
    ctx.agents.setFactory(fakeAgentFactory())
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await mountPlugin(ctx, { patchPath: path })

    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('could not start the loop router'))).toBe(true)
    })
  })

  it('builds one runtime per hosted engine, forwards the engine knobs, and bridges the session surface', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { projections: true })
    // The engine's own slash-command menu is bridged into its session; a name
    // the session already carries is skipped with a warning, never fatal. Its
    // skill catalog is registered for the same session.
    ctx.provide('commands', {
      register: () => { throw new Error('command "help" is already registered') },
    })
    const skills = fakeSkillsService()
    ctx.provide('skills', skills)
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // The composition entry is an engine-agnostic superset: every driver's own
    // knobs live here at once, because any session may select any engine.
    await mountWithoutEngines(ctx, {
      patchPath: path,
      permissionMode: 'plan',
      env: { ENGINE_ENV: '1' },
      model: 'deployment-model',
      disposeGraceMs: 1000,
      maxTurns: 4,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
      piProvider: 'anthropic',
      piThinking: 'high',
      kimiBin: '/fake/kimi',
    })

    await createHostedSessions(ctx)
    const env = { ENGINE_ENV: '1' }
    expect(ctx.get('agentLoopClaudeCode')!.config)
      .toMatchObject({ permissionMode: 'plan', env, model: 'deployment-model', disposeGraceMs: 1000, maxTurns: 4 })
    expect(ctx.get('agentLoopCodex')!.config)
      .toMatchObject({ sandboxMode: 'workspace-write', approvalPolicy: 'on-failure', env, model: 'deployment-model' })
    expect(ctx.get('agentLoopPi')!.config)
      .toMatchObject({ provider: 'anthropic', model: 'deployment-model', thinkingLevel: 'high', sandboxMode: 'workspace-write', env })
    expect(ctx.get('agentLoopKimi')!.config)
      .toMatchObject({ env, model: 'deployment-model', bin: '/fake/kimi' })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skip claude-code command'))

    // Each engine contributes its OWN skill catalog to the session it serves.
    const control: SkillProviderControl = { signal: new AbortController().signal, invalidate: () => {} }
    expect(skills.creates.map(create => create(control))).toEqual([
      expect.any(ClaudeCodeSkillProvider),
      expect.any(CodexSkillProvider),
      expect.any(PiSkillProvider),
      expect.any(KimiSkillProvider),
    ])

    // The runtime is memoized for the plugin's lifetime: a second session on
    // the same preset reuses the one instance instead of starting another.
    const runtime = ctx.get('agentLoopKimi')
    const handle = await ctx.agents.create({
      sessionId: SessionId('hosted-second-kimi'),
      meta: { agentPreset: enginePresetId('kimi') },
    })
    expect(ctx.get('agentLoopKimi')).toBe(runtime)
    await handle.dispose()
  })

  it('leaves a knob the composition omits to the session', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { projections: true })
    // A composition that pins nothing: each driver resolves its own knobs from
    // the session, so the deployment tunables must stay unset in its config.
    await mountWithoutEngines(ctx, { patchPath: path })

    await createHostedSessions(ctx)
    const claude = ctx.get('agentLoopClaudeCode')!.config
    expect(claude.permissionMode).toBeUndefined()
    expect(claude.maxTurns).toBeUndefined()
    expect(claude.disposeGraceMs).toBeGreaterThan(0) // the driver's own default
    const codex = ctx.get('agentLoopCodex')!.config
    expect(codex.sandboxMode).toBeUndefined()
    expect(codex.approvalPolicy).toBeUndefined()
    const pi = ctx.get('agentLoopPi')!.config
    expect(pi.provider).toBeUndefined()
    expect(pi.thinkingLevel).toBeUndefined()
    expect(ctx.get('agentLoopKimi')!.config.model).toBeUndefined()
    // The kimi CLI falls back to a PATH lookup instead of a pinned path.
    expect(ctx.get('agentLoopKimi')!.config.bin).not.toBe('/fake/kimi')
  })

  it('mounts the pi engine without probing for models', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx } = await boot({ [NS]: { engine: 'in-process' } }, { projections: true })
    // The pi engine used to spawn `pi --list-models` on construction, to fill the
    // route adapter's catalog with pi's own models. The route advertises the
    // engine's single `default` entry instead — the label the driver logs — so
    // mounting the engine starts no child of its own.
    const spawnSpy = vi.spyOn(ctx.subprocess, 'spawn')
    await mountPlugin(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoop')).toBeDefined()
    })

    const handle = await ctx.agents.create({
      sessionId: SessionId('hosted-pi-no-probe'),
      meta: { agentPreset: enginePresetId('pi') },
    })
    expect(spawnSpy).not.toHaveBeenCalled()
    // The route still serves the shared label, with exactly its one entry.
    await expect((ctx.get('llm') as LlmRuntime).listModels(HOSTED_ROUTE_LABEL)).resolves.toEqual([
      { id: 'default', provider: HOSTED_ROUTE_LABEL, name: 'default' },
    ])

    await handle.dispose()
  })
})

/** A stand-in for a factory that already owns the single AgentFactory slot. */
function fakeAgentFactory(): AgentFactory {
  return {
    createAgent: vi.fn(async () => { throw new Error('the occupying factory must not serve sessions') }),
    resume: vi.fn(async () => { throw new Error('the occupying factory must not serve sessions') }),
  } as unknown as AgentFactory
}

/** One hosted engine's preset id and the ctx key its runtime publishes. */
const HOSTED_ENGINE_PRESETS: ReadonlyArray<readonly [string, string]> = [
  [enginePresetId('claude-code'), 'agentLoopClaudeCode'],
  [enginePresetId('codex'), 'agentLoopCodex'],
  [enginePresetId('pi'), 'agentLoopPi'],
  [enginePresetId('kimi'), 'agentLoopKimi'],
]

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

/**
 * Mount the plugin with the router up and no hosted engine reachable.
 *
 * The drivers' child processes start on a session's first turn, and no test
 * here runs one, so the subprocess seam refuses every spawn.
 */
async function mountWithoutEngines(ctx: Context, config: Config): Promise<Fiber> {
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
    throw new Error('no hosted engine binary in this test')
  })
  const fiber = await mountPlugin(ctx, config)
  await vi.waitFor(() => {
    expect(ctx.get('agentLoop')).toBeDefined()
  })
  return fiber
}

/** Create one session per hosted engine and assert its runtime was built. */
async function createHostedSessions(ctx: Context): Promise<void> {
  for (const [preset, label] of HOSTED_ENGINE_PRESETS) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(`hosted-${preset}`),
      meta: { agentPreset: preset },
    })
    expect(ctx.get(label)).toBeDefined()
    await handle.dispose()
  }
}