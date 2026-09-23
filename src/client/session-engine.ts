/**
 * Per-session engine, browser half: read the engine a session actually runs
 * from the plugin's OWN Remote, and switch it through that same Remote.
 *
 * The engine a session runs is NOT a client-cache fact, and reading one as if it
 * were is the bug this module exists to prevent. The harness hands a page a
 * projection HINT per session (`@deepseek-ai/dsh-api-session-controller`'s
 * `projectionsFor()` returns `SessionProjectionHints`: "every currently cached
 * wire value", partial by its own documentation), and its `agentPreset` cell
 * answers a different question than "what does this session run": a session may
 * switch engine while it is blank (and, with this plugin, at any time), and that
 * choice lives in the plugin's own record while the session header keeps naming
 * the preset the session was CREATED with. A page reading the hint therefore
 * shows a claude-code session that switched to pi — and the engine it actually
 * runs — as Claude Code, the misreport this plugin shipped a production incident
 * for.
 *
 * So the browser half asks the host instead:
 * `remote.loopEngine.engine({ sessionId })` to read, and
 * `remote.loopEngine.select({ sessionId, engine })` to switch — the endpoints
 * `src/engine-remote.ts` serves from the same read the router routes on. Nothing
 * is derived here: the three-state arrives decided, and a refused switch arrives
 * with the host's own reason.
 *
 * This module is deliberately React-free: the cache, the contribution, and the
 * switch are plain logic, so they run in node under its own spec
 * (`tests/session-engine-cache.spec.ts`). The one part that needs a component to
 * render — the hook that subscribes a surface to the cache — lives in
 * `./use-session-engine.ts`.
 *
 * The cache owns NO document-level side effect, deliberately. The chat
 * turn-status row is painted through a document-level attribute
 * (`./turn-status.ts`), so the only writer entitled to it is the session on
 * screen — and this cache publishes for every session a surface has ever
 * watched, the session the user just left included. Reflecting from
 * `publish` therefore let a background session's (or a left session's late)
 * answer take the attribute over from the session on screen, which painted ITS
 * engine onto the row beside it — a session running pi drew Kimi's moon. The
 * reflection is driven from `./use-session-engine.ts` instead: that hook is
 * where a component knows which session it is the surface of, and the reflection
 * it makes carries a focus guard. Here the cache answers one question only —
 * what one session's engine is.
 *
 * One member of the framework's standard seat is still read from the slot props:
 * the session-scope `sessionId`. The harness declares it by declaration-merging
 * `SessionStandardProps` in `@deepseek-ai/dsh-client-ui-session/client`, and its
 * published declarations elide the type-only imports that carry the merge — so a
 * half compiled against the installed artifacts (this package's
 * `tsconfig.build.json` pins `@deepseek-ai/*` to the artifact plane) never sees
 * it. It is therefore restated structurally here, in the shape the harness
 * declares (`packages/client/ui-session/src/client/index.ts`), and the
 * components assert it off their slot props. The `useSessions` hook needs no
 * such restatement any more: nothing here reads the session list.
 *
 * The Remote's client-side types are restated structurally for the same reason
 * and one more: a third-party plugin cannot reach the main repository's
 * generated `typert.remote-client.d.ts`, and it does not need to — the protocol
 * has no schema registry, so a contribution is plain data (see
 * `LOOP_ENGINE_REMOTE_CONTRIBUTION`).
 *
 * @module dsh-loop-engine/client/session-engine
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  LOOP_ENGINE_IDS, isLoopEngineId, isLoopEngineRefusalCode,
  type LoopEngineId, type LoopEngineRefusalCode, type LoopEngineSelectResult, type SessionEngine, type SessionEngineReport,
} from '../agent-preset-ids.ts'
import { armReloadReturn, browserPage, type ReloadPage } from './reload.ts'

/**
 * The three-state engine answer, re-exported so the client half names one type.
 * It is DEFINED in the zero-import shared module: the node half decides it
 * (`src/engine-of-session.ts`) and this half only renders what it is told.
 */
export type { SessionEngine } from '../agent-preset-ids.ts'

