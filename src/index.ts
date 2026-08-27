/**
 * Web-switchable agent loop engine, node half.
 *
 * Hosts the non-default agent-loop engines (Claude Code, Codex) and
 * bridges them with the harness's single AgentFactory slot. The engine is
 * selected by the `agent-loop-engine` settings section; the selection is
 * realized by a managed block in the profile's `cordis.patch.yml` that
 * disables the base bundle's `agent-loop` row — exactly one AgentFactory may
 * register, so a non-default engine owns the slot by disabling the base loop
 * first, and `in-process` leaves the base row active (this plugin does NOT
 * register its own factory then).
 *
 * The managed block is the ground truth the factory decision reads at boot:
 * apply() reads the file synchronously, so a committed engine change takes
 * effect on the next recomposition (restart); the config-only HMR watcher
 * re-applies the patch file but cannot re-register an AgentFactory mid-run.
 * The settings section is seeded from the block so the UI mirrors the file,
 * and a committed settings change writes the block (only when it differs).
 *
 * @module @kuun993/dsh-loop-engine
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ClaudeCodeLoop, CLAUDE_CODE_PERMISSION_MODES, type Config as ClaudeCodeConfig } from './engine-claude/loop.ts'
import { CodexLoop, CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES, type Config as CodexConfig } from './engine-codex/loop.ts'
import type { CodexApprovalPolicy, CodexSandboxMode } from './engine-codex/types.ts'
import {
  applyManagedBlock,
  currentEngineOf,
} from './patch-manager.ts'
import {
  loopEngineSettingsNamespace,
  LOOP_ENGINE_SETTINGS_SCHEMA,
  type LoopEngineId,
  type LoopEngineSettings,
} from './settings.ts'
import { CLAUDE_CODE_COMMANDS, type CommandDefinition } from './commands.ts'
import { ClaudeCodeSkillProvider, type SkillProvider, type SkillProviderControl } from './skills.ts'
import { CodexSkillProvider } from './engine-codex/skills.ts'

export const name = 'loop-engine'

/** Services the hosted engine factory resolves through the plugin fiber. */
export const inject = ['agents', 'sessions', 'systemPrompt', 'subprocess']

/** Bounded retry window for the AgentFactory slot race on runtime switches. */
const MAX_MOUNT_ATTEMPTS = 40
const MOUNT_RETRY_MS = 50

/** Composition entry for the loop engine selection and the hosted engine drivers. */
export interface Config extends ClaudeCodeConfig {
  /** Profile whose `cordis.patch.yml` carries the managed block; defaults to `web`. */
  profile?: string
  /** Patch file name inside the profile; defaults to `cordis.patch.yml`. */
  patchFilename?: string
  /** Explicit absolute path to the patch file, overriding profile + filename. */
  patchPath?: string
  /** Pinned Codex sandbox mode; falls back to the session's dsh permission knobs. */
  sandboxMode?: CodexSandboxMode
  /** Pinned Codex approval policy; falls back to the session's dsh permission knobs. */
  approvalPolicy?: CodexApprovalPolicy
  /** Codex API key injected as CODEX_API_KEY into the CLI environment. */
  apiKey?: string
  /** Codex API base URL override. */
  baseUrl?: string
  /** Whether the Codex sandbox may reach the network. */
  networkAccessEnabled?: boolean
}

/** Schema of the loop engine composition entry. */
export const Config: z<Config> = z.object({
  profile: z.string(),
  patchFilename: z.string(),
  patchPath: z.string(),
  permissionMode: z.union(CLAUDE_CODE_PERMISSION_MODES.map(mode => z.const(mode))),
  env: z.dict(z.string()),
  model: z.string(),
  disposeGraceMs: z.number(),
  maxTurns: z.number(),
  sandboxMode: z.union(CODEX_SANDBOX_MODES.map(mode => z.const(mode))),
  approvalPolicy: z.union(CODEX_APPROVAL_POLICIES.map(policy => z.const(policy))),
  apiKey: z.string(),
  baseUrl: z.string(),
  networkAccessEnabled: z.boolean(),
})

/** Resolve the managed patch file from configuration, defaulting to the web profile. */
export function resolvePatchPath(config: Config): string {
  if (config.patchPath !== undefined && config.patchPath !== '') return config.patchPath
  return join(
    resolveDshHome(),
    'profiles',
    config.profile ?? 'web',
    config.patchFilename ?? 'cordis.patch.yml',
  )
}

/** Whether a promise rejection was an ENOENT (file not found). */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Read the patch file, or `undefined` when it does not exist yet. */
async function readPatchOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Atomically replace the patch file (same-directory temp + rename). */
export async function writePatchFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * Synchronously atomically replace the patch file. The engine-selection
 * onChange is a synchronous hook with no await, and the write MUST land before
 * the caller is told the switch committed — otherwise a user who restarts
 * `dsh web` immediately reads the stale file and the previous engine boots.
 * @param path - the profile's patch file.
 * @param text - the next file content.
 */
