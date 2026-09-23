/**
 * Loop engine ids, the agent-preset ids that select them, and the two plain
 * wire shapes both halves of the plugin share — in a module with no imports at
 * all.
 *
 * The mapping is pure identity arithmetic (an engine to a preset id and back),
 * so it belongs to neither half; it lives here for the same reason
 * `./namespace.ts` does — the browser bundle needs it, and the files that
 * otherwise carry it are host-side: `./settings.ts` imports `schemastery` and
 * the `dsh-settings` brand type, `./preset.ts` imports `node:fs/promises`.
 * Importing either from `src/client/**` would pull a host package into the
 * client artifact. Both of them re-export what this module defines, so the
 * existing import paths and names stay valid on the node side.
 *
 * The two shapes are here for that same reason: {@link SessionEngine} is what
 * the browser half renders and {@link LoopEngineSelectResult} is what its switch
 * comes back with, so both halves name the same types without either half's
 * modules crossing the boundary. The refusal codes travel with the second one
 * ({@link LoopEngineRefusalCode}) for the same reason plus one more: the browser
 * half is what turns a refusal into copy, so the codes it may read have to be
 * knowable without importing the host's router.
 *
 * @module dsh-loop-engine/agent-preset-ids
 */

/** The installed engine driving new Agent turns. */
export const LOOP_ENGINE_IDS = ['in-process', 'claude-code', 'codex', 'pi', 'kimi'] as const

/** Installed agent loop engine id. */
export type LoopEngineId = (typeof LOOP_ENGINE_IDS)[number]

/** An engine this plugin hosts itself; `in-process` is the harness's own loop. */
export type HostedEngineId = Exclude<LoopEngineId, 'in-process'>

/** Every hosted engine id, in selection order. */
export const HOSTED_ENGINE_IDS = LOOP_ENGINE_IDS.filter(
  (id): id is HostedEngineId => id !== 'in-process',
)

/**
 * Whether an engine is one this plugin hosts — an external CLI some other
 * vendor runs, which owns its own model — rather than the harness's own loop.
 *
 * The judgement a surface needs to say "the model is the engine's own business"
 * without hardcoding one engine's name: every hosted engine behaves the same
 * way here, and naming one of them would make a general fact read as a property
 * of that engine. An engine nobody has answered for yet is not hosted: a surface
 * that does not know says nothing rather than claiming the wrong half.
 * @param engine - an engine id, or undefined while one is still being read.
 * @returns whether that engine is hosted by this plugin.
 */
export function isHostedEngine(engine: LoopEngineId | undefined): engine is HostedEngineId {
  return engine !== undefined && engine !== 'in-process'
}

/**
 * The single provider route label EVERY hosted engine logs into its sessions'
 * `request/header`, and the one placeholder route this plugin registers in the
 * llm registry.
 *
 * One label for all four engines, because the browser model catalog is built
 * for the whole Host GENERATION and is not scoped to a session
 * (`packages/api/session-controller/src/catalog.ts` — "Build the browser model
 * catalog without requiring a Session"; it walks `ctx.llm.listProviders()`
 * once). A per-engine label would therefore surface one provider group per
 * engine in every session's menu at once — four identical `default` entries —
 * which is what this constant collapses away.
 *
 * The value is ASCII on purpose: it is a WIRE value. It is written into each
 * session's `request/header`, it travels through selections, and the host
 * compares it (`providerInfo().id` must equal the provider the adapter
 * registered for — `packages/llm/llm/src/index.ts` `prepareRoutes`). The
 * display name ({@link HOSTED_ROUTE_NAME}) is the same token, for the reason
 * that constant documents.
 */
export const HOSTED_ROUTE_LABEL = 'external'

/**
 * The user-visible name of the one hosted route ({@link HOSTED_ROUTE_LABEL}),
 * shown as the model menu's provider group label.
 *
 * The same token as the wire value, and deliberately not localized: the catalog
 * carries exactly one string per provider group (`ModelCatalog`'s `group.name`,
 * taken from `LlmProviderInfo.name`) and the browser half has no hook to
 * re-translate it, so one fixed name is what every locale sees.
 */
