/**
 * Keep a session's model selection on the seat the engine driving it owns.
 *
 * A session's model selection FOLLOWS ITS ENGINE, in both directions:
 *
 *  - a HOSTED engine owns its model natively, and logs the one shared provider
 *    label (`external`, {@link HOSTED_ROUTE_LABEL}) into the session's
 *    `request/header`; the host derives the session's selection from the latest
 *    header (`packages/api/session-controller/src/agent.ts`, `selectionFor`), so
 *    a session a hosted engine drives selects `external`. That label is served
 *    only by this plugin's placeholder route (`provider-route.ts`), which
 *    advertises exactly one entry under it — {@link HOSTED_DEFAULT_MODEL}. So
 *    the seat of a hosted session is `external/default`, and this module is what
 *    puts that in the log BEFORE the engine's first request would. (A session
 *    whose log still carries an EARLIER build's per-engine label —
 *    `claude-code` / `codex` / `pi` / `kimi` — is recognized as hosted too,
 *    {@link isHostedProviderRoute}, and rewritten to `external/default` on its
 *    next build or switch: no adapter serves those labels any more, so leaving
 *    one in place would fail the host's own route check with
 *    `model-unavailable`.)
 *  - the HARNESS LOOP (`in-process`) DOES call a real model, so it must select
 *    something a real adapter serves, and the only selection this plugin can name
 *    honestly is the deployment's own default:
 *    `agentDefaultModel.currentSelection()`, the value the host's
 *    `agentOptions()` gives every session it creates without one
 *    (`packages/core/agent-default-model/src/index.ts`,
 *    `packages/api/session-controller/src/agent.ts`). That default can name one of
 *    these routes ITSELF — `session.selectModel` saves whatever the model menu
 *    submitted as the deployment default, and the menu carries the hosted route
 *    as an entry — so the deployment's COMPOSED default model (the settings
 *    descriptor's `base` layer, what `packages/bundle/base/cordis.patch.yml`
 *    configures) is what this plugin names instead, and says so once. See
 *    {@link defaultSelection}.
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
 * TWO triggers ask for it, and both answer through the same write:
 *
 *  - {@link ModelSelectionReset.resetFor} — a session SWITCHED to another
 *    engine. The host reads a session's selection from its log and the change is
 *    about to land on that session's next build, so the write has to happen at
 *    the switch rather than at the next request.
 *  - {@link ModelSelectionReset.guardFor} — a session being BUILT. The router
 *    wraps the caller's `setup` for it, which is the one moment the plugin holds
 *    the session before the host installs the selection for it
 *    (`composeAgent`'s `setup` → `installSelection`), so the write still lands
 *    before the first request — and it is what gives a NEW session on a hosted
 *    engine its seat. For the harness loop this trigger also settles a defect the
 *    build path owns: `session.selectModel` saves the pick it was given as the
 *    DEPLOYMENT default (`packages/api/session-controller/src/commands.ts`
 *    `selectModel` → `AgentDefaultModelConfig.saveSelection`), that default is
 *    the selection of every session with nothing in its log, and the menu now
 *    carries the hosted route as an entry — so ONE pick made while a hosted
 *    session was open would otherwise hand every session built on the harness
 *    loop a route no adapter serves.
 *
 * THREE judgements keep those writes honest, and both triggers share them
 * ({@link ModelSelectionReset.appendSeat}):
 *
 *  - a REAL model selection is never overwritten. The test is the provider
 *    ({@link isHostedProviderRoute}): only a label some hosted engine logs is a
 *    seat this module owns. An explicit pick — the model menu's own event, which
 *    also becomes the deployment default — survives every engine change, which is
 *    what the browser half's model notice tells the user: under a hosted engine a
 *    dsh model is inert, not forbidden.
 *  - a session that already selects the target (provider and model) is left
 *    alone, so repeated switches never grow the log.
 *  - an engine SWITCH has nothing to write for a session whose log names no
 *    selection at all: there is no seat to rewrite, and naming a session's first
 *    seat is the BUILD trigger's job ({@link ModelSelectionReset.guardFor}), not
 *    a switch's. Such a session still selects the deployment default — the host's
 *    own fallback — so nothing is broken while the seat shows it.
 *
 * A deployment that composes no `agentDefaultModel` service, or one whose
 * service cannot name a usable selection, is not an error here: the trigger is
 * either the user's own action or a session about to run, and neither must fail
 * over a selection this plugin cannot name. The write is skipped with ONE
 * warning, and the session keeps whatever its log records.
 *
 * @module dsh-loop-engine/model-selection-reset
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { HOSTED_DEFAULT_MODEL } from './agent-preset-ids.ts'
import { currentSelection } from './driver-core/session-model.ts'
import type { SessionModelSelection, SessionProjectionsService, SettingsMutator } from './driver-core/host-servers.ts'
import { hostedRouteLabelOf, isHostedProviderRoute } from './provider-route.ts'
import type { LoopEngineId } from './settings.ts'

/**
 * The host's settings namespace for its default model selection
 * (`packages/core/agent-default-model/src/index.ts`, `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE`).
 * Spelled out rather than imported: that package is not one of this plugin's
 * peers, exactly as `driver-core/hosted-tool-vocabulary.ts` does for its own
 * host-owned vocabulary.
 */
