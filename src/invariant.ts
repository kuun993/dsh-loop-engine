/**
 * Package-owned invariant companion for the loop engine selection.
 *
 * The plugin's owned relationship is the patch-manager round trip: applying the
 * managed block must be a fixed point, the block must be the one that frees the
 * single AgentFactory slot for the router, a legacy block naming a single engine
 * must be migrated to the engine-agnostic form while still being readable as a
 * legacy pin, and a comment-only layer must be re-seeded to a loadable
 * top-level array rather than left as `null`. The companion asserts those
 * against the pure transform, binding the writer's inverse to the reader
 * directly.
 *
 * The host shapes below are declared locally, exactly as `driver-core/
 * host-servers.ts` does, and for the same reason plus one more: the 0.2.1
 * harness line DELETED `@deepseek-ai/dsh-invariants` outright
 * (`docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants`), so this module
 * cannot import the contractor's types and survive as one build across the
 * generations. It still mounts on the lines that have the service — `inject`
 * keeps it pending where the service is absent — and nothing in the plugin
 * mounts it by itself.
 *
 * @module dsh-loop-engine/invariant
 */

import type { Context, Inject } from '@deepseek-ai/cordis'
import { LOOP_ENGINE_IDS } from './settings.ts'
import {
  applyManagedBlock,
  hasManagedBlock,
  LEGACY_MANAGED_BLOCK_BEGIN,
  legacyBlockEngineOf,
  MANAGED_BLOCK_END,
  renderManagedBlock,
} from './patch-manager.ts'

const PACKAGE_NAME = 'dsh-loop-engine'

/** Throw a package-attributed invariant failure (`@deepseek-ai/dsh-invariants`). */
type InvariantFailure = (message: string) => never

/** One package's checks, as the invariant registry installs them. */
interface InvariantInstaller {
  (ctx: Context, fail: InvariantFailure): void | Promise<void>
  /** Services the installer fiber may access. */
  readonly inject?: Inject
}

/** The host invariant registry (`ctx.invariants`), as this plugin uses it. */
interface InvariantRegistryLike {
  /** Register one package's checks; the returned disposer withdraws them. */
  register(packageName: string, install: InvariantInstaller): () => void
}

/** Cordis companion plugin name. */
export const name = 'loop-engine-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * Assert the managed-block transform is a fixed point, that it always frees the
 * router's factory slot, and that a legacy per-engine block migrates.
 * @param ctx - child context owned by this invariant registration (unused: the
 * check is pure; kept for the InvariantInstaller signature).
 * @param fail - reporter bound to the registering package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  void ctx
  // A bare layer is "no file yet"; a comment-only seed is present-but-invalid
  // (`null` to the loader), so the transform must repair it to a loadable `[]`
  // rather than leave it bare.
  const seed = ''
  const commentOnly = '# dsh profile patch layer\n'
  /* v8 ignore start -- the checks below assert the transform's own fixed
  points; each is exercised by the patch-manager suite, and an honest failure
  only becomes reachable when that transform regresses. */
  const applied = applyManagedBlock(seed)
  if (applyManagedBlock(applied) !== applied) fail('the managed block is not a fixed point')
  if (!hasManagedBlock(renderManagedBlock())) fail('the rendered block is not recognized by hasManagedBlock')
  if (!applied.includes('- id: agent-loop')) fail('the managed block must disable the base agent-loop row')
  if (legacyBlockEngineOf(applied) !== undefined) fail('the current block must not read as a legacy engine pin')
  for (const engine of LOOP_ENGINE_IDS) {
    // Every legacy block migrates to the same engine-agnostic form, whatever
    // engine it named — including one this build does not know, whose id the
    // marker still carries. The comparison is against the same layer with no
    // span at all, which is exactly what "the engine was dropped from the file"
    // must mean, and it holds for a legacy writer's usual blank-line separator.
    const head = '# user patch layer\n'
    const legacy = `${head}\n${LEGACY_MANAGED_BLOCK_BEGIN}${engine} --\n- id: agent-loop\n  disabled: true\n${MANAGED_BLOCK_END}\n`
    if (legacyBlockEngineOf(legacy) !== engine) fail(`a legacy ${engine} block must still read as the ${engine} pin`)
    if (applyManagedBlock(legacy) !== applyManagedBlock(head)) {
      fail(`a legacy ${engine} block must migrate to the current block`)
    }
  }
  if (applyManagedBlock(commentOnly) === commentOnly) {
    fail('a comment-only file must gain the block as its top-level array')
  }
  /* v8 ignore stop */
}

/**
 * Register the loop-engine invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve((ctx as Context & { invariants: InvariantRegistryLike }).invariants.register(PACKAGE_NAME, install))
