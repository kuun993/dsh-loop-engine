/**
 * One Claude Agent SDK query: options assembly, process seam projection, and
 * the headless interaction policy. The driver runs exactly one query per dsh
 * step; this module owns no session state.
 *
 * @module dsh-loop-engine/engine-claude/sdk
 */
import type { Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { ClaudeCodeBackend } from './types.ts';
/** Native lock-down mode fixed for every query unless deployment overrides it. */
export declare const DEFAULT_PERMISSION_MODE: "dontAsk";
/** Grace in milliseconds for Claude Code process-tree termination. */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
export type { PermissionMode };
/** Deployment-owned process-spawn capability handed over from the plugin. */
export type SpawnCapability = (spec: SubprocessSpawnSpec) => SubprocessHandle;
/** Everything one SDK query needs, resolved at step time. */
export interface ClaudeCodeQuerySpec {
    /** Absolute workspace the Claude Code process runs in. */
    readonly cwd: string;
    /** Native permission handling for this query. */
    readonly permissionMode: PermissionMode;
    /** Explicit environment entries layered over the scrubbed parent environment. */
    readonly env?: Record<string, string>;
    /** Grace in milliseconds for process-tree termination. */
    readonly disposeGraceMs: number;
    /** Model override for the SDK, when a selection or the deployment pins one. */
    readonly model?: string;
    /** Provider route the model id belongs to, used to diagnose a backend mismatch. */
    readonly provider?: string;
    /** Provider backend the child is pointed at; defaults to `auto`. */
    readonly backend?: ClaudeCodeBackend;
    /** Cap on the number of conversation turns before the query stops. */
    readonly maxTurns?: number;
    /**
     * Decide one native permission request through the dsh approval seam.
     * When present, `canUseTool` forwards to it instead of auto-denying.
     */
    readonly onToolPermission?: (toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<'allow' | 'deny'>;
    /** Spawn the Claude Code child under the shared process owner. */
    readonly spawn: SpawnCapability;
    /** Receive a human-readable denial or decline for one unattended interaction. */
    readonly onUnattended?: (description: string) => void;
}
/**
 * Diagnose one auto-answered interaction in headless mode.
 * @param mode - permission mode in force.
 * @param kind - what the interaction was.
 * @param answer - what the driver did.
 * @param why - reason the driver cannot forward the interaction.
 * @returns a stable one-line diagnostic.
 */
export declare function unattendedDiagnostic(mode: PermissionMode, kind: string, answer: string, why: string): string;
/**
 * Describe the backend the child will actually run on.
 *
 * A misrouted child fails far from its cause: with nothing configured the CLI
 * falls back to its own login state and reports "Not logged in", and with the
 * wrong backend it reports a model that is "not available". Neither names the
 * environment, so state the resolved routing up front.
 *
 * @param env - the composed child environment.
 * @param backend - the deployment's choice.
 * @returns a one-line diagnostic, or undefined when routing is unambiguous.
 */
export declare function backendDiagnostic(env: Record<string, string>, backend: ClaudeCodeBackend): string | undefined;
/**
 * Flag a model the active backend is unlikely to serve.
 *
 * The dsh selection names a provider route, and only a relay's endpoint is
 * deployment-chosen — so a selection routed at some other provider reaching a
 * cloud backend is a mismatch the child will discover as an opaque
 * model-not-found. The id is still sent as-is: the caller asked for it, the
 * provider lists it, and refusing here would substitute a model the user did
 * not pick.
 *
 * @param model - the resolved model id.
 * @param provider - the provider route the selection named, when it named one.
 * @param env - the composed child environment.
 * @returns a one-line diagnostic, or undefined when nothing looks wrong.
 */
export declare function modelDiagnostic(model: string | undefined, provider: string | undefined, env: Record<string, string>): string | undefined;
/**
 * Build the fixed official SDK options for one step's query.
 * @param spec - workspace, environment, process seam, and disposal policy.
 * @param controller - per-query cancellation owner.
 * @returns the options for one stateless query.
 */
export declare function claudeQueryOptions(spec: ClaudeCodeQuerySpec, controller: AbortController): Options;
//# sourceMappingURL=sdk.d.ts.map