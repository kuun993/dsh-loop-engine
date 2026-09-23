/**
 * Hosted-engine provider route placeholders.
 *
 * Every hosted engine logs its sessions' request/header with its own provider
 * label (`claude-code`, `codex`, `pi`, `kimi`) rather than a model endpoint the
 * harness llm registry serves — the engine owns its model natively. The web
 * host derives a session's model selection from that header and refuses a turn
 * whose provider no registered adapter serves, so without a placeholder route
 * the SECOND prompt of every hosted session fails with `model-unavailable`.
 * The placeholder serves the label and advertises no models unless a deployment
 * injects a catalog (only `pi` does, from its model probe); catalog groups that
 * advertise nothing are dropped, so the picker is otherwise unchanged.
 *
 * Serving the label is only half of it: the label is not a model endpoint, and a
 * session switched back to `in-process` really does call a model — so that
 * switch writes the deployment default into the session instead
 * (`model-selection-reset.ts`), which is what keeps a real request away from
 * this route.
 *
 * @module dsh-loop-engine/provider-route
 */

import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { LoopEngineId } from './settings.ts'
import type { PiModelEntry } from './engine-pi/probe.ts'
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

/** Injectable catalog source a hosted engine route can advertise over the placeholder. */
export interface HostedEngineRouteAdapterOptions {
  /**
   * Optional model catalog generator. When present, `listModels` advertises
   * these entries under this route's provider label; when absent, the catalog
   * stays empty (the default, "engine owns its models" behavior).
   */
  readonly listModels?: () => readonly PiModelEntry[]
}

/**
 * Placeholder adapter serving one hosted engine's provider route label. It
 * advertises the injected catalog when a deployment provides one and stays
 * empty otherwise (the engine's model is not itself a harness-selectable
 * endpoint), and {@link stream} fails loud: a call reaching it means a real
 * model query was routed to an engine that owns its model natively — a wiring
 * bug, not a request to serve.
 */
export class HostedEngineRouteAdapter extends LlmAdapter {
  /**
   * @param label - the provider route label this placeholder serves.
   * @param options - optional catalog source; omit for an empty catalog.
   */
  constructor(
    private readonly label: string,
    private readonly options: HostedEngineRouteAdapterOptions = {},
  ) {
    super()
  }

  /**
   * Advertise the injected Pi models (if any) under this route's provider label.
   *
   * The model is what the picker shows at the top level, so `name` is the bare
   * model; the `provider/model` composite stays the submitted `id`, which is
   * both what the engine receives as `--model` and how the driver validates a
   * session-selected model against its catalog.
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = this.options.listModels?.() ?? []
    return catalog.map(entry => ({
      provider: this.label,
      id: `${entry.provider}/${entry.model}`,
      name: entry.model,
    }))
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `provider "${this.label}" is a hosted loop engine route, not a model endpoint`,
      'HOSTED_ENGINE_ROUTE',
    )
  }
}
