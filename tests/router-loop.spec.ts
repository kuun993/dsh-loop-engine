/**
 * Router-loop suite: the single process-wide `AgentFactory`, the per-session
 * engine resolution that reads the agent preset, create/resume routing, the
 * live-session ledger, and the blank-session engine switch.
 *
 * The other node-half suites drive real engines through the whole plugin; this
 * one pins the router itself. Every hosted engine is therefore a fake
 * {@link HostedEngineRuntime} whose create/resume are recorded, because that is
 * the router's entire contract with an engine: it calls one of those two entry
 * points, reads `agent.id`/`agent.session` back, and disposes the handle. The
 * engine-surface bridge is mocked for the same reason — what it registers needs
 * a real agent scope and is covered where one exists (`tests/index.spec.ts`,
 * the per-engine suites); here only the router's decision to call it matters.
 *
 * @module tests/router-loop
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { RouterLoop, type RouterEngine } from '../src/router-loop.ts'
import { HostedEngineRuntime, type HostedAgent } from '../src/driver-core/hosted-engine-runtime.ts'
import { registerEngineSurface } from '../src/engine-surface.ts'
import { enginePresetId, SOURCE_PRESET_ID } from '../src/preset.ts'
import type { HostedEngineId, LoopEngineId } from '../src/settings.ts'

vi.mock('../src/engine-surface.ts', () => ({ registerEngineSurface: vi.fn() }))

const registerSurface = vi.mocked(registerEngineSurface)

beforeEach(() => {
  // The module mock outlives each test; its history does not.
  registerSurface.mockClear()
})

/** A managed preset, i.e. one this plugin owns and maps to a hosted engine. */
const CODEX = enginePresetId('codex')
const KIMI = enginePresetId('kimi')

/** A preset the plugin does not own: a deployment-authored composition. */
const UNOWNED = 'deployment-preset'

/** The deployment default a switch back onto the harness loop restores. */
const DEFAULT_PROVIDER = 'deployment'
const DEFAULT_MODEL = 'deployment-model'

/** Production ctx key of each engine runtime, as `HostedEngineRuntime` publishes it. */
const ENGINE_LABELS: Readonly<Record<HostedEngineId, string>> = {
  'claude-code': 'agentLoopClaudeCode',
  codex: 'agentLoopCodex',
  pi: 'agentLoopPi',
  kimi: 'agentLoopKimi',
}

/**
 * One hosted engine's runtime with its transaction machinery replaced by
 * recorders. The router never sees past `createAgent`/`resume` and the handle
 * they return, so nothing below that line needs a driver, a subprocess, or a
 * session registry.
 */
class FakeEngine extends HostedEngineRuntime<object, HostedAgent> {
  /** Ids the router created on this engine, in order. */
  readonly created: string[] = []
  /** Ids the router resumed on this engine, in order. */
  readonly resumed: string[] = []
  /** Ids whose published handle was disposed, in order. */
  readonly disposed: string[] = []
  /** Agents handed out, in handle order. */
  readonly agents: HostedAgent[] = []
  /** Rejection the published handle's dispose reports, when set. */
  disposeFailure: Error | undefined
  /** Runs inside the published handle's dispose, before it settles. */
  onDispose: ((id: string) => void) | undefined

  constructor(ctx: Context, label: string) {
    super(ctx, label, {})
  }

  protected override buildAgent(): HostedAgent {
    throw new Error('the fake engine runtime never builds a driver')
  }

  override async createAgent(_ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const id = String(options.sessionId)
    this.created.push(id)
    return this.publish(id)
  }

  override async resume(_ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const id = String(options.resumeSessionId)
    this.resumed.push(id)
    return this.publish(id)
  }

