/**
 * Mapping from the dsh session's durable permission knobs to one Claude Code
 * query's native permission handling. The session log pins `sandbox/mode`
 * and `approval/policy` events at creation and records every later switch;
 * folding them per query keeps the Claude Code driver consistent with the
 * permission preset the web surface shows, including mid-session switches.
 *
 * @module dsh-loop-engine/engine-claude/permission
 */
import type { PermissionEvent } from '../driver-core/permission-knobs.ts';
/**
 * The effective native permission stance for one query:
 *   - `bypass` — full access: skip every native permission check.
 *   - `ask` — forward each native permission request to the dsh approval seam.
 *   - `deny` — auto-deny every native permission request (unattended default).
 */
export type SessionPermission = {
    readonly kind: 'bypass';
} | {
    readonly kind: 'ask';
} | {
    readonly kind: 'deny';
};
/**
 * Resolve the session's effective native permission stance. Full access wins
 * outright (the web "full" preset pins it together with `never`); otherwise
 * an `ask` policy forwards permission requests to the dsh approval seam and
 * anything else — including a session with no recorded knobs — fails closed.
 * @param events - the durable session log.
 * @returns the stance one query should run under.
 */
export declare function resolveSessionPermission(events: readonly PermissionEvent[]): SessionPermission;
/**
 * Human-readable explanation of WHY a native permission request is asked,
 * carrying a bounded excerpt of the exact tool input.
 * @param toolName - the native tool being decided.
 * @param input - the exact tool input.
 * @returns the approval request's reason text.
 */
export declare function approvalReason(toolName: string, input: Record<string, unknown>): string;
//# sourceMappingURL=permission.d.ts.map