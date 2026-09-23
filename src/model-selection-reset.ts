/**
 * Give a session its deployment default model selection back when a switch puts
 * it onto the harness's own loop.
 *
 * A session's model selection FOLLOWS ITS ENGINE. Every hosted engine logs its
 * own provider label (`claude-code`, `codex`, `pi`, `kimi`) into the session's
 * `request/header`, and the host derives the session's selection from the latest
 * header (`packages/api/session-controller/src/agent.ts`, `selectionFor`), so a
 * session that ran Kimi selects `kimi`. That label is served only by this
 * plugin's placeholder route (`provider-route.ts`), which fails loud
 * (`HOSTED_ENGINE_ROUTE`) when a real model call reaches it — a hosted engine
 * owns its model natively, so no adapter can serve the label for real. A session
 * switched back to `in-process` DOES call a real model, so it must select
 * something else, and the only selection this plugin can name honestly is the
 * deployment's own default: `agentDefaultModel.currentSelection()`, the value
 * the host's `agentOptions()` gives every session it creates without one
 * (`packages/core/agent-default-model/src/index.ts`,
 * `packages/api/session-controller/src/agent.ts`).
 *
 * The write is the harness's own `model/selection` event: log-only, already a
 * known session event type (`packages/core/session/src/known-event-types.ts`),
 * and exactly what the host's own model picker appends
 * (`ApiSessionAgentController.selectForNextRequest`). That is what makes it the
 * one way a plugin can say "this session's next build selects X" without owning
 * the host's in-memory selection: the event folds into the `modelSelection`
 * projection, and the selection the host installs for the session's next agent
 * reads it back (`selectionFor` prefers the projection's `pending` over the
 * logged header).
 *
 * It is deliberately NOT applied in the other direction. A switch onto a hosted
 * engine leaves the selection alone: those engines never read it (the one that
 * does, Pi, reads the newest `model/selection` as its `--model` candidate and
 * drops a model its own catalog does not know,
 * `src/engine-pi/agent.ts` `dynamicModel`/`pickModel`), and the engine writes
 * its own label into the log's next header anyway. So a default written there
 * would be inert at best, and a stale candidate for a later Pi session at worst.
 *
 * A deployment that composes no `agentDefaultModel` service, or one whose
 * service cannot name a usable selection, is not an error here: the switch is
 * the user's action and must not fail over a selection this plugin cannot name.
 * The reset is skipped with ONE warning, and the session keeps whatever its log
 * records.
 *
 * @module dsh-loop-engine/model-selection-reset
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionModelSelection, SessionProjectionsService } from './driver-core/host-servers.ts'

// The `model/selection` event's one home is
// `@deepseek-ai/dsh-api-session-controller` (`src/types.ts`), which is not one of
// this plugin's peers: the plugin appends the event but never imports the
// package. Mirroring the shape here types the append without taking a
// dependency, exactly as `driver-core/hosted-tool-vocabulary.ts` does for
// `todo/write`; a profile always composes the real package, and the two
// identical declarations merge into one interface.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete validated model selection requested for subsequent prompt
     * assembly. Log-only: it never enters derived model history.
     */
    'model/selection': {
      /** Registered provider route. */
      readonly provider: string
      /** Provider-owned model id. */
      readonly model: string
      /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
      readonly reasoningEffort?: string
    }
  }
}

/** The host's `agentDefaultModel` service (`packages/core/agent-default-model`), as this read needs it. */
export interface AgentDefaultModelService {
  /**
   * The selection the host gives an Agent created without one. Read live on
   * every call, because the settings layer it reads may change at any time.
   * @returns the deployment's default provider, model, and optional effort.
   */
  currentSelection(): SessionModelSelection
}

/**
 * Restores one session's model selection to the deployment default.
 *
 * One instance per router: the "cannot name a default" warning is owed once per
 * process, not once per switch.
 */
