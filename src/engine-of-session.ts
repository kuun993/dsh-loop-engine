/**
 * The engine one session runs: the single authoritative read, shared by the
 * router's routing decision and the plugin's own Remote.
 *
 * Two facts can answer it, in this order:
 *
 *  1. THE PLUGIN'S OWN RECORD — `$DSH_HOME/.loop-engine/engines.json` (see
 *     `./session-engine-store.ts`). It exists because a user may move a session
 *     to another engine at any time, including long after the session started,
 *     and the harness's preset channel refuses exactly that
 *     (`agent-preset/locked`), so the plugin keeps the choice itself. When the
 *     record names an engine, that IS the session's engine and nothing else is
 *     consulted — not even the durable log, which is why a session with a record
 *     still reads correctly when its persistence is unavailable.
 *  2. THE RECORDED AGENT PRESET, for every session the plugin has no record
 *     for: a session created before per-session switching existed, one created
 *     on a preset this plugin does not own, or one in a deployment whose record
 *     file is gone. That answer comes from the durable log — the harness's
 *     `agentPreset` projection folds the session header together with every
 *     committed `agent-preset/selected`, so reading it IS reading the log — and
 *     it never comes from the session header alone (a creation fact, deep-frozen)
 *     or from a client-side listing hint (a partial cache).
 *
 * This module is the ONLY read: the router routes on what it returns and the
 * plugin's own Remote reports the same value, so the engine a session is driven
 * by and the engine it is shown as running cannot disagree.
 *
 * There is one refinement on top of it, and it is the whole reason
 * {@link engineReportOfSession} exists: a session with a LIVE agent has a better
 * answer than its record — the agent in front of it — and the two can differ
 * (only when a release of that agent did not take, since every other switch
 * either swaps the agent in place or leaves the session cold). The report
 * carries both, never blending them (see {@link SessionEngineReport}).
 *
 * The secondary read goes through the same seam the host itself uses before
 * choosing the composition to mount
 * (`ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })`, see
 * `packages/api/session-controller/src/agent.ts` in the harness). The
 * observation is a read-only lease: it is released immediately through `using`,
 * takes no write handle, and holds no write lock.
 *
 * @module dsh-loop-engine/engine-of-session
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionEngineOf, type LoopEngineId, type SessionEngine, type SessionEngineReport } from './agent-preset-ids.ts'
import type { EngineRecordSource } from './session-engine-store.ts'

/** The slice of `ctx.sessionQuery` this read needs. */
interface SessionQuery {
  observeSession(
    sessionId: SessionId,
    options: { projectionMode: 'all' | 'none' },
  ): Promise<SessionObservationLease>
}

/** A leased observation carrying the session's projection snapshot. */
interface SessionObservationLease {
  readonly projections?: { readonly values: { readonly agentPreset?: unknown } }
  [Symbol.dispose](): void
}

/**
 * The engine one session runs, read from the plugin's own record first and from
 * the durable `agentPreset` projection otherwise.
 *
 * A deployment that composes no `sessionQuery` service has no durable log to
 * ask, so a session with no record reads as {@link SessionEngine} `unset`: no
 * engine is claimed for it, and the router falls back exactly as it does for a
 * session that recorded nothing.
 * @param ctx - the context carrying the session-query seam.
 * @param sessionId - the persisted session to inspect.
 * @param records - the plugin's own per-session engine record.
 * @returns what the plugin's record, or else the durable log, says about that
 * session's engine.
 */
export async function engineOfSession(
  ctx: Context,
  sessionId: SessionId,
  records: EngineRecordSource,
): Promise<SessionEngine> {
  const recorded = records.engineOf(sessionId)
  if (recorded !== undefined) return { kind: 'engine', engine: recorded }
  const query = ctx.get('sessionQuery') as SessionQuery | undefined
  if (query === undefined) return { kind: 'unset' }
  using observation = await query.observeSession(sessionId, { projectionMode: 'all' })
  // The cell is nullable by construction (`init: header => header.agentPreset ??
  // null`), and `sessionEngineOf` reads anything that is not a string as "no
  // preset recorded" — the two collapse to the same answer here.
  return sessionEngineOf(observation.projections?.values.agentPreset)
}

/**
 * Reports the engine of one session's LIVE agent, when this process has one:
 * the loop router's own bookkeeping (`RouterLoop.live`), which is the only
 * record of what it actually built for a session.
 *
 * A reader rather than the router itself, so this fold can be exercised without
 * one — and so the router stays the only thing that owns its bookkeeping.
 */
export type LiveEngineReader = (sessionId: SessionId) => LoopEngineId | undefined

/**
 * What one session actually runs, and — when they differ — the engine its own
 * record names.
 *
 * The live agent outranks the record, because it is the answer to the question
 * this report exists to answer honestly: what is driving this session NOW. The
 * record is still consulted, but as the OTHER fact — the engine this session
 * takes when it is next built. A record that equals the live agent is no news
 * and travels as absent; a live agent with no record at all has nothing to
 * report beside it, because a session with no record was never switched.
 *
 * A session with NO live agent answers exactly as {@link engineOfSession} does:
 * nothing is running, so the record (or, with no record, the recorded preset) IS
 * the engine that session runs — the one its next build will use, which is the
 * state a switch that released the session's agent leaves it in. There is no
 * second fact to report and never a pending one.
 * @param ctx - the context carrying the session-query seam.
 * @param sessionId - the session to report on.
 * @param records - the plugin's own per-session engine record.
 * @param liveEngineOf - the engine of this session's live agent, when this
 * process has one (the router's bookkeeping).
 * @returns the engine driving the session, plus the recorded engine it is not
 * running when the two differ.
 */
export async function engineReportOfSession(
  ctx: Context,
  sessionId: SessionId,
  records: EngineRecordSource,
  liveEngineOf: LiveEngineReader,
): Promise<SessionEngineReport> {
  const live = liveEngineOf(sessionId)
  if (live === undefined) return { engine: await engineOfSession(ctx, sessionId, records) }
  const engine: SessionEngine = { kind: 'engine', engine: live }
  const recorded = records.engineOf(sessionId)
  // The record is read DIRECTLY rather than through `engineOfSession`: with a
  // live agent the durable log cannot add anything (a session with a record
  // never consults it), so this path stays off the log entirely.
  return recorded === undefined || recorded === live ? { engine } : { engine, pending: recorded }
}
