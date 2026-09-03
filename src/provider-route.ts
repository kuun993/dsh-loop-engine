/**
 * Hosted-engine provider route placeholders.
 *
 * Every hosted engine logs its sessions' request/header with its own provider
 * label (`claude-code`, `codex`, `pi`, `kimi`) rather than a model endpoint the
 * harness llm registry serves — the engine owns its model natively. The web
 * host derives a session's model selection from that header and refuses a turn
 * whose provider no registered adapter serves, so without a placeholder route
 * the SECOND prompt of every hosted session fails with `model-unavailable`.
 * The placeholder serves the label while advertising no models; catalog groups
 * that advertise nothing are dropped, so the model picker is unchanged.
 *
 * @module dsh-loop-engine/provider-route
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { LoopEngineId } from './settings.ts'
import { PROVIDER as CLAUDE_CODE_PROVIDER } from './engine-claude/agent.ts'
import { PROVIDER as CODEX_PROVIDER } from './engine-codex/agent.ts'
import { PROVIDER as PI_PROVIDER } from './engine-pi/agent.ts'
import { PROVIDER as KIMI_PROVIDER } from './engine-kimi/agent.ts'

/** Provider route label each hosted engine logs into its sessions' request/header. */
export const HOSTED_PROVIDER_ROUTES: Readonly<Record<Exclude<LoopEngineId, 'in-process'>, string>> = {
  'claude-code': CLAUDE_CODE_PROVIDER,
  codex: CODEX_PROVIDER,
  pi: PI_PROVIDER,
  kimi: KIMI_PROVIDER,
}

/**
 * Placeholder adapter serving one hosted engine's provider route label. It
 * inherits the empty catalog and default metadata (the engine's model is not a
 * harness-selectable endpoint), and {@link stream} fails loud: a call reaching
 * it means a real model query was routed to an engine that owns its model
 * natively — a wiring bug, not a request to serve.
 */
export class HostedEngineRouteAdapter extends LlmAdapter {
  /**
   * @param label - the provider route label this placeholder serves.
   */
  constructor(private readonly label: string) {
    super()
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `provider "${this.label}" is a hosted loop engine route, not a model endpoint`,
      'HOSTED_ENGINE_ROUTE',
    )
  }
}
