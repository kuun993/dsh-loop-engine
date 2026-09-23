/**
 * The process-wide agent factory, dispatching each session to the engine it
 * runs.
 *
 * The harness admits exactly ONE `AgentFactory` per process
 * (`AgentRegistry.setFactory` throws on a second registration) and exposes no
 * per-session way to resolve one, so "session A on Codex while session B runs
 * Kimi" is only expressible if the single factory itself routes. This class is
 * that router: it extends the harness's own `AgentLoop`, inheriting the
 * in-process loop in full (turn boundary projection, prompt variables, the
 * agent-loop settings section, the factory registration), and overrides the two
 * AgentFactory entry points to hand a session to its engine's runtime.
 *
 * Which engine that is comes from {@link engineOfSession} — the plugin's own
 * per-session record first, the recorded agent preset otherwise — with one
 * create-time exception spelled out on {@link RouterLoop.engineFor}:
 *   - create: the record, else `CreateAgentOptions.meta.agentPreset` (already
 *     resolved by the caller, `packages/api/session-controller/src/agent.ts`
 *     `composeAgent`), with a live parent's engine as the fallback for a child;
 *   - resume: the record, else the persisted `agentPreset` projection.
 *     `ResumeAgentOptions` carries no metadata, so that projection is read
 *     through {@link engineOfSession} — the same fold the host itself reads
 *     before choosing the composition to mount, and the same one the plugin's
 *     own Remote reports to the browser half.
 *
 * The session can also be moved while it is LIVE — that is what
 * {@link RouterLoop.selectEngine} is for, and it is the half of the story the
 * preset channel cannot express (the harness refuses a preset change on a
 * started session, `agent-preset/locked`). Between two hosted engines the move
 * is an IN-PLACE SWAP: the successor is built onto the session's own `Session`
 * object and the outgoing machine is retired around it, so the session — and
 * the page attached to it — never witnesses a lifecycle edge
 * ({@link RouterLoop.hotSwap}). A move that involves the harness loop on either
 * side cannot be done in place at all, so it is made to land the other way:
 * the session's agent is RELEASED, which leaves the session cold with its
 * record already naming the new engine, and the outcome asks the browser half
 * to reload the page ({@link RouterLoop.move}) — the reload is what reopens the
 * session, and the host's next resolve then builds it on the record's engine.
 *
 * `in-process` sessions are served by `super`; every hosted engine gets one
 * {@link HostedEngineRuntime} built on first use, which is also what makes the
 * engines concurrent: their agents, subprocesses, and scopes are all
 * per-session, and each runtime owns only its own live agents.
 *
 * The router also answers what a session is running
 * ({@link RouterLoop.reportEngine}) from the same bookkeeping that routes it,
 * because it is the only thing that knows which engine built a live agent — see
 * {@link SessionEngineReport} for why "what runs now" and "what the record says"
 * are two facts that must travel separately.
 *
 * @module dsh-loop-engine/router-loop
 */

import type { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { LoopEngineRefusalCode, LoopEngineSelectResult, SessionEngineReport } from './agent-preset-ids.ts'
import type { HostedAgent, HostedAgentHandle, HostedEngineRuntime } from './driver-core/hosted-engine-runtime.ts'
import type { SessionLifetime } from './driver-core/session-lifetime.ts'
import type { SessionProjectionsService } from './driver-core/host-servers.ts'
import { engineOfSession, engineReportOfSession } from './engine-of-session.ts'
import { ModelSelectionReset } from './model-selection-reset.ts'
import { engineOfPreset, hostedEngineOf } from './preset.ts'
import { registerEngineSurface } from './engine-surface.ts'
import type { EngineRecordStore } from './session-engine-store.ts'
import type { HostedEngineId, LoopEngineId } from './settings.ts'

/**
 * The preset roster announces a committed per-session preset change on the
 * shared event bus so consumers can invalidate state derived from that
 * session's composition. Declared here rather than imported from
 * `@deepseek-ai/dsh-agent-presets`: the plugin consumes the notification but
 * takes no build-time dependency on the roster, which a minimal profile may not
 * compose at all.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One session committed a different agent preset to its durable log.
     * @mode emit
     * @param sessionId - the session whose composition changed.
     * @param agentPreset - the preset recorded by the committed selection.
     */
    'agent-preset/selected'(sessionId: SessionId, agentPreset: string): void
  }
}