const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

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
 * Keeps a session's model selection on the seat the engine driving it owns — the
 * shared `external/default` of a hosted engine, or a real model for the harness
 * loop.
 *
 * One instance per router: the "cannot name a default" and "the default itself
 * names a hosted route" warnings are each owed once per process, not once per
 * session.
 */
export class ModelSelectionReset {
  /** Whether the one warning this deployment is owed has been reported. */
  private warned = false
  /** Whether the one report that the deployment default names a hosted route has been made. */
  private reportedHostedDefault = false

  /**
   * @param ctx - context carrying the host's default-model service, its settings
   *   (for the configured default), and the session-projection registry.
   * @param warn - diagnostic sink, used at most once per problem.
   */
  constructor(
    private readonly ctx: Context,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Give one session the selection the engine it is being SWITCHED TO owns,
   * unless its log already names a real model of its own.
   *
   * The switch trigger. A session whose log names no selection at all is left
   * alone: a switch rewrites a seat an engine already put there, and naming a
   * session's first seat belongs to the build of a session being created
   * ({@link guardFor}) rather than to a change of engine.
   * @param session - the live Session the engine switch is being recorded for.
   * @param engine - the engine the session is being moved to.
   * @returns whether a `model/selection` event was appended.
   */
  resetFor(session: Session, engine: LoopEngineId): boolean {
    if (engine !== 'in-process' && this.currentSelection(session) === undefined) return false
    return this.appendSeat(session, engine)
  }

  /**
   * Give one session the selection the engine BUILDING it owns, inside the
   * router's wrapped `setup` — before the caller's own setup installs the
   * session's selection — so a selection written here is the one the host reads
   * back for the agent being built.
   *
   * The harness loop's own build keeps its narrower precondition: it makes real
   * model calls, so it is the one build that must not be left selecting a
   * placeholder route, and a session whose own log already names a real model
   * needs nothing written for it. A hosted engine is being given its seat here,
   * which is what a new session on it starts from.
   * @param session - the session whose agent is being composed.
   * @param engine - the engine composing it.
   * @returns whether a `model/selection` event was appended.
   */
  guardFor(session: Session, engine: LoopEngineId): boolean {
    if (engine === 'in-process' && !this.selectsHostedRoute(session)) return false
    return this.appendSeat(session, engine)
  }

  /**
   * Whether the selection this session's next request would use names one of
   * the hosted engines' provider routes — a label this plugin serves as a
   * placeholder and cannot answer a real model call on.
   *
   * The read is the host's own (`selectionFor`): a pending selection, else the
   * logged header, else the deployment's default. A session with nothing in its
   * log is therefore judged on the deployment default — the value the model menu
   * can write a hosted label into — and that default is read AS IT IS, never as
   * {@link defaultSelection} would substitute it: the substitution only exists
   * once it is written into the session, so judging the substitute would skip
   * the write that makes it real.
   * @param session - the session whose selection is being judged.
   * @returns whether that selection names a hosted engine route.
   */
  private selectsHostedRoute(session: Session): boolean {
    const selected = this.currentSelection(session) ?? this.deploymentDefault()
    return selected !== undefined && isHostedProviderRoute(selected.provider)
  }

  /**
   * Append the selection one engine's seat carries, by the judgements both
   * triggers share.
   *
   * A real model selection is never overwritten — the provider is the test,
   * because only a label some hosted engine logs is a seat this module owns — and
   * a session that already selects the target route is left alone. Provider and
   * model are the comparison: a reasoning effort the target carries is not a
   * reason to log a second event for a session that already selects the same
   * route, and re-appending would only grow the log on every switch.
   * @param session - the session whose selection is being written.
   * @param engine - the engine whose seat the session should select.
   * @returns whether a `model/selection` event was appended.
   */
  private appendSeat(session: Session, engine: LoopEngineId): boolean {
    const target = this.seatOf(engine)
    if (target === undefined) return false
    const current = this.currentSelection(session)
    if (current !== undefined) {
      if (!isHostedProviderRoute(current.provider)) return false
      if (current.provider === target.provider && current.model === target.model) return false
    }
    session.append('model/selection', {
      provider: target.provider,
      model: target.model,
      ...target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort },
    })
    return true
  }

