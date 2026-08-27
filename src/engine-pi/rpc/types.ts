/**
 * Pi RPC protocol type definitions. A minimal subset of the upstream
 * `pi --mode rpc` protocol, covering only what the driver needs: the commands
 * it sends (`new_session`, `prompt`, `abort`, `get_session_stats`), the
 * response envelope, and the streaming events it maps into the durable dsh
 * session log. Types only — no runtime code.
 *
 * The protocol is strict LF (`\n`) JSONL: records are delimited only by a bare
 * `\n` (a trailing `\r` is tolerated), and Unicode separators such as U+2028 /
 * U+2029 are ordinary characters inside JSON strings — so a generic line reader
 * that treats them as newlines is not compliant.
 *
 * @module @kuun993/dsh-loop-engine/engine-pi/rpc/types
 */

// ── Commands (sent to stdin) ──

/** Optional per-command correlation id; echoed back on the response. */
export interface PiCommandCorrelation {
  readonly id?: number
}

/** Start a fresh Pi session (the driver issues one per dsh step). */
export interface PiNewSessionCommand extends PiCommandCorrelation {
  readonly type: 'new_session'
  readonly parentSession?: string
}

/** Send a user prompt to the agent and begin streaming events. */
export interface PiPromptCommand extends PiCommandCorrelation {
  readonly type: 'prompt'
  readonly message: string
  readonly images?: readonly PiImage[]
  readonly streamingBehavior?: 'steer' | 'followUp'
}

/** Abort the current agent operation. */
export interface PiAbortCommand extends PiCommandCorrelation {
  readonly type: 'abort'
}

/** Query session stats (usage/cost fallback when a message carries none). */
export interface PiGetSessionStatsCommand extends PiCommandCorrelation {
  readonly type: 'get_session_stats'
}

/** Every command the client can send. */
export type PiCommand =
  | PiNewSessionCommand
  | PiPromptCommand
  | PiAbortCommand
  | PiGetSessionStatsCommand

/** Message attachment (images) accepted by `prompt`. */
export interface PiImage {
  readonly type: 'image'
  readonly data: string
  readonly mimeType: string
}

// ── Responses / events (from stdout) ──

/** Successful or failed command response. */
export interface PiResponse {
  readonly type: 'response'
  readonly command?: string
  readonly success: boolean
  readonly error?: string
  readonly id?: number
  readonly data?: unknown
}

/** Session statistics returned by `get_session_stats`. */
export interface PiSessionStats {
  readonly tokens?: {
    readonly input?: number
    readonly output?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
    readonly total?: number
  }
  readonly contextUsage?: {
    readonly tokens?: number | null
    readonly contextWindow?: number
    readonly percent?: number | null
  }
}

// ── Messages ──

/** Provider-reported token usage attached to messages and updates. */
export interface PiUsage {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly totalTokens?: number
}

/** A content block of a Pi message. */
export type PiContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string }
  | { readonly type: 'toolCall'; readonly id: string; readonly name: string; readonly arguments: unknown }

/** One role-tagged Pi message. */
export interface PiMessage {
  readonly role: 'user' | 'assistant' | 'toolResult' | 'system'
  readonly content: string | readonly PiContent[]
  readonly usage?: PiUsage
  readonly isError?: boolean
  readonly toolCallId?: string
  readonly toolName?: string
  readonly timestamp?: number
  readonly id?: string
}

/** A tool result as carried by `turn_end.toolResults`. */
export interface PiToolResult {
  readonly role: 'toolResult'
  readonly toolCallId: string
  readonly toolName: string
  readonly content: readonly PiContent[]
  readonly isError?: boolean
  readonly usage?: PiUsage
}

// ── Streaming delta (assistant message event) ──

/** The `assistantMessageEvent` delta union of `message_update`. */
export type PiAssistantMessageEvent =
  | { readonly type: 'text_start'; readonly contentIndex: number }
  | { readonly type: 'text_delta'; readonly contentIndex: number; readonly delta: string }
  | { readonly type: 'text_end'; readonly contentIndex: number; readonly content?: string }
  | { readonly type: 'thinking_start'; readonly contentIndex: number }
  | { readonly type: 'thinking_delta'; readonly contentIndex: number; readonly delta: string }
  | { readonly type: 'thinking_end'; readonly contentIndex: number; readonly thinking?: string }
  | {
    readonly type: 'toolcall_start'
    readonly contentIndex: number
    readonly id: string
    readonly toolName: string
  }
  | { readonly type: 'toolcall_delta'; readonly contentIndex: number; readonly delta: string }
  | {
    readonly type: 'toolcall_end'
    readonly contentIndex: number
    readonly toolCall: { readonly id: string; readonly name: string; readonly arguments: unknown }
  }

// ── Events ──

/** An `extension_ui_request` (dialog or fire-and-forget). */
export interface PiExtensionUiRequest {
  readonly type: 'extension_ui_request'
  readonly id: string
  readonly method: 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text'
  readonly title?: string
  readonly options?: readonly string[]
  readonly message?: string
  readonly [key: string]: unknown
}

/** A tool-execution event (start / update / end). */
export type PiToolExecutionEvent =
  | {
    readonly type: 'tool_execution_start'
    readonly toolCallId: string
    readonly toolName: string
    readonly args: unknown
  }
  | {
    readonly type: 'tool_execution_update'
    readonly toolCallId: string
    readonly toolName: string
    readonly args: unknown
    readonly partialResult: unknown
  }
  | {
    readonly type: 'tool_execution_end'
    readonly toolCallId: string
    readonly toolName: string
    readonly result: unknown
    readonly isError: boolean
  }

/** Every agent event the driver consumes or ignores. */
export type PiEvent =
  | { readonly type: 'response' } & PiResponse
  | { readonly type: 'agent_start' }
  | { readonly type: 'agent_end'; readonly messages?: readonly PiMessage[]; readonly willRetry?: boolean }
  | { readonly type: 'agent_settled' }
  | { readonly type: 'turn_start' }
  | { readonly type: 'turn_end'; readonly message?: PiMessage; readonly toolResults?: readonly PiToolResult[] }
  | { readonly type: 'message_start'; readonly message: PiMessage }
  | { readonly type: 'message_update'; readonly usage?: PiUsage; readonly assistantMessageEvent: PiAssistantMessageEvent }
  | { readonly type: 'message_end'; readonly message: PiMessage }
  | PiToolExecutionEvent
  | { readonly type: 'compaction_start'; readonly reason?: string }
  | { readonly type: 'compaction_end'; readonly reason?: string; readonly aborted?: boolean; readonly willRetry?: boolean; readonly result?: unknown }
  | { readonly type: 'auto_retry_start'; readonly attempt?: number }
  | { readonly type: 'auto_retry_end'; readonly success?: boolean; readonly attempt?: number; readonly finalError?: string }
  | { readonly type: 'queue_update'; readonly steering?: readonly string[]; readonly followUp?: readonly string[] }
  | { readonly type: 'bash_execution_update'; readonly id?: string; readonly delta?: string }
  | PiExtensionUiRequest
