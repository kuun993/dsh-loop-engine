/**
 * Maps Pi RPC messages and end-of-execution events to dsh session-log events.
 * Token-level streaming deltas are folded inline by the driver's step loop
 * (they carry live progress); this module projects the end-state items — a
 * completed tool call, a completed tool execution, and a finished turn's usage
 * — into the durable `tool/call`, `tool/result`, and usage events.
 *
 * @module dsh-loop-engine/engine-pi/rpc/mapping
 */
import { CallId, createToolResultMessage, } from '@deepseek-ai/dsh-llm';
/** Map one Pi usage snapshot to dsh TokenUsage. */
export function mapUsage(usage) {
    return {
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        ...(usage.cacheRead !== undefined && usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
        ...(usage.cacheWrite !== undefined && usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
    };
}
/**
 * Derive the compact transcript text of a Pi content block, joining nested
 * text segments so the durable tool-result block carries the read model text.
 * @param content - the result payload (e.g. `{ content: [{ type, text }, ...] }`).
 * @returns the joined text.
 */
export function resultText(content) {
    if (Array.isArray(content)) {
        return content.map((block) => {
            if (typeof block === 'object' && block !== null) {
                const text = block.text;
                return typeof text === 'string' ? text : '';
            }
            return '';
        }).filter(segment => segment !== '').join('\n\n');
    }
    if (typeof content === 'object' && content !== null) {
        const nested = content.content;
        const text = content.text;
        if (typeof text === 'string')
            return text;
        if (nested !== undefined)
            return resultText(nested);
    }
    return '';
}
/** Map a completed Pi tool-execution end event to the durable tool/result message. */
export function mapToolResult(ev) {
    return createToolResultMessage({
        callId: CallId(ev.toolCallId),
        content: [{ type: 'text', text: resultText(ev.result) || '(no content)' }],
        isError: ev.isError,
    });
}
/** Map the identity of a Pi message tool call or execution start to a durable tool/call. */
export function mapToolCall(ev) {
    return {
        callId: ev.callId,
        name: ev.name,
        arguments: JSON.stringify(ev.arguments ?? {}),
    };
}
//# sourceMappingURL=mapping.js.map