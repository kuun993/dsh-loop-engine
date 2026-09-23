/**
 * Claude Code loop engine module: drives every session it is handed through
 * the official Claude Agent SDK, one stateless query per dsh step, with the
 * durable session log as the sole source of model context. The router routes a
 * session here on the plugin's own engine record, else its recorded agent
 * preset; this module is a library, not a Cordis plugin entry.
 *
 * @module dsh-loop-engine/engine-claude
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ClaudeCodeAgent } from './agent.ts'
import { DEFAULT_DISPOSE_GRACE_MS, type SpawnCapability } from './sdk.ts'
import type { ClaudeCodePermissionMode, ResolvedConfig } from './types.ts'
import { HostedEngineRuntime } from '../driver-core/hosted-engine-runtime.ts'

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

/** Host-face ctx key this engine's runtime is registered under. */
export const CLAUDE_CODE_ENGINE_LABEL = 'agentLoopClaudeCode'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopClaudeCode: ClaudeCodeLoop
  }
}

/**
 * Creation/resume machinery for the Claude Code engine. The process-wide
 * AgentFactory slot belongs to the router, which delegates each session to the
 * engine its preset names; this class is that engine's driver, not a plugin.
 */
export class ClaudeCodeLoop extends HostedEngineRuntime<ResolvedConfig, ClaudeCodeAgent> {
  /** Process-spawn capability handed to every agent, sandboxed by the subprocess seam. */
  readonly spawn: SpawnCapability

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, CLAUDE_CODE_ENGINE_LABEL, resolveConfig(config))
    // Resolved lazily rather than injected: this engine is built only when a
    // session actually selects it, so a profile without the subprocess service
    // fails that session loud instead of stalling the whole plugin.
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error('loop-engine: the claude-code engine needs the dsh subprocess service on this context')
    }
    this.spawn = (spec) => subprocess.spawn(spec)
  }

  /** Construct the Claude Code driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): ClaudeCodeAgent {
    return new ClaudeCodeAgent(loopCtx, id, options, session, this.config, this.spawn)
  }
}