  /** Publish one agent under `id` with the teardown the router adopts. */
  private publish(id: string): AgentHandle {
    // Only `id` and `session` are ever read back: the ledger keys on the former
    // and hands the latter to the turn-boundary projection and to the
    // model-selection reset (`src/model-selection-reset.ts`), which reads the
    // session's own header and appends the deployment default to it. A REAL
    // detached Session is therefore what a hosted engine publishes here — a
    // stand-in carrying only an id would fail the reset's first read.
    const agent = {
      id,
      session: this.runtime.ctx.sessions.prepare(SessionId(id)),
    } as unknown as HostedAgent
    this.agents.push(agent)
    return {
      agent,
      dispose: async () => {
        this.disposed.push(id)
        this.onDispose?.(id)
        if (this.disposeFailure !== undefined) throw this.disposeFailure
      },
    }
  }
}

/** A parent agent stand-in: `engineFor` reads nothing but its id. */
function parentAgent(id: string): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

/** One session's projection snapshot as the observation lease carries it. */
interface LeaseProjections {
  readonly values: { readonly agentPreset?: string | null }
}

/** The observation lease `ctx.sessionQuery` hands the router. */
interface Lease {
  readonly projections: LeaseProjections | undefined
  [Symbol.dispose](): void
}

/** The slice of `ctx.sessionQuery` this router reads, with recording. */
interface FakeQuery {
  /** Snapshots to serve, keyed by session id; an absent id reads as no projections. */
  readonly presets: Map<string, LeaseProjections>
  readonly observeSession: ReturnType<typeof vi.fn>
  /** The lease's `[Symbol.dispose]`, as the router's `using` releases it. */
  readonly dispose: ReturnType<typeof vi.fn>
  /** The service installed as `ctx.sessionQuery`. */
  readonly service: { observeSession: unknown }
}

function fakeQuery(): FakeQuery {
  const presets = new Map<string, LeaseProjections>()
  const dispose = vi.fn()
  const observeSession = vi.fn(
    async (sessionId: SessionId, _options: { projectionMode: 'all' | 'none' }): Promise<Lease> => ({
      projections: presets.get(String(sessionId)),
      [Symbol.dispose]: dispose,
    }),
  )
  return { presets, observeSession, dispose, service: { observeSession } }
}

/**
 * The host session-projection registry the harness loop folds its own units
 * through, plus the turn-boundary read the router makes. Registrations are
 * recorded and a session's cell folds to the definition's `init`, which is all
 * the loop reads back before a turn runs; `stateOf` is a spy so a test can pin
 * one read to a boundary the default can never produce.
 */
function fakeProjections() {
  const definitions = new Map<string, { init: () => unknown }>()
  return {
    register: vi.fn((definition: { key: string; init: () => unknown }) => {
      definitions.set(definition.key, definition)
      return () => { definitions.delete(definition.key) }
    }),
    stateOf: vi.fn((_session: object, key: string): unknown => definitions.get(key)?.init()),
  }
}

type FakeProjections = ReturnType<typeof fakeProjections>

/**
 * The plugin's own per-session engine record, in memory. The router reads it
 * before every preset-derived answer and writes it when a session is moved, so
 * a test can hand it exact pre-existing records and assert what was written.
 */
function fakeRecords() {
  const entries = new Map<string, LoopEngineId>()
  return {
    /** The records the router sees, keyed by session id. */
    entries,
    engineOf: (sessionId: SessionId): LoopEngineId | undefined => entries.get(String(sessionId)),
    record: (sessionId: SessionId, engine: LoopEngineId): void => { entries.set(String(sessionId), engine) },
  }
}

type FakeRecords = ReturnType<typeof fakeRecords>