export const HOSTED_ROUTE_NAME = 'external'

/**
 * The one model id a hosted engine's provider route advertises to the model
 * menu, and the model label that engine logs into its sessions'
 * `request/header` when the deployment pins none.
 *
 * The two are ONE string on purpose, and that is a host-side requirement rather
 * than a style choice: the picker builds its selection out of a catalog entry
 * (`ModelSelect.tsx` `choices` — `model: model.id`) and resolves a session's
 * `(provider, model)` back to that entry by comparing the pair with the logged
 * header (`selectedIndex`), so an entry whose `id` differs from the logged
 * label falls through to the raw `provider/model` string — how a menu ends up
 * showing a model that does not exist. The label is the engine's own word for
 * "whatever it decides"; `name` is the same string because `LlmModelInfo.name`
 * is rendered verbatim and has no localization hook.
 */
export const HOSTED_DEFAULT_MODEL = 'default'

/** Prefix every plugin-authored preset id carries. */
export const HOSTED_PRESET_PREFIX = 'loop-engine-'

/** The deployment's own preset id, which selects the harness loop. */
export const SOURCE_PRESET_ID = 'standard'

/**
 * The pre-routing single preset id: older versions of this plugin authored one
 * preset for every hosted engine and pinned the profile to one of them, so a
 * session carrying this id DID run a hosted engine — but the id does not say
 * which one. It is not a hosted preset id ({@link engineOfPreset} reads it as
 * `undefined`, so the router keeps such a session on the harness loop), and it
 * is not `standard` either; surfaces that name a session's engine must report it
 * as "a hosted engine, unrecorded" rather than claim the in-process loop.
 */
export const LEGACY_HOSTED_PRESET_ID = 'loop-engine'

/**
 * The preset id that selects one engine for a session. `in-process` names the
 * deployment's own `standard` preset: the harness loop is not something this
 * plugin authors a preset for.
 * @param engine - the engine a session should run.
 * @returns the preset id to record on the session.
 */
export function enginePresetId(engine: LoopEngineId): string {
  return engine === 'in-process' ? SOURCE_PRESET_ID : `${HOSTED_PRESET_PREFIX}${engine}`
}

/**
 * Whether an untyped value is one of {@link LOOP_ENGINE_IDS}.
 *
 * The boundary test both halves need: a value crossing the wire, the sidecar
 * file, or a projection read is only an engine when it is one of these.
 * @param value - the value to classify.
 * @returns whether `value` is an installed engine id.
 */
export function isLoopEngineId(value: unknown): value is LoopEngineId {
  return (LOOP_ENGINE_IDS as readonly unknown[]).includes(value)
}

/**
 * The engine a preset id selects, or `undefined` for a preset this plugin does
 * not own (any deployment-authored preset, including `standard`).
 * @param presetId - the session's preset id, when it has one.
 * @returns the hosted engine it names, or undefined for the harness loop.
 */
export function engineOfPreset(presetId: string | undefined): HostedEngineId | undefined {
  if (presetId === undefined) return undefined
  const engine = presetId.startsWith(HOSTED_PRESET_PREFIX)
    ? presetId.slice(HOSTED_PRESET_PREFIX.length)
    : ''
  return (HOSTED_ENGINE_IDS as readonly string[]).includes(engine) ? engine as HostedEngineId : undefined
}

/**
 * What a session's recorded preset says about the engine that session runs.
 *
 * Not every session has an answer: the pre-routing single preset id names a
 * hosted engine without recording which one, and a deployment that composes no
 * presets (or a transcript whose projection is gone) records nothing at all.
 * Both are reported as themselves — a surface that names a session's engine must
 * never read "unknown" as the in-process loop.
 */