/**
 * What one session's engine read answers: the engine it ACTUALLY runs, plus the
 * engine a committed switch has recorded for it but not yet reached.
 *
 * Re-exported for the same reason as the three-state: the split between the two
 * facts is decided on the host (`src/engine-of-session.ts`) and this half renders
 * both without ever merging them — the pending engine belongs in a "not in force
 * yet" marker, never in the place that names what the session runs.
 */
export type { SessionEngineReport } from '../agent-preset-ids.ts'

/**
 * The standard seat members this half reads off a session-scope slot.
 *
 * Only the identity: the engine itself is no longer read from a framework hook,
 * it is asked of the host through this plugin's own Remote.
 */
export interface SessionSeat {
  /**
   * Current Session identity. Undefined only off a seat rendered without a
   * session: the composer then picks the new-session default, and the header chip
   * (which only ever renders with a session) shows nothing.
   */
  sessionId?: string
}

/** Cordis service key AND wire namespace of the plugin's own Remote. */
export const LOOP_ENGINE_REMOTE_NAMESPACE = 'loopEngine'

/** Reporting endpoint of the plugin's own Remote (mirrors `src/engine-remote.ts`). */
export const LOOP_ENGINE_REMOTE_METHOD = 'engine'

/** Switching endpoint of the plugin's own Remote (mirrors `src/engine-remote.ts`). */
export const LOOP_ENGINE_REMOTE_SELECT_METHOD = 'select'

/** One refused Remote call (harness: the error branch of `RemoteResult`). */
export interface RemoteFailure {
  /** The host's own framing of the refusal. */
  readonly message: string
  /** The refusal's detail map; a `reason` entry carries the unframed cause. */
  readonly details?: Readonly<Record<string, unknown>>
}

/** What `remote.loopEngine.engine` resolves to (harness: `RemoteResult<SessionEngineReport>`). */
export type SessionEngineResult =
  | { readonly ok: true; readonly value: SessionEngineReport }
  | { readonly ok: false; readonly error: RemoteFailure }

/** What `remote.loopEngine.select` resolves to (harness: `RemoteResult<LoopEngineSelectResult>`). */
export type EngineSelectResult =
  | { readonly ok: true; readonly value: LoopEngineSelectResult }
  | { readonly ok: false; readonly error: RemoteFailure }

/** This plugin's own Remote namespace, as the browser half calls it. */
export interface SessionEngineRemote {
  /** Report the engine one session runs (and the recorded engine it is not running, if any). */
  engine(request: { readonly sessionId: string }): Promise<SessionEngineResult>
  /** Move one session to another engine, or answer why it was not moved. */
  select(request: {
    readonly sessionId: string
    readonly engine: LoopEngineId
  }): Promise<EngineSelectResult>
}

/** Outcome of one per-session engine switch, ready to render. */
export type SessionSwitchResult =
  | {
    readonly ok: true
    /**
     * Present when the host made the switch land by RELEASING the session's
     * agent — a change with the harness loop on either side of it. This page has
     * already been reloaded (and the session remembered for the page that
     * replaces it) by the time a caller sees this, so a surface renders it as
     * "the switch is happening" rather than as a session that can be typed into.
     */
    readonly reload?: true
  }
  /** This page cannot reach the plugin's own Remote at all. */
  | { readonly ok: false; readonly kind: 'unavailable' }
  /**
   * The host refused the switch. `code` says which refusal it was, for the
   * surface to render in the user's language, and `reason` is the host's own
   * sentence about this session — detail under that copy, or the whole message
   * when the code is absent (an unknown code, a rejected CALL, a lost
   * connection: none of those has a refusal code, and none of them may leave the
   * surface with nothing to show).
   */
  | {
    readonly ok: false
    readonly kind: 'refused'
    readonly reason: string
    readonly code?: LoopEngineRefusalCode
  }

/** Move one session to another engine. */
export type SessionEngineSwitcher =
  (sessionId: string, engine: LoopEngineId) => Promise<SessionSwitchResult>

