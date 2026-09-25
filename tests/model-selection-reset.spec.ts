/**
 * Model-selection suite: a session's model selection stays on the seat its
 * engine owns.
 *
 * The fact this pins: a session's model selection follows its ENGINE. A hosted
 * engine owns its model natively, logs its own provider label into the session's
 * `request/header` (`kimi` here), and that label is served only by this plugin's
 * placeholder route — which fails loud (`HOSTED_ENGINE_ROUTE`) the moment a real
 * model call reaches it; so a session a hosted engine drives selects
 * `<engine>/default`. The harness loop DOES make real calls, so a session
 * switched back to `in-process` has to be handed the deployment default instead.
 * Both are written as the harness's own `model/selection` event, at the moment
 * the session's engine is decided — the switch, or the build of a new session.
 *
 * Real stack throughout: the real plugin composition (`apply`, the patch file,
 * the provider placeholders), the real `RouterLoop` behind its inject gate, the
 * real Remote endpoint the browser half calls, the real engines (Kimi Code as
 * the session's engine, Claude Code as the other hosted engine of a swap), real
 * Sessions with a real JSONL write handle, and the real per-session engine
 * record on disk. Only two host services are stand-ins, both for packages this
 * plugin does not depend on: the session-projection registry (whose
 * `modelSelection` and `sessionListMetadata` folds are reproduced from the
 * host's own source, so the assertions are about the harness's own events rather
 * than about a fixture) and the default-model service.
 *
 * @module tests/model-selection-reset
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, canonicalHeader, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  HOSTED_DEFAULT_MODEL,
  HOSTED_ROUTE_LABEL,
  type LoopEngineSelectResult,
} from '../src/agent-preset-ids.ts'
import { ClaudeCodeAgent } from '../src/engine-claude/agent.ts'
import { apply, type Config } from '../src/index.ts'
import { ModelSelectionReset } from '../src/model-selection-reset.ts'
import { SOURCE_PRESET_ID, enginePresetId } from '../src/preset.ts'
import { isHostedProviderRoute } from '../src/provider-route.ts'
import { createLiveLoopConfig, installFakeSettings } from './helpers/fake-settings.ts'
import { fakeSessionProjections } from './helpers/session-projections.ts'
import { fakeToolRuntime } from './helpers/tool-runtime.ts'

/** The one shared provider route every hosted engine logs: what has to be replaced. */
const ENGINE_LABEL = HOSTED_ROUTE_LABEL
/**
 * A per-engine provider label an EARLIER build logged. No adapter serves it any
 * more, but a pre-existing session's header still names it — so it must be
 * recognized as a hosted route and rewritten like {@link ENGINE_LABEL}.
 */
const LEGACY_ENGINE_LABEL = 'kimi'
/** The model label that engine logs, native to it and unknown to any adapter. */
const ENGINE_MODEL = 'kimi-code-native'
/** The deployment default the host gives a session without a selection. */
const DEFAULT_PROVIDER = 'deployment'
const DEFAULT_MODEL = 'deployment-model'

/** The host's settings namespace for its default model selection. */
const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'
/**
 * The model a deployment composes as its own default — the settings `base` layer
 * a saved (user-layer) default overrides. The base bundle composes exactly such
 * a row for `agent-default-model` (`packages/bundle/base/cordis.patch.yml`), so
 * this is the value this plugin falls back to when the SAVED default has been
 * overwritten by the engine label the model menu writes there.
 */
const COMPOSED_PROVIDER = 'composed'
const COMPOSED_MODEL = 'composed-model'

/** The deployment default a switch restores, as the host's service answers it. */
function deploymentDefault(reasoningEffort?: string) {
  return {
    currentSelection: () => ({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }),
  }
}

/** One durable model selection, as the host's projection carries it. */
interface FoldedSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The host's `modelSelection` fold state. */
interface FoldedState {
  lastUsed: FoldedSelection | null
  pending: FoldedSelection | null
}

/** Field-wise selection equality, the host's own rule. */
function sameSelection(left: FoldedSelection | null, right: FoldedSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort)
}

/**
 * The host's session-projection registry, with the two units this suite needs
 * beyond the harness loop's own.
 *
 * `@deepseek-ai/dsh-api-session-controller` owns the `modelSelection` and
 * `sessionListMetadata` projections and is not a dependency of this package, so
 * both folds are reproduced here from the host's source —
 * `packages/api/session-controller/src/model-selection-projection.ts` and
 * `src/list.ts` `applySessionListMetadata`. That is what makes "the harness's own
 * event, folded by the host" the thing under test rather than a fixture's private
 * state: the writes' idempotence is a statement about the first fold (a
 * `model/selection` stays pending until a matching `request/header` consumes it),
 * and the claim that they leave a session BLANK is a statement about the second
 * (`blank` is cleared by `turn/start` alone).
 * @param ctx - context the fold's `session/event` subscription belongs to.
 * @returns a `sessionProjections`-shaped service.
 */
