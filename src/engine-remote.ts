/**
 * The plugin's own Remote: "which engine does this session run?" and "move this
 * session to another engine", both answered from the plugin's own per-session
 * record, the session's live agent, and the durable log through one shared read.
 *
 * The browser half cannot answer the first question honestly from what the
 * harness hands a page. The client Session list carries `projectionValues`
 * computed by `@deepseek-ai/dsh-api-session-controller`'s `projectionsFor()`,
 * which returns a `SessionProjectionHints` snapshot — "every currently cached
 * wire value", and partial by its own documentation: a cell the page's cache has
 * not folded yet is simply absent. The engine a session ACTUALLY runs is not a
 * cache fact at all, so the plugin becomes its own authority:
 *
 *  - node half (here): a Typert Remote service, discovered by the host Gateway
 *    through its visible `typertRemote` binding and its `@Remote` method marks
 *    (`bindTypertRemote` / `@Remote` in `@deepseek-ai/dsh-typert-protocol`, the
 *    same mechanism `@deepseek-ai/dsh-agent-presets` uses for its own roster).
 *    Both endpoints go through {@link engineReportOfSession} /
 *    {@link RouterLoop.reportEngine} / {@link RouterLoop.selectEngine} — the very
 *    reads the router routes on — so what a session is driven by and what a
 *    session is shown as running cannot disagree, because there is one answer.
 *    The report carries the ONE case in which a session has two facts (a live
 *    agent and a record that did not displace it) as two fields rather than
 *    blending them; see {@link SessionEngineReport}.
 *  - browser half (`src/client/session-engine.ts`): mounts these endpoints as
 *    `remote.loopEngine.engine({ sessionId })` and
 *    `remote.loopEngine.select({ sessionId, engine })`, and renders only what
 *    they answer.
 *
 * Both methods take a PLAIN object parameter rather than an identity the Gateway
 * resolves: typert resolves a parameter named `agent`/`session` into a LIVE
 * object through its lookup providers, and these endpoints must answer for any
 * PERSISTED session — including one no process has loaded.
 *
 * Wire contract (no codegen is involved; the Gateway derives the signature from
 * the live method):
 *
 *  - endpoint `loopEngine/engine`;
 *  - endpoint `loopEngine/select`;
 *  - one `src-json` argument per endpoint whose wire name is the method's own
 *    parameter name (`request`) — REQUIRED for the browser half to be
 *    understood, so the parameter name is part of the contract and must not be
 *    renamed or destructured (see the Gateway's `methodParameterNames`);
 *  - `engine` results in the plain-JSON {@link SessionEngineReport} — the engine
 *    the session ACTUALLY runs, plus (only while a live agent the record did not
 *    displace keeps running) the one the record names; `select` results in the
 *    plain-JSON {@link LoopEngineSelectResult} — a refusal is a VALUE, so a
 *    predictable "no" travels as data the surface can render (a
 *    {@link LoopEngineRefusalCode} plus the host's own sentence as detail, which
 *    is what lets the browser half show localized copy instead of a raw English
 *    one-liner), while only a malformed request is a `RemoteError`, and an
 *    outcome carrying `reload` tells the browser half to reload the page, because
 *    the switch was made to land by releasing the session's agent.
 *
 * @module dsh-loop-engine/engine-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LOOP_ENGINE_IDS, isLoopEngineId, type LoopEngineId, type LoopEngineRefusalCode, type SessionEngine, type SessionEngineReport, type LoopEngineSelectResult } from './agent-preset-ids.ts'

/** Cordis service key AND wire namespace of the plugin's own Remote. */
export const LOOP_ENGINE_REMOTE_KEY = 'loopEngine'

/** Endpoint method reporting one session's engine. */
export const LOOP_ENGINE_REMOTE_METHOD = 'engine'

/** Endpoint method moving one session to another engine. */
export const LOOP_ENGINE_REMOTE_SELECT_METHOD = 'select'

/** The wire request the reporting endpoint accepts. */
export interface LoopEngineRequest {
  /** The session to report on. A plain string, never a resolved live object. */
  readonly sessionId: string
}

/**
 * The wire request the switching endpoint accepts. The engine is typed as a
 * string because that is what the wire carries; the endpoint validates it
 * against {@link LOOP_ENGINE_IDS} before anything acts on it.
 */
export interface LoopEngineSelectRequest {
  /** The session to move. A plain string, never a resolved live object. */
  readonly sessionId: string
  /** The engine that session should run. */
  readonly engine: string
}

/**
 * The engine one session runs, read from the plugin's own record and the durable
 * log (`engineOfSession`).
 *
 * The FALLBACK answer, not the whole one: it knows nothing about a live agent, so
 * the endpoint uses it only while no router is mounted
 * ({@link RouterSurfaceHolder}) — the mount window, in which no session is driven
 * by this plugin anyway.
 */
export type SessionEngineResolver = (sessionId: SessionId) => Promise<SessionEngine>

/** Move one session to another engine, refusing with a reason rather than throwing. */
export type SessionEngineSelector = (
  sessionId: SessionId,
  engine: LoopEngineId,
) => Promise<LoopEngineSelectResult>

/**
 * The mounted loop router, as these two endpoints need it: the reporting read
 * and the move, both of which only a live router can make.
 *
 * Structural rather than the class itself, so this module takes no build-time
 * dependency on `./router-loop.ts` (which drags in the harness loop and every
 * engine driver) and a test can stand in for it.
 */
