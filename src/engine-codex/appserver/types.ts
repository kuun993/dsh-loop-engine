/**
 * App-server protocol type definitions. A minimal subset of the types generated
 * by `codex app-server generate-ts`, covering only what the driver needs for
 * streaming (initialize, thread/start, turn/start, notifications).
 *
 * @module dsh-loop-engine/engine-codex/appserver/types
 */

// ── JSON-RPC 2.0 envelope ──

/** A JSON-RPC 2.0 request sent to the app-server. */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

/** A JSON-RPC 2.0 response (success or error). */
export interface JsonRpcResponse {
  readonly id: number
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

/** A JSON-RPC 2.0 notification (no id). */
export interface JsonRpcNotification {
  readonly method: string
  readonly params: unknown
}

// ── Initialize ──

export interface InitializeParams {
  readonly clientInfo: { readonly name: string; readonly title: string | null; readonly version: string }
  readonly capabilities: { readonly experimentalApi: boolean; readonly requestAttestation: boolean } | null
}

export interface InitializeResult {
  readonly userAgent: string
  readonly codexHome: string
  readonly platformFamily: string
  readonly platformOs: string
}

// ── Thread ──

/** Sandbox mode accepted by `thread/start`; unlike turn policies, this is a string enum. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Internally tagged sandbox override accepted by `turn/start`. */
export type SandboxPolicy =
  | { readonly type: 'dangerFullAccess' }
  | { readonly type: 'readOnly'; readonly networkAccess: boolean }
  | { readonly type: 'externalSandbox'; readonly networkAccess: 'restricted' | 'enabled' }
  | {
    readonly type: 'workspaceWrite'
    readonly writableRoots: readonly string[]
    readonly networkAccess: boolean
    readonly excludeTmpdirEnvVar: boolean
    readonly excludeSlashTmp: boolean
  }

export interface ThreadStartParams {
  readonly model?: string | null
  readonly modelProvider?: string | null
  readonly cwd?: string | null
  readonly approvalPolicy?: string | null
  readonly sandbox?: SandboxMode | null
  readonly ephemeral?: boolean | null
  readonly [key: string]: unknown
}

export interface ThreadInfo {
  readonly id: string
  readonly sessionId: string
  readonly modelProvider: string
  readonly [key: string]: unknown
}

export interface ThreadStartResult {
  readonly thread: ThreadInfo
}

export interface ThreadResumeParams {
  readonly threadId: string
  readonly cwd?: string | null
  readonly approvalPolicy?: string | null
  readonly sandbox?: string | null
  readonly [key: string]: unknown
}

// ── Turn ──

export interface TurnStartParams {
  readonly threadId: string
  readonly input: readonly TurnInput[]
  readonly cwd?: string | null
  readonly approvalPolicy?: string | null
  readonly sandboxPolicy?: SandboxPolicy | null
  readonly model?: string | null
  readonly [key: string]: unknown
}

export interface TurnInput {
  readonly type: 'text'
  readonly text: string
}

export interface TurnInfo {
  readonly id: string
  readonly status: string
  readonly error: { readonly message: string } | null
  readonly items: readonly unknown[]
  readonly [key: string]: unknown
}

export interface TurnStartResult {
  readonly turn: TurnInfo
}

export interface TurnInterruptParams {
  readonly threadId: string
  readonly turnId: string
}

// ── Notifications (delta streaming) ──

/** item/agentMessage/delta — agent message token delta. */
export interface AgentMessageDeltaNotification {
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly delta: string
}

/** item/reasoning/summaryTextDelta — reasoning summary token delta. */
export interface ReasoningSummaryTextDeltaNotification {
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly delta: string
  readonly summaryIndex: number
}

/** item/reasoning/textDelta — reasoning content token delta. */
export interface ReasoningTextDeltaNotification {
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly delta: string
  readonly contentIndex: number
}

/** item/plan/delta — plan delta. */
export interface PlanDeltaNotification {
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly delta: string
}

/** item/started — item lifecycle start. */
export interface ItemStartedNotification {
  readonly threadId: string
  readonly turnId: string
  readonly item: {
    readonly type: string
    readonly id: string
    readonly [key: string]: unknown
  }
  readonly startedAtMs: number
}

/** item/completed — item lifecycle end. */
export interface ItemCompletedNotification {
  readonly threadId: string
  readonly turnId: string
  readonly item: {
    readonly type: string
    readonly id: string
    readonly text?: string
    readonly [key: string]: unknown
  }
  readonly completedAtMs: number
}

/** turn/completed — turn end with usage. */
export interface TurnCompletedNotification {
  readonly threadId: string
  readonly turn: TurnInfo & {
    readonly usage?: {
      readonly inputTokens: number
      readonly cachedInputTokens?: number
      readonly outputTokens: number
      readonly reasoningOutputTokens?: number
    }
  }
}

/** thread/tokenUsage/updated — token usage update. */
export interface ThreadTokenUsageUpdatedNotification {
  readonly threadId: string
  readonly turnId: string
  readonly tokenUsage: {
    readonly total: {
      readonly totalTokens: number
      readonly inputTokens: number
      readonly cachedInputTokens: number
      readonly outputTokens: number
      readonly reasoningOutputTokens: number
    }
    readonly last: {
      readonly totalTokens: number
      readonly inputTokens: number
      readonly cachedInputTokens: number
      readonly outputTokens: number
      readonly reasoningOutputTokens: number
    }
  }
}

/** error notification. */
export interface ErrorNotification {
  readonly threadId: string
  readonly turnId: string
  readonly error: {
    readonly message: string
    readonly codexErrorInfo?: string | null
    readonly additionalDetails?: string | null
  }
  readonly willRetry: boolean
}
