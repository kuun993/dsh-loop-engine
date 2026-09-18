/**
 * Claude Code loop engine module: hosts the AgentFactory that drives every
 * session through the official Claude Agent SDK, one stateless query per dsh
 * step, with the durable session log as the sole source of model context.
 * dsh-loop-engine constructs this factory when the Claude Code engine is
 * selected; this module is a library, not a Cordis plugin entry.
 *
 * @module dsh-loop-engine/engine-claude
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ClaudeCodeAgent } from './agent.ts'
import { DEFAULT_DISPOSE_GRACE_MS } from './sdk.ts'
import type { ClaudeCodePermissionMode, ResolvedConfig } from './types.ts'
import { HostedLoopFactory } from '../driver-core/hosted-loop-factory.ts'

/** Deployment-selectable non-interactive Claude Code permission modes. */
export const CLAUDE_CODE_PERMISSION_MODES: readonly ClaudeCodePermissionMode[] = [
  'dontAsk',
  'acceptEdits',
  'auto',
  'plan',
  'bypassPermissions',
]

/** Deployment-owned configuration for the Claude Code loop plugin. */
export interface Config {
  /**
   * Native non-interactive permission handling for every query. When omitted,
   * each query follows the session's dsh permission knobs (`sandbox/mode` and
   * `approval/policy`): full access bypasses native checks, an `ask` policy
   * forwards requests to the dsh approval seam, and anything else auto-denies.
   * A pinned mode overrides the session for every query: `dontAsk` auto-denies,
   * `acceptEdits` accepts edits, `auto` uses the native classifier, `plan`
   * returns a plan without approving execution, and `bypassPermissions`
   * explicitly skips permission checks.
   */
  permissionMode?: ClaudeCodePermissionMode
  /** Explicit environment entries layered over the credential-scrubbed parent environment. */
  env?: Record<string, string>
  /** Model label for the logged request header; Claude Code native settings own the actual model. */
  model?: string
  /** Grace in milliseconds for Claude Code process-tree termination. */
  disposeGraceMs?: number
  /** Cap on the number of conversation turns before each query stops. */
  maxTurns?: number
}

/** Schema of the Claude Code loop plugin configuration. */
export const Config: z<Config> = z.object({
  permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES]),
  env: z.dict(z.string()).default({}),
  model: z.string(),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  maxTurns: z.number().step(1).min(1),
})

/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config: Config): ResolvedConfig {
  const disposeGraceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0) {
    throw new Error('agent-loop-claude-code: disposeGraceMs must be a positive finite number')
  }
  if (disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `agent-loop-claude-code: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    permissionMode: config.permissionMode,
    env: config.env ?? {},
    model: config.model,
    disposeGraceMs,
    maxTurns: config.maxTurns,
  }
}

/** Host-face ctx key for the Claude Code loop service. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopClaudeCode: ClaudeCodeLoop
  }
}

/**
 * Concrete AgentFactory and driver service of the Claude Code loop. Creation
 * and resume follow the registry factory contract and the shared publication
 * transaction: prepare, run setup, then publish through both registries,
 * announce, and emit `agent/session-start`.
 */
export class ClaudeCodeLoop extends HostedLoopFactory<ResolvedConfig, ClaudeCodeAgent> {
  /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
  static inject = ['agents', 'sessions', 'systemPrompt', 'subprocess']

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, 'agentLoopClaudeCode', resolveConfig(config))
  }

  /** Construct the Claude Code driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): ClaudeCodeAgent {
    return new ClaudeCodeAgent(loopCtx, id, options, session, this.config)
  }
}
