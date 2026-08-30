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
 * @module dsh-loop-engine/engine-codex/permission
 */
import type { PermissionEvent } from '../driver-core/permission-knobs.ts';
import type { CodexApprovalPolicy, CodexSandboxMode } from './types.ts';
/** The declarative permission stance one Codex thread runs under. */
export interface CodexPermission {
    readonly sandboxMode: CodexSandboxMode;
    readonly approvalPolicy: CodexApprovalPolicy;
}
/** Conservative unattended default: read-only sandbox, never ask. */
export declare const DEFAULT_CODEX_PERMISSION: CodexPermission;
/**
 * Resolve the session's effective Codex permission stance. Full access wins
 * outright; otherwise an `ask` policy maps to the CLI's on-request approval
 * inside a workspace-write sandbox; anything else — including a session with
 * no recorded knobs — fails closed.
 * @param events - the durable session log.
 * @returns the stance one query should run under.
 */
export declare function resolveSessionPermission(events: readonly PermissionEvent[]): CodexPermission;
//# sourceMappingURL=permission.d.ts.map