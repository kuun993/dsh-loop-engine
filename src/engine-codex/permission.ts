/**
 * Mapping from the dsh session's durable permission knobs to one Codex query's
 * declarative permission stance. Codex has no interactive approval callback:
 * permissions are the `sandboxMode` + `approvalPolicy` pair chosen when the
 * thread starts, so the fold maps the session's `sandbox/mode` and
 * `approval/policy` events directly, mirroring the web surface's presets:
 *   - full access → `danger-full-access` + `never` (no native checks at all),
 *   - an `ask` policy → `workspace-write` + `on-request` (the CLI's own
 *     interactive prompt degrades to a denial in the unattended dsh runtime),
 *   - anything else fails closed → `read-only` + `never`.
 *
 * @module @deepseek-ai/dsh-loop-engine/engine-codex/permission
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionApprovalPolicy, sessionSandboxMode } from '../engine/permission.ts'
import type { CodexApprovalPolicy, CodexSandboxMode } from './types.ts'

/** Minimal structural shape of one session log event (see engine/permission). */
type PermissionEvent = Pick<SessionEvent, 'data'> & { readonly type: string }

/** The declarative permission stance one Codex thread runs under. */
export interface CodexPermission {
  readonly sandboxMode: CodexSandboxMode
  readonly approvalPolicy: CodexApprovalPolicy
}

/** Conservative unattended default: read-only sandbox, never ask. */
export const DEFAULT_CODEX_PERMISSION: CodexPermission = {
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
}

/**
 * Resolve the session's effective Codex permission stance. Full access wins
 * outright; otherwise an `ask` policy maps to the CLI's on-request approval
 * inside a workspace-write sandbox; anything else — including a session with
 * no recorded knobs — fails closed.
 * @param events - the durable session log.
 * @returns the stance one query should run under.
 */
export function resolveSessionPermission(events: readonly PermissionEvent[]): CodexPermission {
  if (sessionSandboxMode(events) === 'danger-full-access') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  if (sessionApprovalPolicy(events) === 'ask') {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
  }
  return DEFAULT_CODEX_PERMISSION
}
