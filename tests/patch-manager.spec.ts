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
    for (const engine of ['in-process', 'claude-code'] as const) {
      const applied = applyManagedBlock(SEED, engine)
      const reborn = applyManagedBlock(applied, currentEngineOf(applied))
      expect(reborn).toBe(applied)
    }
  })

  it('starts a missing-block read for the claude-code engine from a plain seed', () => {
    const applied = applyManagedBlock(SEED, 'claude-code')
    expect(applied).toBe(`${SEED}\n${renderManagedBlock('claude-code')}`)
  })

  it('treats an unterminated block (no end marker) as extending to the end', () => {
    const text = `# head\n\n${MANAGED_BLOCK_BEGIN}claude-code --\n- id: agent-loop\n  disabled: true\n`
    const next = applyManagedBlock(text, 'in-process')
    expect(hasManagedBlock(next)).toBe(false)
    expect(next).toBe('# head\n')
  })

  it('replaces a block that starts at file head without a blank separator', () => {
    const block = renderManagedBlock('claude-code')
    expect(applyManagedBlock(block, 'claude-code')).toBe(block)
    expect(applyManagedBlock(block, 'in-process')).toBe('')
  })

  it('collapses the separator when content follows the removed block', () => {
    const tail = '# tail content\n'
    const text = `# head\n\n${renderManagedBlock('claude-code')}\n${tail}`
    const next = applyManagedBlock(text, 'in-process')
    expect(hasManagedBlock(next)).toBe(false)
    expect(next).toBe(`# head\n${tail}`)
  })
})