function hostProjections(ctx: Context) {
  const projections = fakeSessionProjections(ctx)
  projections.register({
    key: 'modelSelection',
    init: (): FoldedState => ({ lastUsed: null, pending: null }),
    apply: (state: FoldedState, event: SessionEvent): FoldedState => {
      if (event.type === 'model/selection') {
        return sameSelection(state.pending, event.data)
          ? state
          : { lastUsed: state.lastUsed, pending: event.data }
      }
      if (event.type !== 'request/header') return state
      const lastUsed: FoldedSelection = {
        provider: event.data.header.config.provider,
        model: event.data.header.config.model,
        ...event.data.header.config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: String(event.data.header.config.reasoningEffort) },
      }
      const pending = sameSelection(state.pending, lastUsed) ? null : state.pending
      return sameSelection(state.lastUsed, lastUsed) && pending === state.pending
        ? state
        : { lastUsed, pending }
    },
  })
  projections.register({
    key: 'sessionListMetadata',
    init: (): ListMetadata => ({ blank: true, lastPromptAt: null }),
    apply: applySessionListMetadata,
  })
  return projections
}

/** The host's `sessionListMetadata` projection state (`list.ts`). */
interface ListMetadata {
  /** Whether the session log carries no `turn/start` yet. */
  blank: boolean
  /** Commit time of the newest user message, or null. */
  lastPromptAt: number | null
}

/**
 * Advance the host's list-metadata projection by one committed event, verbatim
 * from `packages/api/session-controller/src/list.ts:46-57`.
 *
 * The blank bit is the derivation this suite's writes have to leave alone: a
 * session stays blank — and therefore stays swappable between presets, and stays
 * rendered as a fresh conversation — until a `turn/start` is committed. Nothing
 * else clears it, `model/selection` least of all.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
function applySessionListMetadata(state: ListMetadata, event: SessionEvent): ListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/** One booted plugin plus the warnings its own sink reported. */
interface App {
  readonly ctx: Context
  /** Every plugin warning, in order. */
  readonly warnings: string[]
}

/** The one warning this suite's subject is allowed to report, at most once. */
function resetWarnings(app: App): string[] {
  return app.warnings.filter(message => message.includes('cannot be given a real model selection'))
}

/** The one report the plugin owes when the SAVED deployment default names an engine route. */
function hostedDefaultWarnings(app: App): string[] {
  return app.warnings.filter(message => message.includes('is the hosted engine route'))
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-model-reset-'))
  cleanups.push(async () => {
    // Renaming a just-written file can leave the Windows directory entry stale;
    // Node's built-in retry handles ENOTEMPTY/EBUSY/EPERM.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/**
 * Boot the services the plugin's composition assumes, then mount the plugin.
 *
 * A fresh `$DSH_HOME` is stubbed per test, so the engine record the switch
 * writes and the presets `apply` authors land in the test's temp directory
 * instead of the developer's real `~/.dsh`.
 *
 * The deployment's own COMPOSED default model is registered as a real settings
 * namespace carrying a `base` layer, because that is how a real profile carries
 * it: the base bundle composes the `agent-default-model` row with its provider
 * and model (`packages/bundle/base/cordis.patch.yml`), which is what makes the
 * settings descriptor carry the `base` layer the plugin falls back to.
 * Registering the section makes that layer real rather than fabricated, while
 * the resolved default a session reads is still the `agentDefaultModel` service
 * this fixture provides.
 * @param opts - the default-model service to compose (`'missing'` for a
 *   deployment whose profile composes none), and the model its own composition
 *   declares (`'none'` for a profile that declares no such row at all).
 * @returns the booted plugin and its warning sink.
 */
async function boot(opts: {
  defaultModel?: object | 'missing'
  composed?: { provider: string; model: string; reasoningEffort?: string } | 'none'
  settings?: 'missing'
} = {}): Promise<App> {
  vi.stubEnv('DSH_HOME', await tempDir())
  const ctx = new Context()
  // Unload the whole root last, so every service and fiber this test composed is
  // torn down instead of leaving a `process` exit listener per test behind.
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  // The real durability backend: the sessions below own a real write handle.
  await ctx.plugin(JsonlSessionPersistence, { root: await tempDir() })
  ctx.provide('sessionProjections', hostProjections(ctx))
  ctx.provide('tools', fakeToolRuntime())
  if (opts.defaultModel !== 'missing') {
    ctx.provide('agentDefaultModel', opts.defaultModel ?? deploymentDefault())
  }

  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message))
  })

  if (opts.settings !== 'missing') {
    const settings = installFakeSettings(ctx)
    // A profile that declares no such composition row registers nothing here.
    if (opts.composed !== 'none') {
      settings.register(AGENT_DEFAULT_MODEL_NS, {
        base: opts.composed ?? { provider: COMPOSED_PROVIDER, model: COMPOSED_MODEL },
      })
    }
  }

  // The plugin's own live Config fields: a minimal profile supplies both, and
  // `in-process` is the composed default.
  const live = createLiveLoopConfig(ctx, { engine: 'in-process' })
  const config: Config = { patchPath: join(await tempDir(), 'cordis.patch.yml'), ...live.config }
  const fiber = ctx.plugin({
    name: 'loop-engine-under-test',
    apply: (pluginCtx: Context) => { apply(pluginCtx, config) },
  })
  await fiber
  cleanups.push(async () => { await fiber.dispose() })
  // The router claims the single `agentLoop` name; the plugin's inject gate
  // defers that registration by a tick, so wait for the service to appear.
  await vi.waitFor(() => { expect(ctx.get('agentLoop')).toBeDefined() })
  return { ctx, warnings }
}