  /**
   * The selection one engine's seat carries: a hosted engine's shared
   * `external/default`, or — for the harness loop — the deployment's default,
   * with the substitution {@link defaultSelection} documents.
   * @param engine - the engine a session runs, or is being moved to.
   * @returns the selection to write, or undefined when this process cannot name
   *   one for that engine.
   */
  private seatOf(engine: LoopEngineId): SessionModelSelection | undefined {
    if (engine === 'in-process') return this.defaultSelection()
    return { provider: hostedRouteLabelOf(engine), model: HOSTED_DEFAULT_MODEL }
  }

  /**
   * The selection the host will use for this session, by the host's own read —
   * the shared read in `driver-core/session-model.ts` (`currentSelection`),
   * which the four hosted drivers also use to resolve the model they hand over.
   * @param session - the session whose selection is being read.
   * @returns the current selection, or undefined when the log records none.
   */
  private currentSelection(session: Session): SessionModelSelection | undefined {
    return currentSelection(session, this.projections())
  }

  /**
   * The selection the deployment's own `agentDefaultModel` service answers, or
   * undefined when this process cannot read one (reported once).
   *
   * Read twice for two different questions — as the selection a session with
   * nothing in its log would use ({@link selectsHostedRoute}), and as the value
   * this plugin restores ({@link defaultSelection}) — so the substitution below
   * never hides the fact that the saved default itself is unusable.
   * @returns the validated default, or undefined when it cannot be named.
   */
  private deploymentDefault(): SessionModelSelection | undefined {
    const service = this.ctx.get('agentDefaultModel') as AgentDefaultModelService | undefined
    if (service === undefined) return this.unavailable('this deployment composes no agentDefaultModel service')
    let answered: Partial<SessionModelSelection> | undefined
    try {
      answered = service.currentSelection()
    } catch (error: unknown) {
      return this.unavailable(`agentDefaultModel.currentSelection() failed: ${String(error)}`)
    }
    const named = usableSelection(answered)
    if (named === undefined) {
      return this.unavailable('agentDefaultModel.currentSelection() named no usable provider/model')
    }
    return named
  }

