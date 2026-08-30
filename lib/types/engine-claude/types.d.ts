/**
 * Public types of the Claude Code loop driver. Types only — no runtime code.
 *
 * @module dsh-loop-engine/engine-claude/types
 */
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
/** Claude Code permission modes that never wait for a human response. */
export type ClaudeCodePermissionMode = Extract<PermissionMode, 'dontAsk' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'>;
/** Driver configuration after defaults and load-time validation. */
export interface ResolvedConfig {
    /** Pinned native mode; `undefined` follows the session's dsh permission knobs per query. */
    readonly permissionMode: ClaudeCodePermissionMode | undefined;
    readonly env: Record<string, string>;
    readonly model: string | undefined;
    readonly disposeGraceMs: number;
    readonly maxTurns: number | undefined;
}
//# sourceMappingURL=types.d.ts.map