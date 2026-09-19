/**
 * Maps `kimi acp` `session/update` events to dsh session-log projections.
 *
 * Kimi streams incremental assistant text (`agent_message_chunk`), incremental
 * thinking (`agent_thought_chunk`), a tool-call announcement (`tool_call`) and its
 * progress/result updates (`tool_call_update`). Assistant text and thinking are
 * Deltas; a tool update's content is a whole Snapshot that replaces the previous
 * one. A tool call's identity arrives on the announcement but its input
 * (`rawInput`) does not — only a later update carries it. This module is pure: it
 * classifies an update, extracts chunk deltas, and projects the tool-call
 * identity/input/content/result so the agent can fold them into the durable log.
 * Content blocks use the observed kimi
 * `{ type: 'content', content: { type: 'text', text } }` nesting; unknown block
 * types are ignored.
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

/**
 * The tool call's real input as the JSON `arguments` string the durable
 * `tool/call` carries, when the frame supplies it.
 *
 * The `tool_call` announcement never carries `rawInput`; a later
 * `tool_call_update` does (measured against kimi 0.28.x: the execution-start
 * frame, `status: 'in_progress'`). A call's arguments are therefore unknowable
 * at announce time, and the driver logs the call only once an update supplies
 * them — or when the call settles, whichever comes first.
 * @param update - one tool-call announcement or update.
 * @returns the arguments string, or `undefined` when the frame omits the field.
 */
export function toolRawInput(update: AcpToolCallExt | AcpToolCallStreamExt): string | undefined {
  const raw = update.rawInput
  if (raw === undefined) return undefined
  // A wire string is already the arguments payload; anything else is a parsed
  // JSON value (`rawInput` is `unknown` in the protocol), so serialize it.
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

/** Whether a tool stream status is settled (no longer streaming). */
export function isToolSettledStatus(status: string): boolean {
  return status !== 'pending' && status !== 'queued' && status !== 'running' && status !== 'in_progress'
}

/** Whether a tool stream status denotes a failure. */
export function isToolErrorStatus(status: string): boolean {
  return status === 'failed' || status === 'error' || status === 'denied'
}

/**
 * The tool call's content as ONE update carries it: the joined text of its
 * observed `{ type: 'content', content: { type: 'text', text } }` blocks.
 *
 * Kimi re-sends the call's whole content on every `tool_call_update` rather than
 * streaming deltas (measured against 0.28.1: the string grows from the tool
 * input's rendering to the final output), so this is a *snapshot* — callers
 * replace with it, never append. `undefined` means the update carried no
 * content field at all (nothing to replace), which is distinct from a present
 * but empty one.
 * @param update - one tool-call announcement or update.
 * @returns the content snapshot, or `undefined` when the field is absent.
 */
export function toolContentText(update: AcpToolCallExt | AcpToolCallStreamExt): string | undefined {
  const blocks = update.content
  if (!Array.isArray(blocks)) return undefined
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