/**
 * The plugin's own Remote endpoint, exactly as the browser half reaches it.
 * @param app - the booted plugin.
 * @param sessionId - the session to switch.
 * @param engine - the engine to switch it to.
 * @returns the endpoint's answer.
 */
function select(app: App, sessionId: string, engine: string): Promise<LoopEngineSelectResult> {
  const remote = app.ctx.get('loopEngine') as {
    select(request: { sessionId: string; engine: string }): Promise<LoopEngineSelectResult>
  }
  return remote.select({ sessionId, engine })
}

/** One live session on a hosted engine, plus its real Session object. */
interface HostedSession {
  readonly handle: AgentHandle
  readonly session: Session
}

/**
 * Create one session on a hosted engine's preset, through the agent registry —
 * i.e. through the router, which routes it to that engine's real runtime.
 * @param app - the booted plugin.
 * @param sessionId - the session identity to create.
 * @returns the published handle and the session the engine now drives.
 */
async function createHostedSession(app: App, sessionId: string): Promise<HostedSession> {
  const handle = await app.ctx.agents.create({
    sessionId: SessionId(sessionId),
    meta: { agentPreset: enginePresetId('kimi') },
  })
  const session = app.ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) throw new Error(`session "${sessionId}" was not entered by its engine`)
  return { handle, session }
}

/**
 * Log the request header the session's engine writes for it.
 *
 * The engine writes this header on the first step of its first turn
 * (`src/engine-kimi/agent.ts` `assertRequestHeader`), so a session that has not
 * run one carries none — logging it here is the fixture's stand-in for that
 * turn, and it is the exact event the host derives a session's model selection
 * from.
 * @param session - the session whose header to log.
 */
function logEngineHeader(session: Session, provider: string = ENGINE_LABEL): void {
  session.append('request/header', {
    header: canonicalHeader({ config: { provider, model: ENGINE_MODEL } }),
    reason: 'initial',
  })
}

/** Every `model/selection` event this session's log carries, in order. */
function selections(session: Session): SessionEvent<'model/selection'>[] {
  return session.snapshotEvents()
    .filter((event): event is SessionEvent<'model/selection'> => event.type === 'model/selection')
}

