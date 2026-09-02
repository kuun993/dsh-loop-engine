/**
 * Pure fold tests for the session-permission → ACP tool-approval bridge.
 * @module tests/engine-kimi/permission
 */

import { describe, expect, it } from 'vitest'
import { resolveToolApproval } from '../../src/engine-kimi/permission.ts'

/** One structural log event. */
function event(type: string, data: unknown): { type: string; data: unknown } {
  return { type, data }
}

describe('resolveToolApproval', () => {
  it('approves tools for never, full-access, workspace-write, and knob-less sessions', () => {
    expect(resolveToolApproval([])).toBe(true)
    expect(resolveToolApproval([event('approval/policy', { policy: 'never' })])).toBe(true)
    expect(resolveToolApproval([event('sandbox/mode', { mode: 'danger-full-access' })])).toBe(true)
    expect(resolveToolApproval([event('sandbox/mode', { mode: 'workspace-write' })])).toBe(true)
  })

  it('degrades an ask policy to a denial (fail-closed)', () => {
    expect(resolveToolApproval([event('approval/policy', { policy: 'ask' })])).toBe(false)
    // An ask policy wins even against a full-access sandbox request.
    expect(resolveToolApproval([
      event('approval/policy', { policy: 'ask' }),
      event('sandbox/mode', { mode: 'danger-full-access' }),
    ])).toBe(false)
  })
})
