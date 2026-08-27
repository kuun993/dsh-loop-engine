/**
 * Reading the dsh session's durable permission knobs from the session log.
 * Both the Claude Code and Codex drivers fold the same `sandbox/mode` and
 * `approval/policy` events (pinned at creation, re-recorded on every switch)
 * into per-query permission decisions; the knob readers are engine-free.
 *
 * @module @kuun993/dsh-loop-engine/driver-core/permission-knobs
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Minimal structural shape of one session log event. The base `SessionEvent`
 * union in this compilation does not carry the sandbox/approval packages'
 * augmentation keys, so the fold reads the wire shape directly.
 */
export type PermissionEvent = Pick<SessionEvent, 'data'> & { readonly type: string }

/** dsh sandbox modes, mirrored inline to avoid a peer dep on @deepseek-ai/dsh-sandbox-policy. */
export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** dsh approval policies, mirrored inline to avoid a peer dep on @deepseek-ai/dsh-user-approval. */
export type DshApprovalPolicy = 'ask' | 'never'

const SANDBOX_MODES: readonly DshSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
const APPROVAL_POLICIES: readonly DshApprovalPolicy[] = ['ask', 'never']

/** The session's sandbox-mode override: the last `sandbox/mode` event, if any. */
export function sessionSandboxMode(events: readonly PermissionEvent[]): DshSandboxMode | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as PermissionEvent
    if (event.type !== 'sandbox/mode') continue
    const mode = (event.data as { mode?: unknown }).mode
    return SANDBOX_MODES.includes(mode as DshSandboxMode) ? (mode as DshSandboxMode) : undefined
  }
  return undefined
}

/** The session's approval-policy override: the last `approval/policy` event, if any. */
export function sessionApprovalPolicy(events: readonly PermissionEvent[]): DshApprovalPolicy | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as PermissionEvent
    if (event.type !== 'approval/policy') continue
    const policy = (event.data as { policy?: unknown }).policy
    return APPROVAL_POLICIES.includes(policy as DshApprovalPolicy) ? (policy as DshApprovalPolicy) : undefined
  }
  return undefined
}