describe('a session switched back onto the harness loop', () => {
  it('restores the deployment default instead of the engine label it was selecting', async () => {
    const app = await boot({ defaultModel: deploymentDefault('high') })
    const { handle, session } = await createHostedSession(app, 'kimi-session')
    logEngineHeader(session)

    const result = await select(app, 'kimi-session', 'in-process')

    // The engine change lands the same way every switch involving the harness
    // loop does: the agent is released and the page told to reload, so the
    // session's next build is what runs in-process.
    expect(result).toEqual({ ok: true, engine: 'in-process', reload: true })
    expect(app.ctx.agents.get(SessionId('kimi-session'))).toBeUndefined()
    // Two writes: the seat the session was CREATED with, then the one this
    // switch hands the harness loop. The last is what the host's next build
    // installs.
    const logged = selections(session).map(event => event.data)
    expect(logged).toEqual([
      { provider: ENGINE_LABEL, model: HOSTED_DEFAULT_MODEL },
      { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, reasoningEffort: 'high' },
    ])
    // The selection the switch wrote is not a hosted route: those are served
    // only by this plugin's placeholder, and a real model call to one fails
    // loud.
    expect(isHostedProviderRoute(logged[1]!.provider)).toBe(false)
    expect(pendingSelection(app, session)).toEqual({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      reasoningEffort: 'high',
    })
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })

  it('does not log a second selection when the session already selects the default', async () => {
    const app = await boot()
    // A session on the harness loop, which is where a switch to in-process leaves
    // one: picking in-process here is a no-op that is still RECORDED (it is the
    // user's explicit choice), and the first pick hands it the deployment default.
    const handle = await app.ctx.agents.create({
      sessionId: SessionId('plain-idempotent'),
      meta: { agentPreset: SOURCE_PRESET_ID },
    })
    const session = app.ctx.sessions.get(SessionId('plain-idempotent'))!
    expect(session.requestHeader()).toBeUndefined()

    const first = await select(app, 'plain-idempotent', 'in-process')
    expect(first).toEqual({ ok: true, engine: 'in-process' })
    expect(selections(session)).toHaveLength(1)

    // The same pick again walks the very same path and finds the session already
    // selecting the deployment default — from the log's own pending selection,
    // which is what the host reads back for it.
    const again = await select(app, 'plain-idempotent', 'in-process')

    expect(again).toEqual({ ok: true, engine: 'in-process' })
    expect(selections(session)).toHaveLength(1)
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })

  it('writes the deployment default for a session whose engine never logged a header', async () => {
    const app = await boot()
    const { handle, session } = await createHostedSession(app, 'kimi-blank')
    // A session switched before its engine ever made a request: the only
    // selection in this log is the seat the session was CREATED with, which the
    // harness loop cannot use — the label is served only by this plugin's
    // placeholder route.
    expect(session.requestHeader()).toBeUndefined()

    await select(app, 'kimi-blank', 'in-process')

    expect(selections(session).map(event => event.data)).toEqual([
      { provider: ENGINE_LABEL, model: HOSTED_DEFAULT_MODEL },
      { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    ])

    await handle.dispose()
  })

  it('restores the default through the harness preset picker as well', async () => {
    const app = await boot()
    // The preset channel only moves a session that has run no turn, so this is a
    // blank session whose engine maps away from the harness loop.
    const { handle, session } = await createHostedSession(app, 'mirror-session')

    app.ctx.emit('agent-preset/selected', SessionId('mirror-session'), SOURCE_PRESET_ID)

    // The engine's seat first (its build), then the deployment default (this
    // switch) — the same write the picker's own entry point makes, in the same
    // place, before the release that detaches the agent.
    expect(selections(session).map(event => event.data)).toEqual([
      { provider: ENGINE_LABEL, model: HOSTED_DEFAULT_MODEL },
      { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    ])
    expect(resetWarnings(app)).toEqual([])
    // The release that follows the reset drops the agent, so the host's next
    // resolve rebuilds the session — now on the harness loop.
    await vi.waitFor(() => {
      expect(app.ctx.agents.get(SessionId('mirror-session'))).toBeUndefined()
    })

    await handle.dispose()
  })
})

describe('a new session on a hosted engine', () => {
  it('starts on the engine\'s own seat, written before the host installs a selection', async () => {
    const app = await boot()
    const installed: unknown[] = []
    const handle = await app.ctx.agents.create({
      sessionId: SessionId('kimi-new'),
      meta: { agentPreset: enginePresetId('kimi') },
      // The host's own composition installs the session's model selection from
      // inside setup (`ApiSessionAgentController.composeAgent` →
      // `installSelection` → `selectionFor`), and that read takes the log's
      // pending `model/selection` — so a write landing after it would change
      // nothing, and what the installer sees here is what the agent starts on.
      setup: (_agentCtx: Context, agent: Agent) => { installed.push(pendingSelection(app, agent.session)) },
    })
    const session = app.ctx.sessions.get(SessionId('kimi-new'))!

    // The seat the engine owns, in the log and in the installer's hands alike.
    const seat = { provider: ENGINE_LABEL, model: HOSTED_DEFAULT_MODEL }
    expect(installed).toEqual([seat])
    expect(selections(session).map(event => event.data)).toEqual([seat])
    expect(pendingSelection(app, session)).toEqual(seat)
    // And the engine is handed the same answer as `agentOptions`, so the two
    // facts about this session's route cannot disagree.
    expect(handle.agent.options).toEqual(seat)

    await handle.dispose()
  })

  it('leaves a session whose log already names a real model alone', async () => {
    const app = await boot()
    // A session created with a real selection already in its log — the shape a
    // host-configured agent is created from. Nothing about the engine it runs
    // makes that explicit pick wrong, so the build writes no second seat.
    const handle = await app.ctx.agents.create({
      sessionId: SessionId('kimi-seeded'),
      meta: { agentPreset: enginePresetId('kimi') },
      seed: [{
        type: 'model/selection',
        seq: SessionSeq(0),
        time: 1,
        data: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
      }],
    })
    const session = app.ctx.sessions.get(SessionId('kimi-seeded'))!

    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }])
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })

  it('leaves it BLANK: only a turn/start clears that bit', async () => {
    const app = await boot()
    const { handle, session } = await createHostedSession(app, 'kimi-blank-bit')
    // The seat is written (asserted above), so this is the question the write
    // raises: does a `model/selection` make the session "started"? Both facts the
    // host derives from a fresh session say no.
    expect(listMetadata(app, session).blank).toBe(true)
    // The harness's own turn boundary — the projection unit the router registers
    // (`@deepseek-ai/dsh-agent-loop`), which is what the preset roster's
    // `agent-preset/locked` check reads (`packages/preset/agent-presets/src/
    // index.ts` `swap`) — is equally untouched.
    expect(turnBoundary(app, session)).toEqual({
      openTurnStartSeq: null,
      lastStepStartSeq: null,
      lastStepBoundary: null,
      lastTurn: 0,
    })

    // A turn is what clears the bit, for both facts. The preset roster's check is
    // `openTurnStartSeq !== null || lastTurn > 0`, so this is the exact state it
    // refuses on.
    session.append('turn/start', { turn: 1 })
    expect(listMetadata(app, session).blank).toBe(false)
    expect(turnBoundary(app, session)).toMatchObject({ lastTurn: 1 })
    expect(turnBoundary(app, session)?.openTurnStartSeq).not.toBeNull()

    await handle.dispose()
  })
})

