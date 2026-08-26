/**
 * One Codex SDK query: options assembly for the class-based API. The driver
 * runs exactly one stateless thread per dsh step (`new Codex(...)` +
 * `startThread(...).runStreamed(...)`); this module owns no session state.
 * The Codex SDK spawns its own CLI binary — there is no spawn injection seam,
 * so the dsh subprocess service is deliberately not involved.
 *
 * @module @deepseek-ai/dsh-loop-engine/engine-codex/sdk
 */

import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { CodexPermission } from './permission.ts'

/** Grace in milliseconds kept for config symmetry with the Claude Code driver. */
export const DEFAULT_DISPOSE_GRACE_MS = 3000

/** Everything one SDK query needs, resolved at step time. */
export interface CodexQuerySpec {
  /** Absolute workspace the Codex CLI runs in. */
  readonly cwd: string
  /** Declarative permission stance for this query. */
  readonly permission: CodexPermission
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env?: Record<string, string>
  /** Model override for the SDK, when the deployment pins one. */
  readonly model?: string
  /** API key injected as CODEX_API_KEY, when the deployment pins one. */
  readonly apiKey?: string
  /** Base URL override for the Codex API endpoint. */
  readonly baseUrl?: string
  /** Whether the sandboxed agent may reach the network. */
  readonly networkAccessEnabled?: boolean
}

/** The assembled inputs of one stateless Codex query. */
export interface CodexQueryOptions {
  /** Constructor options for the per-step `Codex` instance. */
  readonly codexOptions: CodexOptions
  /** Options for the per-step `startThread` call. */
  readonly threadOptions: ThreadOptions
  /** Cancellation signal forwarded to `runStreamed`. */
  readonly signal: AbortSignal
}

/**
 * Build the thread options for one step's query.
 * @param spec - workspace, permission stance, and model pinning.
 * @returns the options for one `startThread` call.
 */
export function codexThreadOptions(spec: CodexQuerySpec): ThreadOptions {
  return {
    workingDirectory: spec.cwd,
    // A dsh session's workspace is not necessarily a git repository.
    skipGitRepoCheck: true,
    sandboxMode: spec.permission.sandboxMode,
    approvalPolicy: spec.permission.approvalPolicy,
    ...spec.model === undefined ? {} : { model: spec.model },
    ...spec.networkAccessEnabled === undefined
      ? {}
      : { networkAccessEnabled: spec.networkAccessEnabled },
  }
}

/**
 * Build the fixed SDK options for one step's query. The environment handed to
 * the Codex CLI is the credential-scrubbed parent environment layered with the
 * deployment's explicit entries; a pinned API key is injected as CODEX_API_KEY
 * (the SDK does not inherit `process.env` once `env` is provided, so the scrub
 * and overlay happen here, at the driver boundary).
 * @param spec - workspace, environment, and permission stance.
 * @param signal - per-query cancellation signal.
 * @returns the constructor/thread options plus the query signal.
 */
export function codexQueryOptions(
  spec: CodexQuerySpec,
  signal: AbortSignal,
): CodexQueryOptions {
  return {
    codexOptions: {
      env: {
        ...scrubbedParentEnv(),
        ...spec.env,
        ...spec.apiKey === undefined ? {} : { CODEX_API_KEY: spec.apiKey },
      },
      ...spec.baseUrl === undefined ? {} : { baseUrl: spec.baseUrl },
    },
    threadOptions: codexThreadOptions(spec),
    signal,
  }
}