  /**
   * The selection this plugin restores: the deployment's default, or — when that
   * default names a hosted engine ROUTE — the model the deployment's own
   * composition declares instead.
   *
   * The route case is not hypothetical: `session.selectModel` saves whatever the
   * model menu submitted as the deployment default, and the menu carries the
   * hosted route as an entry, so one pick made while a hosted session was open
   * puts a label there that no adapter serves a real model on — handing it to a
   * session the harness loop drives would fail that session's first request
   * loud. The composed default is a real model the deployment itself asked for,
   * so nothing is guessed on its behalf.
   * @returns the restored selection, or undefined to skip the write.
   */
  private defaultSelection(): SessionModelSelection | undefined {
    const named = this.deploymentDefault()
    if (named === undefined) return undefined
    if (!isHostedProviderRoute(named.provider)) return named
    const configured = this.configuredDefault()
    if (configured === undefined) {
      return this.unavailable(`the deployment default model is the hosted engine route "${named.provider}/${named.model}", and this deployment composes no usable default model to replace it with`)
    }
    if (!this.reportedHostedDefault) {
      this.reportedHostedDefault = true
      this.warn(
        `loop-engine: the deployment default model is the hosted engine route "${named.provider}/${named.model}", which no adapter serves; `
        + `sessions the in-process engine drives are given the deployment's configured default model "${configured.provider}/${configured.model}" instead — `
        + 'pick a real model to make that the default again',
      )
    }
    return configured
  }

  /**
   * The model the DEPLOYMENT's own composition declares as its default, read
   * from the settings descriptor's `base` layer — the value a saved (user-layer)
   * default overrode.
   *
   * This is what replaces a default that names a hosted route, and it is read
   * live because the composition is what the deployment itself configured:
   * `packages/bundle/base/cordis.patch.yml` gives the `agent-default-model` row
   * a real provider and model, and only the user layer can hold a pick made from
   * the model menu.
   * @returns the configured default, or undefined when this deployment composes
   *   no default-model section, cannot enumerate settings, configured no usable
   *   provider/model, or configured a hosted route there too.
   */
  private configuredDefault(): SessionModelSelection | undefined {
    const settings = this.ctx.get('settings') as SettingsMutator | undefined
    if (settings?.describe === undefined) return undefined
    const base = settings.describe().find(entry => entry.ns === AGENT_DEFAULT_MODEL_NS)?.base
    const named = usableSelection(base as Partial<SessionModelSelection> | undefined)
    return named === undefined || isHostedProviderRoute(named.provider) ? undefined : named
  }

  /** Read the host session-projection registry, structurally. */
  private projections(): SessionProjectionsService {
    /* v8 ignore next -- the router mounts only behind the plugin's inject gate, which requires this service; the cast exists because the plugin takes no build-time dependency on the projection package */
    return this.ctx.get('sessionProjections') as SessionProjectionsService
  }

  /**
   * Report the one thing this read could not answer, once per plugin lifetime.
   *
   * Repeated triggers must not repeat it: a deployment without the service would
   * otherwise log a line per session built for as long as it runs.
   * @param problem - what this process cannot read, with the reason.
   * @returns undefined, so callers can `return this.unavailable(…)` to skip.
   */
  private unavailable(problem: string): undefined {
    if (this.warned) return undefined
    this.warned = true
    this.warn(`loop-engine: a session on the in-process engine cannot be given a real model selection: ${problem}; it keeps the selection its log records, which no adapter serves a real model on`)
    return undefined
  }
}

/**
 * The usable part of a selection a host service answered, or `undefined` when it
 * names no route.
 *
 * Both halves must be non-empty strings; a reasoning effort rides along only
 * when it is one too, so an absent or empty effort means "the provider's own
 * default" rather than an empty one.
 * @param answered - a selection as a host service (or a settings layer) holds it.
 * @returns the selection, or undefined when it names no provider/model pair.
 */
function usableSelection(answered: Partial<SessionModelSelection> | undefined): SessionModelSelection | undefined {
  const provider = answered?.provider
  const model = answered?.model
  if (typeof provider !== 'string' || provider.length === 0
    || typeof model !== 'string' || model.length === 0) {
    return undefined
  }
  const effort = answered?.reasoningEffort
  return {
    provider,
    model,
    ...typeof effort !== 'string' || effort.length === 0 ? {} : { reasoningEffort: effort },
  }
}
