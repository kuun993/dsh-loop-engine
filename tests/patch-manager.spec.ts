/**
 * Pure string-transform tests for the managed patch block.
 *
 * The block is now engine-agnostic: its only job is to disable the base
 * `agent-loop` row so the plugin's router can own the single AgentFactory slot,
 * because which engine a session runs is a per-session preset decision. A block
 * written by the pre-routing build named the one engine the profile was pinned
 * to; the suite covers detecting that legacy form, reading its pin back, and
 * migrating the span to the current form.
 * @module tests/patch-manager
 */

import { describe, expect, it } from 'vitest'
import {
  applyManagedBlock,
  hasLegacyManagedBlock,
  hasManagedBlock,
  legacyBlockEngineOf,
  LEGACY_MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  renderManagedBlock,
} from '../src/patch-manager.ts'
import { LOOP_ENGINE_IDS } from '../src/settings.ts'

const SEED = '# dsh profile patch layer\n'

// The exact empty-sequence template `initProfile` seeds a fresh profile with:
// a lone root-level `[]` flow sequence that the harness must still parse as a
// top-level array. A managed block appended on top of it (rather than replacing
// it) is a SECOND root collection, which js-yaml rejects at boot.
const PROFILE_SEED = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** The span as the pre-routing plugin wrote it, naming the pinned engine. */
function legacySpan(engine: string): string {
  return `${LEGACY_MANAGED_BLOCK_BEGIN}${engine} --\n- id: agent-loop\n  disabled: true\n${MANAGED_BLOCK_END}\n`
}

describe('renderManagedBlock', () => {
  it('renders the engine-agnostic span that frees the router factory slot', () => {
    const block = renderManagedBlock()
    expect(block.startsWith(`${MANAGED_BLOCK_BEGIN}\n`)).toBe(true)
    expect(block).toContain('- id: agent-loop\n  disabled: true')
    // The block only disables the BASE loop so the single AgentFactory slot has
    // no collision; nothing the plugin itself composes is disabled.
    expect(block).not.toMatch(/^- id: agent-loop-/m)
    // The dsh /goal command goes down with the loop: its human command is
    // registered by the preset layer, which no profile patch can reach, so the
    // engine presets strip it too; and no hosted engine implements /goal, so
    // leaving it would put a command in the menu with nothing behind it.
    expect(block).toContain('- id: command-goal\n  disabled: true')
    expect(block.endsWith(`${MANAGED_BLOCK_END}\n`)).toBe(true)
  })

  it('names no engine, because the engine is a per-session preset decision', () => {
    const block = renderManagedBlock()
    for (const engine of LOOP_ENGINE_IDS) expect(block).not.toContain(engine)
    // A process-wide patch file cannot carry a per-session choice, so the
    // renderer takes no engine and renders the same constant for every caller.
    expect(renderManagedBlock()).toBe(block)
  })
})

