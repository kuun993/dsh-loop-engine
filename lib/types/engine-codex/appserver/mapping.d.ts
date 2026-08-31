/**
 * Maps completed app-server items and turn usage to dsh session-log events.
 * Only these end-state projections live here: token-level streaming deltas are
 * folded inline by the driver's step loop; this module turns the item that
 * finished a stream into the durable tool/call + tool/result events and folds
 * a finished turn's usage into a TokenUsage.
 *
 * @module dsh-loop-engine/engine-codex/appserver/mapping
 */
import type { TokenUsage, ToolResultMessage } from '@deepseek-ai/dsh-llm';
import { CallId } from '../../llm-compat.ts';
/** Map app-server turn usage to dsh TokenUsage. */
export declare function mapUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
}): TokenUsage;
/** Map a completed commandExecution item to tool call and result message. */
export declare function mapCommandExecution(item: {
    id: string;
    command?: string;
    aggregatedOutput?: string | null;
    exitCode?: number | null;
    status?: string;
}): {
    call: {
        callId: CallId;
        name: string;
        arguments: string;
    };
    result: ToolResultMessage;
};
/** Map a completed fileChange item to tool call and result message. */
export declare function mapFileChange(item: {
    id: string;
    changes?: unknown[];
    status?: string;
}): {
    call: {
        callId: CallId;
        name: string;
        arguments: string;
    };
    result: ToolResultMessage;
};
/** Map a completed mcpToolCall item to tool call and result message. */
export declare function mapMcpToolCall(item: {
    id: string;
    server?: string;
    tool?: string;
    arguments?: unknown;
    result?: {
        content?: unknown[];
    };
    error?: {
        message?: string;
    };
}): {
    call: {
        callId: CallId;
        name: string;
        arguments: string;
    };
    result: ToolResultMessage;
};
//# sourceMappingURL=mapping.d.ts.map