/**
 * Whether a pick on one session's engine can be committed at all — that is,
 * whether the host has answered what that session runs.
 *
 * This is the composer's usability gate, and it is hostile to guessing on
 * purpose. The reload judgement below is a statement about two engines, and with
 * no answer there is nothing honest to state: an unknown session may reload in
 * EITHER direction. Answering the question anyway would cost the user something
 * either way — `true` raises a confirmation for a switch that may not reload
 * (and the confirmation is the only thing keeping an UNEXPLAINED reload from
 * looking like a glitch), while `false` commits a pick that reloads and takes
 * this page's unsent draft with it. So the picker is simply not usable until the
 * answer lands: the trigger is greyed out with its menu unopenable, and it keeps
 * reading「读取中…」so the user can see what it is waiting for. The instant the
 * answer arrives the control becomes usable, unchanged.
 *
 * It is a TYPE PREDICATE as well as the runtime gate, so "no pick is ever judged
 * against an unknown engine" is enforced by the compiler: the composer narrows a
 * session's report through this before it asks {@link switchNeedsReload}, whose
 * parameter therefore cannot be undefined.
 *
 * A seat with NO session is not this function's business and never calls it: it
 * writes the default for sessions created later, moves nothing, and reloads
 * nothing, so there is no engine to wait for.
 * @param report - the session's engine report, or undefined while the host has
 * not answered yet (or cannot answer at all).
 * @returns whether the engine is known — the one condition under which a pick on
 * that session may be judged and sent.
 */
export function engineSwitchReady(report: SessionEngineReport | undefined): report is SessionEngineReport {
  return report !== undefined
}

/**
 * Whether moving a session from `current` to `target` has to land through a page
 * reload — the one thing a surface must ask the user about BEFORE it commits,
 * because the reload is what takes this page's unsent draft and scroll position
 * with it.
 *
 * The rule is the host's own split (`src/router-loop.ts` `move`): a move with the
 * harness loop on EITHER side cannot be handed over in place — `AgentLoop` neither
 * hands a live session over nor accepts one it did not create — so the session's
 * agent is released, the session goes cold, and the page reloads to rebuild it on
 * the recorded engine. Between two hosted engines nothing reloads: the agent is
 * swapped in place and the conversation stays open. So the move reloads exactly
 * when the two engines differ in being the in-process one.
 *
 * `current` is the engine the session ACTUALLY runs — the report's `engine`, never
 * the engine its record names, which is why this takes a {@link SessionEngine} and
 * not a bare id:
 *
 *  - a state that names an engine answers the rule above directly;
 *  - `legacy` and `unset` name no engine, and both are built on the in-process
 *    loop (`src/agent-preset-ids.ts` `hostedEngineOf` — the router falls back to
 *    the harness loop for a preset this plugin does not own), so they are read as
 *    the in-process side of the rule rather than as "unknown": picking any hosted
 *    engine on such a session really does reload.
 *
 * There is deliberately NO third branch for "the host has not answered yet": that
 * state never reaches here, because the composer gates every pick on
 * {@link engineSwitchReady} first (the picker is disabled until the answer lands),
 * and the parameter's non-optional type is what holds that down. A judgement made
 * without an answer would be a guess in one direction or the other, which is
 * exactly what the gate exists to avoid.
 *
 * It is a pure function of the two engines on purpose: the composer's confirmation
 * is only as trustworthy as this judgement, and this way it is pinned by a test
 * rather than by reading the component.
 * @param current - the engine the session runs now, as the host reports it. Never
 * unknown: callers hold a report that passed {@link engineSwitchReady}.
 * @param target - the engine the user picked.
 * @returns whether committing that pick releases the session's agent and reloads
 * this page.
 */
export function switchNeedsReload(current: SessionEngine, target: LoopEngineId): boolean {
  const from = current.kind === 'engine' ? current.engine : 'in-process'
  return (from === 'in-process') !== (target === 'in-process')
}

// ---------------------------------------------------------------------------
// The contribution this half mounts for itself
//
// The main repository generates a `typert.remote-client` artifact per package
// that exports Remotes; an out-of-tree plugin has no generator, and needs none:
// the protocol carries no schema registry, so a contribution is a package name
// plus method descriptors, and the descriptors are the same plain data the
// generator would have emitted. The only parts the Gateway checks are the ones
// restated below (client `validateContribution` / `requireStrictDescriptor`).
// ---------------------------------------------------------------------------

/** A codec of one wire field (harness: `TypertCodec`, strict branch). */
interface RemoteCodec {
  readonly mode: 'strict'
  /** Stable identity of the field's declared type, for diagnostics. */
  readonly typeSymbol: string
  readonly schema: { parse(value: unknown): unknown }
}

