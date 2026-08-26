/**
 * Claude Code built-in slash command definitions.
 *
 * These commands are registered into the DSH CommandRuntime when the
 * claude-code engine is active.  The handlers are stubs — the real command
 * processing happens inside the Claude Agent SDK — so the UI shows the
 * commands in the slash menu and the handler returns success immediately.
 *
 * @module @deepseek-ai/dsh-loop-engine/commands
 */

/** Minimal shape of a DSH command definition (avoiding a direct peer dep on @deepseek-ai/dsh-commands). */
export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly images?: boolean }
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

export interface CommandInvocation {
  readonly commandId: string
  readonly rawInput: string
  readonly signal: AbortSignal
}

export interface CommandResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** Claude Code's built-in slash commands. */
export const CLAUDE_CODE_COMMANDS: CommandDefinition[] = [
  {
    name: 'help',
    description: 'Show help about Claude Code commands',
    handler: async () => ({ kind: 'success' as const }),
  },
  {
    name: 'compact',
    description: 'Compact the conversation to reduce context usage',
    handler: async () => ({ kind: 'success' as const }),
  },
  {
    name: 'clear',
    description: 'Clear the conversation and start fresh',
    handler: async () => ({ kind: 'success' as const }),
  },
  {
    name: 'review',
    description: 'Review recent changes (git diff)',
    handler: async () => ({ kind: 'success' as const }),
  },
  {
    name: 'explain',
    description: 'Explain the selected code',
    handler: async () => ({ kind: 'success' as const }),
  },
  {
    name: 'fix',
    description: 'Fix issues in the code',
    handler: async () => ({ kind: 'success' as const }),
  },
  {
    name: 'tests',
    description: 'Add tests for the selected code',
    handler: async () => ({ kind: 'success' as const }),
  },
]