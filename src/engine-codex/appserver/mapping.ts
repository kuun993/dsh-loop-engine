/**
 * Maps app-server streaming events to dsh StreamChunks and session-log events.
 * Token deltas become live partial chunks; completed items become durable
 * messages; tool calls/results become tool/call and tool/result events.
 *
 * @module @kuun993/dsh-loop-engine/engine-codex/appserver/mapping
 */

import type { ContentBlock, StreamChunk, TokenUsage, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { AppServerEvent } from './thread.ts'

/** The result of mapping one app-server event to dsh chunks. */
export interface MappedEvent {
  /** Live partial chunks (assistant/chunk events). */
  readonly chunks: readonly StreamChunk[]
  /** Durable message blocks for a completed item. */
  readonly contentBlocks: readonly ContentBlock[]
  /** Whether this event completes an item. */
  readonly itemCompleted: boolean
  /** The item type (for routing). */
  readonly itemType: string | undefined
  /** Whether this event completes the turn. */
  readonly turnCompleted: boolean
  /** Usage info from turn completion. */
  readonly usage: TokenUsage | undefined
  /** Whether this is an error. */
  readonly error: { readonly message: string; readonly willRetry: boolean } | undefined
}

/** State for mapping a turn's streaming events. */
export interface TurnMappingState {
  /** Current block index within the turn's message. */
  blockIndex: number
  /** Accumulated text for the current agent message block. */
  currentText: string
  /** Accumulated reasoning text for the current reasoning block. */
  currentReasoning: string
  /** The current item id being streamed. */
  currentItemId: string | undefined
  /** The current item type being streamed. */
  currentItemType: string | undefined
  /** Whether the current block is a text block. */
  isTextBlock: boolean
  /** Whether the current block is a reasoning block. */
  isReasoningBlock: boolean
}

/** Create initial mapping state for a new turn. */
export function createMappingState(): TurnMappingState {
  return {
    blockIndex: 0,
    currentText: '',
    currentReasoning: '',
    currentItemId: undefined,
    currentItemType: undefined,
    isTextBlock: false,
    isReasoningBlock: false,
  }
}

/** Map one app-server event to dsh chunks and content blocks. */
export function mapEvent(event: AppServerEvent, state: TurnMappingState): MappedEvent {
  const empty: MappedEvent = {
    chunks: [],
    contentBlocks: [],
    itemCompleted: false,
    itemType: undefined,
    turnCompleted: false,
    usage: undefined,
    error: undefined,
  }

  switch (event.kind) {
    case 'turn-started':
      return empty

    case 'item-started': {
      state.currentItemId = event.itemId
      state.currentItemType = event.itemType
      if (event.itemType === 'agentMessage') {
        state.isTextBlock = true
        state.isReasoningBlock = false
        state.blockIndex = 0
        state.currentText = ''
        return {
          ...empty,
          chunks: [{ type: 'block-start', index: 0, blockType: 'text' }],
          itemType: 'agentMessage',
        }
      }
      if (event.itemType === 'reasoning') {
        state.isTextBlock = false
        state.isReasoningBlock = true
        state.blockIndex = 0
        state.currentReasoning = ''
        return {
          ...empty,
          chunks: [{ type: 'block-start', index: 0, blockType: 'reasoning' }],
          itemType: 'reasoning',
        }
      }
      // Other item types (commandExecution, etc.) don't produce text blocks
      return { ...empty, itemType: event.itemType }
    }

    case 'agent-delta': {
      // Token-level streaming of the agent's message
      const chunk: StreamChunk = { type: 'text-delta', index: state.blockIndex, text: event.delta }
      state.currentText += event.delta
      return { ...empty, chunks: [chunk], itemType: 'agentMessage' }
    }

    case 'reasoning-summary-delta':
    case 'reasoning-text-delta': {
      // Token-level streaming of reasoning
      const chunk: StreamChunk = { type: 'reasoning-delta', index: state.blockIndex, text: event.delta }
      state.currentReasoning += event.delta
      return { ...empty, chunks: [chunk], itemType: 'reasoning' }
    }

    case 'plan-delta': {
      // Plan deltas map to reasoning blocks
      const chunk: StreamChunk = { type: 'reasoning-delta', index: state.blockIndex, text: event.delta }
      state.currentReasoning += event.delta
      return { ...empty, chunks: [chunk], itemType: 'reasoning' }
    }

    case 'item-completed': {
      const item = event.item
      if (item.type === 'agentMessage') {
        const content: ContentBlock = { type: 'text', text: item.text ?? state.currentText }
        return {
          ...empty,
          contentBlocks: [content],
          itemCompleted: true,
          itemType: 'agentMessage',
        }
      }
      if (item.type === 'reasoning') {
        // App-server reasoning items carry summary + content arrays.
        const summary = (item as { summary?: string[] }).summary
        const content = (item as { content?: string[] }).content
        const summaryText = summary !== undefined && summary.length > 0 ? summary.join('\n') : undefined
        const contentText = content !== undefined && content.length > 0 ? content.join('\n') : undefined
        const text = summaryText ?? contentText ?? state.currentReasoning
        return {
          ...empty,
          contentBlocks: [{ type: 'reasoning' as const, text }],
          itemCompleted: true,
          itemType: 'reasoning',
        }
      }
      if (item.type === 'commandExecution') {
        const callId = CallId(item.id)
        return {
          ...empty,
          contentBlocks: [
            { type: 'tool-call', id: callId, name: 'command_execution', arguments: JSON.stringify({ command: item.command ?? '' }) },
          ],
          itemCompleted: true,
          itemType: 'commandExecution',
        }
      }
      if (item.type === 'fileChange') {
        const callId = CallId(item.id)
        return {
          ...empty,
          contentBlocks: [
            { type: 'tool-call', id: callId, name: 'apply_patch', arguments: JSON.stringify(item.changes ?? []) },
          ],
          itemCompleted: true,
          itemType: 'fileChange',
        }
      }
      if (item.type === 'mcpToolCall') {
        const callId = CallId(item.id)
        const server = item.server as string | undefined
        const tool = item.tool as string | undefined
        const name = server && tool ? `${server}/${tool}` : 'mcp_tool_call'
        return {
          ...empty,
          contentBlocks: [
            { type: 'tool-call', id: callId, name, arguments: JSON.stringify(item.arguments ?? {}) },
          ],
          itemCompleted: true,
          itemType: 'mcpToolCall',
        }
      }
      return { ...empty, itemCompleted: true, itemType: item.type }
    }

    case 'turn-completed': {
      const turn = event.turn
      const usage = turn.usage
        ? {
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
            ...(turn.usage.cachedInputTokens !== undefined ? { cacheReadTokens: turn.usage.cachedInputTokens } : {}),
            ...(turn.usage.reasoningOutputTokens !== undefined ? { reasoningTokens: turn.usage.reasoningOutputTokens } : {}),
          }
        : undefined
      return { ...empty, turnCompleted: true, usage }
    }

    case 'token-usage':
      return empty // usage updates come during the turn; final usage is in turn-completed

    case 'error':
      return { ...empty, error: { message: event.error.message, willRetry: event.willRetry } }

    /* v8 ignore next -- AppServerEvent is a closed union; no unknown kinds */
    default:
      return empty
  }
}

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
export function mapCommandExecution(item: { id: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string }): { call: { callId: CallId; name: string; arguments: string }; result: ToolResultMessage } {
  return {
    call: {
      callId: CallId(item.id),
      name: 'command_execution',
      arguments: JSON.stringify({ command: item.command ?? '' }),
    },
    result: createToolResultMessage({
      callId: CallId(item.id),
      content: [{ type: 'text', text: item.aggregatedOutput ?? '' }],
      isError: (item.exitCode ?? 0) !== 0 || item.status === 'failed',
    }),
  }
}

/** Map a completed fileChange item to tool call and result message. */
export function mapFileChange(item: { id: string; changes?: unknown[]; status?: string }): { call: { callId: CallId; name: string; arguments: string }; result: ToolResultMessage } {
  return {
    call: {
      callId: CallId(item.id),
      name: 'apply_patch',
      arguments: JSON.stringify(item.changes ?? []),
    },
    result: createToolResultMessage({
      callId: CallId(item.id),
      content: [{ type: 'text', text: `patch ${item.status ?? 'completed'}` }],
      isError: item.status === 'failed',
    }),
  }
}

/** Map a completed mcpToolCall item to tool call and result message. */
export function mapMcpToolCall(item: { id: string; server?: string; tool?: string; arguments?: unknown; result?: { content?: unknown[] }; error?: { message?: string } }): { call: { callId: CallId; name: string; arguments: string }; result: ToolResultMessage } {
  const name = item.server !== undefined && item.tool !== undefined
    ? `${item.server}/${item.tool}`
    : 'mcp_tool_call'
  const isError = item.error !== undefined && item.error !== null
  return {
    call: {
      callId: CallId(item.id),
      name,
      arguments: JSON.stringify(item.arguments ?? {}),
    },
    result: createToolResultMessage({
      callId: CallId(item.id),
      content: isError
        ? [{ type: 'text', text: item.error?.message ?? 'tool call failed' }]
        : [{ type: 'text', text: JSON.stringify(item.result?.content ?? []) }],
      isError,
    }),
  }
}
