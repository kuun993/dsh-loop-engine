/**
 * Reading the dsh session's durable permission knobs from the session log.
 * Both the Claude Code and Codex drivers fold the same `sandbox/mode` and
 * `approval/policy` events (pinned at creation, re-recorded on every switch)
 * into per-query permission decisions; the knob readers are engine-free.
 *
 * @module dsh-loop-engine/driver-core/permission-knobs
 */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES = ['ask', 'never'];
/** The session's sandbox-mode override: the last `sandbox/mode` event, if any. */
export function sessionSandboxMode(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type !== 'sandbox/mode')
            continue;
        const mode = event.data.mode;
        return SANDBOX_MODES.includes(mode) ? mode : undefined;
    }
    return undefined;
}
/** The session's approval-policy override: the last `approval/policy` event, if any. */
export function sessionApprovalPolicy(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type !== 'approval/policy')
            continue;
        const policy = event.data.policy;
        return APPROVAL_POLICIES.includes(policy) ? policy : undefined;
    }
    return undefined;
}
//# sourceMappingURL=permission-knobs.js.map