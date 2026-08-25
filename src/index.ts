/**
 * Web-switchable agent loop engine, node half.
 *
 * Hosts the non-default agent-loop engines (Claude Code, later Codex) and
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
 * @module @deepseek-ai/dsh-loop-engine
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ClaudeCodeLoop, CLAUDE_CODE_PERMISSION_MODES, type Config as ClaudeCodeConfig } from './engine/loop.ts'
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

export const name = 'loop-engine'

/** Services the hosted engine factory resolves through the plugin fiber. */
export const inject = ['agents', 'sessions', 'systemPrompt', 'subprocess']

/** Composition entry for the loop engine selection and the Claude Code driver. */
export interface Config extends ClaudeCodeConfig {
  /** Profile whose `cordis.patch.yml` carries the managed block; defaults to `web`. */
  profile?: string
  /** Patch file name inside the profile; defaults to `cordis.patch.yml`. */
  patchFilename?: string
  /** Explicit absolute path to the patch file, overriding profile + filename. */
  patchPath?: string
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
  // Claude Code loop's own registration; `in-process` mounts no factory here
  // and the base loop stays the slot owner.
  if (fileEngine !== 'in-process') {
    void new ClaudeCodeLoop(ctx, claudeCodeConfig(config))
  }
  // installSettingsSection always calls setSource before the first onChange,
  // so `source` is guaranteed set here; the assertion is a contract guard.
  let source: (() => LoopEngineSettings) | undefined
  installSettingsSection(ctx, loopEngineSettingsNamespace(), LOOP_ENGINE_SETTINGS_SCHEMA, { engine: fileEngine }, {
    setSource: (current) => { source = current },
    onChange: () => {
      const next = source!().engine
      if (next === fileEngine) return
      // Fire-and-forget: the settings watch is synchronous; report write
      // failures instead of letting the caller hang on an HMR-visible file.
      // A no-op sync (file already matches the target) is still authoritative:
      // the file is the ground truth, so the local mirror follows it either way.
      void syncManagedBlock(patchPath, next).then(() => {
        fileEngine = next
      }).catch((error: unknown) => {
        ctx.logger.error(`loop-engine: managed block write failed: ${String(error)}`)
      })
    },
  })
}