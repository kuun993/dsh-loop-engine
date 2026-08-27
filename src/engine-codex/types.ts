/**
 * Public types of the Codex loop driver. Types only — no runtime code.
 *
 * @module @kuun993/dsh-loop-engine/engine-codex/types
 */

/** Codex CLI sandbox modes, as spoken by the app-server `sandbox` field. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Codex CLI approval policies, as spoken by the app-server `approvalPolicy` field. */
export type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted'

/** Driver configuration after defaults and load-time validation. */
export interface ResolvedConfig {
  /** Pinned sandbox mode; `undefined` follows the session's dsh permission knobs per query. */
  readonly sandboxMode: CodexSandboxMode | undefined
  /** Pinned approval policy; `undefined` follows the session's dsh permission knobs per query. */
  readonly approvalPolicy: CodexApprovalPolicy | undefined
  readonly env: Record<string, string>
  readonly model: string | undefined
  readonly apiKey: string | undefined
  readonly baseUrl: string | undefined
  readonly networkAccessEnabled: boolean | undefined
  readonly disposeGraceMs: number
  readonly maxTurns: number | undefined
}
