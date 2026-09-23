/**
 * The plugin's own Remote, and the two promises it makes: the engine a session
 * is SHOWN as running is the engine it is DRIVEN by, and a session can be MOVED
 * to another engine after it has started.
 *
 * The suite builds the incident's exact shape — a session whose HEADER records
 * `loop-engine-claude-code` and whose log then commits `agent-preset/selected =
 * loop-engine-pi` — on the real service stack (a real `SessionStore`, the real
 * JSONL persistence backend, and a projection registry that folds exactly the way
 * the host's does: header-seeded cells, eager over `session/event`). It then asks
 * the two readers that must never disagree:
 *
 *  - the Remote (`remote.loopEngine.engine`), i.e. what the browser half shows;
 *  - the router's resume path, i.e. what the session is actually built on.
 *
 * Both must answer `pi`. A reader that used the session header — or the client
 * session list's partial `agentPreset` hint, which is header-shaped for exactly
 * this fixture — answers `claude-code`, which is the production misreport this
 * Remote exists to end; the first assertion pins that difference so a regression
 * cannot pass by accident.
 *
 * The engine record it reads first is the REAL `SessionEngineStore`, writing a
 * real document into the temp home this suite already owns: a switch commits a
 * file the next process reads, and the assertions here go through that file.
 *
 * The engines are fake {@link HostedEngineRuntime}s that record which engine was
 * asked to build the session (`tests/router-loop.spec.ts` establishes that
 * contract); what is under test here is which engine that is, not what a driver
 * does with it. Unlike that suite's stand-in, this one's published handle owns a
 * REAL session and a REAL registry agent under the plugin's own
 * {@link SessionLifetime}, because an engine switch is asked about a LIVE session:
 * it must keep that session entered, hand its lifetime to the successor, and
 * leave the next delivery for the session with the successor.
 *
 * @module tests/engine-remote
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, symbols } from '@deepseek-ai/cordis'
import SessionStore, {
  SessionId, SessionSeq, type Session, type SessionEvent, type SessionHeader, type UserMessage,
} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { userMessage } from './helpers/agent-harness.ts'
import {
  LoopEngineRemote, LOOP_ENGINE_REMOTE_KEY, LOOP_ENGINE_REMOTE_METHOD, LOOP_ENGINE_REMOTE_SELECT_METHOD,
  type RouterSurfaceHolder,
} from '../src/engine-remote.ts'
import { engineOfSession } from '../src/engine-of-session.ts'
import { RouterLoop, type RouterEngine } from '../src/router-loop.ts'
import {
  HostedEngineRuntime, type HostedAgent, type HostedAgentHandle, type SwapAgentOptions,
} from '../src/driver-core/hosted-engine-runtime.ts'
import { SessionLifetime } from '../src/driver-core/session-lifetime.ts'
import { LEGACY_HOSTED_PRESET_ID, SOURCE_PRESET_ID, enginePresetId } from '../src/agent-preset-ids.ts'
import {
  ENGINE_RECORD_VERSION, SessionEngineStore, type EngineRecordStore,
} from '../src/session-engine-store.ts'
import type { HostedEngineId } from '../src/settings.ts'

/**
 * The durable record the fixture commits: `agent-preset/selected` is declared by
 * `@deepseek-ai/dsh-agent-presets` (`src/session.ts`), a package a third-party
 * plugin neither composes nor depends on — the same discipline the node half
 * follows when it declares the notification on the cordis bus
 * (`src/router-loop.ts`). Restated here for the session-LOG half, which is what
 * the fixture writes and the fold reads.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** The session's agent preset was chosen after creation, while it was blank. */
    'agent-preset/selected': { agentPreset: string }
  }
}

// The router's surface bridge needs a real agent scope, which the recording
// engines below never publish; the router's decision to call it is covered in
// `tests/router-loop.spec.ts`, and what matters here is which ENGINE it decided.
vi.mock('../src/engine-surface.ts', () => ({ registerEngineSurface: vi.fn() }))

/** The preset a session was CREATED with — the fact the header freezes. */
const HEADER_PRESET = enginePresetId('claude-code')

/** The preset the session's log commits afterwards, i.e. the engine it really runs. */
const SELECTED_PRESET = enginePresetId('pi')

/** One closed turn, as a persisted log carries it. */
const SEED: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

/** Production ctx key of each engine runtime, as `HostedEngineRuntime` publishes it. */
const ENGINE_LABELS: Readonly<Record<HostedEngineId, string>> = {
  'claude-code': 'agentLoopClaudeCode',
  codex: 'agentLoopCodex',
  pi: 'agentLoopPi',
  kimi: 'agentLoopKimi',
}

/**
 * One hosted engine's runtime with its driver replaced by a recorder — the same
 * stand-in `tests/router-loop.spec.ts` uses, because the router calls the same
 * three transaction entry points (`createAgent`, `resume`, `swap`) and reads one
 * handle back. What this fake publishes is a REAL session and a REAL registry
 * agent under the plugin's own `SessionLifetime`, because an engine swap is
 * asked about a LIVE session: it keeps that session entered, hands its lifetime
 * over, and must leave `ctx.sessions` and `ctx.agents` pointing at it.
 */
class FakeEngine extends HostedEngineRuntime<object, HostedAgent> {
  /** Ids the router resumed on this engine, in order. */
  readonly resumed: string[] = []
  /** Ids whose LIVE session this engine took over from another engine, in order. */
  readonly taken: string[] = []
  /** Agents this engine published, in publication order. */
  readonly agents: HostedAgent[] = []
  /** Ids whose published agent left the registry, in order. */
  readonly disposed: string[] = []
  /** Raised by {@link swap}: a successor whose own driver could not start. */
  failSwap: Error | undefined
  /** Raised by a published handle's `retire`: a machine that will not unwind. */
  failRetire: Error | undefined
  /** Makes every lifetime this engine publishes carry a write handle that refuses to close. */
  failClose: Error | undefined
  /** The context the published sessions and agents are entered into. */
  private readonly host: Context