describe('managed-block detection and legacy engine derivation', () => {
  it('sees no block in a plain layer, a comment-only file, or the profile seed', () => {
    expect(hasManagedBlock(SEED)).toBe(false)
    expect(hasManagedBlock('')).toBe(false)
    expect(hasManagedBlock('# a comment\n# second line\n')).toBe(false)
    expect(hasManagedBlock(PROFILE_SEED)).toBe(false)
    expect(legacyBlockEngineOf(SEED)).toBeUndefined()
  })

  it('sees the current block, including a lone begin marker', () => {
    expect(hasManagedBlock(renderManagedBlock())).toBe(true)
    expect(hasManagedBlock(`${SEED}\n${renderManagedBlock()}`)).toBe(true)
    // Presence is a substring test on the marker on purpose: a half-written or
    // truncated span is still the plugin's span, and must be rewritten in place
    // rather than appended a second time.
    expect(hasManagedBlock(MANAGED_BLOCK_BEGIN)).toBe(true)
    // The current block names no engine, so it reads back as no pin at all.
    expect(legacyBlockEngineOf(renderManagedBlock())).toBeUndefined()
    expect(legacyBlockEngineOf(MANAGED_BLOCK_BEGIN)).toBeUndefined()
  })

  it('separates the legacy begin marker from the current one', () => {
    expect(hasLegacyManagedBlock(renderManagedBlock())).toBe(false)
    expect(hasLegacyManagedBlock(`${SEED}\n${renderManagedBlock()}`)).toBe(false)
    expect(hasLegacyManagedBlock('')).toBe(false)
    expect(hasLegacyManagedBlock(SEED)).toBe(false)
    expect(hasLegacyManagedBlock('# a comment\n# second line\n')).toBe(false)
    expect(hasLegacyManagedBlock(PROFILE_SEED)).toBe(false)
    expect(hasLegacyManagedBlock(MANAGED_BLOCK_BEGIN)).toBe(false)
    expect(hasLegacyManagedBlock(`${SEED}\n${legacySpan('codex')}`)).toBe(true)
    // Same substring looseness as `hasManagedBlock`: a half-written marker is
    // still the plugin's span, and the legacy form has to be recognized as such
    // so the upgrade path can read (and then rewrite) it.
    expect(hasLegacyManagedBlock(LEGACY_MANAGED_BLOCK_BEGIN)).toBe(true)
  })

  it('sees a legacy block and reads its engine back for every engine', () => {
    for (const engine of LOOP_ENGINE_IDS) {
      const text = `${SEED}\n${legacySpan(engine)}`
      expect(hasManagedBlock(text)).toBe(true)
      expect(legacyBlockEngineOf(text)).toBe(engine)
    }
  })

  it('reads an unknown or malformed legacy marker as no engine pin', () => {
    const unknown = `${SEED}\n${legacySpan('future-engine')}`
    // The span is there and must be rewritten, but no build can honor its pin.
    expect(hasManagedBlock(unknown)).toBe(true)
    expect(legacyBlockEngineOf(unknown)).toBeUndefined()
    // The marker must be a whole line ending the line: a mention inside prose or
    // a longer marker is not a pin.
    expect(legacyBlockEngineOf('# see # -- dsh-loop-engine managed block: codex --\n')).toBeUndefined()
    expect(legacyBlockEngineOf(`${LEGACY_MANAGED_BLOCK_BEGIN}codex -- extra\n`)).toBeUndefined()
  })
})