export interface RouterSurface {
  /** Report what one session actually runs, plus the recorded engine when the two differ. */
  reportEngine(sessionId: SessionId): Promise<SessionEngineReport>
  /** Move one session to another engine, or answer why it was not moved. */
  selectEngine(sessionId: SessionId, engine: LoopEngineId): Promise<LoopEngineSelectResult>
}

/**
 * Where the two endpoints find the mounted router.
 *
 * A holder rather than a fixed reference because the router is mounted
 * asynchronously — and not at all until the harness's live patch reload drops the
 * base bundle's `agent-loop` row (`src/index.ts` `mountRouter`). Until then both
 * endpoints answer from what a router-less process still knows: the record and
 * the log. A session that is not driven by this plugin has no live agent to
 * report anyway, so the answers agree.
 */
export interface RouterSurfaceHolder {
  /** The mounted router, or undefined while there is no router. */
  current: RouterSurface | undefined
}

/**
 * `remote.loopEngine`: report one session's engine, and move it to another.
 *
 * Registered as a Cordis service under {@link LOOP_ENGINE_REMOTE_KEY} on the
 * plugin's own fiber, so the binding and the method marks disappear with the
 * plugin: a profile that mounts no Gateway never discovers it, and unmounting
 * the plugin withdraws both.
 */
export class LoopEngineRemote extends TypertRemoteService {
  private readonly resolve: SessionEngineResolver
  private readonly router: RouterSurfaceHolder
  private readonly warn: (message: string) => void

  /**
   * @param ctx - the context the service (and its lifetime) belongs to.
   * @param resolve - the router-less read; normally
   *   `engineOfSession(ctx, sessionId, records)`.
   * @param router - where both endpoints find the mounted loop router.
   * @param warn - diagnostic sink for a session that could not be read.
   */
  constructor(
    ctx: Context,
    resolve: SessionEngineResolver,
    router: RouterSurfaceHolder,
    warn: (message: string) => void,
  ) {
    super(ctx, LOOP_ENGINE_REMOTE_KEY)
    this.resolve = resolve
    this.router = router
    this.warn = warn
  }

  /**
   * Report what one session runs — and, when its own record names a different
   * engine than the live agent, that fact separately.
   *
   * The router answers when it is mounted, because the live agent outranks every
   * record: only the router knows which engine built the agent driving this
   * session now, and only the router can tell a record whose release did not take
   * from one that already landed. Without a router (the mount-retry window) no
   * session is driven by this plugin, so the record — i.e.
   * {@link SessionEngineResolver} — is the whole answer.
   *
   * A session that cannot be read answers `unset` rather than throwing: a
   * surface that asked about a session the durable log does not know must render
   * "engine not recorded", not break the page it is rendered in. Failures are
   * reported once on the host's log instead.
   *
   * A malformed REQUEST is a caller fault, not an unreadable session, and is
   * refused the way every typert endpoint refuses one.
   * @param request - the wire request carrying the session id.
   * @returns the engine driving that session, plus the recorded engine it is not
   * running when the two differ.
   * @throws {RemoteError} with `gateway/bad-request` when no session id was sent.
   */
  @Remote(LOOP_ENGINE_REMOTE_METHOD)
  async engine(request: LoopEngineRequest): Promise<SessionEngineReport> {
    const sessionId = request?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'sessionId must be a non-empty string', {})
    }
    const router = this.router.current
    try {
      return router === undefined
        ? { engine: await this.resolve(SessionId(sessionId)) }
        : await router.reportEngine(SessionId(sessionId))
    } catch (error: unknown) {
      this.warn(`loop-engine: could not read the engine of session "${sessionId}": ${String(error)}`)
      return { engine: { kind: 'unset' } }
    }
  }

  /**
   * Move one session to another engine.
   *
   * The move owns no policy of its own: the router decides whether this session
   * can be moved right now and answers with a reason when it cannot, because
   * only it knows the session's live agent, its turn state, and the teardown it
   * would have to perform. This endpoint's job is the boundary — reject a
   * malformed request the way every typert endpoint does, and hand a well-formed
   * one to the selector.
   * @param request - the wire request carrying the session id and target engine.
   * @returns the engine now recorded for the session — with `reload: true` when
   * its agent had to be released for the change to land, which the browser half
   * acts on by reloading the page — or, as `ok: false`, the
   * {@link LoopEngineRefusalCode} of the branch that refused it together with the
   * host's own sentence about this session (`router-unmounted` is this
   * endpoint's own, `session-closed` / `turn-running` / `subagent-session` /
   * `not-driven` / `record-failed` / `rebuild-failed` come from the router's
   * checks). The browser half localizes from the code and keeps the sentence as
   * detail, so the code is part of this endpoint's contract even though the
   * shape allows it to be absent.
   * @throws {RemoteError} with `gateway/bad-request` when the session id is not
   * a non-empty string or the engine is not an installed engine id.
   */
  @Remote(LOOP_ENGINE_REMOTE_SELECT_METHOD)
  async select(request: LoopEngineSelectRequest): Promise<LoopEngineSelectResult> {
    const sessionId = request?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'sessionId must be a non-empty string', {})
    }
    const engine = request?.engine
    if (!isLoopEngineId(engine)) {
      throw new RemoteError(
        'gateway/bad-request',
        `engine must be one of ${LOOP_ENGINE_IDS.join(', ')}`,
        {},
      )
    }
    const router = this.router.current
    if (router === undefined) {
      return {
        ok: false,
        code: 'router-unmounted',
        reason: 'this process cannot switch engines yet: the loop router is not mounted',
      }
    }
    return await router.selectEngine(SessionId(sessionId), engine)
  }
}
