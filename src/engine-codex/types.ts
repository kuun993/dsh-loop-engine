/**
 * Public types of the Codex loop driver. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-loop-engine/engine-codex/types
 */

import type { ApprovalMode, SandboxMode } from '@openai/codex-sdk'

/** Codex CLI sandbox modes, re-exported under the driver's own name. */
export type CodexSandboxMode = SandboxMode

/** Codex CLI approval policies, re-exported under the driver's own name. */
export type CodexApprovalPolicy = ApprovalMode

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
