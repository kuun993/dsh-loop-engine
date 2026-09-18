/**
 * Mapping from the dsh session's durable permission knobs to one Pi RPC
 * process's runtime stance. Pi carries no native permission system — "runs
 * with the permissions of the user" — so the driver cannot ask it to sandbox or
 * approve. What is left is the `--tools` allowlist: the child runs under the
 * dsh user either way (the subprocess seam carries no confinement of its own),
 * so withholding a tool IS the stance. The fold mirrors the codex bridge,
 * mapping the session's `sandbox/mode` and `approval/policy` events directly:
 *   - full access → `danger-full-access`, no pruning (Pi's native tools);
 *   - `workspace-write` → a write-capable set, still without a shell;
 *   - an `ask` policy → degraded to a read-only denial (Pi has no request
 *     callback, so interactive approval can only become a rejection);
 *   - anything else fails closed → `read-only`.
 *
 * @module dsh-loop-engine/engine-pi/permission
 */

import type { PermissionEvent } from '../driver-core/permission-knobs.ts'
import { sessionApprovalPolicy, sessionSandboxMode } from '../driver-core/permission-knobs.ts'
import type { PiSandboxMode } from './types.ts'

/** The runtime stance one Pi RPC process should run under. */
export interface PiPermission {
  /** The resolved sandbox stance; selects the tool set, not a process sandbox. */
  readonly sandboxMode: PiSandboxMode
  /** The `--tools` allowlist — the stance's only enforcement; empty means no pruning. */
  readonly tools: readonly string[]
}

/**
 * Conservative unattended default: read-only sandbox, no write/exec tools. The
 * allowlist names pi's built-ins (`read`, `bash`, `edit`, `write`) and nothing
 * else — a name pi does not know matches no tool at all, silently, so a list
 * carrying invented entries would enforce less than it claims to.
 */
export const DEFAULT_PI_PERMISSION: PiPermission = {
  sandboxMode: 'read-only',
  tools: ['read'],
}

/** A write-capable tool set with no shell, used when the session asks for write access. */
const WORKSPACE_WRITE_TOOLS: readonly string[] = ['read', 'write', 'edit']

/** Full access carries no tool pruning: Pi runs with the dsh user's own tools. */
const FULL_ACCESS_TOOLS: readonly string[] = []

/**
 * Derive the `--tools` allowlist for a given sandbox stance. Full access prunes
 * nothing; `workspace-write` allows a write-capable set; `read-only` allows
 * reading and nothing else. Only pi's own built-in tool names appear here.
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
