/**
 * Pure fold tests for the session-permission → Codex declarative-permission bridge.
 * @module tests/engine-codex/permission
 */

import { describe, expect, it } from 'vitest'
import {
  approvalDecision,
  approvalReason,
  approvalToolName,
  DEFAULT_CODEX_PERMISSION,
  elicitationResponse,
  permissionsGrant,
  resolveApprovalRequest,
  resolveSessionPermission,
  userInputQuestions,
  userInputResponse,
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

describe('approvalReason', () => {
  it('quotes the command being approved', () => {
    expect(approvalReason('item/commandExecution/requestApproval', { command: 'rm -rf /' }))
      .toBe('Codex requests permission for command execution: rm -rf /')
  })

  it('prefers the request reason when no command detail is available', () => {
    expect(approvalReason('item/fileChange/requestApproval', { reason: 'extra write access', grantRoot: '/root' }))
      .toBe('Codex requests permission for file change: extra write access')
  })

  it('caps an overlong detail excerpt', () => {
    const long = 'x'.repeat(300)
    const reason = approvalReason('item/commandExecution/requestApproval', { command: long })
    expect(reason.length).toBeLessThan(long.length + 60)
    expect(reason.endsWith('...')).toBe(true)
  })

  it('labels the three approval methods as their dsh tool identity', () => {
    expect(approvalToolName('item/commandExecution/requestApproval')).toBe('command')
    expect(approvalToolName('item/fileChange/requestApproval')).toBe('file-change')
    expect(approvalToolName('item/permissions/requestApproval')).toBe('permissions')
    expect(approvalToolName('some/other')).toBe('some/other')
  })

  it('falls back to stringifying non-object params and a non-string grant root', () => {
    expect(approvalReason('item/fileChange/requestApproval', 'plain')).toBe('Codex requests permission for file change: plain')
    expect(approvalReason('item/fileChange/requestApproval', { grantRoot: 42 })).toBe('Codex requests permission for file change: {"grantRoot":42}')
  })

  it('quotes a file-change grant root when no reason is present', () => {
    expect(approvalReason('item/fileChange/requestApproval', { grantRoot: '/root' }))
      .toBe('Codex requests permission for file change: /root')
  })
})

describe('approvalDecision and permissionsGrant', () => {
  it('accepts only an allowed-once outcome and declines everything else', () => {
    expect(approvalDecision('allowed-once')).toBe('accept')
    expect(approvalDecision('rejected')).toBe('decline')
    expect(approvalDecision('cancelled')).toBe('decline')
    expect(approvalDecision('unavailable')).toBe('decline')
  })

  it('grants the requested permissions only on allow', () => {
    const requested = { network: { enabled: true } }
    expect(permissionsGrant('allowed-once', requested)).toEqual({ permissions: requested, scope: 'turn' })
    expect(permissionsGrant('rejected', requested)).toEqual({ permissions: {}, scope: 'turn' })
  })
})

describe('resolveApprovalRequest', () => {
  it('maps command and file-change approvals to their native decisions', () => {
    expect(resolveApprovalRequest('item/commandExecution/requestApproval', { command: 'ls' }, 'allowed-once'))
      .toEqual({ result: { decision: 'accept' } })
    expect(resolveApprovalRequest('item/commandExecution/requestApproval', { command: 'ls' }, 'rejected'))
      .toEqual({ result: { decision: 'decline' } })
    expect(resolveApprovalRequest('item/fileChange/requestApproval', {}, 'cancelled'))
      .toEqual({ result: { decision: 'decline' } })
  })

  it('maps a permissions approval to a grant or an empty denial', () => {
    const requested = { network: { enabled: true } }
    expect(resolveApprovalRequest('item/permissions/requestApproval', { permissions: requested }, 'allowed-once'))
      .toEqual({ result: { permissions: requested, scope: 'turn' } })
    expect(resolveApprovalRequest('item/permissions/requestApproval', { permissions: requested }, 'unavailable'))
      .toEqual({ result: { permissions: {}, scope: 'turn' } })
  })

  it('treats a missing permissions field as an empty grant', () => {
    expect(resolveApprovalRequest('item/permissions/requestApproval', {}, 'allowed-once'))
      .toEqual({ result: { permissions: {}, scope: 'turn' } })
    expect(resolveApprovalRequest('item/permissions/requestApproval', null, 'allowed-once'))
      .toEqual({ result: { permissions: {}, scope: 'turn' } })
  })

  it('fails unknown methods with method-not-found', () => {
    expect(resolveApprovalRequest('item/tool/call', {}, 'allowed-once'))
      .toEqual({ error: { code: -32601, message: 'Method not found' } })
  })
})

describe('userInputQuestions', () => {
  it('projects the wire questions with headers and options', () => {
    expect(userInputQuestions({
      questions: [{
        id: 'q1',
        header: 'Deploy',
        question: 'Which environment?',
        options: [{ label: 'dev', description: 'the dev cluster' }, { label: 'prod' }],
      }],
    })).toEqual([{
      id: 'q1',
      header: 'Deploy',
      question: 'Which environment?',
      options: [{ label: 'dev', description: 'the dev cluster' }, { label: 'prod' }],
    }])
  })

  it('drops entries with no usable id, wording, or option label', () => {
    expect(userInputQuestions({
      questions: [
        { question: 'no id' },
        { id: 'q2' },
        { id: '', question: '' },
        { id: 'q3', question: 'keep me', options: ['nope', { description: 'no label' }, null] },
        'not-an-object',
      ],
    })).toEqual([{ id: 'q3', question: 'keep me' }])
  })

  it('returns nothing for params with no questions array', () => {
    expect(userInputQuestions({})).toEqual([])
    expect(userInputQuestions({ questions: 'nope' })).toEqual([])
    expect(userInputQuestions(null)).toEqual([])
  })
})

describe('userInputResponse', () => {
  it('maps an answer onto answer lists keyed by question id', () => {
    expect(userInputResponse({
      answers: [
        { id: 'q1', selected: ['dev'] },
        { id: 'q2', selected: [], custom: 'staging' },
      ],
    })).toEqual({ answers: { q1: { answers: ['dev'] }, q2: { answers: ['staging'] } } })
  })

  it('maps an empty custom answer to just the selected labels', () => {
    expect(userInputResponse({ answers: [{ id: 'q1', selected: ['a'], custom: '' }] }))
      .toEqual({ answers: { q1: { answers: ['a'] } } })
  })

  it('answers with an empty map when nobody answered', () => {
    expect(userInputResponse(undefined)).toEqual({ answers: {} })
  })
})

describe('elicitationResponse', () => {
  it('declines an unattended MCP elicitation', () => {
    expect(elicitationResponse()).toEqual({ action: 'decline' })
  })
})
