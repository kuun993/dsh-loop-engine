/**
 * Package-owned invariant companion for the loop engine selection.
 *
 * The plugin's owned relationship is the patch-manager round trip: rendering
 * a managed block for an engine and reading it back must produce the same
 * engine, and the `in-process` engine must render an absent block (so the base
 * bundle's `agent-loop` row stays mounted). The companion asserts both against
 * the pure transform, binding the writer's inverse to the reader directly.
 *
 * @module @deepseek-ai/dsh-loop-engine/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { LOOP_ENGINE_IDS } from './settings.ts'
import {
  applyManagedBlock,
  currentEngineOf,
  renderManagedBlock,
} from './patch-manager.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-loop-engine'

/** Cordis companion plugin name. */
export const name = 'loop-engine-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * Assert the managed-block transform is a fixed point for every engine.
 * @param ctx - child context owned by this invariant registration (unused: the
 * check is pure; kept for the InvariantInstaller signature).
 * @param fail - reporter bound to the registering package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  void ctx
  const seed = '# dsh profile patch layer\n'
  /* v8 ignore start -- the checks below assert the transform's own fixed
  points; each is exercised by the patch-manager suite, and an honest failure
  only becomes reachable when that transform regresses. */
  for (const engine of LOOP_ENGINE_IDS) {
    const applied = applyManagedBlock(seed, engine)
    const reborn = applyManagedBlock(applied, currentEngineOf(applied))
    if (reborn !== applied) fail(`managed-block round trip for ${engine} is not a fixed point`)
    if (engine === 'in-process' && applied !== seed) fail('in-process engine must leave the file text unchanged')
    if (engine === 'claude-code' && currentEngineOf(renderManagedBlock(engine)) !== 'claude-code') fail('claude-code block must read back as the claude-code engine')
  }
  /* v8 ignore stop */
}

/**
 * Register the loop-engine invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))