/** One ordered business parameter (harness: `InvocationParameterDescriptor`). */
interface RemoteParameter {
  readonly name: string
  /** Wire field this parameter occupies in `args`. */
  readonly wire: string
  readonly source: 'json'
  readonly codec: RemoteCodec
}

/** One exported method (harness: `InvocationDescriptor`). */
interface RemoteMethod {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly invocation: { readonly kind: 'direct' }
  readonly parameters: readonly RemoteParameter[]
  readonly result: RemoteCodec
}

/** One package's exported methods (harness: `TypertRemoteContribution`). */
export interface RemoteContribution {
  readonly package: string
  readonly descriptors: readonly RemoteMethod[]
}

/** The Client Remote service, as much of it as this half calls (harness: `ClientRemote`). */
export interface EngineRemoteHost {
  /** Install one contribution's namespaces for the calling fiber. */
  $mount(contribution: RemoteContribution): Promise<() => Promise<void>>
}

/** The plugin's npm package name, as the contribution identifies itself. */
export const LOOP_ENGINE_PACKAGE = 'dsh-loop-engine'

/**
 * Read one session's three-state engine answer off an untrusted value.
 *
 * The carrier hands a Remote result through without decoding it (the Gateway
 * validates results on the HOST side), so this is the browser-side boundary for
 * the answer: anything that is not one of the three states is no answer at all,
 * never a default.
 * @param value - the decoded JSON the host answered with.
 * @returns the three-state, verified.
 * @throws {TypeError} when the value is not one of the three states.
 */
function parseSessionEngine(value: unknown): SessionEngine {
  const kind = (value as { readonly kind?: unknown } | null | undefined)?.kind
  if (kind === 'legacy' || kind === 'unset') return { kind }
  const engine = (value as { readonly engine?: unknown } | null | undefined)?.engine
  if (kind === 'engine' && isLoopEngineId(engine)) return { kind, engine }
  throw new TypeError(`loop-engine: "${String(kind)}" is not a session engine state`)
}

/**
 * Read one session's engine report off an untrusted wire value.
 *
 * The carrier hands a Remote result through without decoding it (the Gateway
 * validates results on the HOST side), so this is the browser-side boundary for
 * the answer: anything that is not one of the three states, or that names a
 * pending engine that is not an installed engine, is no answer at all — never a
 * default, and never a session shown as running the engine it has only recorded.
 * @param value - the decoded JSON the host answered with.
 * @returns the report, verified.
 * @throws {TypeError} when the value is not a well-formed report.
 */
function parseSessionEngineReport(value: unknown): SessionEngineReport {
  const engine = parseSessionEngine((value as { readonly engine?: unknown } | null | undefined)?.engine)
  const pending = (value as { readonly pending?: unknown } | null | undefined)?.pending
  if (pending === undefined) return { engine }
  if (!isLoopEngineId(pending)) {
    throw new TypeError(`loop-engine: "${String(pending)}" is not a session engine state`)
  }
  return { engine, pending }
}

/**
 * Read the session id field off an untrusted value.
 * @param value - the decoded JSON a caller sent.
 * @returns the non-empty session id.
 * @throws {TypeError} when the field is missing or malformed.
 */
function parseSessionId(value: unknown): string {
  const sessionId = (value as { readonly sessionId?: unknown } | null | undefined)?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('loop-engine: sessionId must be a non-empty string')
  }
  return sessionId
}

/**
 * Read the switching request off an untrusted caller's value.
 *
 * Both fields are part of the endpoint's signature, so both are normalized here
 * the way the host validates them: a request that names no session, or names
 * something that is not an installed engine, is not a request this endpoint can
 * serve.
 * @param value - the decoded JSON the browser half is about to send.
 * @returns the two-field request, verified.
 * @throws {TypeError} when either field is missing or malformed.
 */
function parseSelectRequest(value: unknown): { sessionId: string; engine: LoopEngineId } {
  const sessionId = parseSessionId(value)
  const engine = (value as { readonly engine?: unknown } | null | undefined)?.engine
  if (!isLoopEngineId(engine)) {
    throw new TypeError(`loop-engine: engine must be one of ${LOOP_ENGINE_IDS.join(', ')}`)
  }
  return { sessionId, engine }
}

