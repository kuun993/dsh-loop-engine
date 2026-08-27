/**
 * Pure translation from the Claude Agent SDK's message vocabulary to the dsh
 * session-log vocabulary. Each function maps one SDK message to the durable
 * event payloads the driver appends inside its current step, so the mapping
 * stays unit-testable without any SDK process.
 *
 * @module @deepseek-ai/dsh-loop-engine/engine-claude/mapping
 */

import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { MessageParam } from '@anthropic-ai/sdk/resources'
import {
  CallId,
  createToolResultMessage,
  type ContentBlock,
  type StreamChunk,
  type TokenUsage,
  type ToolResultMessage,
} from '@deepseek-ai/dsh-llm'

/** One tool invocation surfaced from a Claude Code assistant message. */
export interface MappedToolCall {
  /** SDK tool_use id, reused as the dsh call-id so results pair. */
  readonly callId: CallId
  /** Tool name exactly as the SDK reported it. */
  readonly name: string
  /** Raw JSON arguments string as the SDK produced them. */
  readonly arguments: string
}

/** Result of translating one SDK assistant message. */
export interface MappedAssistantMessage {
  /** dsh content blocks: text verbatim, tool calls as tool-call blocks. */
  readonly content: ContentBlock[]
  /** Tool invocations surfaced as dsh tool/call events. */
  readonly toolCalls: readonly MappedToolCall[]
  /** Provider-reported token accounting, when present. */
  readonly usage: TokenUsage | undefined
  /** Model id reported by the SDK message. */
  readonly model: string
}

/**
 * Render an SDK tool input as the raw JSON string carried by a dsh tool-call
 * block. Values that cannot be stringified (undefined, functions, cyclic
 * graphs) fall back to a stable placeholder instead of failing the mapping.
 * @param input - the SDK tool input value.
 * @returns the JSON string, or a placeholder when the input is not JSON-serializable.
 */
export function stringifyToolInput(input: unknown): string {
  try {
    // JSON.stringify is typed string but returns undefined for undefined input.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    return JSON.stringify(input) ?? 'null'
  } catch {
    return '[unserializable tool input]'
  }
}

/**
 * Translate one SDK assistant message into dsh content blocks and tool calls.
 * Text blocks map verbatim; tool_use blocks map to tool-call blocks and
 * surfaced calls; thinking blocks map to reasoning blocks; redacted-thinking
 * and unknown blocks are dropped.
 * @param message - the SDK assistant message.
 * @returns the mapped content, calls, usage, and model.
 */
export function mapAssistantMessage(message: BetaMessage): MappedAssistantMessage {
  const content: ContentBlock[] = []
  const toolCalls: MappedToolCall[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'tool_use': {
        const callId = CallId(block.id)
        content.push({
          type: 'tool-call',
          id: callId,
          name: block.name,
          arguments: stringifyToolInput(block.input),
        })
        toolCalls.push({
          callId,
          name: block.name,
          arguments: stringifyToolInput(block.input),
        })
        break
      }
      case 'thinking':
        // Claude Code thinking surfaces as a dsh reasoning block, matching
        // what the native adapters produce for thinking models.
        content.push({ type: 'reasoning', text: block.thinking })
        break
      default:
        // redacted-thinking and unknown blocks are not transcribed.
        break
    }
  }
  // The SDK types usage as required but streamed messages can omit it.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  const usage = message.usage === undefined ? undefined : mapUsage(message.usage)
  return {
    content,
    toolCalls,
    usage,
    model: message.model,
  }
}

/**
 * Translate the tool_result blocks of one SDK user message into dsh
 * tool-result messages. Non-tool_result blocks are ignored: Claude Code user
 * messages inside a query carry only tool outcomes.
 * @param message - the SDK user message.
 * @returns the mapped tool-result messages, in block order.
 */
export function mapToolResults(message: MessageParam): ToolResultMessage[] {
  const content = typeof message.content === 'string' ? [] : message.content
  const results: ToolResultMessage[] = []
  for (const block of content) {
    if (block.type !== 'tool_result') continue
    results.push(createToolResultMessage({
      callId: CallId(block.tool_use_id),
      content: toolResultContent(block.content),
      isError: block.is_error === true,
    }))
  }
  return results
}