describe('applyManagedBlock', () => {
  it('appends the block to a file without one, preserving prior bytes', () => {
    const prior = '# my own patches\n- id: subagent-claude-code\n'
    const next = applyManagedBlock(prior)
    expect(next).toBe(`${prior}\n${renderManagedBlock()}`)
    expect(next.startsWith(prior)).toBe(true)
    expect(hasManagedBlock(next)).toBe(true)
    expect(legacyBlockEngineOf(next)).toBeUndefined()
  })

  it('adds the missing trailing newline before the blank separator', () => {
    const prior = '# head'
    expect(applyManagedBlock(prior).startsWith(`${prior}\n\n${MANAGED_BLOCK_BEGIN}`)).toBe(true)
  })

  it('writes the block into a layer that is absent or whitespace only', () => {
    // An empty profile has no patch layer at all, but the router still needs the
    // base loop row disabled — so the bare block, with no leading filler, is what
    // the file gets: the block's own `- id: agent-loop` is already the root array.
    expect(applyManagedBlock('')).toBe(renderManagedBlock())
    // A layer that exists but holds only whitespace keeps its bytes and gains the
    // blank separator line every append path writes.
    expect(applyManagedBlock('  \n')).toBe(`  \n\n${renderManagedBlock()}`)
  })

  it('re-seeds the profile `[]` placeholder so the block is the only top-level collection', () => {
    const next = applyManagedBlock(PROFILE_SEED)
    expect(hasManagedBlock(next)).toBe(true)
    // No leftover root `[]` — the managed block is the whole top-level array now.
    expect(next.match(/^\[\]\s*$/m)).toBeNull()
    expect(next).not.toContain('[]\n\n# -- dsh-loop-engine')
    expect(next).toBe(`${PROFILE_SEED.replace('[]\n', '')}\n${renderManagedBlock()}`)
  })

  it('drops a root `[]` sitting above an already-present block', () => {
    // `dropSeedPlaceholder` runs on the replace path too, so no head — however it
    // was produced — can leave a second root collection beside the block.
    const next = applyManagedBlock(`[]\n\n${renderManagedBlock()}`)
    expect(next).toBe(`\n${renderManagedBlock()}`)
    expect(next.match(/^\[\]\s*$/m)).toBeNull()
    expect(hasManagedBlock(next)).toBe(true)
  })

  it('keeps an indented `[]` inside an entry config intact', () => {
    const prior = '# my patch\n- id: subagent-codex\n  config:\n    options: []\n'
    const next = applyManagedBlock(prior)
    expect(next).toContain('    options: []')
    expect(hasManagedBlock(next)).toBe(true)
  })

  it('makes a comment-only file loadable by giving it the block as its array', () => {
    // A comment-only file is present but parses to `null`; the harness demands a
    // top-level array, and the block is now that array. This is the exact input
    // that failed to boot `dsh web`.
    const commentOnly = '# a comment\n# second line\n'
    expect(applyManagedBlock(commentOnly)).toBe(`${commentOnly}\n${renderManagedBlock()}`)
    expect(applyManagedBlock('# comment')).toBe(`# comment\n\n${renderManagedBlock()}`)
  })

  it('is a fixed point on every shape it can produce', () => {
    const shapes = ['', '  \n', '# head', SEED, PROFILE_SEED, '# a comment\n# second line\n', renderManagedBlock()]
    for (const before of shapes) {
      const once = applyManagedBlock(before)
      expect(applyManagedBlock(once)).toBe(once)
    }
  })

  it('rewrites a legacy block to the constant block, keeping the rest of the file', () => {
    const head = '# my own patches\n- id: subagent-codex\n'
    for (const engine of LOOP_ENGINE_IDS) {
      const legacy = `${head}\n${legacySpan(engine)}`
      // The upgrade can still recover the engine the profile was pinned to…
      expect(legacyBlockEngineOf(legacy)).toBe(engine)
      const migrated = applyManagedBlock(legacy)
      // …but every engine migrates to the same engine-agnostic form, byte for
      // byte the file this head would get with no span at all.
      expect(migrated).toBe(applyManagedBlock(head))
      expect(migrated).toBe(`${head}\n${renderManagedBlock()}`)
      expect(legacyBlockEngineOf(migrated)).toBeUndefined()
      expect(hasManagedBlock(migrated)).toBe(true)
    }
  })

  it('normalizes a legacy block at file head to the bare block', () => {
    // No head means no blank separator either, so the migrated file is the block
    // alone — byte for byte what an absent layer gets, which is why
    // `src/invariant.ts` can compare this at-head shape against that seed.
    expect(applyManagedBlock(legacySpan('kimi'))).toBe(renderManagedBlock())
    expect(applyManagedBlock('')).toBe(renderManagedBlock())
  })

  it('rewrites an unknown legacy engine marker, so boot repairs it', () => {
    const text = `${SEED}\n${legacySpan('future-engine')}`
    expect(applyManagedBlock(text)).toBe(`${SEED}\n${renderManagedBlock()}`)
  })

  it('treats an unterminated span (no end marker) as extending to the end', () => {
    const unterminated = `# head\n\n${MANAGED_BLOCK_BEGIN}\n- id: agent-loop\n  disabled: true\n`
    expect(applyManagedBlock(unterminated)).toBe(`# head\n\n${renderManagedBlock()}`)
    // A lone begin marker at file head is the same case with no head at all.
    expect(applyManagedBlock(MANAGED_BLOCK_BEGIN)).toBe(renderManagedBlock())
  })

  it('replaces a block that starts at file head without a blank separator', () => {
    const block = renderManagedBlock()
    expect(applyManagedBlock(block)).toBe(block)
  })

  it('preserves user lines after the block byte for byte', () => {
    const tail = '# tail content\n'
    const text = `# head\n\n${renderManagedBlock()}\n${tail}`
    // The block is current, so the whole file comes back untouched.
    expect(applyManagedBlock(text)).toBe(text)
  })
})
