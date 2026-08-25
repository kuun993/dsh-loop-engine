/**
 * Public types of the Claude Code loop driver. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-loop-engine/engine/types
 */

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/** Claude Code permission modes that never wait for a human response. */
export type ClaudeCodePermissionMode = Extract<PermissionMode,
  | 'dontAsk'
  | 'acceptEdits'
  | 'auto'
  | 'plan'
  | 'bypassPermissions'>

/** Driver configuration after defaults and load-time validation. */
export interface ResolvedConfig {
  readonly permissionMode: ClaudeCodePermissionMode
  readonly env: Record<string, string>
  readonly model: string | undefined
  readonly disposeGraceMs: number
  readonly maxTurns: number | undefined
}