/**
 * Render the nested content of one SDK tool_result block as dsh text blocks.
 * String content passes through verbatim; block content maps its text blocks
 * only. Unknown or empty content yields an empty text block so the caller can
 * still correlate the result.
 * @param content - the SDK tool_result content, string or block array.
 * @returns dsh text blocks in order.
 */
/**
 * Render the nested content of one SDK tool_result block as dsh text blocks.
 * String content passes through verbatim; block content maps its text blocks
 * only. Unknown or empty content yields an empty text block so the caller can
 * still correlate the result.
 * @param content - the SDK tool_result content, string or block array.
 * @returns dsh text blocks in order.
 */
function toolResultContent(content: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content })
    return blocks
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      // The beta and stable SDK unions differ; this mapping reads only the
      // text discriminant shared by both, so a structural cast is narrower
      // than importing either complete union.
      const candidate = block as { readonly type?: unknown; readonly text?: unknown } | null
      if (candidate === null || candidate.type !== 'text') continue
      if (typeof candidate.text !== 'string') continue
      blocks.push({ type: 'text', text: candidate.text })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '(no content)' })
  return blocks
}

/**
 * Translate SDK token accounting into the dsh token-usage shape. Cache
 * breakpoints are optional; absent or null SDK counters stay absent.
 * @param usage - SDK-reported usage for one assistant message.
 * @returns dsh token accounting, omitting absent optional counters.
 */
export function mapUsage(usage: BetaUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...usage.cache_read_input_tokens == null ? {} : { cacheReadTokens: usage.cache_read_input_tokens },
    ...usage.cache_creation_input_tokens == null ? {} : { cacheWriteTokens: usage.cache_creation_input_tokens },
  }
}

/** Per-block-index tool-call identity captured at `content_block_start`, reused by `input_json_delta`. */
export interface StreamToolCall {
  readonly callId: CallId
  readonly name: string
}

/**
 * Translate one SDK raw stream event into the dsh assistant chunks that drive
 * the live partial projection. Text blocks yield `block-start`/`text-delta`;
 * thinking blocks yield `block-start`/`reasoning-delta`; tool_use blocks yield
 * `block-start`/`tool-call-delta`. Redacted thinking, signature deltas,
 * `content_block_stop`, and transport events yield nothing — the durable
 * `assistant/message` is appended separately from the SDK's complete message,
 * so the streamed chunks never have to carry the whole block.
 * @param event - one raw stream event from an `includePartialMessages` query.
 * @param toolCalls - per-block-index tool identity, mutated here at a tool
 *   `content_block_start` so later `input_json_delta` can name the call.
 * @returns the chunks that change the visible partial (empty for non-visual events).
 */
export function mapStreamEvent(
  event: BetaRawMessageStreamEvent,
  toolCalls: Map<number, StreamToolCall>,
): StreamChunk[] {
  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block
      if (block.type === 'text') {
        return [{ type: 'block-start', index: event.index, blockType: 'text' }]
      }
      if (block.type === 'thinking') {
        return [{ type: 'block-start', index: event.index, blockType: 'reasoning' }]
      }
      if (block.type === 'tool_use') {
        toolCalls.set(event.index, { callId: CallId(block.id), name: block.name })
        return [{ type: 'block-start', index: event.index, blockType: 'tool-call' }]
      }
      return []
    }
    case 'content_block_delta': {
      const delta = event.delta
      if (delta.type === 'text_delta') {
        return [{ type: 'text-delta', index: event.index, text: delta.text }]
      }
      if (delta.type === 'thinking_delta') {
        return [{ type: 'reasoning-delta', index: event.index, text: delta.thinking }]
      }
      if (delta.type === 'input_json_delta') {
        const call = toolCalls.get(event.index)
        return [{
          type: 'tool-call-delta',
          index: event.index,
          id: call?.callId ?? CallId(`call-${event.index}`),
          ...call === undefined ? {} : { name: call.name },
          argumentsDelta: delta.partial_json,
        }]
      }
      return []
    }
    default:
      // message_start/message_delta/message_stop/content_block_stop and other
      // transport events do not change the visible partial.
      return []
  }
}