describe('a session switched between hosted engines', () => {
  it('keeps the one shared seat: the incoming engine logs the same route, so nothing is appended', async () => {
    const app = await boot()
    const { handle, session } = await createHostedSession(app, 'kimi-to-claude')

    const result = await select(app, 'kimi-to-claude', 'claude-code')

    // Hosted-to-hosted is the in-place swap: the session keeps its `Session`
    // object and there is no reload to ask for.
    expect(result).toEqual({ ok: true, engine: 'claude-code' })
    // The seat does NOT move: every hosted engine selects the same route, so
    // the `external/default` the session was created with already IS the
    // incoming engine's seat. Re-appending it would only grow the log on every
    // swap between hosted engines.
    const seat = { provider: ENGINE_LABEL, model: HOSTED_DEFAULT_MODEL }
    expect(selections(session).map(event => event.data)).toEqual([seat])
    expect(pendingSelection(app, session)).toEqual(seat)
    // The swap really landed on the session the switch named: the incoming
    // engine's agent drives the same Session object. Its `agentOptions` are the
    // recipe's — a swap replays how the session was BUILT, and this caller
    // composed none — while the log holds the seat above. No engine reads them;
    // the selection the host installs is the one in the log.
    const successor = app.ctx.agents.get(SessionId('kimi-to-claude'))!
    expect(successor).toBeInstanceOf(ClaudeCodeAgent)
    expect(successor.options).toEqual({})
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })

  it('leaves a real model selection alone', async () => {
    const app = await boot()
    const { handle, session } = await createHostedSession(app, 'kimi-real-model')
    // An explicit pick made while this session ran kimi: the model menu's own
    // event, which is a real route no engine label can improve on. The model
    // notice the browser half shows beside a hosted engine says exactly that —
    // the selection is inert there, not gone.
    session.append('model/selection', { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL })

    const result = await select(app, 'kimi-real-model', 'pi')

    expect(result).toEqual({ ok: true, engine: 'pi' })
    expect(selections(session).map(event => event.data)).toEqual([
      { provider: ENGINE_LABEL, model: HOSTED_DEFAULT_MODEL },
      { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    ])
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })

  it('does not write a second seat when the session already selects the engine it picks', async () => {
    const app = await boot()
    const { handle, session } = await createHostedSession(app, 'kimi-again')

    // Picking the engine the session already runs is recorded and left running,
    // and the seat it already carries is not appended a second time.
    const result = await select(app, 'kimi-again', 'kimi')

    expect(result).toEqual({ ok: true, engine: 'kimi' })
    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: ENGINE_LABEL, model: HOSTED_DEFAULT_MODEL }])
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })
})

describe('an engine change for a session this plugin never built', () => {
  it('writes nothing while the log names no selection, and the deployment default on the way to the harness loop', async () => {
    const app = await boot()
    // A session with nothing in its log — no seat, no header. Its engine was
    // never built by this plugin, so there is no seat for an engine change to
    // rewrite (the shape a session created before this plugin wrote seats has).
    // Driven through the writer itself, because the router cannot produce this
    // state: every build of a session on a hosted engine writes a seat.
    const session = app.ctx.sessions.prepare(SessionId('legacy'))
    const warnings: string[] = []
    const reset = new ModelSelectionReset(app.ctx, (message: string) => { warnings.push(message) })

    expect(reset.resetFor(session, 'kimi')).toBe(false)
    expect(selections(session)).toEqual([])

    // The harness loop's side is the one that has to land a real model in the
    // log: its next build reads the selection from there.
    expect(reset.resetFor(session, 'in-process')).toBe(true)
    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }])
    expect(warnings).toEqual([])
  })
})