export function writePatchFileSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/**
 * Rewrite the managed block for a target engine, preserving the rest of the
 * file byte for byte. Only writes when the file actually differs.
 * @param path - the profile's patch file.
 * @param engine - the target engine.
 * @returns whether a write occurred.
 */
export async function syncManagedBlock(path: string, engine: LoopEngineId): Promise<boolean> {
  const current = await readPatchOrUndefined(path)
  if (current !== undefined && currentEngineOf(current) === engine) return false
  const next = applyManagedBlock(current ?? '', engine)
  await writePatchFile(path, next)
  return true
}

/** Synchronous patch-file read for plugin startup only. */
function readPatchFileSync(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return ''
    throw error
  }
}

/** Forward the engine-driver fields of the composition entry to the Claude Code loop. */
function claudeCodeConfig(config: Config): ClaudeCodeConfig {
  return {
    ...config.permissionMode === undefined ? {} : { permissionMode: config.permissionMode },
    ...config.env === undefined ? {} : { env: config.env },
    ...config.model === undefined ? {} : { model: config.model },
    ...config.disposeGraceMs === undefined ? {} : { disposeGraceMs: config.disposeGraceMs },
    ...config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns },
  }
}

/** Forward the engine-driver fields of the composition entry to the Codex loop. */
function codexConfig(config: Config): CodexConfig {
  return {
    ...config.sandboxMode === undefined ? {} : { sandboxMode: config.sandboxMode },
    ...config.approvalPolicy === undefined ? {} : { approvalPolicy: config.approvalPolicy },
    ...config.env === undefined ? {} : { env: config.env },
    ...config.model === undefined ? {} : { model: config.model },
    ...config.apiKey === undefined ? {} : { apiKey: config.apiKey },
    ...config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl },
    ...config.networkAccessEnabled === undefined ? {} : { networkAccessEnabled: config.networkAccessEnabled },
    ...config.disposeGraceMs === undefined ? {} : { disposeGraceMs: config.disposeGraceMs },
    ...config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns },
  }
}

/**
 * Apply the plugin: seed the settings section from the managed block, host
 * the non-default engine factory when the block says so, and translate
 * committed engine changes into managed-block writes.
 * @param ctx - the composing context.
 * @param config - composition entry for the managed patch file.
 */