/** One booted router plus the fixtures a test asserts against. */
interface App {
  readonly ctx: Context
  readonly projections: FakeProjections
  readonly query: FakeQuery | undefined
  readonly build: ReturnType<typeof vi.fn<(engine: HostedEngineId) => RouterEngine>>
  readonly records: FakeRecords
  readonly warn: ReturnType<typeof vi.fn<(message: string) => void>>
  /** Engines the router built, keyed by engine id. */
  readonly engines: Map<HostedEngineId, FakeEngine>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-router-'))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/**
 * Boot the services the harness loop needs, install the fixtures the router
 * reads, and mount the router on top of them — the composition the plugin's
 * inject gate performs, without the patch file and preset authoring around it.
 *
 * The router is mounted through a plugin fiber declaring the same injects the
 * plugin does, because `AgentLoop`'s constructor reaches its services through
 * `ctx` accessors, which only resolve on an inject-scoped context.
 *
 * @param opts - `query: false` leaves `sessionQuery` uncomposed; `persistence`
 *   mounts the real JSONL backend so an in-process resume has a log to load.
 * @returns the booted router and its fixtures.
 */
async function boot(
  opts: { query?: boolean; persistence?: boolean; records?: FakeRecords } = {},
): Promise<App> {
  // The persistence root is claimed first so its cleanup runs LAST: the backend
  // is still attached to the context while that context unloads.
  const root = opts.persistence === true ? await tempDir() : undefined
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  const projections = fakeProjections()
  ctx.provide('sessionProjections', projections)
  // The deployment default a switch back onto the harness loop restores
  // (`src/model-selection-reset.ts`). A real profile always composes this
  // service, so the router's switches must not report its absence as trouble.
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }) })
  const query = opts.query === false ? undefined : fakeQuery()
  if (query !== undefined) ctx.provide('sessionQuery', query.service)
  if (root !== undefined) await ctx.plugin(JsonlSessionPersistence, { root })

  const records = opts.records ?? fakeRecords()
  const engines = new Map<HostedEngineId, FakeEngine>()
  const build = vi.fn((engine: HostedEngineId): RouterEngine => {
    const runtime = new FakeEngine(ctx, ENGINE_LABELS[engine])
    engines.set(engine, runtime)
    return runtime
  })
  const warn = vi.fn()
  const fiber = ctx.plugin({
    name: 'loop-engine-router-under-test',
    inject: ['agents', 'sessions', 'systemPrompt', 'sessionProjections'],
    apply: (routerCtx: Context) => { new RouterLoop(routerCtx, build, records, warn) },
  })
  await fiber
  cleanups.push(async () => { await fiber.dispose() })
  await vi.waitFor(() => { expect(ctx.get('agentLoop')).toBeDefined() })
  return { ctx, projections, query, build, records, warn, engines }
}

/** Announce one committed preset change the way the preset roster does. */
function selectPreset(ctx: Context, sessionId: string, preset: string): void {
  ctx.emit('agent-preset/selected', SessionId(sessionId), preset)
}

/** Create one session through the registry, i.e. through the router. */
function createSession(app: App, sessionId: string, agentPreset?: string): Promise<AgentHandle> {
  return app.ctx.agents.create({
    sessionId: SessionId(sessionId),
    ...agentPreset === undefined ? {} : { meta: { agentPreset } },
  })
}

/** One closed turn, as a persisted log carries it. */
const SEED: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

/**
 * Store one closed turn under `sessionId` in the mounted backend.
 *
 * A session only materializes once it has events to write: the router's create
 * path stores the header plus whatever the session already carries, so an agent
 * that never ran a turn leaves nothing to open. Seeding through a write handle
 * is how a resumable session exists here without driving a turn.
 */
async function storeSession(app: App, sessionId: string): Promise<void> {
  const session = app.ctx.sessions.prepare(SessionId(sessionId), { seed: SEED })
  const handle = await app.ctx.sessionPersistence.create(session.header, {
    inheritedEventCount: session.inheritedEventCount,
  })
  await handle.append(session.snapshotEvents())
  await handle.close()
}

