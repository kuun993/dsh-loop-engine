/**
 * Maps completed app-server items and turn usage to dsh session-log events.
 * Only these end-state projections live here: token-level streaming deltas are
 * folded inline by the driver's step loop; this module turns the item that
 * finished a stream into the durable tool/call + tool/result events and folds
 * a finished turn's usage into a TokenUsage.
 *
 * @module dsh-loop-engine/engine-codex/appserver/mapping
 */

import type { TokenUsage, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'

/** Map app-server turn usage to dsh TokenUsage. */
export function mapUsage(usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningOutputTokens?: number }): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined ? { cacheReadTokens: usage.cachedInputTokens } : {}),
    ...(usage.reasoningOutputTokens !== undefined ? { reasoningTokens: usage.reasoningOutputTokens } : {}),
  }
}

/** Map a completed commandExecution item to tool call and result message. */
export function mapCommandExecution(item: { id: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string }): { call: { callId: ToolCallId; name: string; arguments: string }; result: ToolResultMessage } {
  return {
    call: {
      callId: ToolCallId(item.id),
      name: 'command_execution',
      arguments: JSON.stringify({ command: item.command ?? '' }),
    },
    result: createToolResultMessage({
      callId: ToolCallId(item.id),
      content: [{ type: 'text', text: item.aggregatedOutput ?? '' }],
      isError: (item.exitCode ?? 0) !== 0 || item.status === 'failed',
    }),
  }
}

/** Map a completed fileChange item to tool call and result message. */
export function mapFileChange(item: { id: string; changes?: unknown[]; status?: string }): { call: { callId: ToolCallId; name: string; arguments: string }; result: ToolResultMessage } {
  return {
    call: {
      callId: ToolCallId(item.id),
      name: 'apply_patch',
      arguments: JSON.stringify(item.changes ?? []),
    },
    result: createToolResultMessage({
      callId: ToolCallId(item.id),
      content: [{ type: 'text', text: `patch ${item.status ?? 'completed'}` }],
      isError: item.status === 'failed',
    }),
  }
}

/** Map a completed mcpToolCall item to tool call and result message. */
export function mapMcpToolCall(item: { id: string; server?: string; tool?: string; arguments?: unknown; result?: { content?: unknown[] }; error?: { message?: string } }): { call: { callId: ToolCallId; name: string; arguments: string }; result: ToolResultMessage } {
  const name = item.server !== undefined && item.tool !== undefined
    ? `${item.server}/${item.tool}`
    : 'mcp_tool_call'
  const isError = item.error !== undefined && item.error !== null
  return {
    call: {
      callId: ToolCallId(item.id),
      name,
      arguments: JSON.stringify(item.arguments ?? {}),
    },
    result: createToolResultMessage({
      callId: ToolCallId(item.id),
      content: isError
        ? [{ type: 'text', text: item.error?.message ?? 'tool call failed' }]
        : [{ type: 'text', text: JSON.stringify(item.result?.content ?? []) }],
      isError,
    }),
  }
}