/**
 * Services the router's context must inject.
 *
 * Taken from the harness loop verbatim rather than re-listed: the router IS the
 * harness loop for `in-process` sessions, and cordis refuses a service
 * PROPERTY READ on a context whose fiber did not inject it
 * (`cannot get property "tools" without inject`). The loop's turn machinery
 * reads `ctx.tools` and `ctx.llm` directly, so a shorter gate here compiles and
 * even creates agents, then dies on the first real turn.
 */
export const ROUTER_SERVICES: readonly string[] = [...AgentLoop.inject]

/**
 * Any hosted engine's runtime, as this router holds it. The engines differ only
 * in configuration and driver; the transaction surface the router calls is
 * identical, so the map is type-erased once here.
 */
export type RouterEngine = HostedEngineRuntime<object, HostedAgent>

/** Builds (or returns the memoized) driver runtime of one hosted engine. */
export type EngineBuilder = (engine: HostedEngineId) => RouterEngine

/**
 * How one session's agent was built, so a hot swap can build its successor the
 * same way.
 *
 * The composition callback is the CALLER's — `ApiSessionAgentController`'s
 * `composeAgent` result, which installs the session's model selection and mounts
 * its agent preset into the agent's scope. Replaying that exact closure is what
 * keeps a swapped-in agent composed the way one the host built itself would be;
 * deriving the composition here instead would duplicate the API layer's policy
 * and drift from it.
 */
interface BuildRecipe {
  /** The caller context that structurally owns the session's lifecycle. */
  readonly ownerCtx: Context
  /** Loop options the agent was built with. */
  readonly agentOptions: AgentOptions
  /** The caller's composition callback, replayed onto the successor. */
  readonly setup: AgentSetup | undefined
  /** The agent's runtime owner, for a child session's inherited ownership. */
  readonly parentAgent: Agent | undefined
}

/**
 * A hosted agent's session handover, as this router holds it: everything
 * {@link RouterLoop.hotSwap} needs from the machine it is replacing.
 */
interface Handover {
  /** The live session's lifetime resources — its store entry and write handle. */
  readonly lifetime: SessionLifetime
  /** Retire this machine for good, leaving the session to its successor. */
  retire(): Promise<void>
}

/** One session's live agent, as the router tracks it for engine changes. */
interface LiveSession {
  /** The engine that built the agent. */
  readonly engine: LoopEngineId
  /** The published agent, for the blank-session and projection reads. */
  readonly agent: Agent
  /** The handle's exact teardown, for the paths that release the session. */
  readonly dispose: () => Promise<void>
  /** Present for a hosted engine: the session handover a hot swap moves through. */
  readonly handover?: Handover
  /** How the agent was built, for the successor a hot swap builds. */
  readonly recipe: BuildRecipe
}

/**
 * The single AgentFactory, routing per session.
 *
 * Constructed by the plugin once the services the harness loop needs are
 * active; its effects belong to the constructing fiber, so unloading the plugin
 * tears every engine down.
 */
export class RouterLoop extends AgentLoop {
  private readonly engines = new Map<HostedEngineId, RouterEngine>()
  private readonly live = new Map<string, LiveSession>()
  private readonly build: EngineBuilder
  private readonly records: EngineRecordStore
  private readonly warn: (message: string) => void
  /**
   * The model-selection half of a switch back onto the harness loop
   * ({@link RouterLoop.restoreDefaultModel}), owned here rather than built per
   * switch because its one warning is owed once per process.
   */
  private readonly selectionReset: ModelSelectionReset