describe('create routing', () => {
  it('routes each managed preset to its engine and serves everything else from the harness loop', async () => {
    const app = await boot()

    const onCodex = await createSession(app, 'codex-session', CODEX)
    expect(app.build.mock.calls).toEqual([['codex']])
    const codex = app.engines.get('codex')!
    expect(codex.created).toEqual(['codex-session'])
    // The published handle wraps the ENGINE's agent, not one the harness loop
    // built: the router is a pure dispatcher.
    expect(onCodex.agent).toBe(codex.agents[0])

    const onKimi = await createSession(app, 'kimi-session', KIMI)
    expect(app.build.mock.calls).toEqual([['codex'], ['kimi']])
    expect(app.engines.get('kimi')!.created).toEqual(['kimi-session'])
    expect(onKimi.agent).toBe(app.engines.get('kimi')!.agents[0])

    // A standard, deployment-authored, or absent preset names no hosted engine,
    // so every one of them runs on the loop the router extends — and no engine
    // runtime is built on their behalf.
    const standard = await createSession(app, 'standard-session', SOURCE_PRESET_ID)
    const unowned = await createSession(app, 'unowned-session', UNOWNED)
    const absent = await createSession(app, 'absent-session')
    expect([standard.agent.status, unowned.agent.status, absent.agent.status]).toEqual(['idle', 'idle', 'idle'])
    expect(app.build.mock.calls).toEqual([['codex'], ['kimi']])
    // An owned preset resolves without consulting the session query at all.
    expect(app.query!.observeSession).not.toHaveBeenCalled()

    for (const handle of [onCodex, onKimi, standard, unowned, absent]) await handle.dispose()
  })

  it('memoizes one runtime per engine across sessions', async () => {
    const app = await boot()

    const first = await createSession(app, 'kimi-first', KIMI)
    const second = await createSession(app, 'kimi-second', KIMI)

    // One runtime built for the engine, however many sessions it serves:
    // concurrency is the engine's, and a second factory slot per session is
    // something the harness does not have.
    expect(app.build.mock.calls).toEqual([['kimi']])
    expect(app.engines.get('kimi')!.created).toEqual(['kimi-first', 'kimi-second'])
    expect(app.ctx.get('agentLoopKimi')).toBe(app.engines.get('kimi'))

    await first.dispose()
    await second.dispose()
  })

  it('inherits the engine of the session an agent was delegated from', async () => {
    const app = await boot()
    // The child's own preset is deployment-authored, so its engine can only
    // come from the parent session it was delegated from.
    app.query!.presets.set('parent-session', { values: { agentPreset: CODEX } })

    const handle = await app.ctx.agents.create({
      sessionId: SessionId('child-session'),
      meta: { agentPreset: UNOWNED },
      parentAgent: parentAgent('parent-session'),
    })

    expect(app.query!.observeSession).toHaveBeenCalledWith(SessionId('parent-session'), { projectionMode: 'all' })
    expect(app.query!.dispose).toHaveBeenCalledTimes(1)
    expect(app.build.mock.calls).toEqual([['codex']])
    expect(app.engines.get('codex')!.created).toEqual(['child-session'])
    await handle.dispose()
  })

  it('builds a session this plugin holds a record for on the recorded engine', async () => {
    const app = await boot()
    app.records.entries.set('recorded-session', 'codex')

    // The record outranks the preset the caller composed with: the engine the
    // router builds and the engine the Remote reports for one session must be
    // one answer, whatever channel the create arrived through.
    const handle = await createSession(app, 'recorded-session', KIMI)

    expect(app.build.mock.calls).toEqual([['codex']])
    expect(app.engines.get('codex')!.created).toEqual(['recorded-session'])
    expect(app.warn).not.toHaveBeenCalled()
    await handle.dispose()
  })

  it('leaves a child of an unowned parent preset on the harness loop', async () => {
    const app = await boot()
    // The parent runs no hosted engine either, so the child inherits nothing
    // and stays where the deployment put it.
    app.query!.presets.set('parent-session', { values: { agentPreset: UNOWNED } })

    const handle = await app.ctx.agents.create({
      sessionId: SessionId('child-session'),
      meta: { agentPreset: UNOWNED },
      parentAgent: parentAgent('parent-session'),
    })

    expect(app.query!.observeSession).toHaveBeenCalledWith(SessionId('parent-session'), { projectionMode: 'all' })
    expect(handle.agent.status).toBe('idle')
    expect(app.build).not.toHaveBeenCalled()
    await handle.dispose()
  })
})