/**
 * Read one switch answer off an untrusted wire value.
 *
 * A refusal is an ordinary answer here — the host refused a session that cannot
 * be moved, with a code naming the branch and its own sentence about this session
 * — so both branches round-trip; only a value that is neither is no answer at
 * all.
 *
 * The code is the one field that may be dropped rather than rejected: a code this
 * build does not know (a newer host) is normalized to absent, which leaves the
 * host's sentence as the message the surface renders. Dropping an unknown code
 * costs the user localized copy; refusing the whole answer would cost them the
 * reason too.
 * @param value - the decoded JSON the host answered with.
 * @returns the verified outcome.
 * @throws {TypeError} when the value is neither branch.
 */
function parseSelectResult(value: unknown): LoopEngineSelectResult {
  const outcome = (value ?? {}) as {
    readonly ok?: unknown
    readonly engine?: unknown
    readonly code?: unknown
    readonly reason?: unknown
    readonly reload?: unknown
  }
  if (outcome.ok === true && isLoopEngineId(outcome.engine)) {
    // `reload` asks this half to rebuild the page, so only the literal `true`
    // may ask for it: anything else at that field is a malformed outcome like
    // any other, never an instruction to reload.
    if (outcome.reload !== undefined && outcome.reload !== true) {
      throw new TypeError('loop-engine: not an engine switch outcome')
    }
    return outcome.reload === true
      ? { ok: true, engine: outcome.engine, reload: true }
      : { ok: true, engine: outcome.engine }
  }
  if (outcome.ok === false && typeof outcome.reason === 'string') {
    return isLoopEngineRefusalCode(outcome.code)
      ? { ok: false, code: outcome.code, reason: outcome.reason }
      : { ok: false, reason: outcome.reason }
  }
  throw new TypeError('loop-engine: not an engine switch outcome')
}

/** One endpoint of the plugin's own Remote, as the contribution declares it. */
function descriptor(
  method: string,
  request: RemoteCodec['schema'],
  result: RemoteCodec['schema'],
): RemoteMethod {
  return {
    id: `${LOOP_ENGINE_PACKAGE}#${LOOP_ENGINE_REMOTE_NAMESPACE}/${method}`,
    service: LOOP_ENGINE_REMOTE_NAMESPACE,
    namespace: LOOP_ENGINE_REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      // The wire name is the HOST method's own parameter name: the Gateway
      // derives an unregistered endpoint's signature from the live method
      // (`methodParameterNames`), and refuses args whose fields do not match it.
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: `${LOOP_ENGINE_PACKAGE}#${LOOP_ENGINE_REMOTE_NAMESPACE}/${method}:request`,
        schema: request,
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: `${LOOP_ENGINE_PACKAGE}#${LOOP_ENGINE_REMOTE_NAMESPACE}/${method}:result`,
      schema: result,
    },
  }
}

/** The plugin's own Remote, declared for the Gateway's client mount. */
export const LOOP_ENGINE_REMOTE_CONTRIBUTION: RemoteContribution = {
  package: LOOP_ENGINE_PACKAGE,
  descriptors: [
    descriptor(
      LOOP_ENGINE_REMOTE_METHOD,
      {
        /** Normalize the one-field request the host's method declares. */
        parse(value: unknown): { sessionId: string } {
          return { sessionId: parseSessionId(value) }
        },
      },
      { parse: parseSessionEngineReport },
    ),
    descriptor(LOOP_ENGINE_REMOTE_SELECT_METHOD, { parse: parseSelectRequest }, { parse: parseSelectResult }),
  ],
}

