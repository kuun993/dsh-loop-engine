/**
 * Mapping from the dsh session's durable permission knobs to one Claude Code
 * query's native permission handling. The session log pins `sandbox/mode`
 * and `approval/policy` events at creation and records every later switch;
 * folding them per query keeps the Claude Code driver consistent with the
 * permission preset the web surface shows, including mid-session switches.
 *
 * @module dsh-loop-engine/engine-claude/permission
 */
import { sessionApprovalPolicy, sessionSandboxMode } from "../driver-core/permission-knobs.js";
/**
 * Resolve the session's effective native permission stance. Full access wins
 * outright (the web "full" preset pins it together with `never`); otherwise
 * an `ask` policy forwards permission requests to the dsh approval seam and
 * anything else — including a session with no recorded knobs — fails closed.
 * @param events - the durable session log.
 * @returns the stance one query should run under.
 */
export function resolveSessionPermission(events) {
    if (sessionSandboxMode(events) === 'danger-full-access')
        return { kind: 'bypass' };
    if (sessionApprovalPolicy(events) === 'ask')
        return { kind: 'ask' };
    return { kind: 'deny' };
}
/** Cap in characters for the tool-input excerpt attached to an approval request. */
const REASON_INPUT_CAP = 200;
/**
 * Human-readable explanation of WHY a native permission request is asked,
 * carrying a bounded excerpt of the exact tool input.
 * @param toolName - the native tool being decided.
 * @param input - the exact tool input.
 * @returns the approval request's reason text.
 */
export function approvalReason(toolName, input) {
    const excerpt = JSON.stringify(input);
    const bounded = excerpt.length > REASON_INPUT_CAP ? `${excerpt.slice(0, REASON_INPUT_CAP - 3)}...` : excerpt;
    return `Claude Code requests permission to run ${toolName}: ${bounded}`;
}
//# sourceMappingURL=permission.js.map