export function apply(ctx: Context, config: Config): void {
  const patchPath = resolvePatchPath(config)
  // Seed from the file so attach is a no-op when the file already matches.
  let fileEngine = currentEngineOf(readPatchFileSync(patchPath))
  // Only the non-default engines live here. Their managed block disables the
  // base `agent-loop` row, freeing the single AgentFactory slot for the
  // selected loop's own registration; `in-process` mounts no factory here
  // and the base loop stays the slot owner. The selected factory is hosted
  // as a plugin fiber so a runtime switch can mount and unmount it — the
  // AgentFactory is a single slot, so the active engine must own it in the
  // same process, not only at the next boot.

  // Minimal shape of the host commands service (avoiding a direct peer dep).
  interface CommandsService {
    register(def: CommandDefinition): () => void
  }
  // Minimal shape of the host skills service.
  interface SkillsService {
    registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
  }

  let engineFiber: (Fiber & PromiseLike<Fiber>) | undefined
  /** The engine whose fiber is currently mounted (or mounting), if any. */
  let mountedEngine: LoopEngineId | undefined
  let commandDisposers: (() => void)[] | undefined
  let skillDisposer: (() => void) | undefined
  /** Bounded retry bookkeeping for the AgentFactory slot race described below. */
  let mountAttempts = 0
  let mountRetry: ReturnType<typeof setTimeout> | undefined

  const CLEAR_RETRY = (): void => {
    if (mountRetry !== undefined) {
      clearTimeout(mountRetry)
      mountRetry = undefined
    }
  }

  /** Dispose the engine-specific command and skill registrations. */
  const cleanupEngineRegistrations = (): void => {
    if (commandDisposers !== undefined) {
      for (const dispose of commandDisposers) dispose()
      commandDisposers = undefined
    }
    if (skillDisposer !== undefined) {
      skillDisposer()
      skillDisposer = undefined
    }
  }

  /**
   * Host one engine factory as a plugin fiber and touch it so it starts now:
   * Cordis starts plugin fibers lazily on await, and the settings watch is a
   * synchronous callback with no await of its own. Report a start failure; a
   * factory that never mounted leaves the slot null, which surface errors
   * describe correctly.
   * @param engine - the engine being mounted (for diagnostics and retry).
   * @param mount - the engine-specific fiber construction.
   */
  const hostFactory = (engine: LoopEngineId, mount: () => (Fiber & PromiseLike<Fiber>)): void => {
    /* v8 ignore start -- mountEngine only fires when no fiber is live (onChange's mountedEngine check and the rejection handler's cleanup); defensive re-entrancy backstop */
    /* v8 ignore next -- see above */
    if (engineFiber !== undefined) return
    /* v8 ignore stop */
    const fiber = mount()
    engineFiber = fiber
    mountedEngine = engine
    void fiber.then(() => undefined, (error: unknown) => {
      // Cleanup claude-specific registrations on failure (a no-op for codex).
      cleanupEngineRegistrations()
      engineFiber = undefined
      mountedEngine = undefined
      // A runtime switch to a hosted engine races the patch-layer reload that
      // disables the base `agent-loop` row: until that reload lands, the base
      // factory still owns the single AgentFactory slot and `setFactory`
      // rejects. Retry on exactly that collision — bounded — so the hosted
      // factory registers right after the reload frees the slot; any other
      // failure is deployment trouble and fails loud once.
      if (
        error instanceof Error
        && error.message.includes('an agent factory is already registered')
        && mountAttempts < MAX_MOUNT_ATTEMPTS
      ) {
        mountAttempts += 1
        mountRetry = setTimeout(() => { mountEngine(engine) }, MOUNT_RETRY_MS)
        return
      }
      ctx.logger.error(`loop-engine: ${engine} factory failed to start: ${String(error)}`)
    })
  }

  const mountClaude = (): void => {
    /* v8 ignore start -- hostFactory owns the live-fiber backstop; this guard additionally protects the command/skill registrations from doubling */
    /* v8 ignore next -- see above */
    if (engineFiber !== undefined) return
    /* v8 ignore stop */

    // Register Claude Code commands alongside the DSH-native ones.
    const commands = ctx.get('commands') as CommandsService | undefined
    if (commands !== undefined) {
      const disposers: (() => void)[] = []
      for (const cmd of CLAUDE_CODE_COMMANDS) {
        disposers.push(commands.register(cmd))
      }
      commandDisposers = disposers
    }

    // Register the Claude Code skill provider so skills from .claude/skills/
    // and CLAUDE.md are available alongside DSH skills.
    const skills = ctx.get('skills') as SkillsService | undefined
    if (skills !== undefined) {
      skillDisposer = skills.registerProvider(control => new ClaudeCodeSkillProvider(control))
    }

    hostFactory('claude-code', () => ctx.plugin(ClaudeCodeLoop, claudeCodeConfig(config)))
  }

  /** Mount the Codex loop factory plus its AGENTS.md skill provider. */
  const mountCodex = (): void => {
    // Register the Codex skill provider so AGENTS.md instruction files are
    // available through the same dsh skill-injection seam as Claude skills.
    const skills = ctx.get('skills') as SkillsService | undefined
    if (skills !== undefined) {
      skillDisposer = skills.registerProvider(control => new CodexSkillProvider(control))
    }

    hostFactory('codex', () => ctx.plugin(CodexLoop, codexConfig(config)))
  }

  /** Mount the factory of a non-default engine; `in-process` mounts nothing here. */
  const mountEngine = (engine: LoopEngineId): void => {
    if (engine === 'claude-code') mountClaude()
    else if (engine === 'codex') mountCodex()
  }

  const unmountEngine = (): void => {
    const fiber = engineFiber
    mountAttempts = 0
    CLEAR_RETRY()
    cleanupEngineRegistrations()
    mountedEngine = undefined
    if (fiber === undefined) return
    engineFiber = undefined
    /* v8 ignore start -- a fiber that failed already cleared engineFiber in hostFactory's rejection handler, so this rejection arm is unreachable */
    void fiber.then((resolved) => { void resolved.dispose() }, () => undefined)
    /* v8 ignore stop */
  }
  mountEngine(fileEngine)
  // A pending slot-collision retry must not outlive the plugin: mounting after
  // this fiber is gone would fail on the inactive context and log noise.
  ctx.effect(() => () => CLEAR_RETRY(), 'loop-engine: mount retry cleanup')
  // installSettingsSection always calls setSource before the first onChange,
  // so `source` is guaranteed set here; the assertion is a contract guard.
  let source: (() => LoopEngineSettings) | undefined
  installSettingsSection(ctx, loopEngineSettingsNamespace(), LOOP_ENGINE_SETTINGS_SCHEMA, { engine: fileEngine }, {
    setSource: (current) => { source = current },
    onChange: () => {
      const next = source!().engine
      if (next === fileEngine) return
      // Runtime engines follow the selection in the same process: switching
      // to a hosted engine mounts its factory, switching back to in-process
      // unmounts it so the base loop regains the single AgentFactory slot.
      // Re-entering the already-mounted engine is a no-op, not a churn.
      if (mountedEngine !== next) {
        unmountEngine()
        mountEngine(next)
      }
      // Synchronous: the settings watch has no await, and a user may restart
      // `dsh web` immediately after switching — the managed block must be on
      // disk before the commit returns, or the restart reads the old engine.
      try {
        const updated = applyManagedBlock(readPatchFileSync(patchPath), next)
        writePatchFileSync(patchPath, updated)
        fileEngine = next
      } catch (error: unknown) {
        ctx.logger.error(`loop-engine: managed block write failed: ${String(error)}`)
      }
    },
  })
}