/**
 * Pure string-transform tests for the managed patch block.
 * @module tests/patch-manager
 */

import { describe, expect, it } from 'vitest'
import {
  applyManagedBlock,
  currentEngineOf,
  hasManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  renderManagedBlock,
} from '../src/patch-manager.ts'

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
    // The dsh /goal command goes down with the loop: a hosted engine owns the
    // session's command surface (Kimi brings its own /goal).
    expect(block).toContain('- id: command-goal\n  disabled: true')
    expect(block.endsWith(`${MANAGED_BLOCK_END}\n`)).toBe(true)
  })

  it('renders the swap span for the codex engine', () => {
    const block = renderManagedBlock('codex')
    expect(block.startsWith(`${MANAGED_BLOCK_BEGIN}codex --\n`)).toBe(true)
    expect(block).toContain('- id: agent-loop\n  disabled: true')
    expect(block.endsWith(`${MANAGED_BLOCK_END}\n`)).toBe(true)
  })

  it('renders the swap span for the kimi engine', () => {
    const block = renderManagedBlock('kimi')
    expect(block.startsWith(`${MANAGED_BLOCK_BEGIN}kimi --\n`)).toBe(true)
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

  it('detects presence and derives kimi', () => {
    const text = `${SEED}\n${renderManagedBlock('kimi')}`
    expect(hasManagedBlock(text)).toBe(true)
    expect(currentEngineOf(text)).toBe('kimi')
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

  it('leaves a missing (empty) layer bare and re-seeds a comment-only file for in-process', () => {
    // A truly missing file is "no layer" — bare `''` is the harness's signal.
    expect(applyManagedBlock('', 'in-process')).toBe('')
    expect(applyManagedBlock('  \n', 'in-process')).toBe('  \n')
    // A comment-only file is present but parses to `null`; the harness demands a
    // top-level array, so the transform must re-seed `[]` rather than leave the
    // file uncrashable. This is the exact input that failed to boot `dsh web`.
    const commentOnly = '# a comment\n# second line\n'
    expect(applyManagedBlock(commentOnly, 'in-process')).toBe(`${commentOnly}[]\n`)
    expect(applyManagedBlock('# comment', 'in-process')).toBe('# comment\n[]\n')
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
    for (const engine of ['in-process', 'claude-code', 'codex', 'kimi'] as const) {
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
    // A removal that leaves no entries re-seeds an empty top-level array, so the
    // file stays a loadable patch list (a comment-only file is `null` to the loader).
    expect(next).toBe('# head\n[]\n')
  })

  it('replaces a block that starts at file head without a blank separator', () => {
    const block = renderManagedBlock('claude-code')
    expect(applyManagedBlock(block, 'claude-code')).toBe(block)
    expect(applyManagedBlock(block, 'in-process')).toBe('[]\n')
  })

  it('collapses the separator when content follows the removed block', () => {
    const tail = '# tail content\n'
    const text = `# head\n\n${renderManagedBlock('claude-code')}\n${tail}`
    const next = applyManagedBlock(text, 'in-process')
    expect(hasManagedBlock(next)).toBe(false)
    expect(next).toBe(`# head\n${tail}[]\n`)
  })

  it('replaces the profile seed `[]` placeholder so a block is the only top-level collection', () => {
    const next = applyManagedBlock(PROFILE_SEED, 'claude-code')
    expect(hasManagedBlock(next)).toBe(true)
    expect(currentEngineOf(next)).toBe('claude-code')
    // No leftover root `[]` — the managed block is the whole top-level array now.
    expect(next.match(/^\[\]\s*$/m)).toBeNull()
    expect(next).not.toContain('[]\n\n# -- dsh-loop-engine')
    // Round trip back to in-process leaves a clean single `[]`, valid on its own.
    expect(applyManagedBlock(next, 'in-process').match(/^\[\]\s*$/m)).not.toBeNull()
  })

  it('keeps an indented `[]` inside an entry config intact across a switch', () => {
    const prior = '# my patch\n- id: subagent-codex\n  config:\n    options: []\n'
    const switched = applyManagedBlock(prior, 'claude-code')
    expect(switched).toContain('    options: []')
    expect(hasManagedBlock(switched)).toBe(true)
  })
})