describe('a session whose log selects a legacy per-engine provider label', () => {
  /** A session whose only selection is the header an earlier build logged. */
  function legacySession(app: App, id: string): Session {
    const session = app.ctx.sessions.prepare(SessionId(id))
    logEngineHeader(session, LEGACY_ENGINE_LABEL)
    return session
  }

  it('is still recognized as hosted, so a switch onto the harness loop resets it', async () => {
    const app = await boot()
    // A per-engine label (`kimi`) no adapter serves any more. If the plugin only
    // recognized the current `external` route, this session would keep selecting
    // `kimi` and the host would refuse its next turn with `model-unavailable`.
    const session = legacySession(app, 'legacy-label-reset')
    const reset = new ModelSelectionReset(app.ctx, () => {})

    expect(reset.resetFor(session, 'in-process')).toBe(true)
    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }])
  })

  it('is rewritten to the shared route when the session stays on a hosted engine', async () => {
    const app = await boot()
    const session = legacySession(app, 'legacy-label-rewrite')
    const reset = new ModelSelectionReset(app.ctx, () => {})

    expect(reset.resetFor(session, 'codex')).toBe(true)
    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: ENGINE_LABEL, model: HOSTED_DEFAULT_MODEL }])
  })

  it('is reset by the BUILD guard too, not only by a switch', async () => {
    const app = await boot()
    const session = legacySession(app, 'legacy-label-guard')
    const reset = new ModelSelectionReset(app.ctx, () => {})

    expect(reset.guardFor(session, 'in-process')).toBe(true)
    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }])
  })
})

describe('a deployment that cannot name a default model', () => {
  /** One unusable default-model service, and the warning it must produce. */
  type Unusable = readonly [what: string, service: object | 'missing', reported: string]

  it.each<Unusable>([
    ['composes none', 'missing', 'this deployment composes no agentDefaultModel service'],
    ['cannot answer', { currentSelection: () => { throw new Error('no default configured') } }, 'agentDefaultModel.currentSelection() failed: Error: no default configured'],
    ['answers nothing', { currentSelection: () => undefined }, 'agentDefaultModel.currentSelection() named no usable provider/model'],
    ['answers no provider', { currentSelection: () => ({ model: DEFAULT_MODEL }) }, 'agentDefaultModel.currentSelection() named no usable provider/model'],
    ['answers no model', { currentSelection: () => ({ provider: DEFAULT_PROVIDER }) }, 'agentDefaultModel.currentSelection() named no usable provider/model'],
  ])('switches anyway, with ONE warning, when its default-model service %s', async (_what, service, reported) => {
    const app = await boot({ defaultModel: service === 'missing' ? 'missing' : service })
    const first = await createHostedSession(app, 'no-default-first')
    const second = await createHostedSession(app, 'no-default-second')
    logEngineHeader(first.session)
    logEngineHeader(second.session)

    const one = await select(app, 'no-default-first', 'in-process')
    const two = await select(app, 'no-default-second', 'in-process')

    // The switch is the user's action and succeeds: a selection this plugin
    // cannot name is not a reason to refuse it.
    expect(one).toEqual({ ok: true, engine: 'in-process', reload: true })
    expect(two).toEqual({ ok: true, engine: 'in-process', reload: true })
    // Nothing was written by the switch, so each session keeps what its log
    // records — which is the seat its own engine's build put there, and no
    // second selection.
    const seat = { provider: ENGINE_LABEL, model: HOSTED_DEFAULT_MODEL }
    expect(selections(first.session).map(event => event.data)).toEqual([seat])
    expect(selections(second.session).map(event => event.data)).toEqual([seat])
    expect(resetWarnings(app)).toEqual([
      expect.stringContaining(`cannot be given a real model selection: ${reported}`),
    ])

    await first.handle.dispose()
    await second.handle.dispose()
  })
})

/** The pending `model/selection` the host's own install reads back for a session. */
function pendingSelection(app: App, session: Session): unknown {
  const projections = app.ctx.get('sessionProjections') as {
    stateOf(session: Session, key: string): { pending: unknown } | undefined
  }
  return projections.stateOf(session, 'modelSelection')?.pending ?? null
}

