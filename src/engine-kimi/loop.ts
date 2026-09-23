/**
 * Kimi Code loop engine module: drives every session it is handed through a
 * persistent `kimi acp` child (Agent Client Protocol over stdio), speaking one
 * stateless `session/new` + `session/prompt` per dsh step, with the durable
 * session log as the sole source of model context. The router routes a session
 * here on the plugin's own engine record, else its agent preset; this module is
 * a library, not a Cordis plugin entry. Kimi has no host approval
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
import { HostedEngineRuntime } from '../driver-core/hosted-engine-runtime.ts'

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

/** Host-face ctx key this engine's runtime is registered under. */
export const KIMI_ENGINE_LABEL = 'agentLoopKimi'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopKimi: KimiLoop
  }
}

/**
 * Creation/resume machinery for the Kimi Code engine. The process-wide
 * AgentFactory slot belongs to the router, which delegates each session to the
 * engine its preset names; this class is that engine's driver, not a plugin.
 */
export class KimiLoop extends HostedEngineRuntime<ResolvedConfig, KimiAgent> {
  /** One-shot spawn capability handed to every agent, sandboxed by the subprocess seam. */
  readonly spawn: KimiSpawnCapability

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, KIMI_ENGINE_LABEL, resolveConfig(config))
    // Resolved lazily rather than injected: this engine is built only when a
    // session actually selects it, so a profile without the subprocess service
    // fails that session loud instead of stalling the whole plugin.
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error('loop-engine: the kimi engine needs the dsh subprocess service on this context')
    }
    this.spawn = (spec) => fromSubprocess(subprocess.spawn(kimiSubprocessSpec(spec, KIMI_DISPOSE_GRACE_MS)))
  }

  /** Construct the Kimi ACP driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): KimiAgent {
    return new KimiAgent(loopCtx, id, options, session, this.config, this.spawn, this.config.bin)
  }
}