describe('resume routing', () => {
  it('resumes on the engine the recorded preset names and releases the observation lease', async () => {
    const app = await boot()
    app.query!.presets.set('kimi-resume', { values: { agentPreset: KIMI } })

    const handle = await app.ctx.agents.resume({ resumeSessionId: SessionId('kimi-resume') })

    // A resumed session carries no metadata, so the recorded projection is the
    // only engine signal: read through the same seam the host reads.
    expect(app.query!.observeSession).toHaveBeenCalledWith(SessionId('kimi-resume'), { projectionMode: 'all' })
    expect(app.query!.dispose).toHaveBeenCalledTimes(1)
    expect(app.build.mock.calls).toEqual([['kimi']])
    expect(app.engines.get('kimi')!.resumed).toEqual(['kimi-resume'])
    expect(handle.agent).toBe(app.engines.get('kimi')!.agents[0])
    await handle.dispose()
  })

  it('leaves a standard, unowned, missing, or null preset to the harness loop', async () => {
    const app = await boot()
    app.query!.presets.set('standard-resume', { values: { agentPreset: SOURCE_PRESET_ID } })
    app.query!.presets.set('unowned-resume', { values: { agentPreset: UNOWNED } })
    app.query!.presets.set('null-resume', { values: { agentPreset: null } })
    // 'missing-resume' is deliberately absent: an observation with no projections.

    for (const id of ['standard-resume', 'unowned-resume', 'missing-resume', 'null-resume']) {
      // Reaching `super.resume` without a backend is the harness loop's own
      // complaint, which is exactly what proves the router sent it there.
      await expect(app.ctx.agents.resume({ resumeSessionId: SessionId(id) }))
        .rejects.toThrow('session persistence is not configured')
    }
    expect(app.build).not.toHaveBeenCalled()
    expect(app.query!.dispose).toHaveBeenCalledTimes(4)
  })

  it('resumes an in-process session through the harness loop', async () => {
    const app = await boot({ persistence: true })
    app.query!.presets.set('persisted', { values: { agentPreset: SOURCE_PRESET_ID } })
    await storeSession(app, 'persisted')

    const resumed = await app.ctx.agents.resume({ resumeSessionId: SessionId('persisted') })

    expect(resumed.agent.status).toBe('idle')
    expect(resumed.agent.id).toBe('persisted')
    expect(app.build).not.toHaveBeenCalled()
    await resumed.dispose()
  })

  it('resumes a session this plugin holds a record for on the recorded engine', async () => {
    const app = await boot()
    app.query!.presets.set('moved', { values: { agentPreset: CODEX } })
    app.records.entries.set('moved', 'pi')

    const handle = await app.ctx.agents.resume({ resumeSessionId: SessionId('moved') })

    // The record is what a session switched in place leaves behind, and it is
    // the only thing that can bring the session back on the engine it was moved
    // to: the log still names the preset the session was created with.
    expect(app.build.mock.calls).toEqual([['pi']])
    expect(app.engines.get('pi')!.resumed).toEqual(['moved'])
    await handle.dispose()
  })

  it('inherits the parent engine when the resumed session records no preset', async () => {
    const app = await boot()
    app.query!.presets.set('parent-session', { values: { agentPreset: KIMI } })

    const handle = await app.ctx.agents.resume({
      resumeSessionId: SessionId('bare-child'),
      parentAgent: parentAgent('parent-session'),
    })

    // The resumed session itself records nothing, so the engine falls through
    // to the live parent — a delegated session never changes engines silently.
    expect(app.build.mock.calls).toEqual([['kimi']])
    expect(app.engines.get('kimi')!.resumed).toEqual(['bare-child'])
    await handle.dispose()
  })

  it('resumes on the harness loop when the deployment composes no session query', async () => {
    const app = await boot({ query: false })

    await expect(app.ctx.agents.resume({
      resumeSessionId: SessionId('child-session'),
      parentAgent: parentAgent('parent-session'),
    })).rejects.toThrow('session persistence is not configured')
    expect(app.build).not.toHaveBeenCalled()
  })
})