/**
 * What one session's engine is, cached per session.
 *
 * Every read goes to the host's authoritative answer and is cached by session id
 * so the chip and the composer in the same header cannot disagree. Until the
 * first answer arrives a session has NO engine here: {@link read} returns
 * undefined, and the surfaces render nothing (chip) or a neutral loading state
 * (composer) rather than a guess — a default or a list hint would be exactly the
 * misreport this class exists to end.
 *
 * What is cached is the whole {@link SessionEngineReport}, the recorded engine
 * that differs from the live one included, because the three surfaces read
 * different halves of it: the chip, the composer's label, and the chat
 * turn-status row all name the engine the session RUNS, and only the first two
 * also carry the "recorded, not in force" marker. Merging the two here would
 * make that distinction unavailable downstream; leaving the report intact lets
 * each surface take the half it renders.
 *
 * A cached answer is never treated as final for the page's lifetime: a session
 * the user comes back to is re-read when its surfaces appear again
 * ({@link watch} → {@link refresh}). Coming back does not move the session — a
 * switch is performed on the host, between hosted engines it swaps the agent in
 * place, and the direction that has to release the session reloads this very
 * page (`./reload.ts`) — but the answer this page holds is still only one this
 * page took earlier: another window, a hot swap performed elsewhere, or a plugin
 * reload can have moved the session since. The answer a surface holds is
 * therefore correct for as long as that surface is on screen, and refreshed at
 * every re-mount — not only when a switch this page performed invalidated it
 * ({@link invalidate}).
 *
 * Its answer is also what the chat turn-status row draws (the third place a
 * session's engine is shown), but through the surfaces rather than through this
 * class: the row follows the session on screen because the hook both surfaces
 * share reflects that session's answer with a focus guard — the same authority
 * the chip and the composer read, where the settings default it used to follow
 * was not. Nothing here writes to the document; see `./turn-status.ts` and
 * `./use-session-engine.ts`.
 */
export class SessionEngineCache {
  private readonly engines = new Map<string, SessionEngineReport>()
  private readonly watchers = new Map<string, Set<() => void>>()
  private readonly reading = new Map<string, Promise<void>>()
  /**
   * Monotonic read generation per session. A read started before an
   * invalidation describes the session as it was BEFORE the switch, so however
   * late it settles it must not publish — publishing it would put the old engine
   * back on screen, which is the very misreport this cache exists to prevent.
   */
  private readonly generations = new Map<string, number>()
  private remote: SessionEngineRemote | undefined
  private disposed = false

  /**
   * Attach the mounted Remote namespace. Values asked for before the mount
   * settled are re-read, so a surface that mounted first is not left loading.
   * @param remote - the namespace, or undefined when the mount failed.
   */
  attach(remote: SessionEngineRemote | undefined): void {
    if (this.disposed) return
    this.remote = remote
    for (const sessionId of [...this.watchers.keys()]) this.readIfUnknown(sessionId)
  }

  /**
   * The engine report cached for one session, or undefined while the first
   * answer is still in flight (or when the host could not answer at all).
   * @param sessionId - the session whose engine is asked for.
   * @returns the authoritative report, cached by session id.
   */
  read(sessionId: string): SessionEngineReport | undefined {
    return this.engines.get(sessionId)
  }

  /**
   * Follow one session's engine, re-reading it whenever a session's surfaces
   * appear again.
   *
   * A watch is a surface appearing for this session, and that is the moment the
   * cached answer can be stale in a way nothing else reports: a session whose
   * surfaces all went away and came back — the page switched to another session
   * and back — must not render what the page cached before. A re-mount is not
   * what moves a session's engine (a switch is performed on the host, and either
   * swaps the agent in place or releases the session and reloads this page), but
   * the page's answer is old by then, and a surface that rendered it as current
   * would be the one lying about what runs.
   *
   * Only the FIRST watcher of a session triggers the re-read, which is what
   * makes this "the session's surfaces appeared" rather than "a component
   * rendered": the chip and the composer are two watchers of one session, and
   * the second joins the read the first one started instead of sending its own.
   * While a session keeps its surfaces, nothing here asks again — the answer only
   * changes through {@link invalidate} (a committed switch) or a later re-mount.
   * @param sessionId - the session to follow.
   * @param listener - called whenever that session's cached state changes.
   * @returns the unsubscribe.
   */
  watch(sessionId: string, listener: () => void): () => void {
    const listeners = this.watchers.get(sessionId) ?? new Set<() => void>()
    const appearing = listeners.size === 0
    listeners.add(listener)
    this.watchers.set(sessionId, listeners)
    if (appearing) this.refresh(sessionId)
    return () => {
      if (this.watchers.get(sessionId) !== listeners) return
      listeners.delete(listener)
      if (listeners.size === 0) this.watchers.delete(sessionId)
    }
  }

