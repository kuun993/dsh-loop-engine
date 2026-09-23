/**
 * Model-selection-reset suite: a session switched back onto the harness loop
 * stops selecting its engine's provider label.
 *
 * The defect this pins: a session's model selection follows its ENGINE. Every
 * hosted engine logs its own provider label into the session's `request/header`
 * (`kimi` here), the host derives the session's selection from that header, and
 * the label is served only by this plugin's placeholder route — which fails loud
 * (`HOSTED_ENGINE_ROUTE`) the moment a real model call reaches it. A session
 * switched back to `in-process` does make real calls, so the switch has to hand
 * it back the deployment default, as the harness's own `model/selection` event.
 *
 * Real stack throughout: the real plugin composition (`apply`, the patch file,
 * the provider placeholders), the real `RouterLoop` behind its inject gate, the
 * real Remote endpoint the browser half calls, the real engines (Kimi Code as
 * the session's engine, Claude Code as the other hosted engine of a swap), real
 * Sessions with a real JSONL write handle, and the real per-session engine
 * record on disk. Only two host services are stand-ins, both for packages this
 * plugin does not depend on: the session-projection registry (whose
 * `modelSelection` fold is reproduced so the assertions are about the harness's
 * own event, not about a fixture) and the default-model service.
 *
 * @module tests/model-selection-reset
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, canonicalHeader, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { LoopEngineSelectResult } from '../src/agent-preset-ids.ts'
import { ClaudeCodeAgent } from '../src/engine-claude/agent.ts'
import { apply, type Config } from '../src/index.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../src/namespace.ts'
import { SOURCE_PRESET_ID, enginePresetId } from '../src/preset.ts'
import { HOSTED_PROVIDER_ROUTES } from '../src/provider-route.ts'
import { fakeSessionProjections } from './helpers/session-projections.ts'
import { fakeToolRuntime } from './helpers/tool-runtime.ts'

/** The provider route the session's engine label is: what has to be replaced. */
const ENGINE_LABEL = HOSTED_PROVIDER_ROUTES.kimi
/** The model label that engine logs, native to it and unknown to any adapter. */
const ENGINE_MODEL = 'kimi-code-native'
/** The deployment default the host gives a session without a selection. */
const DEFAULT_PROVIDER = 'deployment'
const DEFAULT_MODEL = 'deployment-model'

/**
 * In-memory settings provider, so the mount path runs the composition the web
 * profile runs and nothing reaches a real on-disk settings file.
 */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, doc?: Record<string, unknown>) {
    super(ctx)
    this.doc = structuredClone(doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

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
 * The host's session-projection registry, with the one unit this suite needs
 * beyond the harness loop's own.
 *
 * `@deepseek-ai/dsh-api-session-controller` owns the `modelSelection` projection
 * and is not a dependency of this package, so its fold is reproduced here —
 * `packages/api/session-controller/src/model-selection-projection.ts` — from the
 * host's source. It is what makes "the harness's own event, folded by the host"
 * the thing under test rather than a fixture's private state: the reset's
 * idempotence is a statement about this fold (a `model/selection` stays pending
 * until a matching `request/header` consumes it).
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
  return projections
}

/** One booted plugin plus the warnings its own sink reported. */
interface App {
  readonly ctx: Context
  /** Every plugin warning, in order. */
  readonly warnings: string[]
}

/** The one warning this suite's subject is allowed to report, at most once. */
function resetWarnings(app: App): string[] {
  return app.warnings.filter(message => message.includes('not restoring the model selection'))
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

const NS_BRANDED = LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL as SettingsNamespace

/**
 * Boot the services the plugin's composition assumes, then mount the plugin.
 *
 * A fresh `$DSH_HOME` is stubbed per test, so the engine record the switch
 * writes and the presets `apply` authors land in the test's temp directory
 * instead of the developer's real `~/.dsh`.
 * @param opts - the default-model service to compose, or `'missing'` for a
 *   deployment whose profile composes none.
 * @returns the booted plugin and its warning sink.
 */
async function boot(opts: { defaultModel?: object | 'missing' } = {}): Promise<App> {
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

  const settingsFiber = ctx.plugin(MemorySettings, { [NS_BRANDED]: { engine: 'in-process' } })
  await settingsFiber
  cleanups.push(async () => { await settingsFiber.dispose() })

  const config: Config = { patchPath: join(await tempDir(), 'cordis.patch.yml') }
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
function logEngineHeader(session: Session): void {
  session.append('request/header', {
    header: canonicalHeader({ config: { provider: ENGINE_LABEL, model: ENGINE_MODEL } }),
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
    const logged = selections(session)
    expect(logged).toHaveLength(1)
    expect(logged[0]!.data).toEqual({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, reasoningEffort: 'high' })
    // Not one of the four engine labels: those are served only by this plugin's
    // placeholder route, and a real model call to one fails loud.
    expect(Object.values(HOSTED_PROVIDER_ROUTES)).not.toContain(logged[0]!.data.provider)
    expect(resetWarnings(app)).toEqual([])

    await handle.dispose()
  })

  it('leaves the model selection alone when the switch targets a hosted engine', async () => {
    const app = await boot()
    const { handle, session } = await createHostedSession(app, 'kimi-to-claude')
    logEngineHeader(session)

    const result = await select(app, 'kimi-to-claude', 'claude-code')

    // Hosted-to-hosted is the in-place swap, and it is NOT a transition the
    // plugin may write a model selection for: the incoming engine owns its model
    // natively and logs its own label into the next header. It is also the one
    // switch that moves the session without releasing it, so there is no reload
    // to ask for.
    expect(result).toEqual({ ok: true, engine: 'claude-code' })
    expect(selections(session)).toEqual([])
    // The swap really landed on the session the switch named: the incoming
    // engine's agent drives the same Session object, and still nothing wrote a
    // model selection for it.
    expect(app.ctx.agents.get(SessionId('kimi-to-claude'))).toBeInstanceOf(ClaudeCodeAgent)
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

  it('gives a session that logged no header at all the deployment default', async () => {
    const app = await boot()
    const { handle, session } = await createHostedSession(app, 'kimi-blank')
    // A session switched before its engine ever made a request: nothing in this
    // log names a model the harness loop could use.
    expect(session.requestHeader()).toBeUndefined()

    await select(app, 'kimi-blank', 'in-process')

    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }])

    await handle.dispose()
  })

  it('restores the default through the harness preset picker as well', async () => {
    const app = await boot()
    // The preset channel only moves a session that has run no turn, so this is a
    // blank session whose engine maps away from the harness loop.
    const { handle, session } = await createHostedSession(app, 'mirror-session')

    app.ctx.emit('agent-preset/selected', SessionId('mirror-session'), SOURCE_PRESET_ID)

    expect(selections(session).map(event => event.data))
      .toEqual([{ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }])
    expect(resetWarnings(app)).toEqual([])
    // The release that follows the reset drops the agent, so the host's next
    // resolve rebuilds the session — now on the harness loop.
    await vi.waitFor(() => {
      expect(app.ctx.agents.get(SessionId('mirror-session'))).toBeUndefined()
    })

    await handle.dispose()
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
    // Nothing was written, so each session keeps what its log records.
    expect(selections(first.session)).toEqual([])
    expect(selections(second.session)).toEqual([])
    expect(resetWarnings(app)).toEqual([
      expect.stringContaining(`not restoring the model selection of sessions switched to in-process: ${reported}`),
    ])

    await first.handle.dispose()
    await second.handle.dispose()
  })
})