describe('the live-session ledger', () => {
  it('bridges a hosted engine\'s surface into its session and leaves the harness loop alone', async () => {
    const app = await boot()

    const hosted = await createSession(app, 'hosted-session', KIMI)
    expect(registerSurface).toHaveBeenCalledTimes(1)
    // The bridge is handed the agent itself, whose own context is what makes
    // the engine's commands and skills session-scoped instead of process-wide.
    const call = registerSurface.mock.calls[0]!
    expect(call[0]).toBe(hosted.agent)
    expect(call[1]).toBe('kimi')
    // The sink reaches the plugin's own `warn` through cordis's traceable
    // service proxy, so it is identified by what it does, not by identity.
    const sink = call[2] as (message: string) => void
    sink('probe')
    expect(app.warn).toHaveBeenCalledWith('probe')

    const plain = await createSession(app, 'plain-session', SOURCE_PRESET_ID)
    expect(plain.agent.status).toBe('idle')
    // An in-process session has no engine surface to bridge: the harness loop
    // owns its own commands and skills.
    expect(registerSurface).toHaveBeenCalledTimes(1)

    await hosted.dispose()
    await plain.dispose()
  })

  it('forgets a session before releasing its agent', async () => {
    const app = await boot()
    const handle = await createSession(app, 'ledger-session', KIMI)
    const runtime = app.engines.get('kimi')!

    // A preset change observed from inside the teardown itself must find no
    // record: dropping the entry first is what keeps a listener (or a racing
    // resolve) from driving a second teardown of the agent being released.
    let duringDispose = 0
    runtime.onDispose = (id) => {
      duringDispose += 1
      if (duringDispose > 1) return
      selectPreset(app.ctx, id, SOURCE_PRESET_ID)
    }

    await handle.dispose()

    expect(runtime.disposed).toEqual(['ledger-session'])
    expect(duringDispose).toBe(1)
    expect(app.warn).not.toHaveBeenCalled()

    // And the record is gone afterwards: the same change is a no-op.
    selectPreset(app.ctx, 'ledger-session', SOURCE_PRESET_ID)
    expect(runtime.disposed).toEqual(['ledger-session'])
  })

  it('keeps the record of a rebuilt agent when a stale handle is released', async () => {
    const app = await boot()
    const stale = await createSession(app, 'rebuilt-session', CODEX)
    // The engine switch rebuilds a session under the SAME id, so the ledger now
    // holds the new entry and the old handle's record is history.
    const rebuilt = await createSession(app, 'rebuilt-session', KIMI)

    await stale.dispose()
    expect(app.engines.get('codex')!.disposed).toEqual(['rebuilt-session'])

    // Releasing the stale handle must not have dropped the live record — a
    // stale entry disposing a rebuilt agent is the leak this guards against.
    selectPreset(app.ctx, 'rebuilt-session', SOURCE_PRESET_ID)
    expect(app.engines.get('kimi')!.disposed).toEqual(['rebuilt-session'])
    expect(app.warn).not.toHaveBeenCalled()

    await rebuilt.dispose()
  })
})

