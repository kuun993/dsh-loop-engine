/**
 * Kimi Code slash-command bridge.
 *
 * The dsh `commands` runtime executes a registered command locally — the line is
 * consumed and never reaches the model — so a command whose real processing
 * lives inside the Kimi engine must forward the raw line back to the agent, which
 * Kimi then expands natively. Registering the built-ins keeps them visible in
 * the dsh web slash menu; unregistered `/lines` pass through as user text, but
 * the menu would hide the engine's command surface.
 *
 * The list below is exactly what the `kimi acp` command surface implements
 * (verified against kimi 0.28.1, both by driving `session/prompt` directly and
 * by reading the `available_commands_update` the child publishes): `compact`,
 * `status`, `usage`, `mcp`, `tasks`, `help`. Everything else Kimi's TUI offers
 * (`/login`, `/provider`, `/settings`, `/sessions`, `/clear`, `/plan`, …) is a
 * TUI control the ACP surface does not implement — forwarding one answers
 * `Unknown ACP command: /name.` — so none of them is registered. `skill:`
 * commands are already carried by the dsh skill injection seam and Kimi's own
 * shorthand, so they are not duplicated here.
 *
 * `model` is deliberately absent even though the CLI has it: the dsh web
 * client owns a `/model` contribution, and a same-named host command makes
 * `ui-commands` throw the whole command menu source away, leaving only the
 * skill group. `/goal` is absent too: the managed block frees the
 * `command-goal` slot for hosted engines, but the ACP surface has no `/goal` to
 * take it over, so registering one would only answer with an unknown-command
 * error.
 *
 * @module dsh-loop-engine/engine-kimi/commands
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition, CommandInvocation, CommandResult } from '../commands.ts'

/**
 * Build the forwarding handler for one Kimi slash command: it re-delivers the
 * full `/<name> [args]` line to the receiving agent as a plain user message,
 * where the engine expands it. `rawInput` already carries the separator
 * whitespace and any arguments.
 * @param name - the command name without the leading slash.
 * @returns the command handler.
 */
export function forwardKimiCommand(name: string): (invocation: CommandInvocation) => CommandResult {
  return (invocation: CommandInvocation): CommandResult => {
    invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `/${name}${invocation.rawInput}` }],
      source: { kind: 'user' },
    }))
    return { kind: 'success' }
  }
}

/** One built-in Kimi slash command, registered with a forwarding handler. */
function builtin(name: string, description: string): CommandDefinition {
  return { name, description, handler: forwardKimiCommand(name) }
}

/** Kimi Code's built-in slash commands that the ACP surface implements. */
export const KIMI_COMMANDS: readonly CommandDefinition[] = [
  builtin('compact', 'Compact the conversation context'),
  builtin('status', 'Show current session status'),
  builtin('usage', 'Show session token usage'),
  builtin('mcp', 'Show MCP server status'),
  builtin('tasks', 'List background tasks'),
  builtin('help', 'Show available ACP commands'),
]