  constructor(ctx: Context, label: string) {
    super(ctx, label, {})
    this.host = ctx
  }

  protected override buildAgent(): HostedAgent {
    throw new Error('the fake engine runtime never builds a driver')
  }

  override async createAgent(_ownerCtx: Context, options: CreateAgentOptions): Promise<HostedAgentHandle> {
    return this.publish(this.ownLifetime(
      this.host.sessions.prepare(options.sessionId, { seed: [...SEED] }),
    ))
  }

  override async resume(_ownerCtx: Context, options: ResumeAgentOptions): Promise<HostedAgentHandle> {
    const id = options.resumeSessionId
    this.resumed.push(String(id))
    return this.publish(this.ownLifetime(this.host.sessions.prepare(id, { seed: [...SEED] })))
  }

  /**
   * Take a live session over the way a real engine's `swap` does: the session
   * driven is the one the handed-over lifetime already holds, so nothing is
   * re-entered and the engine is the only thing that changes.
   */
  override async swap(_ownerCtx: Context, options: SwapAgentOptions): Promise<HostedAgentHandle> {
    if (this.failSwap !== undefined) throw this.failSwap
    const id = options.lifetime.session.id
    this.taken.push(String(id))
    return this.publish(options.lifetime)
  }

  /** A lifetime this engine owns from birth, carrying the write handle this fake pretends to hold. */
  private ownLifetime(session: Session): SessionLifetime {
    const { failClose } = this
    return new SessionLifetime(
      session,
      failClose === undefined
        ? undefined
        : { close: () => Promise.reject(failClose) } as unknown as SessionHandle,
    )
  }

  /** Publish one live session and agent on `lifetime`, entering it only when it is this engine's own. */
  private publish(lifetime: SessionLifetime): HostedAgentHandle {
    const session = lifetime.session
    const id = session.id
    if (!lifetime.entered) lifetime.bind(this.host.sessions.enter(session))
    const prompts: string[] = []
    const agent = {
      id,
      session,
      status: 'idle',
      options: {},
      prompts,
      followup: (message: UserMessage) => {
        for (const block of message.content) if (block.type === 'text') prompts.push(block.text)
      },
    } as unknown as HostedAgent
    const detachAgent = this.host.agents.enter(agent, undefined)
    this.agents.push(agent)
    /** Whether this machine still owns the session; a retirement or a disposal ends that. */
    let owning = true
    return {
      agent,
      lifetime,
      retire: async () => {
        if (!owning) return
        owning = false
        // A retirement leaves the session — and its lifetime — to the successor:
        // only the agent leaves the registry, whatever the unwinding cost.
        this.disposed.push(String(id))
        detachAgent()
        if (this.failRetire !== undefined) throw this.failRetire
      },
      dispose: async () => {
        // A retired machine's teardown already ran and its lifetime belongs to
        // its successor: disposal is memoized in the real machinery, so it is
        // inert here too.
        if (!owning) return
        owning = false
        this.disposed.push(String(id))
        try {
          await lifetime.closeHandle()
        } finally {
          detachAgent()
          lifetime.leaveStore()
        }
      },
    }
  }
}

/** The prompts one stand-in agent was delivered, as this suite reads them back. */
function promptsOf(agent: Agent): string[] {
  return (agent as unknown as { readonly prompts: string[] }).prompts
}

/**
 * The host's `agentPreset` fold, restated from
 * `../deepseek-harness/packages/preset/agent-presets/src/session.ts`: the cell is
 * seeded from the session HEADER and advanced by every committed selection. This
 * restatement is the point of the fixture — it is what makes the header fact and
 * the durable fact observably different, and it is the fold the harness's own
 * prepared observation drives over a restored log.
 */
const AGENT_PRESET_UNIT = {
  key: 'agentPreset',
  init: (header: SessionHeader): string | null => header.agentPreset ?? null,
  apply: (state: string | null, event: SessionEvent): string | null =>
    event.type === 'agent-preset/selected' ? event.data.agentPreset : state,
}

/** One registered projection unit after erasure. */
interface ErasedUnit {
  readonly init: (header: SessionHeader) => unknown
  readonly apply: (state: unknown, event: SessionEvent) => unknown
}

/**
 * A projection registry with the host's own semantics: cells are per session and
 * key, seeded from the session header on first use, and driven eagerly over
 * `session/event`. The router's own units (`turnBoundary`, `inbox`) are
 * registered here too — the suite does not drive a turn, but the loop's
 * constructor and the router's blank-session check read them.
 * @param ctx - the context the drive's subscription belongs to.
 * @returns a `sessionProjections`-shaped service.
 */
function foldingProjections(ctx: Context) {
  const units = new Map<string, ErasedUnit>()
  const cells = new WeakMap<Session, Map<string, unknown>>()

  const cellFor = (session: Session): Map<string, unknown> => {
    let cell = cells.get(session)
    if (cell === undefined) {
      cell = new Map()
      cells.set(session, cell)
    }
    return cell
  }

  const stateFor = (session: Session, key: string): unknown => {
    const cell = cellFor(session)
    if (!cell.has(key)) {
      const unit = units.get(key)
      if (unit === undefined) return undefined
      cell.set(key, unit.init(session.header))
    }
    return cell.get(key)
  }

  ctx.on('session/event', (session, event) => {
    for (const key of units.keys()) {
      const unit = units.get(key)!
      cellFor(session).set(key, unit.apply(stateFor(session, key), event))
    }
  })

  return {
    register: (definition: { key: string } & ErasedUnit): (() => void) => {
      units.set(definition.key, {
        init: header => definition.init(header),
        apply: (state, event) => definition.apply(state, event),
      })
      return () => { units.delete(definition.key) }
    },
    stateOf: (session: Session, key: string): unknown => stateFor(session, key),
  }
}