export type SessionEngine =
  | { readonly kind: 'engine'; readonly engine: LoopEngineId }
  /** The pre-routing preset: this session ran a hosted engine, but the id does not say which. */
  | { readonly kind: 'legacy' }
  /** The session records no preset at all (a deployment that composes none, or one created before presets existed). */
  | { readonly kind: 'unset' }

/**
 * What one session's engine report carries: the engine the session ACTUALLY
 * runs, and — when they differ — the engine its own record names for it.
 *
 * The two are one answer because a surface must never render the second as if it
 * were the first. A session switched onto or off the harness loop has its agent
 * RELEASED (`src/router-loop.ts` `move`), so the session is simply cold
 * afterwards and its record IS what its next build runs — no second fact, no
 * pending. This field therefore survives for the one case in which a live agent
 * still differs from the record: the release did not take (its teardown failed,
 * or another process wrote the record), so the session keeps running its old
 * engine while the record names another. Reporting only the live agent would
 * hide that a switch was accepted at all — the "显示在撒谎" bug this report
 * exists to prevent — so both travel, and {@link pending} says which is which.
 */
export interface SessionEngineReport {
  /** The engine driving this session NOW. */
  readonly engine: SessionEngine
  /**
   * Present only while the session has an engine recorded that its LIVE agent is
   * not running — i.e. a recorded switch whose release did not complete. Absent
   * whenever the record and the live agent agree, and always absent for a session
   * with no live agent (there the record IS what the session runs).
   */
  readonly pending?: LoopEngineId
}

/**
 * Every way this plugin refuses to move a session to another engine, as a stable
 * code.
 *
 * A code exists because the host's own sentence is not what a surface shows any
 * more: the browser half localizes the refusal from the code (`refusalFace` in
 * `./client/locales.ts`) and keeps {@link LoopEngineRefusal.reason} only as
 * detail, so the codes are part of the wire contract and a value may be added but
 * never quietly repurposed. The list is exactly the refusals the host can produce
 * — one per branch of `RouterLoop.selectEngine`, plus the Remote's own
 * "no router mounted" answer:
 *
 *  - `session-closed`: the session has no agent in this process (nothing is open
 *    to move);
 *  - `turn-running`: a turn is in flight, and it is never interrupted;
 *  - `subagent-session`: a delegated child's agent belongs to its delegation;
 *  - `not-driven`: an agent is live but this router did not build it (the mount
 *    window in which the base loop still owns the factory slot);
 *  - `router-unmounted`: no router is mounted at all yet;
 *  - `record-failed`: the plugin's own per-session record could not be written,
 *    so the choice could not be committed;
 *  - `rebuild-failed`: the outgoing machine was retired, the successor could not
 *    be built, and the session was left cold on the recorded engine.
 *
 * A malformed REQUEST is deliberately NOT one of these: it travels as a
 * `RemoteError` with `gateway/bad-request`, because it is the caller's fault
 * rather than a state of the session.
 */
export const LOOP_ENGINE_REFUSAL_CODES = [
  'session-closed',
  'turn-running',
  'subagent-session',
  'not-driven',
  'router-unmounted',
  'record-failed',
  'rebuild-failed',
] as const

/** Why one session's engine switch was refused. */
export type LoopEngineRefusalCode = (typeof LOOP_ENGINE_REFUSAL_CODES)[number]

/**
 * Whether an untyped value is one of {@link LOOP_ENGINE_REFUSAL_CODES}.
 *
 * The boundary test the browser half needs: a code is only a code when this
 * build knows it, so a value it does not recognize is normalized away and the
 * host's `reason` stays readable instead (`./client/session-engine.ts`
 * `parseSelectResult`).
 * @param value - the value to classify.
 * @returns whether `value` is a known refusal code.
 */
export function isLoopEngineRefusalCode(value: unknown): value is LoopEngineRefusalCode {
  return (LOOP_ENGINE_REFUSAL_CODES as readonly unknown[]).includes(value)
}

