/**
 * Pure fold and mapping tests for the session-permission → native-permission bridge.
 * @module tests/engine-claude/permission
 */

import { describe, expect, it } from 'vitest'
import {
  approvalReason,
  resolveSessionPermission,
  sessionApprovalPolicy,
  sessionSandboxMode,
} from '../../src/engine-claude/permission.ts'

/** One structural log event. */
function event(type: string, data: unknown): { type: string; data: unknown } {
  return { type, data }
}

describe('sessionSandboxMode', () => {
  it('returns undefined for a log without sandbox events', () => {
    expect(sessionSandboxMode([])).toBeUndefined()
    expect(sessionSandboxMode([event('user/message', {})])).toBeUndefined()
  })

  it('reads the last sandbox/mode event', () => {
    expect(sessionSandboxMode([
      event('sandbox/mode', { mode: 'read-only' }),
      event('sandbox/mode', { mode: 'workspace-write' }),
    ])).toBe('workspace-write')
  })

  it('ignores a mode value outside the known set', () => {
    expect(sessionSandboxMode([event('sandbox/mode', { mode: 'yolo' })])).toBeUndefined()
  })
})

describe('sessionApprovalPolicy', () => {
  it('returns undefined for a log without policy events', () => {
    expect(sessionApprovalPolicy([])).toBeUndefined()
    expect(sessionApprovalPolicy([event('sandbox/mode', { mode: 'read-only' })])).toBeUndefined()
  })

  it('reads the last approval/policy event', () => {
    expect(sessionApprovalPolicy([
      event('approval/policy', { policy: 'never' }),
      event('approval/policy', { policy: 'ask' }),
    ])).toBe('ask')
  })

  it('ignores a policy value outside the known set', () => {
    expect(sessionApprovalPolicy([event('approval/policy', { policy: 'sometimes' })])).toBeUndefined()
  })
})

describe('resolveSessionPermission', () => {
  it('maps full access to bypass regardless of the policy', () => {
    expect(resolveSessionPermission([
      event('sandbox/mode', { mode: 'danger-full-access' }),
      event('approval/policy', { policy: 'ask' }),
    ])).toEqual({ kind: 'bypass' })
  })

  it('maps an ask policy without full access to ask', () => {
    expect(resolveSessionPermission([
      event('sandbox/mode', { mode: 'workspace-write' }),
      event('approval/policy', { policy: 'ask' }),
    ])).toEqual({ kind: 'ask' })
  })

  it('fails closed for never, read-only, and knob-less sessions', () => {
    expect(resolveSessionPermission([event('approval/policy', { policy: 'never' })])).toEqual({ kind: 'deny' })
    expect(resolveSessionPermission([event('sandbox/mode', { mode: 'read-only' })])).toEqual({ kind: 'deny' })
    expect(resolveSessionPermission([])).toEqual({ kind: 'deny' })
  })
})

describe('approvalReason', () => {
  it('carries the tool name and the full input when short', () => {
    expect(approvalReason('Bash', { command: 'ls' }))
      .toBe('Claude Code requests permission to run Bash: {"command":"ls"}')
  })

  it('bounds a long input excerpt with an ellipsis', () => {
    const reason = approvalReason('Write', { content: 'x'.repeat(500) })
    expect(reason.endsWith('...')).toBe(true)
    expect(reason.length).toBeLessThan(300)
  })
})
