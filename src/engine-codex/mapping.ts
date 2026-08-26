/**
 * Pure translation from the Codex SDK's thread-event vocabulary to the dsh
 * session-log vocabulary. Codex streams at item granularity — there are no
 * incremental text deltas — so each function maps one terminal `ThreadItem`
 * (or the turn's usage) to the durable event payloads the driver appends
 * inside its current step, keeping the mapping unit-testable without any
 * Codex CLI process.
 *
 * @module @deepseek-ai/dsh-loop-engine/engine-codex/mapping
 */

import type {
  AgentMessageItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ReasoningItem,
  Usage,
} from '@openai/codex-sdk'
import {
  CallId,
  createToolResultMessage,
  type ContentBlock,
  type TokenUsage,
  type ToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import { stringifyToolInput, type MappedToolCall } from '../engine/mapping.ts'

/** One tool invocation plus its outcome, surfaced from a terminal Codex item. */
export interface MappedToolActivity {
  /** The tool/call payload. */
  readonly call: MappedToolCall
  /** The tool/result message. */
  readonly result: ToolResultMessage
}

/**
 * Translate one completed `agent_message` item into dsh content blocks. The
 * item's full text becomes a single text block (no incremental deltas exist).
 * @param item - the completed agent message item.
 * @returns the mapped content blocks.
 */
export function mapAgentMessage(item: AgentMessageItem): ContentBlock[] {
  return [{ type: 'text', text: item.text }]
}

/**
 * Translate one `reasoning` item into its thinking text, folded by the driver
 * into the following assistant message (mirroring the Claude Code driver's
 * thinking handling).
 * @param item - the completed reasoning item.
 * @returns the reasoning summary text.
 */
export function mapReasoning(item: ReasoningItem): string {
  return item.text
}

/**
 * Translate a terminal `command_execution` item into a tool call/result pair.
 * The command line is the call input; the aggregated output is the result,
 * flagged as an error when the execution failed or exited non-zero.
 * @param item - the completed (or failed) command execution item.
 * @returns the tool activity to log.
 */
export function mapCommandExecution(item: CommandExecutionItem): MappedToolActivity {
  return {
    call: {
      callId: CallId(item.id),
      name: 'command_execution',
      arguments: stringifyToolInput({ command: item.command }),
    },
    result: createToolResultMessage({
      callId: CallId(item.id),
      content: [{ type: 'text', text: item.aggregated_output || '(no output)' }],
      isError: item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0),
    }),
  }
}

/**
 * Translate a terminal `file_change` item into a tool call/result pair with
 * `apply_patch` semantics: the change set is the call input, and a one-line
 * summary is the result, flagged as an error when the patch failed.
 * @param item - the completed (or failed) file change item.
 * @returns the tool activity to log.
 */
export function mapFileChange(item: FileChangeItem): MappedToolActivity {
  const summary = item.changes.map(change => `${change.kind} ${change.path}`).join('\n')
  return {
    call: {
      callId: CallId(item.id),
      name: 'apply_patch',
      arguments: stringifyToolInput({ changes: item.changes }),
    },
    result: createToolResultMessage({
      callId: CallId(item.id),
      content: [{ type: 'text', text: summary || '(no changes)' }],
      isError: item.status === 'failed',
    }),
  }
}

/**
 * Translate a terminal `mcp_tool_call` item into a tool call/result pair. The
 * call is named `server/tool`; the result carries the server's error message
 * or the JSON-encoded result payload, flagged as an error on failure.
 * @param item - the completed (or failed) MCP tool call item.
 * @returns the tool activity to log.
 */
export function mapMcpToolCall(item: McpToolCallItem): MappedToolActivity {
  const failed = item.status === 'failed' || item.error !== undefined
  return {
    call: {
      callId: CallId(item.id),
      name: `${item.server}/${item.tool}`,
      arguments: stringifyToolInput(item.arguments),
    },
    result: createToolResultMessage({
      callId: CallId(item.id),
      content: [{
        type: 'text',
        text: item.error?.message ?? stringifyToolInput(item.result?.structured_content ?? item.result?.content ?? null),
      }],
      isError: failed,
    }),
  }
}

/**
 * Translate the turn's token accounting into the dsh token-usage shape. Codex
 * reports cached input and reasoning output as disjoint counters, matching the
 * dsh optional fields directly.
 * @param usage - SDK-reported usage for the completed turn.
 * @returns dsh token accounting.
 */
export function mapUsage(usage: Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cached_input_tokens,
    cacheWriteTokens: usage.cache_write_input_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
  }
}
