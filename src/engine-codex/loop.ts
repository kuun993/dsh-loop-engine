/**
 * Codex loop engine module: drives every session it is handed through the
 * OpenAI Codex SDK, one stateless thread per dsh step, with the durable
 * session log as the sole source of model context. The router routes a session
 * here on the plugin's own engine record, else its agent preset; this module is
 * a library, not a Cordis plugin entry. The Codex SDK spawns its own CLI binary
 * (no spawn injection seam), so this loop deliberately does not inject the dsh
 * subprocess service.
 *
 * @module dsh-loop-engine/engine-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CodexAgent } from './agent.ts'
import type { CodexApprovalPolicy, CodexSandboxMode, ResolvedConfig } from './types.ts'
import { HostedEngineRuntime } from '../driver-core/hosted-engine-runtime.ts'

/** Codex CLI sandbox modes a deployment may pin. */
export const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

/** Codex CLI approval policies a deployment may pin. */
export const CODEX_APPROVAL_POLICIES: readonly CodexApprovalPolicy[] = [
  'never',
  'on-request',
  'on-failure',
  'untrusted',
]

/** Deployment-owned configuration for the Codex loop plugin. */
export interface Config {
  /**
   * Pinned sandbox mode for every thread. When omitted, each query follows the
   * session's dsh permission knobs (`sandbox/mode` and `approval/policy`):
   * full access maps to `danger-full-access`, an `ask` policy maps to
   * `workspace-write`, and anything else fails closed with `read-only`.
   */
  sandboxMode?: CodexSandboxMode
  /**
   * Pinned approval policy for every thread. When omitted, each query follows
   * the session's dsh permission knobs: an `ask` policy maps to `on-request`
   * (the CLI's own interactive prompt degrades to a denial in the unattended
   * dsh runtime) and anything else maps to `never`.
   */
  approvalPolicy?: CodexApprovalPolicy
  /** Explicit environment entries layered over the credential-scrubbed parent environment. */
  env?: Record<string, string>
  /** Model override for the SDK; Codex native settings own the model when omitted. */
  model?: string
}

/** Schema of the Codex loop plugin configuration. */
export const Config: z<Config> = z.object({
  sandboxMode: z.union([...CODEX_SANDBOX_MODES]),
  approvalPolicy: z.union([...CODEX_APPROVAL_POLICIES]),
  env: z.dict(z.string()).default({}),
  model: z.string(),
})

/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config: Config): ResolvedConfig {
  return {
    sandboxMode: config.sandboxMode,
    approvalPolicy: config.approvalPolicy,
    env: config.env ?? {},
    model: config.model,
  }
}

/** Host-face ctx key this engine's runtime is registered under. */
export const CODEX_ENGINE_LABEL = 'agentLoopCodex'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopCodex: CodexLoop
  }
}

/**
 * Creation/resume machinery for the Codex engine. The process-wide
 * AgentFactory slot belongs to the router, which delegates each session to the
 * engine its preset names; this class is that engine's driver, not a plugin.
 */
export class CodexLoop extends HostedEngineRuntime<ResolvedConfig, CodexAgent> {
  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, CODEX_ENGINE_LABEL, resolveConfig(config))
  }

  /** Construct the Codex driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): CodexAgent {
    return new CodexAgent(loopCtx, id, options, session, this.config)
  }
}