/** What one durable session says about its engine, read off disk. */
interface DurableEngine {
  /** The stored header — the creation fact. */
  readonly header: SessionHeader
  /** The folded `agentPreset` cell — what the session actually runs. */
  readonly agentPreset: string | null
}

/**
 * Read one session's durable log and fold its `agentPreset` cell: the stored
 * header seeds the state and every stored event advances it, which is exactly
 * what the harness's prepared (cold) observation does after restoring a session.
 * @param ctx - the context carrying the persistence backend.
 * @param sessionId - the stored session to read.
 * @returns the header and folded cell, or undefined when nothing is stored.
 */
async function readDurable(ctx: Context, sessionId: SessionId): Promise<DurableEngine | undefined> {
  let handle
  try {
    handle = await ctx.sessionPersistence.open(sessionId, 'read')
  } catch {
    return undefined
  }
  try {
    const { events } = await handle.read(0)
    let agentPreset = AGENT_PRESET_UNIT.init(handle.header)
    for (const event of events) agentPreset = AGENT_PRESET_UNIT.apply(agentPreset, event)
    return { header: handle.header, agentPreset }
  } finally {
    await handle.close()
  }
}

/**
 * The host `sessionQuery` seam as this suite needs it: a point observation of a
 * session the DURABLE LOG holds. Every fixture here is a session on disk that no
 * process has loaded, so the observation takes the harness's prepared (cold) path
 * — restore the header and the stored log, then fold.
 * @param ctx - the context carrying the persistence backend.
 * @returns a `sessionQuery`-shaped service.
 */
function durableQuery(ctx: Context) {
  return {
    async observeSession(sessionId: SessionId) {
      const durable = await readDurable(ctx, sessionId)
      return {
        projections: durable === undefined ? undefined : { values: { agentPreset: durable.agentPreset } },
        [Symbol.dispose](): void {},
      }
    },
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-remote-'))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/** Failures an engine runtime built from here on should raise, for the recovery arms. */
interface FakeFailures {
  /** Raised by the engine's `swap`: a successor whose driver cannot start. */
  swap?: Error
  /** Raised by a published handle's `retire`: a machine that will not unwind. */
  retire?: Error
  /** Carried as the write handle of every lifetime published from here on: a drain that fails. */
  close?: Error
}

/** One booted stack plus the fixtures a test asserts against. */
interface App {
  readonly ctx: Context
  /** The one server-side Remote instance, as its namespace resolves it. */
  readonly remote: LoopEngineRemote
  readonly build: ReturnType<typeof vi.fn<(engine: HostedEngineId) => RouterEngine>>
  readonly engines: Map<HostedEngineId, FakeEngine>
  /** Every engine runtime the router built, in order. */
  readonly built: HostedEngineId[]
  /** Failures every runtime is built with; a runtime's own field can still be changed later. */
  readonly failures: FakeFailures
  /** Logs the router's own diagnostics sink received. */
  readonly routerWarn: ReturnType<typeof vi.fn<(message: string) => void>>
  /** The plugin's own per-session engine record, as the router and Remote read it. */
  readonly records: EngineRecordStore
  /** Absolute path of the record document this boot writes. */
  readonly recordPath: string
  /** Logs the record store's own diagnostics sink received. */
  readonly recordWarn: ReturnType<typeof vi.fn<(message: string) => void>>
  /** Logs the plugin's own diagnostics sink received. */
  readonly remoteWarn: ReturnType<typeof vi.fn<(message: string) => void>>
}

/**
 * Boot the real service stack, mount the router (so a resume really routes), and
 * register the plugin's Remote the way `apply()` does — inside a plugin fiber, so
 * the Gateway's discovery surface is the one under test.
 * @param options - `records` replaces the real engine record store, which is how
 * a write the store refuses is reproducible on every host.
 * @returns the booted stack and its fixtures.
 */
async function boot(options: { records?: EngineRecordStore } = {}): Promise<App> {
  const root = await tempDir()
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root })
  const projections = foldingProjections(ctx)
  ctx.provide('sessionProjections', projections)
  ctx.provide('sessionQuery', durableQuery(ctx))

  const recordPath = join(root, 'engines.json')
  const recordWarn = vi.fn()
  const records = options.records
    ?? new SessionEngineStore(recordPath, (message: string) => { recordWarn(message) })

  // The router publishes itself as the Remote's selector, exactly as `apply()`
  // does, so `loopEngine/select` runs the real routing decision.
  const routerHolder: RouterSurfaceHolder = { current: undefined }
  const engines = new Map<HostedEngineId, FakeEngine>()
  const built: HostedEngineId[] = []
  const failures: FakeFailures = {}
  const build = vi.fn((engine: HostedEngineId): RouterEngine => {
    built.push(engine)
    const runtime = new FakeEngine(ctx, ENGINE_LABELS[engine])
    runtime.failSwap = failures.swap
    runtime.failRetire = failures.retire
    runtime.failClose = failures.close
    engines.set(engine, runtime)
    return runtime
  })
  const routerWarn = vi.fn()
  const routerFiber = ctx.plugin({
    name: 'loop-engine-router-under-test',
    inject: ['agents', 'sessions', 'systemPrompt', 'sessionProjections'],
    apply: (routerCtx: Context) => {
      const router = new RouterLoop(routerCtx, build, records, (message: string) => { routerWarn(message) })
      routerHolder.current = router
    },
  })
  await routerFiber
  cleanups.push(async () => { await routerFiber.dispose() })
  await vi.waitFor(() => { expect(ctx.get('agentLoop')).toBeDefined() })

  const remoteWarn = vi.fn()
  const pluginFiber = ctx.plugin({
    name: 'loop-engine-under-test',
    apply: (pluginCtx: Context) => {
      new LoopEngineRemote(
        pluginCtx,
        (sessionId: SessionId) => engineOfSession(pluginCtx, sessionId, records),
        routerHolder,
        (message: string) => { remoteWarn(message) },
      )
    },
  })
  await pluginFiber
  cleanups.push(async () => { await pluginFiber.dispose() })

  return {
    ctx,
    remote: ctx.get(LOOP_ENGINE_REMOTE_KEY) as unknown as LoopEngineRemote,
    build,
    engines,
    built,
    failures,
    routerWarn,
    records,
    recordPath,
    recordWarn,
    remoteWarn,
  }
}

