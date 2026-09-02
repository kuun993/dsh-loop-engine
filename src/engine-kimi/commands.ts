/**
 * Kimi Code slash-command bridge.
 *
 * The dsh `commands` runtime executes a registered command locally — the line is
 * consumed and never reaches the model — so a command whose real processing
 * lives inside the Kimi engine must forward the raw line back to the agent, which
 * Kimi then expands (as far as the ACP prompt surface supports). Registering the
 * built-ins keeps them visible in the dsh web slash menu; unregistered `/lines`
 * pass through as user text, but the menu would hide the engine's command
 * surface.
 *
 * Kimi's slash commands are chiefly TUI controls (`/login`, `/provider`,
 * `/settings`, `/sessions`, `/tasks`, …) that the ACP prompt surface does not
 * expand the way an interactive TUI does; this bridge therefore registers the
 * subset that are meaningful to forward to the engine (session/mode/status and
 * the goal form). `skill:` commands are already carried by the dsh skill
 * injection seam and Kimi's own shorthand, so they are not duplicated here.
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

/** Kimi Code's built-in slash commands that make sense to forward to the engine. */
export const KIMI_COMMANDS: readonly CommandDefinition[] = [
  builtin('help', 'Show available Kimi Code commands'),
  builtin('status', 'Show the current session runtime state'),
  builtin('compact', 'Compact the conversation context to free token usage'),
  builtin('clear', 'Start a fresh session, discarding the current context'),
  builtin('model', 'Switch the LLM model used in the current session'),
  builtin('plan', 'Toggle plan (read-only exploration) mode'),
  builtin('auto', 'Toggle auto permission mode'),
  builtin('usage', 'Show token usage, context, and quota information'),
  builtin('version', 'Display the Kimi Code CLI version number'),
  builtin('goal', 'Start or manage an autonomous goal'),
]
