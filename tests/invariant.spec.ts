/**
 * Invariant companion suite: the registration runs the patch-manager
 * fixed-point checks, and the checks the invariant makes must hold for the
 * shapes the plugin itself writes.
 *
 * @module tests/invariant
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply as applyInvariant } from '../src/invariant.ts'
import { LOOP_ENGINE_IDS } from '../src/settings.ts'
import {
  applyManagedBlock,
  hasManagedBlock,
  legacyBlockEngineOf,
  LEGACY_MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  renderManagedBlock,
} from '../src/patch-manager.ts'

/**
 * Minimal invariant registry: runs the installer synchronously at register.
 *
 * `throwOnFail` mirrors the real registry, which reports a violated check by
 * throwing and so fails the plugin load; the default records the messages
 * instead, so the suite can assert WHICH checks report.
 */
class FakeInvariants extends Service {
  registered: string[] = []
  failures: string[] = []

  constructor(ctx: Context, private readonly throwOnFail = false) {
    super(ctx, 'invariants')
  }

  register(
    packageName: string,
    installer: (ctx: Context, fail: (message: string) => never) => void,
  ): () => void {
    this.registered.push(packageName)
    installer(this.ctx!, (message: string): never => {
      if (this.throwOnFail) throw new Error(message)
      this.failures.push(message)
      // The installer's signature demands a `never` return; nothing reads it.
      return undefined as never
    })
    return () => {}
  }
}

/** Mount the companion under a booted fake registry. */
async function mountInvariant(throwOnFail = false): Promise<{ registry: FakeInvariants; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fiber = ctx.plugin(FakeInvariants, throwOnFail)
  await fiber
  const mounted = ctx.plugin({
    name: 'loop-engine-invariant',
    inject: ['invariants'],
    apply: applyInvariant,
  })
  await mounted
  return {
    registry: ctx.get('invariants') as unknown as FakeInvariants,
    dispose: async () => {
      await mounted.dispose()
      await fiber.dispose()
    },
  }
}

describe('loop-engine invariant companion', () => {
  it('registers under the package name', async () => {
    const { registry, dispose } = await mountInvariant()
    expect(registry.registered).toEqual(['dsh-loop-engine'])
    await dispose()
  })

  it('reports no violated check', async () => {
    // The fixed point, the rendered block's recognition, the base agent-loop
    // disable, the absence of a pin on the current block, the per-engine legacy
    // migration and read-back, and the comment-only re-seed all hold for the
    // current transform.
    const { registry, dispose } = await mountInvariant()
    expect(registry.failures).toEqual([])
    await dispose()
  })

  it('passes every check through a throwing registry reporter', async () => {
    // A throwing reporter IS the real registry, so this run is what the plugin
    // needs to load: every check holds without reporting.
    const { dispose } = await mountInvariant(true)
    await dispose()
  })

  it('asserts the same fixed points the invariant checks', () => {
    // Independent restatement so a silent invariant regression is caught by
    // both the registration run and this explicit probe. The bare layer is
    // "no file yet", so the block — with no leading filler — is what the
    // transform writes there, and a comment-only layer is re-seeded to a
    // loadable array by that same block.
    const seed = ''
    const commentOnly = '# dsh profile patch layer\n'
    const applied = applyManagedBlock(seed)
    expect(applied).toBe(renderManagedBlock())
    expect(applyManagedBlock(applied)).toBe(applied)
    expect(hasManagedBlock(renderManagedBlock())).toBe(true)
    expect(applied).toContain('- id: agent-loop')
    expect(legacyBlockEngineOf(applied)).toBeUndefined()
    for (const engine of LOOP_ENGINE_IDS) {
      // The legacy shape the pre-routing writer produced: appended behind a
      // blank separator. Every engine migrates to the same constant span with
      // that separator — the bytes outside the span survive — while the upgrade
      // can still recover the engine it pinned. The expectation is the same
      // layer WITHOUT a span, which is what "the engine left the file" means.
      const head = '# user patch layer\n'
      const legacy = `${head}\n${LEGACY_MANAGED_BLOCK_BEGIN}${engine} --\n- id: agent-loop\n  disabled: true\n${MANAGED_BLOCK_END}\n`
      expect(legacyBlockEngineOf(legacy)).toBe(engine)
      expect(applyManagedBlock(legacy)).toBe(applyManagedBlock(head))
      expect(applyManagedBlock(legacy)).toBe(`${head}\n${applied}`)
    }
    expect(applyManagedBlock(commentOnly)).not.toBe(commentOnly)
  })
})
