/**
 * Kimi Code loop engine module: hosts the AgentFactory that drives every
 * session through a persistent `kimi acp` child (Agent Client Protocol over
 * stdio), speaking one stateless `session/new` + `session/prompt` per dsh step,
 * with the durable session log as the sole source of model context.
 * dsh-loop-engine constructs this factory when the Kimi engine is selected; this
 * module is a library, not a Cordis plugin entry. Kimi has no host approval
 * callback, so tool approvals surfaced by ACP (`session/request_permission`) are
 * answered from the session's dsh approval knobs (an `ask` policy degrades to
 * denial); the whole child is spawned through the dsh subprocess seam — the only
 * available privilege boundary — and the sandbox stance follows the session's
 * durable permission knobs as the subprocess provider resolves them (default
 * read-only).
 *
 * @module dsh-loop-engine/engine-kimi
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { KimiAgent } from './agent.ts'
import type { KimiSpawnCapability } from './process.ts'
import { fromSubprocess, kimiBinResolver, kimiSubprocessSpec } from './process.ts'
import type { ResolvedConfig } from './types.ts'
import { HostedLoopFactory } from '../driver-core/hosted-loop-factory.ts'

/** Grace in milliseconds for Kimi process-tree termination. */
export const KIMI_DISPOSE_GRACE_MS = 3000

/** Deployment-owned configuration for the Kimi loop plugin. */
export interface Config {
  /** Model alias for the `kimi` child (`-m`); Kimi native config owns the model when omitted. */
  model?: string
  /** Explicit environment entries passed to the `kimi` child. */
  env?: Record<string, string>
  /** Kimi CLI executable; `'kimi'` resolves through PATH when not pinned to an absolute path. */
  bin?: string
}

/** Schema of the Kimi loop plugin configuration. */
export const Config: z<Config> = z.object({
  model: z.string(),
  env: z.dict(z.string()).default({}),
  bin: z.string(),
})

/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config: Config): ResolvedConfig {
  return {
    model: config.model,
    env: config.env ?? {},
    bin: kimiBinResolver(config.bin),
  }
}

/** Host-face ctx key for the Kimi loop service. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopKimi: KimiLoop
  }
}

/**
 * Concrete AgentFactory and driver service of the Kimi loop. Creation and
 * resume follow the registry factory contract and the shared publication
 * transaction: prepare, run setup, then publish through both registries,
 * announce, and emit `agent/session-start`.
 */
export class KimiLoop extends HostedLoopFactory<ResolvedConfig, KimiAgent> {
  /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
  static inject = ['agents', 'sessions', 'systemPrompt', 'subprocess']

  /** One-shot spawn capability handed to every agent, sandboxed by the subprocess seam. */
  readonly spawn: KimiSpawnCapability

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, 'agentLoopKimi', resolveConfig(config))
    this.spawn = (spec) => fromSubprocess(this.runtime.ctx.subprocess.spawn(kimiSubprocessSpec(spec, KIMI_DISPOSE_GRACE_MS)))
  }

  /** Construct the Kimi ACP driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): KimiAgent {
    return new KimiAgent(loopCtx, id, options, session, this.config, this.spawn, this.config.bin)
  }
}