export class ModelSelectionReset {
  /** Whether the one warning this deployment is owed has been reported. */
  private warned = false

  /**
   * @param ctx - context carrying the host's default-model service and the
   *   session-projection registry.
   * @param warn - diagnostic sink, used at most once.
   */
  constructor(
    private readonly ctx: Context,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Append the deployment default as this session's selection, unless the
   * session already selects it.
   * @param session - the live Session the engine switch is being recorded for.
   * @returns whether a `model/selection` event was appended.
   */
  resetFor(session: Session): boolean {
    const selected = this.defaultSelection()
    if (selected === undefined) return false
    if (this.alreadySelects(session, selected)) return false
    session.append('model/selection', {
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
    })
    return true
  }

  /**
   * Whether the selection the host would use for this session is already that
   * provider and model.
   *
   * Provider and model only: a reasoning effort the default carries is not a
   * reason to log a second event for a session that already selects the same
   * route, and re-appending would only grow the log on every switch.
   * @param session - the session whose selection is being compared.
   * @param selected - the deployment default.
   * @returns whether the two name the same route.
   */
  private alreadySelects(session: Session, selected: SessionModelSelection): boolean {
    const current = this.currentSelection(session)
    return current !== undefined
      && current.provider === selected.provider
      && current.model === selected.model
  }

  /**
   * The selection the host will use for this session, by the host's own read
   * (`ApiSessionAgentController.selectionFor`): a pending selection — one
   * appended, not yet consumed by a matching recorded request — outranks the
   * logged header, and the header answers when nothing is pending.
   * @param session - the session whose selection is being read.
   * @returns the current selection, or undefined when the log records none.
   */
  private currentSelection(session: Session): SessionModelSelection | undefined {
    const pending = this.projections().stateOf(session, 'modelSelection')?.pending ?? null
    if (pending !== null) return pending
    const header = session.requestHeader()?.config
    return header === undefined ? undefined : { provider: header.provider, model: header.model }
  }

  /**
   * The deployment's default selection, or undefined when this process cannot
   * name one (reported once).
   * @returns the validated default, or undefined to skip the reset.
   */
  private defaultSelection(): SessionModelSelection | undefined {
    const service = this.ctx.get('agentDefaultModel') as AgentDefaultModelService | undefined
    if (service === undefined) return this.unavailable('this deployment composes no agentDefaultModel service')
    let answered: Partial<SessionModelSelection> | undefined
    try {
      answered = service.currentSelection()
    } catch (error: unknown) {
      return this.unavailable(`agentDefaultModel.currentSelection() failed: ${String(error)}`)
    }
    const provider = answered?.provider
    const model = answered?.model
    if (typeof provider !== 'string' || provider.length === 0
      || typeof model !== 'string' || model.length === 0) {
      return this.unavailable('agentDefaultModel.currentSelection() named no usable provider/model')
    }
    const effort = answered?.reasoningEffort
    return {
      provider,
      model,
      ...typeof effort !== 'string' || effort.length === 0 ? {} : { reasoningEffort: effort },
    }
  }

  /** Read the host session-projection registry, structurally. */
  private projections(): SessionProjectionsService {
    /* v8 ignore next -- the router mounts only behind the plugin's inject gate, which requires this service; the cast exists because the plugin takes no build-time dependency on the projection package */
    return this.ctx.get('sessionProjections') as SessionProjectionsService
  }

  /**
   * Report the one thing this read could not answer, once per plugin lifetime.
   *
   * Repeated switches must not repeat it: a deployment without the service would
   * otherwise log a line per session switched for as long as it runs.
   * @param problem - what this process cannot read, with the reason.
   * @returns undefined, so callers can `return this.unavailable(…)` to skip.
   */
  private unavailable(problem: string): undefined {
    if (this.warned) return undefined
    this.warned = true
    this.warn(`loop-engine: not restoring the model selection of sessions switched to in-process: ${problem}; each session keeps the selection its log records`)
    return undefined
  }
}