/** The host's list-metadata fold for one session — the `blank` bit a list renders. */
function listMetadata(app: App, session: Session): ListMetadata {
  const projections = app.ctx.get('sessionProjections') as {
    stateOf(session: Session, key: string): ListMetadata | undefined
  }
  const state = projections.stateOf(session, 'sessionListMetadata')
  if (state === undefined) throw new Error('the sessionListMetadata unit is not registered')
  return state
}

/** The harness loop's own turn-boundary fold — the preset lock's two fields. */
function turnBoundary(app: App, session: Session): Record<string, unknown> | undefined {
  const projections = app.ctx.get('sessionProjections') as {
    stateOf(session: Session, key: string): Record<string, unknown> | undefined
  }
  return projections.stateOf(session, 'turnBoundary')
}

/** One session created on the harness loop's preset, i.e. through the router. */
async function createInProcessSession(app: App, sessionId: string, setup?: (session: Session) => void) {
  const handle = await app.ctx.agents.create({
    sessionId: SessionId(sessionId),
    meta: { agentPreset: SOURCE_PRESET_ID },
    ...setup === undefined
      ? {}
      : {
        // The host's own composition installs the session's model selection from
        // inside setup (`ApiSessionAgentController.composeAgent` →
        // `installSelection`), so a spy here reads what it would install.
        setup: (_agentCtx: Context, agent: Agent) => { setup(agent.session) },
      },
  })
  const session = app.ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) throw new Error(`session "${sessionId}" was not entered`)
  return { handle, session }
}

describe('a session the harness loop is building', () => {
  it('hands the deployment default to a session the log says ran an engine, before the caller installs a selection', async () => {
    const app = await boot()
    // A session whose log records the engine's own placeholder route: its last
    // build ran a hosted engine, and the harness loop is building it again. The
    // host would read that header back as this session's selection.
    const started = await createInProcessSession(app, 'guard-recorded')
    // A request header is only meaningful inside a turn (the session format
    // enforces it on read), so the recorded engine request opens one first.
    started.session.append('turn/start', { turn: 1 })
    started.session.append('request/header', {
      header: canonicalHeader({ config: { provider: ENGINE_LABEL, model: ENGINE_MODEL } }),
      reason: 'initial',
    })
    await started.handle.dispose()

    const installed: unknown[] = []
    const handle = await app.ctx.agents.resume({
      resumeSessionId: SessionId('guard-recorded'),
      setup: (_agentCtx, agent) => { installed.push(pendingSelection(app, agent.session)) },
    })
    const session = app.ctx.sessions.get(SessionId('guard-recorded'))!

    // The write is visible to the installer, which is the whole point of making
    // it inside the wrapped setup: the host reads the log's pending selection
    // there, and a write after that read would change nothing.
    expect(installed).toEqual([{ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }])
    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }])
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })

  it('leaves an ordinary session alone: a real selection is written for nobody', async () => {
    const app = await boot()
    const { handle, session } = await createInProcessSession(app, 'guard-ordinary')

    // A brand-new session selects the deployment default, which a real adapter
    // serves — so the plugin's only correct action is none at all.
    expect(selections(session)).toEqual([])
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })

  it('keeps the caller\'s loop options, which ARE the harness loop\'s route', async () => {
    const app = await boot()
    const installed: unknown[] = []
    // A brand-new session the harness loop drives: no write (see above), and the
    // `agentOptions` the caller composed stay exactly as they were — for this
    // engine they are not a mirror of a seat, they are the request route the loop
    // calls (`agent-loop/src/agent.ts` `prepareRequest`).
    const handle = await app.ctx.agents.create({
      sessionId: SessionId('plain-options'),
      meta: { agentPreset: SOURCE_PRESET_ID },
      agentOptions: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
      setup: (_agentCtx: Context, agent: Agent) => { installed.push(agent.options) },
    })
    const session = app.ctx.sessions.get(SessionId('plain-options'))!
    const options = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }

    expect(selections(session)).toEqual([])
    expect(installed).toEqual([options])
    expect(handle.agent.options).toEqual(options)
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })

  it('leaves a session whose log records a real model alone', async () => {
    const app = await boot()
    const { handle, session } = await createInProcessSession(app, 'guard-real-header')
    session.append('request/header', {
      header: canonicalHeader({ config: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL } }),
      reason: 'initial',
    })

    expect(selections(session)).toEqual([])

    await handle.dispose()
  })

  it('writes nothing, and reports once, when it cannot name a default at all', async () => {
    const app = await boot({ defaultModel: 'missing' })
    const first = await createInProcessSession(app, 'guard-no-default')
    const second = await createInProcessSession(app, 'guard-no-default-second')

    // Nothing is broken here (a session with no selection would fail later, on
    // the missing service itself), so the plugin writes nothing and says so once.
    expect(selections(first.session)).toEqual([])
    expect(selections(second.session)).toEqual([])
    expect(resetWarnings(app)).toEqual([
      expect.stringContaining('this deployment composes no agentDefaultModel service'),
    ])

    await first.handle.dispose()
    await second.handle.dispose()
  })
})

