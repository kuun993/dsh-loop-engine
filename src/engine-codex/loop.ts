/**
 * Codex loop engine module: hosts the AgentFactory that drives every session
 * through the OpenAI Codex SDK, one stateless thread per dsh step, with the
 * durable session log as the sole source of model context. dsh-loop-engine
 * constructs this factory when the Codex engine is selected; this module is a
 * library, not a Cordis plugin entry. The Codex SDK spawns its own CLI binary
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
import { HostedLoopFactory } from '../driver-core/hosted-loop-factory.ts'

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

/** Host-face ctx key for the Codex loop service. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopCodex: CodexLoop
  }
}

/**
 * Concrete AgentFactory and driver service of the Codex loop. Creation and
 * resume follow the registry factory contract and the shared publication
 * transaction: prepare, run setup, then publish through both registries,
 * announce, and emit `agent/session-start`.
 */
export class CodexLoop extends HostedLoopFactory<ResolvedConfig, CodexAgent> {
  /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
  static inject = ['agents', 'sessions', 'systemPrompt']

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, 'agentLoopCodex', resolveConfig(config))
  }

  /** Construct the Codex driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): CodexAgent {
    return new CodexAgent(loopCtx, id, options, session, this.config)
  }
}