describe('the blank-session engine switch', () => {
  it('ignores a preset change for a session it holds no agent for', async () => {
    const app = await boot()

    selectPreset(app.ctx, 'unknown-session', CODEX)

    expect(app.warn).not.toHaveBeenCalled()
    expect(app.build).not.toHaveBeenCalled()
  })

  it('ignores a preset change that keeps the session on the same engine', async () => {
    const app = await boot()
    const hosted = await createSession(app, 'settled-session', KIMI)
    const plain = await createSession(app, 'plain-session', SOURCE_PRESET_ID)

    selectPreset(app.ctx, 'settled-session', KIMI)
    // A standard preset names no hosted engine, so it maps back to the loop the
    // session is already on.
    selectPreset(app.ctx, 'plain-session', SOURCE_PRESET_ID)

    expect(app.warn).not.toHaveBeenCalled()
    expect(app.engines.get('kimi')!.disposed).toEqual([])
    expect(app.ctx.agents.get(SessionId('plain-session'))).toBeDefined()

    await hosted.dispose()
    await plain.dispose()
  })

  it('only warns for a session that has already run a turn', async () => {
    const app = await boot()
    const handle = await createSession(app, 'running-session', KIMI)
    // A turn in flight, and a session whose history a previous turn produced.
    app.projections.stateOf
      .mockReturnValueOnce({ openTurnStartSeq: 0, lastTurn: 0 })
      .mockReturnValueOnce({ openTurnStartSeq: null, lastTurn: 3 })

    selectPreset(app.ctx, 'running-session', SOURCE_PRESET_ID)
    selectPreset(app.ctx, 'running-session', SOURCE_PRESET_ID)

    expect(app.warn).toHaveBeenCalledTimes(2)
    expect(app.warn).toHaveBeenCalledWith(
      expect.stringContaining('session "running-session" has already started; its engine stays kimi'),
    )
    expect(app.engines.get('kimi')!.disposed).toEqual([])

    await handle.dispose()
  })

  it('releases the agent of a blank session that moves to another engine', async () => {
    const app = await boot()
    const handle = await createSession(app, 'blank-session', KIMI)

    selectPreset(app.ctx, 'blank-session', SOURCE_PRESET_ID)

    // The agent is dropped, not rebuilt: the host's next resolve composes from
    // the recorded preset and lands on the new engine.
    expect(app.engines.get('kimi')!.disposed).toEqual(['blank-session'])
    expect(app.build.mock.calls).toEqual([['kimi']])
    expect(app.warn).not.toHaveBeenCalled()
    await handle.dispose()
  })

  it('treats a session with no boundary state at all as blank', async () => {
    const app = await boot()
    const handle = await createSession(app, 'unfolded-session', KIMI)
    app.projections.stateOf.mockReturnValueOnce(undefined)

    selectPreset(app.ctx, 'unfolded-session', SOURCE_PRESET_ID)

    expect(app.engines.get('kimi')!.disposed).toEqual(['unfolded-session'])
    expect(app.warn).not.toHaveBeenCalled()
    await handle.dispose()
  })

  it('releases an in-process agent when its session moves to a hosted engine', async () => {
    const app = await boot()
    const handle = await createSession(app, 'plain-session', SOURCE_PRESET_ID)

    selectPreset(app.ctx, 'plain-session', CODEX)

    // The harness loop's own agent leaves the registry as its teardown drains;
    // the codex engine is NOT started here — the host's next resolve does that
    // from the recorded preset.
    await vi.waitFor(() => {
      expect(app.ctx.agents.get(SessionId('plain-session'))).toBeUndefined()
    })
    expect(app.build).not.toHaveBeenCalled()
    expect(app.warn).not.toHaveBeenCalled()
    await handle.dispose()
  })

  it('reports a release that fails instead of dropping it', async () => {
    const app = await boot()
    await createSession(app, 'failing-session', KIMI)
    app.engines.get('kimi')!.disposeFailure = new Error('scope unwound hard')

    selectPreset(app.ctx, 'failing-session', SOURCE_PRESET_ID)

    // The teardown rejection surfaces from the promise the handler kicked off,
    // so it is reported rather than swallowed as an unhandled rejection. The
    // engine's handle rejects on every dispose, so this test leaves it
    // un-disposed: the report is the behavior under test.
    await vi.waitFor(() => {
      expect(app.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not release the kimi agent of "failing-session": Error: scope unwound hard'),
      )
    })
    // One blank check per committed preset change: the reset that follows it
    // reads the model-selection cell, so the count is stated per key.
    expect(app.projections.stateOf.mock.calls.filter(call => call[1] === 'turnBoundary')).toHaveLength(1)
    expect(app.engines.get('kimi')!.disposed).toEqual(['failing-session'])
  })
})