/**
 * Store one DURABLE session: a header recording `headerPreset`, a closed turn on
 * disk, and — when given — a committed preset selection in the log.
 * @param app - the booted stack.
 * @param id - the session id to create.
 * @param headerPreset - the preset the session was created with, or undefined.
 * @param selected - the preset its log committed afterwards, when it switched.
 * @returns what the stored log holds, as the observation seam will read it.
 */
async function durableSession(
  app: App,
  id: string,
  headerPreset: string | undefined,
  selected?: string,
): Promise<DurableEngine> {
  const session = app.ctx.sessions.prepare(SessionId(id), {
    seed: [...SEED],
    ...headerPreset === undefined ? {} : { meta: { agentPreset: headerPreset } },
  })
  if (selected !== undefined) session.append('agent-preset/selected', { agentPreset: selected })
  const handle = await app.ctx.sessionPersistence.create(session.header, {
    inheritedEventCount: session.inheritedEventCount,
  })
  await handle.append(session.snapshotEvents())
  await handle.close()
  const stored = await readDurable(app.ctx, SessionId(id))
  // A fixture that did not reach disk would make every "unset" assertion below
  // pass for the wrong reason, so the read is asserted here, once.
  expect(stored).toBeDefined()
  return stored!
}

describe('the engine Remote', () => {
  it('reports the engine the session ACTUALLY runs, not the one its header froze', async () => {
    const app = await boot()
    const stored = await durableSession(app, 'switched', HEADER_PRESET, SELECTED_PRESET)

    // The fixture is the incident: two different facts, one session. A reader of
    // the header (or of the client list's header-shaped hint) would report Claude
    // Code here — that is the bug this Remote replaces.
    expect(stored.header.agentPreset).toBe(HEADER_PRESET)
    expect(stored.agentPreset).toBe(SELECTED_PRESET)

    await expect(app.remote.engine({ sessionId: 'switched' }))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'pi' } })
    expect(app.remoteWarn).not.toHaveBeenCalled()
  })

  it('agrees with the router: the session the Remote reports as Pi is the session the router builds on Pi', async () => {
    const app = await boot()
    await durableSession(app, 'switched', HEADER_PRESET, SELECTED_PRESET)

    const reported = await app.remote.engine({ sessionId: 'switched' })
    expect(reported).toEqual({ engine: { kind: 'engine', engine: 'pi' } })

    // The resume the host performs when it builds the session again (a cold
    // session, i.e. after a restart): the same durable
    // read decides which engine runtime builds it.
    const handle = await app.ctx.agents.resume({ resumeSessionId: SessionId('switched') })
    expect(app.build.mock.calls).toEqual([['pi']])
    expect(app.engines.get('pi')!.resumed).toEqual(['switched'])
    await handle.dispose()

    // One read, two answers: the engine the plugin REPORTS for this session is
    // the only engine the router built for it.
    expect(app.built).toEqual(reported.engine.kind === 'engine' ? [reported.engine.engine] : [])
  })

  it('reads a session that never recorded a preset as unset', async () => {
    const app = await boot()
    const stored = await durableSession(app, 'bare', undefined)

    expect(stored.header.agentPreset).toBeUndefined()
    expect(stored.agentPreset).toBeNull()
    await expect(app.remote.engine({ sessionId: 'bare' })).resolves.toEqual({ engine: { kind: 'unset' } })
    expect(app.remoteWarn).not.toHaveBeenCalled()
  })

  it('reads the pre-routing preset id as legacy, never as the in-process loop', async () => {
    const app = await boot()
    const stored = await durableSession(app, 'legacy', LEGACY_HOSTED_PRESET_ID)

    expect(stored.agentPreset).toBe(LEGACY_HOSTED_PRESET_ID)
    await expect(app.remote.engine({ sessionId: 'legacy' })).resolves.toEqual({ engine: { kind: 'legacy' } })
    // And the router still runs it on the harness loop: nothing is claimed for it
    // either way, so the two readers stay consistent about that too.
    expect(app.build).not.toHaveBeenCalled()
  })

  it('names the harness loop for a deployment-authored preset', async () => {
    const app = await boot()
    const stored = await durableSession(app, 'standard', SOURCE_PRESET_ID)

    expect(stored.agentPreset).toBe(SOURCE_PRESET_ID)
    await expect(app.remote.engine({ sessionId: 'standard' }))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'in-process' } })
  })

  it('reads a session the durable log does not know as unset, without throwing', async () => {
    const app = await boot()

    await expect(app.remote.engine({ sessionId: 'never-existed' })).resolves.toEqual({ engine: { kind: 'unset' } })
    expect(app.remoteWarn).not.toHaveBeenCalled()
  })

  it('refuses a request with no session id instead of silently reporting unset', async () => {
    const app = await boot()

    await expect(app.remote.engine({ sessionId: '' })).rejects.toThrow(/sessionId must be a non-empty string/)
    await expect(app.remote.engine({ sessionId: 7 as unknown as string }))
      .rejects.toThrow(/sessionId must be a non-empty string/)
  })

  it('reports an unreadable session as unset and warns once, instead of failing the page', async () => {
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    const warn = vi.fn()
    const remote = new LoopEngineRemote(
      ctx,
      async () => { throw new Error('persistence is gone') },
      { current: undefined },
      (message: string) => { warn(message) },
    )

    await expect(remote.engine({ sessionId: 'switched' })).resolves.toEqual({ engine: { kind: 'unset' } })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not read the engine of session "switched": Error: persistence is gone'),
    )
  })
})

