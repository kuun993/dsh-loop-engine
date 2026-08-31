/**
 * Pure translation from the Claude Agent SDK's message vocabulary to the dsh
 * session-log vocabulary. Each function maps one SDK message to the durable
 * event payloads the driver appends inside its current step, so the mapping
 * stays unit-testable without any SDK process.
 *
 * @module dsh-loop-engine/engine-claude/mapping
 */
import type { BetaMessage, BetaRawMessageStreamEvent, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { type ContentBlock, type StreamChunk, type TokenUsage, type ToolResultMessage } from '@deepseek-ai/dsh-llm';
import { CallId } from '../llm-compat.ts';
/** One tool invocation surfaced from a Claude Code assistant message. */
export interface MappedToolCall {
    /** SDK tool_use id, reused as the dsh call-id so results pair. */
    readonly callId: CallId;
    /** Tool name exactly as the SDK reported it. */
    readonly name: string;
    /** Raw JSON arguments string as the SDK produced them. */
    readonly arguments: string;
}
/** Result of translating one SDK assistant message. */
export interface MappedAssistantMessage {
    /** dsh content blocks: text verbatim, tool calls as tool-call blocks. */
    readonly content: ContentBlock[];
    /** Tool invocations surfaced as dsh tool/call events. */
    readonly toolCalls: readonly MappedToolCall[];
    /** Provider-reported token accounting, when present. */
    readonly usage: TokenUsage | undefined;
    /** Model id reported by the SDK message. */
    readonly model: string;
}
/**
 * Render an SDK tool input as the raw JSON string carried by a dsh tool-call
 * block. Values that cannot be stringified (undefined, functions, cyclic
 * graphs) fall back to a stable placeholder instead of failing the mapping.
 * @param input - the SDK tool input value.
 * @returns the JSON string, or a placeholder when the input is not JSON-serializable.
 */
export declare function stringifyToolInput(input: unknown): string;
/**
 * Translate one SDK assistant message into dsh content blocks and tool calls.
 * Text blocks map verbatim; tool_use blocks map to tool-call blocks and
 * surfaced calls; thinking blocks map to reasoning blocks; redacted-thinking
 * and unknown blocks are dropped.
 * @param message - the SDK assistant message.
 * @returns the mapped content, calls, usage, and model.
 */
export declare function mapAssistantMessage(message: BetaMessage): MappedAssistantMessage;
/**
 * Translate the tool_result blocks of one SDK user message into dsh
 * tool-result messages. Non-tool_result blocks are ignored: Claude Code user
 * messages inside a query carry only tool outcomes.
 * @param message - the SDK user message.
 * @returns the mapped tool-result messages, in block order.
 */
export declare function mapToolResults(message: MessageParam): ToolResultMessage[];
/**
 * Translate SDK token accounting into the dsh token-usage shape. Cache
 * breakpoints are optional; absent or null SDK counters stay absent.
 * @param usage - SDK-reported usage for one assistant message.
 * @returns dsh token accounting, omitting absent optional counters.
 */
export declare function mapUsage(usage: BetaUsage): TokenUsage;
/** Per-block-index tool-call identity captured at `content_block_start`, reused by `input_json_delta`. */
export interface StreamToolCall {
    readonly callId: CallId;
    readonly name: string;
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
export declare function mapStreamEvent(event: BetaRawMessageStreamEvent, toolCalls: Map<number, StreamToolCall>): StreamChunk[];
//# sourceMappingURL=mapping.d.ts.map