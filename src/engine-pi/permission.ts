/**
 * Mapping from the dsh session's durable permission knobs to one Pi RPC
 * process's runtime stance. Pi carries no native permission system — "runs
 * with the permissions of the user" — so the driver cannot ask it to sandbox or
 * approve. The only available boundary is the process environment: the driver
 * either wraps the whole `pi --mode rpc` child in the dsh subprocess sandbox
 * and prunes its `--tools`, or (full access) lets it run under the dsh user.
 * The fold mirrors the codex bridge, mapping the session's `sandbox/mode` and
 * `approval/policy` events directly:
 *   - full access → `danger-full-access`, no tool pruning (native tools);
 *   - `workspace-write` → sandbox wrap with a write-capable tool set;
 *   - an `ask` policy → degraded to a read-only denial (Pi has no request
 *     callback, so interactive approval can only become a rejection);
 *   - anything else fails closed → `read-only`.
 *
 * @module @kuun993/dsh-loop-engine/engine-pi/permission
 */

import type { PermissionEvent } from '../driver-core/permission-knobs.ts'
import { sessionApprovalPolicy, sessionSandboxMode } from '../driver-core/permission-knobs.ts'
import type { PiSandboxMode } from './types.ts'

/** The runtime stance one Pi RPC process should run under. */
export interface PiPermission {
  /** Sandbox mode driving whether the child is wrapped in the dsh sandbox. */
  readonly sandboxMode: PiSandboxMode
  /** The `--tools` allowlist; empty means "use Pi's native tools" (no pruning). */
  readonly tools: readonly string[]
}

/** Conservative unattended default: read-only sandbox, no write/exec tools. */
export const DEFAULT_PI_PERMISSION: PiPermission = {
  sandboxMode: 'read-only',
  tools: ['read', 'grep', 'find', 'ls'],
}

/** A read-only-but-reachable tool set, used when the session asks for write access. */
const WORKSPACE_WRITE_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls', 'write', 'edit']

/** Full access carries no tool pruning: Pi runs with the dsh user's own tools. */
const FULL_ACCESS_TOOLS: readonly string[] = []

/**
 * Derive the `--tools` allowlist for a given sandbox stance. Full access prunes
 * nothing; `workspace-write` allows a write-capable set; `read-only` allows read
 * and search only.
 * @param mode - the resolved sandbox stance.
 * @returns the tool set to pass as `--tools`.
 */
export function toolsForSandbox(mode: PiSandboxMode): readonly string[] {
  switch (mode) {
    case 'danger-full-access': return FULL_ACCESS_TOOLS
    case 'workspace-write': return WORKSPACE_WRITE_TOOLS
    default: return DEFAULT_PI_PERMISSION.tools
  }
}

/**
 * Resolve the session's effective Pi runtime stance.
 * @param events - the durable session log.
 * @returns the stance one Pi RPC process should run under.
 */
export function resolveSessionPermission(events: readonly PermissionEvent[]): PiPermission {
  if (sessionSandboxMode(events) === 'danger-full-access') {
    return { sandboxMode: 'danger-full-access', tools: FULL_ACCESS_TOOLS }
  }
  // Pi has no approval callback, so an `ask` policy can only degrade to a
  // read-only denial — even against a workspace-write sandbox request.
  if (sessionApprovalPolicy(events) === 'ask') {
    return { sandboxMode: 'read-only', tools: DEFAULT_PI_PERMISSION.tools }
  }
  if (sessionSandboxMode(events) === 'workspace-write') {
    return { sandboxMode: 'workspace-write', tools: WORKSPACE_WRITE_TOOLS }
  }
  return DEFAULT_PI_PERMISSION
}
