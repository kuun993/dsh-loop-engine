/**
 * Maps `kimi acp` `session/update` events to dsh session-log projections.
 *
 * Kimi streams incremental assistant text (`agent_message_chunk`), incremental
 * thinking (`agent_thought_chunk`), a tool-call announcement (`tool_call`) and its
 * progress/result stream (`tool_call_update`). This module is pure: it classifies
 * an update, extracts chunk deltas, and projects the tool-call identity/result so
 * the agent can fold them into the durable log. Content blocks use the observed
 * kimi `{ type: 'content', content: { type: 'text', text } }` nesting; unknown
 * block types are ignored.
 *
 * @module dsh-loop-engine/engine-kimi/acp/mapping
 */

import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { AcpContentBlock, AcpToolCallExt, AcpToolCallStreamExt, AcpUpdate } from './types.ts'

/** Whether the update is an incremental assistant text chunk. */
export function isTextChunk(update: AcpUpdate): update is AcpUpdate & { readonly sessionUpdate: 'agent_message_chunk'; readonly content: AcpContentBlock } {
  return update.sessionUpdate === 'agent_message_chunk'
}

/** Whether the update is an incremental thinking chunk. */
export function isThoughtChunk(update: AcpUpdate): update is AcpUpdate & { readonly sessionUpdate: 'agent_thought_chunk'; readonly content: AcpContentBlock } {
  return update.sessionUpdate === 'agent_thought_chunk'
}

/** Whether the update announces a tool call. */
export function isToolCall(update: AcpUpdate): update is AcpToolCallExt {
  return update.sessionUpdate === 'tool_call'
}

/** Whether the update streams a tool call's progress/result. */
export function isToolCallUpdate(update: AcpUpdate): update is AcpToolCallStreamExt {
  return update.sessionUpdate === 'tool_call_update'
}

/** The delta text of a text/thinking chunk. */
export function chunkDelta(update: AcpUpdate): string {
  const content = (update as { content?: AcpContentBlock }).content
  if (content === undefined) return ''
  const text = (content as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

/** The raw tool-call id (+ content index) as the wire carries it. */
export function toolCallIdOf(update: AcpUpdate): string {
  return (update as { toolCallId?: unknown }).toolCallId as string
}

/** The tool display name (`title`). */
export function toolCallName(update: AcpUpdate): string {
  return (update as { title?: unknown }).title as string
}

/** Whether a tool stream status is settled (no longer streaming). */
export function isToolSettledStatus(status: string): boolean {
  return status !== 'pending' && status !== 'queued' && status !== 'running' && status !== 'in_progress'
}

/** Whether a tool stream status denotes a failure. */
export function isToolErrorStatus(status: string): boolean {
  return status === 'failed' || status === 'error' || status === 'denied'
}

/** Join the observed `{ type: 'content', content: { type: 'text', text } }` blocks. */
export function toolContentText(update: AcpToolCallExt | AcpToolCallStreamExt): string {
  const blocks = update.content ?? []
  return blocks.map((block) => (block.type === 'content' && block.content.type === 'text' ? block.content.text : '')).join('')
}

/** Project a completed tool call to a durable tool/result message. */
export function toolResult(callId: string, text: string, isError: boolean): ToolResultMessage {
  return createToolResultMessage({
    callId: ToolCallId(callId),
    content: [{ type: 'text', text: text.length > 0 ? text : '(no content)' }],
    isError,
  })
}
