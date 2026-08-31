/**
 * Pure string-transform tests for the managed patch block.
 * @module tests/patch-manager
 */

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  applyManagedBlock,
  currentEngineOf,
  hasManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  renderManagedBlock,
} from '../src/patch-manager.ts'

const SEED = '# dsh profile patch layer\n'

describe('renderManagedBlock', () => {
  it('renders nothing for the in-process engine', () => {
    expect(renderManagedBlock('in-process')).toBe('')
  })

  it('renders the swap span for the claude-code engine', () => {
    const block = renderManagedBlock('claude-code')
    expect(block.startsWith(`${MANAGED_BLOCK_BEGIN}claude-code --\n`)).toBe(true)
    expect(block).toContain('- id: agent-loop\n  disabled: true')
    // The engine lives inside dsh-loop-engine; the block only disables the
    // base loop so the single AgentFactory slot has no collision.
    expect(block).not.toContain('agent-loop-claude-code')
    expect(block.endsWith(`${MANAGED_BLOCK_END}\n`)).toBe(true)
  })

  it('renders the swap span for the codex engine', () => {
    const block = renderManagedBlock('codex')
    expect(block.startsWith(`${MANAGED_BLOCK_BEGIN}codex --\n`)).toBe(true)
    expect(block).toContain('- id: agent-loop\n  disabled: true')
    expect(block.endsWith(`${MANAGED_BLOCK_END}\n`)).toBe(true)
  })
})

describe('block presence and engine derivation', () => {
  it('detects absence and derives in-process', () => {
    expect(hasManagedBlock(SEED)).toBe(false)
    expect(currentEngineOf(SEED)).toBe('in-process')
    expect(currentEngineOf('')).toBe('in-process')
  })

  it('detects presence and derives claude-code', () => {
    const text = `${SEED}\n${renderManagedBlock('claude-code')}`
    expect(hasManagedBlock(text)).toBe(true)
    expect(currentEngineOf(text)).toBe('claude-code')
  })

  it('detects presence and derives codex', () => {
    const text = `${SEED}\n${renderManagedBlock('codex')}`
    expect(hasManagedBlock(text)).toBe(true)
    expect(currentEngineOf(text)).toBe('codex')
  })

  it('reads an unknown engine marker as in-process', () => {
    const text = `${SEED}\n${MANAGED_BLOCK_BEGIN}future-engine --\n- id: agent-loop\n  disabled: true\n${MANAGED_BLOCK_END}\n`
    expect(hasManagedBlock(text)).toBe(true)
    expect(currentEngineOf(text)).toBe('in-process')
  })
})

