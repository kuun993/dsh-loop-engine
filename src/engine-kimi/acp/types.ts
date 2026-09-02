/**
 * Agent Client Protocol (ACP) wire types for the `kimi acp` driver.
 *
 * Kimi exposes the ACP adapter over stdio (JSON-RPC 2.0). The driver speaks a
 * minimal, stable subset that a normal agent flow needs: initialize, session/new,
 * session/prompt, session/cancel, plus the `session/update` notifications carrying
 * incremental assistant text (`agent_message_chunk`), thinking
 * (`agent_thought_chunk`), and tool calls (`tool_call` / `tool_call_update`).
 * Tool-approval arrives as the reverse-RPC `session/request_permission`, which the
 * client must answer. Shapes below are the live-record deltas observed against the
 * 0.28.1 CLI; content blocks re-use a `{ type, text }` text shape (and tolerate
 * other block types by ignoring them).
 *
 * @module dsh-loop-engine/engine-kimi/acp/types
 */

/** A text content block in an ACP update (the observed kimi shape). */
export interface AcpTextContent {
  readonly type: 'text'
  readonly text: string
}

/** One tool-call content block: the observed kimi `{ type: 'content', content }` nesting. */
export interface AcpToolContentBlock {
  readonly type: 'content'
  readonly content: AcpTextContent
}

/** A content block in a chunk/thought update; text is handled, others are ignored. */
export type AcpContentBlock = AcpTextContent | { readonly type: 'image' | 'resource_link' | 'audio' | string; readonly [key: string]: unknown }

/** One `session/update` notification (partial; the discriminator is `sessionUpdate`). */
export interface AcpUpdate {
  readonly sessionUpdate: string
  readonly [key: string]: unknown
}

/** A tool-call announcement (`sessionUpdate: 'tool_call'`). */
export interface AcpToolCallExt extends AcpUpdate {
  readonly sessionUpdate: 'tool_call'
  readonly toolCallId: string
  readonly title: string
  readonly kind: string
  readonly status: string
  readonly content?: readonly AcpToolContentBlock[]
}

/** A tool-call progress/result stream (`sessionUpdate: 'tool_call_update'`). */
export interface AcpToolCallStreamExt extends AcpUpdate {
  readonly sessionUpdate: 'tool_call_update'
  readonly toolCallId: string
  readonly status: string
  readonly content?: readonly AcpToolContentBlock[]
}

/** The `session/request_permission` reverse-RPC params. */
export interface AcpPermissionRequest {
  readonly sessionId?: string
  readonly request?: unknown
}

/** Result of a completed `session/prompt` request (opaque; the turn ended). */
export interface AcpPromptResult {
  readonly [key: string]: unknown
}

/** The id-scoped response to a request (result or error). */
export interface AcpResponse {
  readonly id: number
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

/** A JSON-RPC request/notification frame on the wire. */
export interface AcpFrame {
  readonly jsonrpc: '2.0'
  readonly id?: number
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

/** Guards toolkit: is the frame a `session/update` notification carrying an update. */
export function isUpdateFrame(frame: AcpFrame): frame is AcpFrame & { readonly method: 'session/update'; readonly params: { readonly sessionId: string; readonly update: AcpUpdate } } {
  return frame.method === 'session/update'
    && typeof frame.params === 'object'
    && frame.params !== null
    && typeof (frame.params as { update?: unknown }).update === 'object'
    && (frame.params as { update?: unknown }).update !== null
}

/** Guards toolkit: is the frame a reverse-RPC request needing an approval answer. */
export function isPermissionRequestFrame(frame: AcpFrame): frame is AcpFrame & { readonly id: number; readonly method: 'session/request_permission' } {
  return frame.method === 'session/request_permission' && typeof frame.id === 'number'
}
