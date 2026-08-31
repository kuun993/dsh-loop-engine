/**
 * Public types of the Claude Code loop driver. Types only — no runtime code.
 *
 * @module dsh-loop-engine/engine-claude/types
 */
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
/** Claude Code permission modes that never wait for a human response. */
export type ClaudeCodePermissionMode = Extract<PermissionMode, 'dontAsk' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'>;
/**
 * Which provider backend the CLI child is pointed at.
 *
 * The CLI resolves backends by precedence rather than by merging, so a host
 * environment carrying two of them silently runs on the wrong one. `auto`
 * picks the first configured backend in the order relay, Bedrock, Vertex,
 * direct; the explicit values pin one and drop the others.
 */
export type ClaudeCodeBackend = 'auto' | 'relay' | 'bedrock' | 'vertex' | 'anthropic';
/** Driver configuration after defaults and load-time validation. */
export interface ResolvedConfig {
    /** Pinned native mode; `undefined` follows the session's dsh permission knobs per query. */
    readonly permissionMode: ClaudeCodePermissionMode | undefined;
    readonly env: Record<string, string>;
    readonly model: string | undefined;
    readonly backend: ClaudeCodeBackend;
    readonly disposeGraceMs: number;
    readonly maxTurns: number | undefined;
}
//# sourceMappingURL=types.d.ts.map