describe('applyManagedBlock', () => {
  it('appends the block to a file without one, preserving prior bytes', () => {
    const prior = '# my own patches\n- id: subagent-claude-code\n'
    const next = applyManagedBlock(prior, 'claude-code')
    expect(next.startsWith(prior)).toBe(true)
    expect(next).toContain(renderManagedBlock('claude-code'))
    expect(currentEngineOf(next)).toBe('claude-code')
  })

  it('leaves a file without a block untouched for in-process', () => {
    expect(applyManagedBlock(SEED, 'in-process')).toBe(SEED)
    expect(applyManagedBlock('', 'in-process')).toBe('')
  })

  it('replaces an existing block with the same engine idempotently', () => {
    const once = applyManagedBlock(SEED, 'claude-code')
    const twice = applyManagedBlock(once, 'claude-code')
    expect(twice).toBe(once)
  })

  it('removes the block when switching back to in-process', () => {
    const once = applyManagedBlock(SEED, 'claude-code')
    const back = applyManagedBlock(once, 'in-process')
    expect(hasManagedBlock(back)).toBe(false)
    expect(currentEngineOf(back)).toBe('in-process')
  })

  it('keeps the file byte-for-byte identical after one full round trip', () => {
    const prior = '# my own patches\n- id: subagent-claude-code\n'
    const switched = applyManagedBlock(prior, 'claude-code')
    const restored = applyManagedBlock(switched, 'in-process')
    expect(restored).toBe(prior)
  })

  it('preserves lines after the block across removal', () => {
    const prior = '# head\n'
    const trailer = '# tail\n- id: tool-x\n'
    const switched = applyManagedBlock(`${prior}${trailer}`, 'claude-code')
    const restored = applyManagedBlock(switched, 'in-process')
    expect(restored).toBe(`${prior}${trailer}`)
  })

  it('handles a file without a trailing newline', () => {
    const prior = '# head'
    const next = applyManagedBlock(prior, 'claude-code')
    expect(next.startsWith(`${prior}\n\n${MANAGED_BLOCK_BEGIN}`)).toBe(true)
  })

  it('fixed point: reading back a block and re-applying that engine is stable', () => {
    for (const engine of ['in-process', 'claude-code', 'codex'] as const) {
      const applied = applyManagedBlock(SEED, engine)
      const reborn = applyManagedBlock(applied, currentEngineOf(applied))
      expect(reborn).toBe(applied)
    }
  })

  it('replaces a claude-code block with a codex block', () => {
    const once = applyManagedBlock(SEED, 'claude-code')
    const switched = applyManagedBlock(once, 'codex')
    expect(currentEngineOf(switched)).toBe('codex')
    expect(switched).toBe(`${SEED}\n${renderManagedBlock('codex')}`)
  })

  it('starts a missing-block read for the claude-code engine from a plain seed', () => {
    const applied = applyManagedBlock(SEED, 'claude-code')
    expect(applied).toBe(`${SEED}\n${renderManagedBlock('claude-code')}`)
  })

  it('treats an unterminated block (no end marker) as extending to the end', () => {
    const text = `# head\n\n${MANAGED_BLOCK_BEGIN}claude-code --\n- id: agent-loop\n  disabled: true\n`
    const next = applyManagedBlock(text, 'in-process')
    expect(hasManagedBlock(next)).toBe(false)
    expect(next).toBe('# head\n[]\n')
  })

  it('replaces a block that starts at file head without a blank separator', () => {
    const block = renderManagedBlock('claude-code')
    expect(applyManagedBlock(block, 'claude-code')).toBe(block)
    // Removing the only content cannot leave an empty file: the loader rejects
    // anything that is not a top-level array.
    expect(applyManagedBlock(block, 'in-process')).toBe('[]\n')
  })

  it('collapses the separator when content follows the removed block', () => {
    const tail = '# tail content\n'
    const text = `# head\n\n${renderManagedBlock('claude-code')}\n${tail}`
    const next = applyManagedBlock(text, 'in-process')
    expect(hasManagedBlock(next)).toBe(false)
    expect(next).toBe(`# head\n${tail}[]\n`)
  })

  it('does not add `[]` when the file still has entries of its own', () => {
    const prior = '# head\n- id: other\n'
    const next = applyManagedBlock(applyManagedBlock(prior, 'claude-code'), 'in-process')
    expect(next).toBe(prior)
    expect(next).not.toContain('[]')
  })
})
/**
 * The body dsh writes into a fresh profile's `cordis.patch.yml`: a comment
 * preamble plus an empty flow sequence. Every test above seeds a comments-only
 * file, which is why the `[]` case shipped broken — appending block sequence
 * items after `[]` is a YAML syntax error, and nothing here parsed the result.
 */
const PROFILE_SEED = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

describe('applyManagedBlock on a real profile seed', () => {
  it('produces parseable YAML when adding a block to the `[]` seed', () => {
    const next = applyManagedBlock(PROFILE_SEED, 'claude-code')
    expect(() => parse(next)).not.toThrow()
    expect(parse(next)).toEqual([{ id: 'agent-loop', disabled: true }])
    expect(currentEngineOf(next)).toBe('claude-code')
  })

  it('keeps the comment preamble when dropping the empty sequence', () => {
    const next = applyManagedBlock(PROFILE_SEED, 'claude-code')
    expect(next).toContain('# Your patch layer for this dsh profile')
    expect(next).not.toMatch(/^\s*\[\]\s*$/m)
  })

  it('restores the `[]` body so the removed-block file is still a patch list', () => {
    const added = applyManagedBlock(PROFILE_SEED, 'claude-code')
    const back = applyManagedBlock(added, 'in-process')
    expect(hasManagedBlock(back)).toBe(false)
    // A comments-only file parses as null, and app-boot's parsePatchList throws
    // "must be a top-level YAML array of loader patch entries" on it — which
    // fails the whole plugin tree, including this plugin's own insert row, so
    // no agent factory registers at all. It has to stay an (empty) array.
    expect(() => parse(back)).not.toThrow()
    expect(parse(back)).toEqual([])
    expect(back).toContain('# Your patch layer for this dsh profile')
  })

  it('round-trips the profile seed back to itself', () => {
    const added = applyManagedBlock(PROFILE_SEED, 'claude-code')
    expect(applyManagedBlock(added, 'in-process')).toBe(PROFILE_SEED)
  })

  it('stays an array across repeated engine switches', () => {
    let text = PROFILE_SEED
    for (const engine of ['claude-code', 'codex', 'pi', 'in-process', 'codex'] as const) {
      text = applyManagedBlock(text, engine)
      expect(() => parse(text)).not.toThrow()
      expect(Array.isArray(parse(text))).toBe(true)
      expect(currentEngineOf(text)).toBe(engine)
    }
  })

  it('does not disturb an `[]` that is a user entry rather than the whole body', () => {
    const withList = '# head\n- id: other\n  config: []\n'
    const next = applyManagedBlock(withList, 'claude-code')
    expect(parse(next)).toEqual([
      { id: 'other', config: [] },
      { id: 'agent-loop', disabled: true },
    ])
  })
})