describe('a deployment default that names an engine route', () => {
  /** A deployment whose saved default is the label a pick made in the model menu wrote there. */
  const poisoned = () => ({ currentSelection: () => ({ provider: ENGINE_LABEL, model: ENGINE_MODEL }) })

  it('gives every session built on the harness loop the model its composition declares, reporting once', async () => {
    const app = await boot({ defaultModel: poisoned() })
    const first = await createInProcessSession(app, 'poisoned-first')
    const second = await createInProcessSession(app, 'poisoned-second')

    // `session.selectModel` saves the pick it was given as the deployment default
    // (`commands.ts` → `AgentDefaultModelConfig.saveSelection`), and a session
    // with nothing in its log reads exactly that. Handing it to the harness loop
    // would fail the session's first request on this plugin's own placeholder, so
    // the deployment's composed default replaces it.
    expect(selections(first.session).map(event => event.data))
      .toEqual([{ provider: COMPOSED_PROVIDER, model: COMPOSED_MODEL }])
    expect(selections(second.session).map(event => event.data))
      .toEqual([{ provider: COMPOSED_PROVIDER, model: COMPOSED_MODEL }])
    expect(hostedDefaultWarnings(app)).toEqual([
      expect.stringContaining(`the deployment default model is the hosted engine route "${ENGINE_LABEL}/${ENGINE_MODEL}"`),
    ])

    await first.handle.dispose()
    await second.handle.dispose()
  })

  it('drops an empty reasoning effort the composed default carries', async () => {
    const app = await boot({
      defaultModel: poisoned(),
      composed: { provider: COMPOSED_PROVIDER, model: COMPOSED_MODEL, reasoningEffort: '' },
    })
    const { handle, session } = await createInProcessSession(app, 'poisoned-empty-effort')

    // An empty effort means the provider's own default, not an empty one: the
    // written selection carries no effort at all.
    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: COMPOSED_PROVIDER, model: COMPOSED_MODEL }])

    await handle.dispose()
  })

  it('reports and writes nothing when the composition names an engine route too', async () => {
    const app = await boot({
      defaultModel: poisoned(),
      composed: { provider: LEGACY_ENGINE_LABEL, model: ENGINE_MODEL },
    })
    const { handle, session } = await createInProcessSession(app, 'poisoned-composed-hosted')

    expect(selections(session)).toEqual([])
    expect(hostedDefaultWarnings(app)).toEqual([
      expect.stringContaining('is the hosted engine route'),
    ])

    await handle.dispose()
  })

  it('reports and writes nothing when the composition names no usable model', async () => {
    const app = await boot({ defaultModel: poisoned(), composed: { provider: '', model: '' } })
    const { handle, session } = await createInProcessSession(app, 'poisoned-composed-empty')

    expect(selections(session)).toEqual([])
    expect(hostedDefaultWarnings(app)).toEqual([
      expect.stringContaining('is the hosted engine route'),
    ])

    await handle.dispose()
  })

  it('reports and writes nothing when the profile declares no such composition row', async () => {
    const app = await boot({ defaultModel: poisoned(), composed: 'none' })
    const { handle, session } = await createInProcessSession(app, 'poisoned-no-composed')

    expect(selections(session)).toEqual([])
    expect(hostedDefaultWarnings(app)).toEqual([
      expect.stringContaining('is the hosted engine route'),
    ])

    await handle.dispose()
  })

  it('reports and writes nothing when the settings service cannot enumerate its namespaces', async () => {
    const app = await boot({ defaultModel: poisoned() })
    // A provider that cannot enumerate namespaces is a composition the plugin's
    // own preset steering already handles (`index.ts` `mutatePresetDefault`):
    // here it only means the composed default cannot be read back.
    ;(app.ctx.get('settings') as unknown as { describe?: unknown }).describe = undefined
    const { handle, session } = await createInProcessSession(app, 'poisoned-opaque-settings')

    expect(selections(session)).toEqual([])
    expect(hostedDefaultWarnings(app)).toEqual([
      expect.stringContaining('is the hosted engine route'),
    ])

    await handle.dispose()
  })

  it('reports and writes nothing when the deployment composes no settings service', async () => {
    const app = await boot({ defaultModel: poisoned(), settings: 'missing' })
    const { handle, session } = await createInProcessSession(app, 'poisoned-no-settings')

    expect(selections(session)).toEqual([])
    expect(hostedDefaultWarnings(app)).toEqual([
      expect.stringContaining('is the hosted engine route'),
    ])

    await handle.dispose()
  })
})
