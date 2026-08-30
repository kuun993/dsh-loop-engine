/**
 * Maps Pi RPC messages and end-of-execution events to dsh session-log events.
 * Token-level streaming deltas are folded inline by the driver's step loop
 * (they carry live progress); this module projects the end-state items — a
 * completed tool call, a completed tool execution, and a finished turn's usage
 * — into the durable `tool/call`, `tool/result`, and usage events.
 *
 * @module dsh-loop-engine/engine-pi/rpc/mapping
 */
import type { TokenUsage, ToolResultMessage } from '@deepseek-ai/dsh-llm';
import type { PiUsage } from './types.ts';
/** Map one Pi usage snapshot to dsh TokenUsage. */
export declare function mapUsage(usage: PiUsage): TokenUsage;
/**
 * Derive the compact transcript text of a Pi content block, joining nested
 * text segments so the durable tool-result block carries the read model text.
 * @param content - the result payload (e.g. `{ content: [{ type, text }, ...] }`).
 * @returns the joined text.
 */
export declare function resultText(content: unknown): string;
/** Map a completed Pi tool-execution end event to the durable tool/result message. */
export declare function mapToolResult(ev: {
    toolCallId: string;
    result: unknown;
    isError: boolean;
}): ToolResultMessage;
/** Map the identity of a Pi message tool call or execution start to a durable tool/call. */
export declare function mapToolCall(ev: {
    callId: string;
    name: string;
    arguments: unknown;
}): {
    callId: string;
    name: string;
    arguments: string;
};
//# sourceMappingURL=mapping.d.ts.map