  /**
   * @param ctx - the context the router's effects belong to.
   * @param build - memoized builder for one hosted engine's runtime.
   * @param records - the plugin's own per-session engine record, which outranks
   *   every preset-derived answer and is what {@link selectEngine} writes.
   * @param warn - diagnostic sink for a skipped engine command.
   */
  constructor(
    ctx: Context,
    build: EngineBuilder,
    records: EngineRecordStore,
    warn: (message: string) => void,
  ) {
    // The declarative `agents` list is the harness loop's own boot-time feature;
    // this deployment declares none, so the router is a pure dispatcher.
    super(ctx, { agents: [] })
    this.build = build
    this.records = records
    this.warn = warn
    this.selectionReset = new ModelSelectionReset(ctx, warn)
    this.rebuildOnEngineChange()
  }

  /** The engine that drives one session's agent. */
  private async engineFor(presetId: string | undefined, parent?: Agent): Promise<LoopEngineId> {
    const named = engineOfPreset(presetId)
    if (named !== undefined) return named
    // A preset this plugin does not own: a deployment-authored preset, or none
    // at all. A child agent inherits the engine its parent is running, so a
    // delegated session never silently changes engines.
    if (parent !== undefined) {
      const inherited = hostedEngineOf(await engineOfSession(this.ctx, parent.id, this.records))
      if (inherited !== undefined) return inherited
    }
    return 'in-process'
  }

  /** The engine's runtime, built on first use and kept for the plugin's lifetime. */
  private runtimeOf(engine: HostedEngineId): RouterEngine {
    const existing = this.engines.get(engine)
    if (existing !== undefined) return existing
    const created = this.build(engine)
    this.engines.set(engine, created)
    return created
  }

  /**
   * Record one published agent so a later engine change can rebuild it, and
   * bridge the engine's command/skill surface into its session.
   * @param engine - the engine that built the handle.
   * @param handle - the published handle.
   * @param recipe - how it was built, for a hot swap's successor.
   * @param handover - a hosted handle's session handover; absent for the
   *   harness loop, whose handle carries neither the session's lifetime nor a
   *   way to retire the machine without releasing it.
   * @returns the handle the harness tracks.
   */
  private adopt(engine: LoopEngineId, handle: AgentHandle, recipe: BuildRecipe, handover?: Handover): AgentHandle {
    if (engine !== 'in-process') registerEngineSurface(handle.agent, engine, this.warn)
    const entry: LiveSession = {
      engine,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      recipe,
      ...handover === undefined ? {} : { handover },
    }
    this.live.set(handle.agent.id, entry)
    // The handle's teardown is the agent's, whoever triggers it: forget the
    // record once it ran so a stale entry can never dispose a rebuilt agent.
    return {
      agent: handle.agent,
      dispose: async () => {
        this.forget(entry)
        await handle.dispose()
      },
    }
  }

  /** Drop one tracked session, if the record still points at that exact agent. */
  private forget(entry: LiveSession): void {
    if (this.live.get(entry.agent.id) === entry) this.live.delete(entry.agent.id)
  }