describe("the plugin's own engine record", () => {
  it('lets the harness picker move a session the plugin already holds a record for', async () => {
    const app = await boot()
    app.records.entries.set('recorded-session', 'codex')
    const first = await createSession(app, 'recorded-session', KIMI)
    expect(app.build.mock.calls).toEqual([['codex']])

    selectPreset(app.ctx, 'recorded-session', KIMI)

    // LAST USER ACTION WINS: the built-in preset picker is an engine choice too,
    // so the record follows it. Without this the two entry points would fight —
    // the picker would rebuild on kimi while the next resume put the session
    // straight back on codex.
    expect(app.records.entries.get('recorded-session')).toBe('kimi')
    expect(app.engines.get('codex')!.disposed).toEqual(['recorded-session'])
    expect(app.warn).not.toHaveBeenCalled()

    // And the host's next resolve lands on the engine the record now names.
    const rebuilt = await createSession(app, 'recorded-session', KIMI)
    expect(app.build.mock.calls).toEqual([['codex'], ['kimi']])
    expect(app.engines.get('kimi')!.created).toEqual(['recorded-session'])
    await first.dispose()
    await rebuilt.dispose()
  })

  it('records nothing for a session with no record, which its preset already answers', async () => {
    const app = await boot()
    const handle = await createSession(app, 'unrecorded-session', KIMI)

    selectPreset(app.ctx, 'unrecorded-session', SOURCE_PRESET_ID)

    // The blank-session switch behaves exactly as it did before records existed:
    // the agent is released and the read keeps answering from the preset.
    expect(app.engines.get('kimi')!.disposed).toEqual(['unrecorded-session'])
    expect(app.records.entries.size).toBe(0)
    await handle.dispose()
  })

  it('reports a record it could not write and still releases the agent', async () => {
    const records = fakeRecords()
    records.record = () => { throw new Error('read-only home') }
    const app = await boot({ records })
    app.records.entries.set('recorded-session', 'codex')
    const handle = await createSession(app, 'recorded-session', KIMI)

    selectPreset(app.ctx, 'recorded-session', KIMI)

    expect(app.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not record the engine of "recorded-session": Error: read-only home'),
    )
    // The release still runs, so the session is rebuilt from the record that IS
    // on disk — the only state the next process could have read anyway.
    expect(app.engines.get('codex')!.disposed).toEqual(['recorded-session'])
    await handle.dispose()
  })

  it('leaves a started session\'s engine and record untouched', async () => {
    const app = await boot()
    app.records.entries.set('started-session', 'codex')
    const handle = await createSession(app, 'started-session', KIMI)
    app.projections.stateOf.mockReturnValueOnce({ openTurnStartSeq: null, lastTurn: 4 })

    selectPreset(app.ctx, 'started-session', KIMI)

    // A move this router refuses must move nothing: the live engine and the
    // record both stay where they are, so the router and the Remote keep
    // answering the same thing about this session.
    expect(app.records.entries.get('started-session')).toBe('codex')
    expect(app.engines.get('codex')!.disposed).toEqual([])
    expect(app.warn).toHaveBeenCalledWith(
      expect.stringContaining('session "started-session" has already started; its engine stays codex'),
    )
    await handle.dispose()
  })
})
