/**
 * Pure fold tests for the session-permission → Pi runtime-stance bridge.
 * @module tests/engine-pi/permission
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PI_PERMISSION,
  resolveSessionPermission,
  toolsForSandbox,
} from '../../src/engine-pi/permission.ts'

/** One structural log event. */
function event(type: string, data: unknown): { type: string; data: unknown } {
  return { type, data }
}

describe('resolveSessionPermission', () => {
  it('maps full access to danger-full-access with no tool pruning regardless of the policy', () => {
    expect(resolveSessionPermission([
      event('sandbox/mode', { mode: 'danger-full-access' }),
      event('approval/policy', { policy: 'ask' }),
    ])).toEqual({ sandboxMode: 'danger-full-access', tools: [] })
  })

  it('maps a workspace-write sandbox to a write-capable tool set', () => {
    expect(resolveSessionPermission([
      event('sandbox/mode', { mode: 'workspace-write' }),
    ])).toEqual({
      sandboxMode: 'workspace-write',
      tools: ['read', 'grep', 'find', 'ls', 'write', 'edit'],
    })
  })

  it('degrades an ask policy to a read-only denial', () => {
    expect(resolveSessionPermission([
      event('sandbox/mode', { mode: 'workspace-write' }),
      event('approval/policy', { policy: 'ask' }),
    ])).toEqual({ sandboxMode: 'read-only', tools: ['read', 'grep', 'find', 'ls'] })
  })

  it('fails closed for never, read-only, and knob-less sessions', () => {
    expect(resolveSessionPermission([event('approval/policy', { policy: 'never' })])).toEqual(DEFAULT_PI_PERMISSION)
    expect(resolveSessionPermission([event('sandbox/mode', { mode: 'read-only' })])).toEqual(DEFAULT_PI_PERMISSION)
    expect(resolveSessionPermission([])).toEqual(DEFAULT_PI_PERMISSION)
    expect(DEFAULT_PI_PERMISSION).toEqual({ sandboxMode: 'read-only', tools: ['read', 'grep', 'find', 'ls'] })
  })
})

describe('toolsForSandbox', () => {
  it('maps each sandbox mode to its tool allowlist', () => {
    expect(toolsForSandbox('read-only')).toEqual(['read', 'grep', 'find', 'ls'])
    expect(toolsForSandbox('workspace-write')).toEqual(['read', 'grep', 'find', 'ls', 'write', 'edit'])
    expect(toolsForSandbox('danger-full-access')).toEqual([])
  })
})