/**
 * What one attempt to move a session to another engine produced.
 *
 * A refusal is a VALUE rather than a thrown error: every reason below is a
 * predictable state of the session (it is not open, it is mid-turn, it belongs
 * to subagent routing) that the surface must show — localized by
 * {@link LoopEngineRefusal.code}, with the host's own sentence kept as detail —
 * and only a malformed REQUEST is the caller's fault (`gateway/bad-request`).
 */
export type LoopEngineSelectResult =
  | {
    readonly ok: true
    readonly engine: LoopEngineId
    /**
     * Present when the switch was made to land by RELEASING the session's live
     * agent rather than by moving it: a change with the harness loop on either
     * side of it cannot be applied in place, so the agent is torn down, the
     * session goes cold, and the record's engine is what its next build uses.
     *
     * The page must reload for that next build to happen: releasing publishes
     * `session/disposed`, which the browser half reads as this session being
     * gone — with no way back in that page's lifetime — so a reload (and a
     * re-open of the session) is what replaces the page state with a fresh list
     * and a fresh build. The flag is how the surface knows to do that instead of
     * leaving the user on a session that looks broken.
     */
    readonly reload?: true
  }
  /** The switch did not happen; the branch that refused it is `code`. */
  | {
    readonly ok: false
    /**
     * Which refusal this is, for the surface to localize
     * ({@link LoopEngineRefusalCode}). Every refusal this plugin's host produces
     * carries one — `refuse(code, reason)` in `./router-loop.ts` takes it as a
     * required argument, so the node half cannot forget it.
     *
     * Optional in the SHAPE only, because the browser half is what reads it off
     * the wire: a code this build does not know (a newer host, or a hand-written
     * answer) is normalized to absent so that `reason` — which is always there —
     * is what the user reads, instead of the whole answer failing the boundary
     * check and leaving the surface with nothing to show.
     */
    readonly code?: LoopEngineRefusalCode
    /**
     * The host's own complete sentence about this session. It is DETAIL, not the
     * message any more: a surface shows its own localized copy for `code` and
     * keeps this beside it (small print) or falls back to it when `code` is
     * absent.
     */
    readonly reason: string
  }

/**
 * The engine one session's recorded preset says it runs, with the harness's own
 * fallback for a preset this plugin does not own: the deployment's `standard` and
 * anything else a deployment authored keep the session on the harness loop.
 *
 * The two answers that are not an engine stay distinct: {@link LEGACY_HOSTED_PRESET_ID}
 * is a hosted engine whose name was never recorded, and a missing preset is this
 * session recording nothing.
 *
 * This is the ONE preset-id → engine judgement: the router routes on what it
 * returns and the plugin's own Remote reports it, so "what the session runs" and
 * "what the session is shown as running" cannot disagree
 * (`src/engine-of-session.ts` supplies the preset id from the durable log;
 * `src/engine-remote.ts` publishes the answer to the browser half).
 * @param presetId - the session's recorded preset id, when it has one. Reads off
 * an untyped projection, so anything that is not a string is as good as no
 * preset at all.
 * @returns what that id says about the session's engine.
 */
export function sessionEngineOf(presetId: unknown): SessionEngine {
  if (typeof presetId !== 'string') return { kind: 'unset' }
  if (presetId === LEGACY_HOSTED_PRESET_ID) return { kind: 'legacy' }
  return { kind: 'engine', engine: engineOfPreset(presetId) ?? 'in-process' }
}

/**
 * The hosted engine one {@link SessionEngine} names, or `undefined` for every
 * answer that is not this plugin's own engine preset.
 *
 * This is the router's half of the judgement: the harness loop still owns
 * `in-process`, the pre-routing id and an unrecorded session both run whatever
 * the deployment's own composition gives them (the harness loop).
 * @param session - what a session's preset says about its engine.
 * @returns the hosted engine to build a driver runtime for, or undefined for the
 * harness loop.
 */
export function hostedEngineOf(session: SessionEngine): HostedEngineId | undefined {
  if (session.kind !== 'engine' || session.engine === 'in-process') return undefined
  return session.engine
}