describe('the engine Remote as the Gateway discovers it', () => {
  it('publishes the binding and method marks the Gateway reflects over', async () => {
    const app = await boot()
    const receiver = app.ctx.get(LOOP_ENGINE_REMOTE_KEY) as unknown as object
    const original = (Reflect.get(receiver, symbols.original) as object | undefined) ?? receiver

    // `TypertRemoteService` binds the service, and `@Remote` marks the methods on
    // the prototype; this is exactly what the Gateway's source-mode discovery
    // reads (`collectSrcClaims` / `resolveSrcDescriptor`).
    const binding = Reflect.get(original, 'typertRemote') as {
      service?: unknown
      serviceKey?: unknown
      namespace?: unknown
    }
    expect(binding.service).toBe(original)
    expect(binding.serviceKey).toBe(LOOP_ENGINE_REMOTE_KEY)
    expect(binding.namespace).toBe(LOOP_ENGINE_REMOTE_KEY)
    expect(app.ctx.reflect.props[LOOP_ENGINE_REMOTE_KEY]?.type).toBe('service')
    expect(remoteMethods(original)).toEqual([
      { method: LOOP_ENGINE_REMOTE_METHOD, invocation: { kind: 'direct' } },
      { method: LOOP_ENGINE_REMOTE_SELECT_METHOD, invocation: { kind: 'direct' } },
    ])
  })

  it('declares the parameter name the browser half must send as the wire field', async () => {
    await boot()
    // The Gateway derives an SRC descriptor's argument names from the live
    // method's own source text (`methodParameterNames`), so the parameter name IS
    // the wire field: renaming it, destructuring it, or giving it a default would
    // break the browser half's `{ request: { sessionId } }` argument silently.
    for (const method of [LOOP_ENGINE_REMOTE_METHOD, LOOP_ENGINE_REMOTE_SELECT_METHOD]) {
      const implementation = Object.getOwnPropertyDescriptor(LoopEngineRemote.prototype, method)!
        .value as object
      const source = Function.prototype.toString.call(implementation)
      const open = source.indexOf('(')
      const close = source.indexOf(')', open + 1)
      expect(source.slice(open + 1, close).trim()).toBe('request')
    }
  })
})