  /**
   * Ask the host for one session's engine report again, superseding nothing.
   *
   * This is the way a surface that has just been rendered asks "is what this page
   * cached still what runs?" — the answer that can go stale without anyone
   * invalidating it, because the page is not the only thing that can move a
   * session (another window, a hot swap elsewhere, a plugin reload).
   * A read already in flight for that session is joined rather than replaced (it
   * was started no earlier than this call and describes the same moment), and the
   * cached answer is kept until the new one lands, so a re-read never blinks the
   * chip back to "reading". Use {@link invalidate} instead for an answer that is
   * known to be WRONG.
   * @param sessionId - the session whose answer should be re-read.
   */
  refresh(sessionId: string): void {
    if (this.disposed) return
    if (this.reading.has(sessionId)) return
    this.start(sessionId)
  }

  /**
   * Forget one session's cached engine and ask the host again.
   *
   * A successful engine switch changes what the host answers for that session,
   * so the picker MUST come through here: without it the composer would keep
   * showing the engine the session no longer runs. Any read already in flight
   * for that session is superseded and can no longer publish.
   * @param sessionId - the session whose answer is now stale.
   */
  invalidate(sessionId: string): void {
    this.engines.delete(sessionId)
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
    this.reading.delete(sessionId)
    this.publish(sessionId)
    this.readIfUnknown(sessionId)
  }

  /** Drop every cached answer and notification (plugin unload). */
  dispose(): void {
    this.disposed = true
    this.remote = undefined
    this.engines.clear()
    this.reading.clear()
    this.generations.clear()
    this.watchers.clear()
  }

  /**
   * Ask unless the session is already answered, being read, or unanswerable.
   *
   * For the paths that need an answer and have none: the plugin's mount settling
   * (a surface asked before the Remote existed), a session whose cached answer
   * was just dropped — and never a re-read of an answer this page already holds,
   * which is {@link refresh}'s job and only a freshly rendered surface may ask
   * for.
   */
  private readIfUnknown(sessionId: string): void {
    if (this.engines.has(sessionId) || this.reading.has(sessionId)) return
    this.start(sessionId)
  }

  /**
   * Start one read for a session, unless there is nothing to read it with.
   * @param sessionId - the session to read.
   */
  private start(sessionId: string): void {
    const remote = this.remote
    if (this.disposed || remote === undefined) return
    const generation = (this.generations.get(sessionId) ?? 0) + 1
    this.generations.set(sessionId, generation)
    const read = this.ask(remote, sessionId, generation)
    this.reading.set(sessionId, read)
    void read.then(() => {
      if (this.reading.get(sessionId) === read) this.reading.delete(sessionId)
    })
  }

  /**
   * One read, quiet on failure: a session the host cannot answer for stays
   * unknown, and the surfaces keep their neutral state instead of claiming an
   * engine. A refusal is not cached as an answer, so the next watch re-asks.
   * @param remote - the mounted namespace.
   * @param sessionId - the session asked about.
   * @param generation - the read generation this answer belongs to.
   */
  private async ask(remote: SessionEngineRemote, sessionId: string, generation: number): Promise<void> {
    let result: SessionEngineResult
    try {
      result = await remote.engine({ sessionId })
    } catch {
      return
    }
    if (!result.ok || this.disposed || this.generations.get(sessionId) !== generation) return
    let report: SessionEngineReport
    try {
      report = parseSessionEngineReport(result.value)
    } catch {
      return
    }
    this.engines.set(sessionId, report)
    this.publish(sessionId)
  }

  /**
   * Notify one session's watchers.
   *
   * Nothing is painted here. The session's engine shows up in the chat
   * turn-status row too, but that row hangs off a DOCUMENT-level attribute, whose
   * only entitled owner is the session on screen — and a publish says nothing
   * about what is on screen (this is called for every session a surface has ever
   * watched, and for a session the user has already left, when its late answer
   * lands). So painting here let a background session take the attribute over
   * from the session on screen. The surfaces reflect instead, with the focus
   * guard in `./turn-status.ts`; this is the notification the chip and the
   * composer wake up on.
   */
  private publish(sessionId: string): void {
    for (const listener of this.watchers.get(sessionId) ?? []) listener()
  }
}