  /**
   * Create a session's agent on the engine it runs.
   *
   * The plugin's own record is consulted FIRST, ahead of the preset the caller
   * composed with: a session that already has a record must be built on the
   * engine the plugin reports for it, or the router and the Remote would answer
   * differently about one session. Only a session with no record — every session
   * this plugin has never switched, including every brand-new one — falls
   * through to the preset.
   * @param ownerCtx - caller context that owns the lifecycle.
   * @param options - identities, metadata (carrying the preset), and setup.
   * @returns the published handle.
   */
  override async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const recipe = recipeOf(ownerCtx, options)
    const engine = this.records.engineOf(options.sessionId)
      ?? await this.engineFor(options.meta?.agentPreset, options.parentAgent)
    if (engine === 'in-process') {
      return this.adopt(engine, await super.createAgent(ownerCtx, options), recipe)
    }
    const handle = await this.runtimeOf(engine).createAgent(ownerCtx, options)
    return this.adopt(engine, handle, recipe, handoverOf(handle))
  }

  /**
   * Resume a persisted session on the engine it runs.
   *
   * The read is {@link engineOfSession}: the plugin's own record first, then the
   * durable `agentPreset` projection, which folds the session header together
   * with every committed `agent-preset/selected`. The session header alone would
   * name the preset the session was CREATED with, which is exactly the wrong
   * answer for a session that switched engine while it was blank — and the
   * record is the only answer for one that switched after it started, which no
   * preset can express.
   * @param ownerCtx - caller context that owns load, setup, and the lifecycle.
   * @param options - persisted identity, loop options, and setup.
   * @returns the published handle.
   */
  override async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const recipe = recipeOf(ownerCtx, options)
    const engine = hostedEngineOf(
      await engineOfSession(this.ctx, options.resumeSessionId, this.records),
    )
      ?? await this.engineFor(undefined, options.parentAgent)
    if (engine === 'in-process') {
      return this.adopt(engine, await super.resume(ownerCtx, options), recipe)
    }
    const handle = await this.runtimeOf(engine).resume(ownerCtx, options)
    return this.adopt(engine, handle, recipe, handoverOf(handle))
  }

  /**
   * Report what one session ACTUALLY runs, and — when they differ — the engine
   * its record names.
   *
   * This is the read the plugin's own Remote publishes, and the reason it is the
   * router's to make is the live bookkeeping below: for a session with an agent
   * this router built, {@link RouterLoop.live} says which engine built it, and
   * that beats every record — it is what is running. A session this router does
   * not drive (cold, or still on the base loop's slot during the mount window)
   * has no live fact to report, so the record answers, exactly as it does for a
   * session about to be built; and since every switch this plugin performs
   * either swaps the agent in place or releases it, the two facts differ only
   * for a release that did not take.
   * @param sessionId - the session to report on.
   * @returns the engine driving it now, plus the engine its record names for its
   * next build when the two differ.
   */
  async reportEngine(sessionId: SessionId): Promise<SessionEngineReport> {
    return await engineReportOfSession(
      this.ctx,
      sessionId,
      this.records,
      (id: SessionId) => this.live.get(id)?.engine,
    )
  }

  /**
   * Move one live session to another engine.
   *
   * The one entry point that makes "switch this session's engine" possible after
   * a session has started, which the harness's own preset channel refuses
   * (`agent-preset/locked`, `packages/preset/agent-presets/src/index.ts`). The
   * order below is load-bearing:
   *
   *  1. the checks, so a session that cannot be moved is refused with a reason
   *     instead of half-moved;
   *  2. the record, because it is the answer the router, the Remote, and the
   *     host's next resolve all read — and a record that could not be written
   *     must leave the session where it is;
   *  3. the move itself: an in-place swap between two hosted engines, or — when
   *     the harness loop is on either side — a release of the session's agent
   *     plus a request that the page reload (`reload: true`), which is what
   *     makes the host build the session again on the recorded engine.
   *
   * A session already on the requested engine is recorded and left running: the
   * record is the user's explicit choice, while tearing an untouched agent down
   * would cost the session's rebuild for no change at all. "Already on" is
   * judged on the LIVE AGENT's engine, not on the record: the two can differ
   * while a released agent is still in flight, and then re-selecting the engine
   * the session is actually running is how a user takes that record back — the
   * record follows the agent back, and nothing is torn down.
   * @param sessionId - the session to move.
   * @param engine - the engine it should run.
   * @returns the engine now recorded for it, whether the page must reload for it
   *   to be built, or — as `ok: false` — the {@link LoopEngineRefusalCode} of the
   *   branch that refused it plus its own sentence about this session. Every
   *   refusal this method produces carries a code; the browser half localizes
   *   from it and keeps the sentence as detail.
   */
  async selectEngine(sessionId: SessionId, engine: LoopEngineId): Promise<LoopEngineSelectResult> {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) {
      return refuse('session-closed', `session "${sessionId}" is not open; open it first, then switch its engine`)
    }
    // A turn in flight is never interrupted: its output belongs to the engine
    // that produced it, and the engine's child process holds a context this
    // plugin cannot hand over mid-turn.
    if (agent.status === 'running') {
      return refuse('turn-running', `session "${sessionId}" is running; switch its engine after this turn ends`)
    }
    // A subagent's agent belongs to the delegation that created it; dropping it
    // here would strand the parent's child mid-delegation.
    if (agent.session.header.origin === 'subagent') {
      return refuse('subagent-session', `session "${sessionId}" is a subagent session; its agent belongs to subagent routing`)
    }
    const entry = this.live.get(sessionId)
    // Reachable only while the base loop still owns the factory slot (the
    // plugin's own mount is still being retried): the agent exists, but it is
    // not one this router can rebuild.
    if (entry === undefined) {
      return refuse('not-driven', `session "${sessionId}" is not driven by this plugin's loop router`)
    }
    try {
      this.records.record(sessionId, engine)
    } catch (error: unknown) {
      return refuse('record-failed', `could not record the engine of session "${sessionId}": ${String(error)}`)
    }
    // The model selection moves with the choice, right after the record and
    // before any outcome is returned: a switch onto the harness loop hands the
    // session back to a real model, and the selection the host reads for this
    // session belongs to its next build — which the move below triggers. A cold
    // session never reaches here (the checks above refuse it), which is also the
    // only session that could have no stale selection to replace.
    if (engine === 'in-process') this.restoreDefaultModel(entry)
    if (entry.engine === engine) return { ok: true, engine }
    return await this.move(entry, engine)
  }

  /**
   * Make a just-recorded engine change take effect on the live session.
   *
   * Between two hosted engines the change is an IN-PLACE SWAP
   * ({@link hotSwap}): the session's `Session` object is kept, its agent is
   * replaced, and the browser half attached to that session sees no lifecycle
   * edge at all.
   *
   * A change with the harness loop on EITHER side cannot be done in place, and
   * this is a limit of the harness rather than a choice: `AgentLoop` neither
   * hands a live session over nor accepts one it did not create. Its factory
   * holds the session's store entry and write handle in private closure state
   * (`agent-loop/src/index.ts` `prepare`), its publication enters the session
   * (`sessions.enter`, which refuses an id already in the store), and its own
   * agent class is not exported. So the session's agent is RELEASED instead
   * ({@link release}) and the change lands on the session's next build, which
   * the returned `reload: true` puts in the user's hands: the session goes cold
   * with the record already naming its engine, and the page — reloaded, and
   * reopening that session — is what makes the host resolve it again, on the
   * engine the record names.
   *
   * The page really does have to reload, and that is the one cost of this path:
   * a release emits `session/disposed`, and the browser half reads that as this
   * session being gone, with no way back in that page's lifetime
   * (`session.ts` `handleRemoved` sets a `removed` flag nothing ever clears), so
   * a page that stayed put would show a session that can no longer be typed
   * into. The alternative — leaving the live agent alone and letting the record
   * wait for a process restart — is what this plugin used to do, and it cost the
   * user a restart for a switch the host can perform itself.
   * @param entry - the live session's record; the caller verified it is movable.
   * @param engine - the engine just recorded for it.
   * @returns the switch outcome, asking for the page reload that builds the
   *   session again when its agent had to be released.
   */
  private async move(entry: LiveSession, engine: LoopEngineId): Promise<LoopEngineSelectResult> {
    const handover = entry.handover
    if (handover === undefined || engine === 'in-process') {
      await this.release(entry)
      return { ok: true, engine, reload: true }
    }
    return await this.hotSwap(entry, handover, engine)
  }

  /**
   * Replace one live session's agent with a machine the incoming engine builds
   * onto the SAME `Session`.
   *
   * The order is load-bearing. The outgoing machine is retired FIRST and
   * completely: only one agent may be registered per session id (`agents.enter`
   * refuses a duplicate), and two machines folded over one session's inbox would
   * splice each other's queued messages, so the outgoing machine must be settled
   * before any input can reach the successor. The SESSION is never released:
   * its store entry and write handle travel in the lifetime the outgoing machine
   * hands over, which is exactly why the page attached to this session stays
   * usable across the swap.
   *
   * A failure after the handover cannot be undone — the outgoing machine is
   * gone and the successor never published. The lifetime is then released, so
   * the session goes cold and reopens on the recorded engine the way any session
   * the host has not loaded does, and the refusal says what happened.
   * @param entry - the live session's record; the caller verified it is movable.
   * @param handover - the outgoing machine's session handover.
   * @param engine - the hosted engine to build the successor on.
   * @returns the switch outcome.
   */
  private async hotSwap(entry: LiveSession, handover: Handover, engine: HostedEngineId): Promise<LoopEngineSelectResult> {
    const sessionId = entry.agent.id
    try {
      await handover.retire()
    } catch (error: unknown) {
      // The machine left the agent registry either way — unregistering is its
      // teardown's own last step — so the swap goes on: refusing here would
      // leave the session live but driverless, which is strictly worse than a
      // reported unwind failure. The session's lifetime is intact either way.
      this.warn(`loop-engine: could not fully retire the ${entry.engine} agent of "${sessionId}" before switching it to ${engine}: ${String(error)}`)
    }
    try {
      const handle = await this.runtimeOf(engine).swap(entry.recipe.ownerCtx, {
        lifetime: handover.lifetime,
        agentOptions: entry.recipe.agentOptions,
        setup: entry.recipe.setup,
        parentAgent: entry.recipe.parentAgent,
      })
      this.adopt(engine, handle, entry.recipe, handoverOf(handle))
      return { ok: true, engine }
    } catch (error: unknown) {
      // Nothing drives the session now, so drop its record — `live` holds live
      // sessions only — and release its lifetime exactly as the retired machine
      // would have: close the write handle, then leave the store. Leaving the
      // store is the step that makes the session reopenable again, so it runs
      // even when the drain fails.
      this.forget(entry)
      try {
        await handover.lifetime.closeHandle()
      } catch (closeFailure: unknown) {
        this.warn(`loop-engine: could not close the write handle of session "${sessionId}" after a failed switch: ${String(closeFailure)}`)
      }
      handover.lifetime.leaveStore()
      return refuse('rebuild-failed', `could not rebuild session "${sessionId}" on ${engine}: ${String(error)}`)
    }
  }

  /** Read the host session-projection registry, structurally. */
  private projections(): SessionProjectionsService {
    /* v8 ignore next -- the router mounts only behind the plugin's inject gate, which requires this service; the cast exists because the plugin takes no build-time dependency on the projection package */
    return this.ctx.get('sessionProjections') as SessionProjectionsService
  }

  /**
   * Drop one tracked session's agent so the host's next resolve rebuilds it.
   *
   * Two callers, and they both want the engine change to land at the session's
   * next build rather than in place:
   *
   *  - {@link move}, the engine picker's path involving the harness loop, which
   *    WAITS for the teardown (the outcome it is about to return says the
   *    session is cold, and that must be true when it says so);
   *  - the harness's own preset switch on a blank session, which fire-and-forgets
   *    it because it runs inside a synchronous event handler. It is the one
   *    engine change this plugin still makes by releasing the session rather
   *    than by moving it: the successor's composition is the NEW preset's, which
   *    only the API layer composes (a preset the harness mounted itself reaches
   *    the plugin as an id, not as a composition callback), so the plugin cannot
   *    build a correctly-composed successor in place.
   *
   * The record is forgotten before the teardown runs, so a teardown-driven event
   * can never find the entry it is releasing and start a second teardown of the
   * same agent; a failure is reported rather than thrown, and the returned
   * promise settles either way.
   * @param entry - the live session record to release.
   * @returns the teardown, once it settled.
   */
  private release(entry: LiveSession): Promise<void> {
    this.forget(entry)
    return entry.dispose().catch((error: unknown) => {
      this.warn(`loop-engine: could not release the ${entry.engine} agent of "${entry.agent.id}": ${String(error)}`)
    })
  }

  /**
   * Follow the harness's own preset switch, for a BLANK session.
   *
   * The harness's preset switch on a blank session re-parents the live agent's
   * scope and records the choice; it does not rebuild the agent, so the engine
   * would keep running the one the session was created with. Dropping the agent
   * instead lets the host's own next resolve fall back to a resume
   * (`ApiSessionAgentController.resolve`), which composes from the recorded
   * preset and lands on the new engine — the same path a reopened session
   * takes, with the durable log as the only carry-over.
   *
   * LAST USER ACTION WINS: for a session this plugin already holds a record
   * for, the harness's picker is an engine choice too, so the record follows it
   * before the agent is released. Without that, the two entry points would
   * contradict each other — the picker would rebuild the session on the preset's
   * engine, while the very next resume would read the plugin's record and move
   * it back. A session with NO record keeps reading its engine off the preset,
   * exactly as before, and gets none: only an explicit choice is recorded.
   *
   * A session that has already run a turn is left alone — its live engine and
   * its record both stay where they are, so the router and the Remote keep
   * agreeing about it. (A started session cannot reach here through the
   * harness's picker anyway: the roster refuses with `agent-preset/locked`.)
   */
  private rebuildOnEngineChange(): void {
    this.ctx.on('agent-preset/selected', (sessionId, preset) => {
      const entry = this.live.get(sessionId)
      if (entry === undefined) return
      const next = engineOfPreset(preset) ?? 'in-process'
      if (next === entry.engine) return
      const boundary = this.projections().stateOf(entry.agent.session, 'turnBoundary')
      if (boundary !== undefined && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)) {
        this.warn(`loop-engine: session "${sessionId}" has already started; its engine stays ${entry.engine}`)
        return
      }
      if (this.records.engineOf(sessionId) !== undefined) {
        try {
          this.records.record(sessionId, next)
        } catch (error: unknown) {
          this.warn(`loop-engine: could not record the engine of "${sessionId}": ${String(error)}`)
        }
      }
      // The same defect this path's own entry point fixes, in the same place:
      // a preset that maps to the harness loop hands the session back to a real
      // model, so it must stop selecting the engine label its log records. Done
      // BEFORE the release, because the release is what detaches this agent.
      if (next === 'in-process') this.restoreDefaultModel(entry)
      void this.release(entry)
    })
  }

  /**
   * Hand one session's model selection back to the deployment default, because
   * the switch under way is putting it onto the harness loop.
   *
   * A session's selection follows its engine — a hosted engine logs its own
   * provider label into `request/header`, and the host derives the selection
   * from there — and that label is served only by this plugin's placeholder
   * route, which fails loud (`HOSTED_ENGINE_ROUTE`) when a real model call
   * reaches it. The harness loop does make real calls, so the switch writes the
   * deployment default instead. The write, its trigger-agnostic rationale, and
   * why a switch ONTO a hosted engine is left alone are in
   * `model-selection-reset.ts`; this method is only the router's half.
   *
   * The selection is written at the moment of the switch, not at the moment the
   * engine changes: the switch releases the session's agent and the page reloads
   * ({@link move}), so the engine really does change at the session's next build
   * — and this write is what that build reads.
   * @param entry - the live session being switched onto the harness loop.
   * @returns nothing; a selection this process cannot name is skipped with one
   *   warning, and the session keeps what its log records.
   */
  private restoreDefaultModel(entry: LiveSession): void {
    this.selectionReset.resetFor(entry.agent.session)
  }
}

/** One refusal a session's engine switch produced, as data. */
function refuse(code: LoopEngineRefusalCode, reason: string): LoopEngineSelectResult {
  return { ok: false, code, reason }
}

/** The rebuild recipe of one create or resume call. */
function recipeOf(
  ownerCtx: Context,
  options: CreateAgentOptions | ResumeAgentOptions,
): BuildRecipe {
  return {
    ownerCtx,
    agentOptions: options.agentOptions ?? {},
    setup: options.setup,
    parentAgent: options.parentAgent,
  }
}

/** A hosted handle's handover, as the router holds it. */
function handoverOf(handle: HostedAgentHandle): Handover {
  return { lifetime: handle.lifetime, retire: () => handle.retire() }
}
