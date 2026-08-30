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
 * @module dsh-loop-engine/engine-pi/permission
 */
import type { PermissionEvent } from '../driver-core/permission-knobs.ts';
import type { PiSandboxMode } from './types.ts';
/** The runtime stance one Pi RPC process should run under. */
export interface PiPermission {
    /** Sandbox mode driving whether the child is wrapped in the dsh sandbox. */
    readonly sandboxMode: PiSandboxMode;
    /** The `--tools` allowlist; empty means "use Pi's native tools" (no pruning). */
    readonly tools: readonly string[];
}
/** Conservative unattended default: read-only sandbox, no write/exec tools. */
export declare const DEFAULT_PI_PERMISSION: PiPermission;
/**
 * Derive the `--tools` allowlist for a given sandbox stance. Full access prunes
 * nothing; `workspace-write` allows a write-capable set; `read-only` allows read
 * and search only.
 * @param mode - the resolved sandbox stance.
 * @returns the tool set to pass as `--tools`.
 */
export declare function toolsForSandbox(mode: PiSandboxMode): readonly string[];
/**
 * Resolve the session's effective Pi runtime stance.
 * @param events - the durable session log.
 * @returns the stance one Pi RPC process should run under.
 */
export declare function resolveSessionPermission(events: readonly PermissionEvent[]): PiPermission;
//# sourceMappingURL=permission.d.ts.map