/**
 * Mount this plugin's own engine Remote and return the cache the session
 * surfaces render from.
 *
 * `remote` is taken lazily rather than declared in the client half's `inject`:
 * the settings page must keep working on a page that composes no Gateway, and
 * the two session surfaces degrade to "engine not recorded" — never to a guess.
 * @param ctx - the client root context.
 * @returns the cache both session surfaces and the switcher share.
 */
export function createSessionEngineCache(ctx: ClientContext): SessionEngineCache {
  const cache = new SessionEngineCache()
  ctx.inject(['remote'], (remoteCtx: ClientContext) => {
    const remote = remoteCtx.get('remote') as EngineRemoteHost | undefined
    if (remote === undefined) return
    remote.$mount(LOOP_ENGINE_REMOTE_CONTRIBUTION).then(
      () => {
        cache.attach(remoteCtx.get(`remote.${LOOP_ENGINE_REMOTE_NAMESPACE}`) as SessionEngineRemote | undefined)
      },
      (error: unknown) => {
        ctx.logger.warn(`loop-engine: could not mount the session engine Remote: ${String(error)}`)
      },
    )
  })
  ctx.effect(() => () => { cache.dispose() }, 'loop-engine: session engine cache')
  return cache
}

/**
 * Build the per-session switch over this plugin's own Remote.
 *
 * Every refusal is reported rather than thrown: the host's own reason when it
 * refused (the session is not open, it is mid-turn, it belongs to subagent
 * routing, or the engine record could not be written), and this page's own words
 * when the namespace is not reachable. A switch that DID land drops the cached
 * answer, because the host's read for that session just changed.
 *
 * A switch the host had to make by RELEASING the session's agent is finished
 * here rather than reported: the page is reloaded — the only action that clears
 * the client state a `session/disposed` leaves behind — and the session is
 * stashed for the page that replaces it, so the reload lands back on it
 * (`./reload.ts` explains why each half is necessary). That is why this function
 * owns the reload instead of leaving it to a component: it is the one place that
 * knows the host released the agent, and it keeps the sequence (invalidate →
 * stash → reload) in one testable step.
 * @param ctx - the client context carrying the Remote namespace.
 * @param onSwitched - called with the session id once the host accepted the
 *   switch, so the caller can drop the cached engine it just changed.
 * @param page - the page to reload and to stash the return in.
 * @returns the switch the composer's picker commits through.
 */
export function sessionEngineSwitcher(
  ctx: ClientContext,
  onSwitched?: (sessionId: string) => void,
  page: ReloadPage = browserPage(),
): SessionEngineSwitcher {
  return async (sessionId, engine) => {
    const remote = ctx.get(`remote.${LOOP_ENGINE_REMOTE_NAMESPACE}`) as SessionEngineRemote | undefined
    if (remote === undefined) return { ok: false, kind: 'unavailable' }
    let result: EngineSelectResult
    try {
      result = await remote.select({ sessionId, engine })
    } catch (error: unknown) {
      // Only assembly faults reject (an unmounted method, a lost connection the
      // carrier did not fold); report them the same way as a refusal.
      return { ok: false, kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
    }
    if (!result.ok) {
      // The call itself was refused — a malformed request the Gateway rejected,
      // or a lost connection. Its framing names the session this surface already
      // names, so the unframed message is the readable text.
      return { ok: false, kind: 'refused', reason: result.error.message }
    }
    // The call was served, and the plugin either moved the session or said why
    // it could not. A refusal here is the ordinary case — the picker's own
    // dialog renders the refusal's code in the user's language and keeps this
    // sentence as its detail.
    if (!result.value.ok) {
      return result.value.code === undefined
        ? { ok: false, kind: 'refused', reason: result.value.reason }
        : { ok: false, kind: 'refused', reason: result.value.reason, code: result.value.code }
    }
    // The switch was committed, so the reported engine is stale by definition:
    // the record is what the host now answers with.
    onSwitched?.(sessionId)
    if (result.value.reload !== true) return { ok: true }
    // The session's agent is gone and the page's copy of it is what the host's
    // `session/disposed` left behind — a session that can no longer be used. The
    // reload replaces that state, and the stashed id is how the page that comes
    // back opens this session instead of the client's own fallback.
    armReloadReturn(page, sessionId)
    page.reload()
    return { ok: true, reload: true }
  }
}