describe('switching a session\'s engine', () => {
  it('moves a session that has already run a turn by swapping its agent in place', async () => {
    const app = await boot()
    await durableSession(app, 'started', enginePresetId('claude-code'))
    // The session the host builds again: it has already run a turn, which is
    // exactly the session the harness's own preset channel refuses to move.
    const before = await app.ctx.agents.resume({ resumeSessionId: SessionId('started') })
    expect(app.build.mock.calls).toEqual([['claude-code']])
    const retired = before.agent
    const live = retired.session

    await expect(app.remote.select({ sessionId: 'started', engine: 'pi' }))
      .resolves.toEqual({ ok: true, engine: 'pi' })

    // ① The session is STILL the same live Session object: the entry the browser
    // half is attached to never left the store, so nothing about it was ever
    // published as a removal.
    expect(app.ctx.sessions.get(SessionId('started'))).toBeDefined()
    expect(app.ctx.sessions.get(SessionId('started'))).toBe(live)
    // ② ...and it is still DRIVEN: the agent in the registry is the one the new
    // engine published onto that session, and the retired machine is gone.
    const successor = app.ctx.agents.get(SessionId('started'))
    expect(successor).toBeDefined()
    expect(successor).toBe(app.engines.get('pi')!.agents.at(-1))
    expect(successor).not.toBe(retired)
    expect(app.engines.get('pi')!.taken).toEqual(['started'])
    expect(app.engines.get('claude-code')!.disposed).toEqual(['started'])

    // ③ The next delivery for this session — what a prompt becomes — reaches the
    // successor: `ctx.agents.get` is how the host's prompt path resolves it.
    successor!.followup(userMessage('do it again'))
    expect(promptsOf(successor!)).toEqual(['do it again'])
    expect(promptsOf(retired)).toEqual([])

    // The record is what the host's next resolve reads.
    expect(JSON.parse(await readFile(app.recordPath, 'utf8'))).toEqual({
      version: ENGINE_RECORD_VERSION,
      engines: { started: 'pi' },
    })
    await expect(app.remote.engine({ sessionId: 'started' }))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'pi' } })

    // Nothing was reopened to get there: the successor was built on the live
    // session, so this switch needed no resume and no session lifecycle at all.
    expect(app.build.mock.calls).toEqual([['claude-code'], ['pi']])
    expect(app.engines.get('pi')!.resumed).toEqual([])
    expect(app.engines.get('pi')!.agents).toHaveLength(1)
    expect(app.routerWarn).not.toHaveBeenCalled()
    await before.dispose()
  })

  it('moves a session onto the harness loop by releasing its agent and asking for a reload', async () => {
    const app = await boot()
    await durableSession(app, 'homed', enginePresetId('claude-code'))
    const before = await app.ctx.agents.resume({ resumeSessionId: SessionId('homed') })
    const retired = before.agent
    expect(app.engines.get('claude-code')!.disposed).toEqual([])

    await expect(app.remote.select({ sessionId: 'homed', engine: 'in-process' }))
      .resolves.toEqual({ ok: true, engine: 'in-process', reload: true })

    // ① The choice is committed, durably, before anything is torn down.
    expect(app.records.engineOf(SessionId('homed'))).toBe('in-process')
    expect(JSON.parse(await readFile(app.recordPath, 'utf8'))).toEqual({
      version: ENGINE_RECORD_VERSION,
      engines: { homed: 'in-process' },
    })
    // ② The agent really is gone by the time the switch answers. The harness loop
    // cannot take a live session over, so the change is made to land by releasing
    // it — and the page is about to reload on the strength of that, so it must
    // already be true: `ctx.agents` is what the host's resolve reads.
    expect(app.engines.get('claude-code')!.disposed).toEqual(['homed'])
    expect(app.ctx.agents.get(SessionId('homed'))).toBeUndefined()
    expect(app.ctx.sessions.get(SessionId('homed'))).toBeUndefined()
    // The switch reports nothing: this fixture composes no `agentDefaultModel`,
    // so the only line the router logs is that reset's own one-time warning —
    // there is no "keeps X" notice to report any more.
    expect(app.routerWarn).toHaveBeenCalledTimes(1)
    expect(app.routerWarn).toHaveBeenCalledWith(
      expect.stringContaining('cannot be given a real model selection'),
    )
    // ③ Nothing was built to replace it: the session is COLD, and its record is
    // the engine its next build uses. No hosted engine is started here at all.
    expect(app.build.mock.calls).toEqual([['claude-code']])
    // ④ A cold session reports its record and nothing else — there is no live
    // agent left to differ from it, so no "recorded but not running" marker.
    await expect(app.remote.engine({ sessionId: 'homed' }))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'in-process' } })

    // ⑤ The next build — what the reloaded page's own open triggers — is the
    // harness loop's, and no hosted engine is asked to build this session again.
    const reopened = await app.ctx.agents.resume({ resumeSessionId: SessionId('homed') })
    expect(app.ctx.agents.get(SessionId('homed'))).toBe(reopened.agent)
    expect(reopened.agent.session).not.toBe(retired.session)
    expect(app.build.mock.calls).toEqual([['claude-code']])
    expect(app.engines.get('claude-code')!.agents).not.toContain(reopened.agent)
    await reopened.dispose()
  })

  it('moves a session off the harness loop the same way, so the next build takes the recorded engine', async () => {
    const app = await boot()
    await durableSession(app, 'homed-plain', SOURCE_PRESET_ID)
    const before = await app.ctx.agents.resume({ resumeSessionId: SessionId('homed-plain') })
    expect(app.build).not.toHaveBeenCalled()

    await expect(app.remote.select({ sessionId: 'homed-plain', engine: 'pi' }))
      .resolves.toEqual({ ok: true, engine: 'pi', reload: true })

    // The harness loop's own agent is what had to go: an `in-process` session's
    // handle is the loop's, and only releasing it frees the session for another
    // engine. Nothing is built here — the host's next resolve builds the
    // successor, on the engine the record now names.
    expect(app.ctx.agents.get(SessionId('homed-plain'))).toBeUndefined()
    expect(app.ctx.sessions.get(SessionId('homed-plain'))).toBeUndefined()
    expect(app.build).not.toHaveBeenCalled()
    expect(app.records.engineOf(SessionId('homed-plain'))).toBe('pi')
    await expect(app.remote.engine({ sessionId: 'homed-plain' }))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'pi' } })

    const reopened = await app.ctx.agents.resume({ resumeSessionId: SessionId('homed-plain') })
    expect(app.build.mock.calls).toEqual([['pi']])
    expect(app.engines.get('pi')!.resumed).toEqual(['homed-plain'])
    await reopened.dispose()
    await before.dispose()
  })

  it('reports a session it could not drain after a failed successor build', async () => {
    const app = await boot()
    await durableSession(app, 'undrained', enginePresetId('claude-code'))
    // The outgoing lifetime's write handle refuses to close, and the successor
    // engine refuses to start: the worst pair of failures a swap can meet.
    app.failures.close = new Error('the log would not drain')
    app.failures.swap = new Error('pi could not start')
    const before = await app.ctx.agents.resume({ resumeSessionId: SessionId('undrained') })

    await expect(app.remote.select({ sessionId: 'undrained', engine: 'pi' }))
      .resolves.toEqual({
        ok: false,
        code: 'rebuild-failed',
        reason: 'could not rebuild session "undrained" on pi: Error: pi could not start',
      })

    // Nothing drives the session, so it did not stay live with no driver: its
    // lifetime was released, and leaving the store is the step that happened even
    // though the drain failed — that is what keeps it reopenable.
    expect(app.ctx.agents.get(SessionId('undrained'))).toBeUndefined()
    expect(app.ctx.sessions.get(SessionId('undrained'))).toBeUndefined()
    expect(app.routerWarn).toHaveBeenCalledWith(expect.stringContaining('could not close the write handle'))
    expect(app.records.engineOf(SessionId('undrained'))).toBe('pi')
    await before.dispose()
  })

  it('swaps the session even when the outgoing machine will not unwind', async () => {
    const app = await boot()
    await durableSession(app, 'stuck', enginePresetId('claude-code'))
    const before = await app.ctx.agents.resume({ resumeSessionId: SessionId('stuck') })
    app.engines.get('claude-code')!.failRetire = new Error('the scope would not unwind')

    await expect(app.remote.select({ sessionId: 'stuck', engine: 'kimi' }))
      .resolves.toEqual({ ok: true, engine: 'kimi' })

    // The retired machine left the registry either way, so the session is live
    // and driven by the new engine; the failed unwind is reported, never turned
    // into a session the plugin can no longer drive.
    expect(app.ctx.sessions.get(SessionId('stuck'))).toBe(before.agent.session)
    expect(app.ctx.agents.get(SessionId('stuck'))).toBe(app.engines.get('kimi')!.agents.at(-1))
    expect(app.routerWarn).toHaveBeenCalledWith(expect.stringContaining('could not fully retire the claude-code agent'))
    await before.dispose()
  })

  it('answers the record over the session\'s own preset, which it never rewrites', async () => {
    const app = await boot()
    // The session's composition stays what it was: the engine is the plugin's
    // own per-session fact, so moving the session must not touch the log.
    const stored = await durableSession(app, 'composed', enginePresetId('claude-code'))
    expect(stored.agentPreset).toBe(enginePresetId('claude-code'))
    await app.ctx.agents.resume({ resumeSessionId: SessionId('composed') })

    await app.remote.select({ sessionId: 'composed', engine: 'pi' })

    await expect(app.remote.engine({ sessionId: 'composed' }))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'pi' } })
    const after = await readDurable(app.ctx, SessionId('composed'))
    expect(after!.agentPreset).toBe(enginePresetId('claude-code'))
    expect(app.records.engineOf(SessionId('composed'))).toBe('pi')
  })

  it('survives a restart: a fresh store reads the same document', async () => {
    const app = await boot()
    await durableSession(app, 'durable-switch', enginePresetId('codex'))
    await app.ctx.agents.resume({ resumeSessionId: SessionId('durable-switch') })
    await app.remote.select({ sessionId: 'durable-switch', engine: 'kimi' })

    // A new process reads the file, not this one's memory.
    const restarted = new SessionEngineStore(app.recordPath, vi.fn())
    expect(restarted.engineOf(SessionId('durable-switch'))).toBe('kimi')
    await expect(engineOfSession(app.ctx, SessionId('durable-switch'), restarted))
      .resolves.toEqual({ kind: 'engine', engine: 'kimi' })
  })

  it('records a session already running the requested engine without rebuilding it', async () => {
    const app = await boot()
    await durableSession(app, 'steady', enginePresetId('pi'))
    const handle = await app.ctx.agents.resume({ resumeSessionId: SessionId('steady') })

    await expect(app.remote.select({ sessionId: 'steady', engine: 'pi' }))
      .resolves.toEqual({ ok: true, engine: 'pi' })

    // The pick is still recorded — it is an explicit choice, and it pins the
    // engine against a later preset change — but nothing is torn down for a
    // switch that switches nothing.
    expect(app.records.engineOf(SessionId('steady'))).toBe('pi')
    expect(app.engines.get('pi')!.disposed).toEqual([])
    await handle.dispose()
  })

  it('takes a recorded engine back when the engine the session actually runs is picked again', async () => {
    const app = await boot()
    await durableSession(app, 'back', enginePresetId('pi'))
    const handle = await app.ctx.agents.resume({ resumeSessionId: SessionId('back') })
    // The session is live on pi while its record names the harness loop — a
    // release that did not take, or an operator editing the sidecar. Picking pi
    // again is the user saying "stay where you are", and the record follows the
    // live agent back.
    app.records.record(SessionId('back'), 'in-process')

    await expect(app.remote.select({ sessionId: 'back', engine: 'pi' }))
      .resolves.toEqual({ ok: true, engine: 'pi' })

    expect(app.records.engineOf(SessionId('back'))).toBe('pi')
    // Nothing was rebuilt to get there — and nothing was released either: the
    // session is already running the engine that was asked for, so there is
    // nothing for a reload to build — and the report no longer has a second fact
    // to carry.
    expect(app.engines.get('pi')!.disposed).toEqual([])
    await expect(app.remote.engine({ sessionId: 'back' }))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'pi' } })
    await handle.dispose()
  })

  it('releases a session running a hosted engine even when its record already names the harness loop', async () => {
    const app = await boot()
    await durableSession(app, 'plain', enginePresetId('pi'))
    const handle = await app.ctx.agents.resume({ resumeSessionId: SessionId('plain') })
    // The record already names the deployment's own loop while the live agent is
    // the pi runtime: this is what a release that did not take (or an operator
    // editing the sidecar) leaves behind. Asking for in-process again cannot be a
    // no-op on the strength of the record alone — the engine this session RUNS
    // is pi, and the only way to hand it back to the harness loop is to release
    // it.
    app.records.record(SessionId('plain'), 'in-process')

    await expect(app.remote.select({ sessionId: 'plain', engine: 'in-process' }))
      .resolves.toEqual({ ok: true, engine: 'in-process', reload: true })

    // The pi agent is gone and nothing replaced it: the session is cold, and its
    // record — which already said in-process — is what its next build uses.
    expect(app.engines.get('pi')!.disposed).toEqual(['plain'])
    expect(app.ctx.agents.get(SessionId('plain'))).toBeUndefined()
    expect(app.build.mock.calls).toEqual([['pi']])
    await expect(app.remote.engine({ sessionId: 'plain' }))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'in-process' } })
    await handle.dispose()
  })

  it('refuses a session that is not open, without recording anything', async () => {
    const app = await boot()
    await durableSession(app, 'cold', enginePresetId('pi'))

    // A cold session has no Session object to append to and no agent to release;
    // the host opens it before a surface can act on it.
    await expect(app.remote.select({ sessionId: 'cold', engine: 'kimi' }))
      .resolves.toEqual({
        ok: false,
        code: 'session-closed',
        reason: 'session "cold" is not open; open it first, then switch its engine',
      })
    expect(app.records.engineOf(SessionId('cold'))).toBeUndefined()
    // Nothing was built and nothing was released: a refused switch moves nothing.
    expect(app.build).not.toHaveBeenCalled()
  })

  it('refuses a session that is mid-turn, without interrupting it', async () => {
    const app = await boot()
    await durableSession(app, 'busy', enginePresetId('pi'))
    const handle = await app.ctx.agents.resume({ resumeSessionId: SessionId('busy') })
    ;(handle.agent as unknown as { status: string }).status = 'running'

    await expect(app.remote.select({ sessionId: 'busy', engine: 'kimi' }))
      .resolves.toEqual({
        ok: false,
        code: 'turn-running',
        reason: 'session "busy" is running; switch its engine after this turn ends',
      })
    expect(app.records.engineOf(SessionId('busy'))).toBeUndefined()
    expect(app.engines.get('pi')!.disposed).toEqual([])
    await handle.dispose()
  })

  it('refuses a subagent session, whose agent belongs to its delegation', async () => {
    const app = await boot()
    // A delegated child: its agent is owned by subagent routing, so releasing it
    // here would strand the parent's delegation mid-flight.
    const session = app.ctx.sessions.prepare(SessionId('child'), { meta: { origin: 'subagent' } })
    const detachSession = app.ctx.sessions.enter(session)
    const detachAgent = app.ctx.agents.enter(
      { id: SessionId('child'), session, status: 'idle' } as unknown as Agent,
      undefined,
    )

    await expect(app.remote.select({ sessionId: 'child', engine: 'kimi' }))
      .resolves.toEqual({
        ok: false,
        code: 'subagent-session',
        reason: 'session "child" is a subagent session; its agent belongs to subagent routing',
      })
    expect(app.records.engineOf(SessionId('child'))).toBeUndefined()
    // The delegation's agent is untouched: it is still the registered one.
    expect(app.ctx.agents.get(SessionId('child'))).toBeDefined()
    expect(app.build).not.toHaveBeenCalled()
    detachAgent()
    detachSession()
  })

  it('refuses a session this router does not drive', async () => {
    const app = await boot()
    // The window where the base bundle's loop still owns the factory slot: an
    // agent is live, but it is not one this router could rebuild, so recording a
    // new engine for it would only make the two readers disagree.
    const session = app.ctx.sessions.prepare(SessionId('foreign'), { seed: [...SEED] })
    const detachSession = app.ctx.sessions.enter(session)
    const detachAgent = app.ctx.agents.enter(
      { id: SessionId('foreign'), session, status: 'idle' } as unknown as Agent,
      undefined,
    )

    await expect(app.remote.select({ sessionId: 'foreign', engine: 'kimi' }))
      .resolves.toEqual({
        ok: false,
        code: 'not-driven',
        reason: 'session "foreign" is not driven by this plugin\'s loop router',
      })
    expect(app.records.engineOf(SessionId('foreign'))).toBeUndefined()
    // A session this router did not build is left exactly as it is: it is not
    // this plugin's to release.
    expect(app.ctx.agents.get(SessionId('foreign'))).toBeDefined()
    detachAgent()
    detachSession()
  })

  it('refuses a malformed request the way every endpoint does', async () => {
    const app = await boot()

    await expect(app.remote.select({ sessionId: '', engine: 'pi' }))
      .rejects.toThrow(/sessionId must be a non-empty string/)
    await expect(app.remote.select({ sessionId: 7 as unknown as string, engine: 'pi' }))
      .rejects.toThrow(/sessionId must be a non-empty string/)
    await expect(app.remote.select({ sessionId: 's1', engine: 'gpt' }))
      .rejects.toThrow(/engine must be one of in-process, claude-code, codex, pi, kimi/)
    await expect(app.remote.select({ sessionId: 's1', engine: undefined as unknown as string }))
      .rejects.toThrow(/engine must be one of/)
  })

  it('refuses when the engine record could not be written, leaving the session where it is', async () => {
    const app = await boot({
      records: {
        engineOf: () => undefined,
        record: () => { throw new Error('read-only home') },
      },
    })
    await durableSession(app, 'unwritable', enginePresetId('pi'))
    const handle = await app.ctx.agents.resume({ resumeSessionId: SessionId('unwritable') })

    await expect(app.remote.select({ sessionId: 'unwritable', engine: 'kimi' }))
      .resolves.toEqual({
        ok: false,
        code: 'record-failed',
        reason: 'could not record the engine of session "unwritable": Error: read-only home',
      })
    // Nothing moved: no record, and the live agent still runs the old engine, so
    // the two readers keep agreeing about this session.
    expect(app.engines.get('pi')!.disposed).toEqual([])
    await handle.dispose()
  })

  it('refuses in words while no loop router is mounted yet', async () => {
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    const remote = new LoopEngineRemote(
      ctx,
      async () => ({ kind: 'unset' }),
      { current: undefined },
      vi.fn(),
    )

    await expect(remote.select({ sessionId: 's1', engine: 'pi' }))
      .resolves.toEqual({
        ok: false,
        code: 'router-unmounted',
        reason: 'this process cannot switch engines yet: the loop router is not mounted',
      })
  })

  it('keeps answering from the preset when the record document is unusable', async () => {
    const app = await boot()
    await writeFile(app.recordPath, 'not a document', 'utf8')
    await durableSession(app, 'old', enginePresetId('kimi'))

    // A broken record costs a session its remembered engine, never its ability
    // to open: the read falls back to the preset and reports itself once.
    await expect(app.remote.engine({ sessionId: 'old' }))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'kimi' } })
    await expect(app.remote.engine({ sessionId: 'other' })).resolves.toEqual({ engine: { kind: 'unset' } })
    expect(app.recordWarn).toHaveBeenCalledTimes(1)
    expect(app.recordWarn).toHaveBeenCalledWith(
      expect.stringContaining('is not a version 1 engine record'),
    )
  })
})
