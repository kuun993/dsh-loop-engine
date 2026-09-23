/**
 * Hosted-engine provider route placeholder.
 *
 * Every hosted engine logs its sessions' request/header with ONE shared provider
 * label ({@link HOSTED_ROUTE_LABEL}, `external`) rather than a model endpoint the
 * harness llm registry serves — the engine owns its model natively. The web
 * host derives a session's model selection from that header and refuses a turn
 * whose provider no registered adapter serves, so without a placeholder route
 * the SECOND prompt of every hosted session fails with `model-unavailable`.
 *
 * One label for all four engines, because the browser model catalog is built
 * per Host GENERATION and does not require (or vary by) a Session
 * (`packages/api/session-controller/src/catalog.ts`). A per-engine label would
 * therefore show one provider group per engine in every session's menu at once —
 * four identical `default` entries — so they are collapsed into this one route.
 *
 * Serving the label is only half of it. The model menu renders the session's
 * selection through the catalog, and a provider group that advertises no models
 * is dropped (`packages/api/session-controller/src/catalog.ts`, non-empty
 * groups only) — leaving the seat to show the raw `provider/model` string, i.e.
 * a model that does not exist to any adapter. So the placeholder advertises
 * exactly ONE entry, {@link HOSTED_DEFAULT_MODEL}:
 * `{ provider: HOSTED_ROUTE_LABEL, id: 'default', name: 'default' }`. The id is
 * the same string every engine logs as its model label, which is what makes the
 * seat resolve the session's `(provider, model)` to this entry and render the
 * engine's own word for "whatever it decides" instead of a composite string
 * (see {@link HOSTED_DEFAULT_MODEL} for the host-side mechanism).
 *
 * The entry is not a model this plugin can serve: {@link HostedEngineRouteAdapter.stream}
 * fails loud, because a real model call reaching one of these routes means a
 * session the harness loop drives was handed an engine label — a wiring bug,
 * not a request. Two things keep that from happening: a session switched back
 * to `in-process` has the deployment default written into its log
 * (`model-selection-reset.ts`), and a session BUILT on `in-process` whose
 * selection is one of these labels has it replaced by the same authority before
 * the host installs it (same module, `guardFor`).
 *
 * @module dsh-loop-engine/provider-route
 */

import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { HOSTED_DEFAULT_MODEL, HOSTED_ROUTE_LABEL, HOSTED_ROUTE_NAME } from './agent-preset-ids.ts'
import type { HostedEngineId } from './settings.ts'

/**
 * The provider route label ONE hosted engine logs into its sessions'
 * request/header — always {@link HOSTED_ROUTE_LABEL}.
 *
 * A function rather than a per-engine map because there is now ONE label: the
 * engine an id names no longer changes the route. It is kept as a function so
 * the "an engine logs a route" relationship still reads as such at the call
 * sites that have an engine id in hand (`router-loop.ts` `engineRouteOptions`,
 * `model-selection-reset.ts` `seatOf`).
 * @param _engine - the hosted engine whose route label is asked for.
 * @returns the single route label every hosted engine logs.
 */
export function hostedRouteLabelOf(_engine: HostedEngineId): string {
  return HOSTED_ROUTE_LABEL
}

/**
 * Every provider label this plugin has ever logged, for the membership tests the
 * plugin makes.
 *
 * The registered route ({@link HOSTED_ROUTE_LABEL}) plus the per-engine labels
 * EARLIER builds logged (`claude-code` / `codex` / `pi` / `kimi` — which happen
 * to be the hosted engine ids). The old labels are kept even though no adapter
 * serves them any more, because a session whose log still selects one must
 * still be recognized as selecting a hosted route: that is what makes the reset
 * guard rewrite such a session before the host would refuse its turn with
 * `model-unavailable` (see {@link isHostedProviderRoute}).
 */
const HOSTED_PROVIDER_LABELS: readonly string[] = [HOSTED_ROUTE_LABEL, 'claude-code', 'codex', 'pi', 'kimi']

/**
 * Whether a provider is one of this plugin's hosted engine route labels — a
 * label some hosted engine logs (now, or in an earlier build), which no adapter
 * serves a real model on.
 *
 * The OLD four per-engine labels are members on purpose, even though only
 * {@link HOSTED_ROUTE_LABEL} is registered. A pre-existing session's header
 * still names one of them; treating only the current label as hosted would let
 * such a session keep the stale selection, and the host — which finds no
 * adapter serving `kimi` any more — would refuse its next turn
 * (`model-unavailable`). Membership here is what lets `model-selection-reset`
 * rewrite the seat to `external/default` (or the deployment default) first.
 * @param provider - the provider of any selection, header, or default.
 * @returns whether that provider is a hosted engine's route label.
 */
export function isHostedProviderRoute(provider: string): boolean {
  return HOSTED_PROVIDER_LABELS.includes(provider)
}

/**
 * Placeholder adapter serving the one hosted engine provider route label.
 *
 * It advertises the single menu entry ({@link HOSTED_DEFAULT_MODEL}) so the
 * model seat can name the session's selection, carries the route's display name
 * ({@link HOSTED_ROUTE_NAME}) so the catalog's provider group is labelled
 * `external`, and {@link stream} fails loud: a call reaching it means a real model
 * query was routed to an engine that owns its model natively — a wiring bug, not
 * a request to serve.
 */
export class HostedEngineRouteAdapter extends LlmAdapter {
  /**
   * Name the route's one entry.
   *
   * `id` must equal the provider the adapter was registered for (the registry
   * rejects a mismatch — `packages/llm/llm/src/index.ts` `prepareRoutes`), so it
   * is echoed back; `name` is the one localized string the catalog carries.
   * @param provider - the route this adapter is registered for.
   * @returns the route's display metadata.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: HOSTED_ROUTE_NAME }
  }

  /**
   * Advertise the route's single entry.
   *
   * The id is the model label the engine logs, so the picker resolves a hosted
   * session's selection to this entry (and highlights its row) rather than
   * falling through to the raw composite string; the name is the same word,
   * rendered as-is.
   * @returns the one entry this route advertises.
   */
  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider: HOSTED_ROUTE_LABEL, id: HOSTED_DEFAULT_MODEL, name: HOSTED_DEFAULT_MODEL }])
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `provider "${HOSTED_ROUTE_LABEL}" is a hosted loop engine route, not a model endpoint`,
      'HOSTED_ENGINE_ROUTE',
    )
  }
}
