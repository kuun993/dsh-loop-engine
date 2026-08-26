/**
 * Pure fold tests for the session-permission → Codex declarative-permission bridge.
 * @module tests/engine-codex/permission
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CODEX_PERMISSION,
  resolveSessionPermission,
} from '../../src/engine-codex/permission.ts'

/** One structural log event. */
function event(type: string, data: unknown): { type: string; data: unknown } {
  return { type, data }
}

describe('resolveSessionPermission', () => {
  it('maps full access to danger-full-access with no approval regardless of the policy', () => {
    expect(resolveSessionPermission([
      event('sandbox/mode', { mode: 'danger-full-access' }),
      event('approval/policy', { policy: 'ask' }),
    ])).toEqual({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' })
  })

  it('maps an ask policy without full access to workspace-write with on-request approval', () => {
    expect(resolveSessionPermission([
      event('sandbox/mode', { mode: 'workspace-write' }),
      event('approval/policy', { policy: 'ask' }),
    ])).toEqual({ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' })
  })

  it('fails closed for never, read-only, and knob-less sessions', () => {
    expect(resolveSessionPermission([event('approval/policy', { policy: 'never' })])).toEqual(DEFAULT_CODEX_PERMISSION)
    expect(resolveSessionPermission([event('sandbox/mode', { mode: 'read-only' })])).toEqual(DEFAULT_CODEX_PERMISSION)
    expect(resolveSessionPermission([])).toEqual(DEFAULT_CODEX_PERMISSION)
    expect(DEFAULT_CODEX_PERMISSION).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'never' })
  })
})
