/**
 * Mapping from the dsh session's durable permission knobs to one Claude Code
 * query's native permission handling. The session log pins `sandbox/mode`
 * and `approval/policy` events at creation and records every later switch;
 * folding them per query keeps the Claude Code driver consistent with the
 * permission preset the web surface shows, including mid-session switches.
 *
 * @module @kuun993/dsh-loop-engine/engine-claude/permission
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Minimal structural shape of one session log event. The base `SessionEvent`
 * union in this compilation does not carry the sandbox/approval packages'
 * augmentation keys, so the fold reads the wire shape directly.
 */
type PermissionEvent = Pick<SessionEvent, 'data'> & { readonly type: string }

/** dsh sandbox modes, mirrored inline to avoid a peer dep on @deepseek-ai/dsh-sandbox-policy. */
export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** dsh approval policies, mirrored inline to avoid a peer dep on @deepseek-ai/dsh-user-approval. */
export type DshApprovalPolicy = 'ask' | 'never'

/**
 * The effective native permission stance for one query:
 *   - `bypass` — full access: skip every native permission check.
 *   - `ask` — forward each native permission request to the dsh approval seam.
 *   - `deny` — auto-deny every native permission request (unattended default).
 */
export type SessionPermission =
  | { readonly kind: 'bypass' }
  | { readonly kind: 'ask' }
  | { readonly kind: 'deny' }

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

/**
 * Resolve the session's effective native permission stance. Full access wins
 * outright (the web "full" preset pins it together with `never`); otherwise
 * an `ask` policy forwards permission requests to the dsh approval seam and
 * anything else — including a session with no recorded knobs — fails closed.
 * @param events - the durable session log.
 * @returns the stance one query should run under.
 */
export function resolveSessionPermission(events: readonly PermissionEvent[]): SessionPermission {
  if (sessionSandboxMode(events) === 'danger-full-access') return { kind: 'bypass' }
  if (sessionApprovalPolicy(events) === 'ask') return { kind: 'ask' }
  return { kind: 'deny' }
}

/** Cap in characters for the tool-input excerpt attached to an approval request. */
const REASON_INPUT_CAP = 200

/**
 * Human-readable explanation of WHY a native permission request is asked,
 * carrying a bounded excerpt of the exact tool input.
 * @param toolName - the native tool being decided.
 * @param input - the exact tool input.
 * @returns the approval request's reason text.
 */
export function approvalReason(toolName: string, input: Record<string, unknown>): string {
  const excerpt = JSON.stringify(input)
  const bounded = excerpt.length > REASON_INPUT_CAP ? `${excerpt.slice(0, REASON_INPUT_CAP - 3)}...` : excerpt
  return `Claude Code requests permission to run ${toolName}: ${bounded}`
}
