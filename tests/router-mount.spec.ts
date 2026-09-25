/**
 * Router-mount retry suite: `apply`'s bounded remount window for the single
 * process-wide `agentLoop` factory slot.
 *
 * The plugin keeps the base bundle's `agent-loop` row disabled through the
 * managed block, but that block is written by `apply` and only read at the NEXT
 * composition — so a fresh install's first boot still has the base loop
 * active, holding the `agentLoop` name AND the `AgentFactory` slot the router
 * claims for itself. The router's construction is therefore refused on that
 * first attempt, and the plugin retries for a bounded window while the
 * harness's live patch reload drops the base row.
 *
 * These tests drive that window itself, with a real base `AgentLoop` mounted
 * the way the base bundle's row mounts it: the retry that succeeds once the
 * slot frees, the loud give-up when it never does, the unload that must stop a
 * pending retry, and the non-collision failure that is deployment trouble
 * rather than a race.
 *
 * @module tests/router-mount
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop, { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, type Config } from '../src/index.ts'
import { SOURCE_PRESET_ID } from '../src/preset.ts'
import { RouterLoop } from '../src/router-loop.ts'
import { createLiveLoopConfig } from './helpers/fake-settings.ts'
import { LEGACY_HARNESS } from './helpers/harness-generation.ts'
import { fakeToolRuntime } from './helpers/tool-runtime.ts'

/**
 * Minimal stand-in for the host session-projection registry.
 *
 * `AgentLoop`'s constructor registers its `turnBoundary` unit through
 * `ctx.sessionProjections`, so the base loop and the router both need the
 * service to be present; registrations are recorded and a session's cell folds
 * to the definition's `init`. The registry takes no build-time dependency on
 * the projection package, hence the structural stand-in.
 */
function fakeSessionProjections() {
  const definitions = new Map<string, { init: () => unknown }>()
  const cells = new WeakMap<object, Map<string, unknown>>()
  return {
    register: vi.fn((definition: { key: string; init: () => unknown }) => {
      definitions.set(definition.key, definition)
      return () => { definitions.delete(definition.key) }
    }),
    stateOf: (session: object, key: string): unknown => {
      let byKey = cells.get(session)
      if (byKey === undefined) {
        byKey = new Map()
        cells.set(session, byKey)
      }
      if (!byKey.has(key)) {
        const definition = definitions.get(key)
        if (definition === undefined) return undefined
        byKey.set(key, definition.init())
      }
      return byKey.get(key)
    },
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-router-mount-'))
  cleanups.push(async () => {
    // Renaming a just-written file can leave the Windows directory entry
    // stale; Node's built-in retry handles ENOTEMPTY/EBUSY/EPERM.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/**
 * Boot the services the plugin's composition assumes and return the context.
 *
 * A fresh `$DSH_HOME` is stubbed per test, so the presets `apply` authors land
 * in the test's temp directory instead of the developer's real `~/.dsh`.
 */
async function boot(): Promise<Context> {
  vi.stubEnv('DSH_HOME', await tempDir())
  const ctx = new Context()
  // Unload the whole root last, so every service and fiber this test composed
  // is torn down instead of leaving a `process` exit listener per test behind.
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  ctx.provide('sessionProjections', fakeSessionProjections())
  // The router's inject gate is the harness loop's own dependency set, which
  // includes the tool registry its turn machinery reads.
  ctx.provide('tools', fakeToolRuntime())
  return ctx
}

/**
 * Mount the plugin as its own fiber, the way its composition row does.
 *
 * A minimal profile supplies the plugin's own live Config fields; `in-process`
 * is the composed default, and no roster settings namespace is registered, so
 * the default steering no-ops.
 */
async function mountPlugin(ctx: Context, config: Config): Promise<Fiber> {
  const fiber = ctx.plugin({
    name: 'loop-engine-under-test',
    apply: (pluginCtx: Context) => { apply(pluginCtx, config) },
  })
  await fiber
  cleanups.push(async () => { await fiber.dispose() })
  return fiber
}

/**
 * Mount the base bundle's in-process loop on its own fiber.
 *
 * Direct construction on an inject-scoped fiber is what the base row's
 * `cordis.yml` entry resolves to, and it is the same shape the plugin uses for
 * the router. The fiber owns the `agentLoop` registration, so disposing it is
 * exactly what the harness's live patch reload does to the base row.
 */
async function mountBaseLoop(ctx: Context): Promise<Fiber> {
  const fiber = ctx.plugin({
    name: 'base-agent-loop',
    inject: ['agents', 'sessions', 'systemPrompt', 'sessionProjections'],
    apply: (baseCtx: Context) => { new AgentLoop(baseCtx, { agents: [] }) },
  })
  await fiber
  cleanups.push(async () => { await fiber.dispose() })
  return fiber
}

/** Mount the plugin with a live Config for the profile's own fields. */
function withLive(ctx: Context, config: Config): Config {
  const live = createLiveLoopConfig(ctx, { engine: 'in-process' })
  return { ...config, ...live.config }
}

/** A patch file path inside a fresh temp directory. */
async function patchPath(): Promise<string> {
  return join(await tempDir(), 'cordis.patch.yml')
}

/** A stand-in for a factory that already owns the single AgentFactory slot. */
function fakeAgentFactory(): AgentFactory {
  return {
    createAgent: vi.fn(async () => { throw new Error('the occupying factory must not serve sessions') }),
    resume: vi.fn(async () => { throw new Error('the occupying factory must not serve sessions') }),
  } as unknown as AgentFactory
}

/** Every logged error mentioning the router's failed start. */
function routerErrors(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map(call => String(call[0]))
    .filter(message => message.includes('could not start the loop router'))
}

describe('the router mount retry window', () => {
  it('retries while the base loop holds the slot, then mounts the router once it is released', async () => {
    const ctx = await boot()
    const base = await mountBaseLoop(ctx)
    expect(ctx.get('agentLoop') instanceof AgentLoop).toBe(true)
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})

    await mountPlugin(ctx, withLive(ctx, { patchPath: await patchPath() }))
    // Settle past several retry ticks with the base row still composed: the
    // mount attempts have been refused — and the window armed — before the row
    // is dropped, so what takes the slot below can only be a retry.
    await new Promise(resolve => setTimeout(resolve, 120))
    // The harness's live patch reload is what drops the row mid-window here.
    await base.dispose()

    // The service the retry took is the router, not the base loop it replaced:
    // `RouterLoop` is constructed nowhere else.
    await vi.waitFor(() => {
      expect(ctx.get('agentLoop') instanceof RouterLoop).toBe(true)
    }, { timeout: 8000 })
    // No give-up was reported: the window closed by succeeding.
    expect(routerErrors(errorSpy)).toEqual([])

    // The router pins the harness loop's parallel-call cap to the harness
    // default, expressed per generation: the 0.1.7 line requires a live field
    // (`super` bypasses the schema transform, so the reference is the router's
    // own), while the 0.1.5 line keeps a plain number the base loop defaults.
    const routerConfig = (ctx.get('agentLoop') as RouterLoop).config
    const cap = LEGACY_HARNESS
      ? routerConfig.maxParallelToolCalls as unknown as number
      : (routerConfig.maxParallelToolCalls as unknown as { get(): number }).get()
    expect(cap).toBe(DEFAULT_MAX_PARALLEL_TOOL_CALLS)

    // The retried router is a working factory, not merely a claimed name: an
    // in-process session is served through it.
    const handle = await ctx.agents.create({
      sessionId: SessionId('router-mount-in-process'),
      meta: { agentPreset: SOURCE_PRESET_ID },
    })
    expect(handle.agent).toBeDefined()
    expect(handle.agent.id).toBe('router-mount-in-process')
    await handle.dispose()
  }, 20000)

  it('gives up loud when the base loop never releases the slot', async () => {
    const ctx = await boot()
    await mountBaseLoop(ctx)
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})

    await mountPlugin(ctx, withLive(ctx, { patchPath: await patchPath() }))

    // 40 attempts at 50ms: the window exhausts with the base row still active,
    // and the router's inability to take the slot is reported once.
    await vi.waitFor(() => {
      expect(routerErrors(errorSpy)).toHaveLength(1)
    }, { timeout: 20000, interval: 100 })
    expect(routerErrors(errorSpy)[0]).toContain('service "agentLoop" has been registered')
    // The deployment keeps running the loop it had: the base row still owns the
    // service name, and the router never got constructed.
    expect(ctx.get('agentLoop') instanceof AgentLoop).toBe(true)
    expect(ctx.get('agentLoop') instanceof RouterLoop).toBe(false)

    // The exhausted window stays exhausted: no further attempt is armed, so no
    // second report lands and the base loop still keeps the slot.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(routerErrors(errorSpy)).toHaveLength(1)
    expect(ctx.get('agentLoop') instanceof RouterLoop).toBe(false)
  }, 40000)

  it('stops retrying when the plugin is unloaded mid-window', async () => {
    const ctx = await boot()
    const base = await mountBaseLoop(ctx)
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const fiber = await mountPlugin(ctx, withLive(ctx, { patchPath: await patchPath() }))

    // Settle past a few retry ticks: every refused attempt re-arms the timer,
    // so the plugin's cleanup effect definitely finds one pending.
    await new Promise(resolve => setTimeout(resolve, 150))

    // Unload the plugin FIRST: its cleanup effect clears the pending retry.
    await fiber.dispose()
    // The slot frees only afterwards, so the only thing that could have taken
    // it is the retry that was just cleared.
    await base.dispose()
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(ctx.get('agentLoop')).toBeUndefined()
    expect(routerErrors(errorSpy)).toEqual([])
  }, 20000)

  it('fails loud without retrying when nothing holds the slot', async () => {
    const ctx = await boot()
    // The kernel of the collision guard: retrying is for a live base loop under
    // the router's own service name. Here the `agentLoop` name is free and a
    // foreign factory owns the single slot, which is deployment trouble — no
    // window can fix it, so it is reported once and abandoned.
    ctx.agents.setFactory(fakeAgentFactory())
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})

    await mountPlugin(ctx, withLive(ctx, { patchPath: await patchPath() }))
    await vi.waitFor(() => {
      expect(routerErrors(errorSpy)).toHaveLength(1)
    }, { timeout: 8000 })
    expect(routerErrors(errorSpy)[0]).toContain('an agent factory is already registered')

    // One report, no retry: the window is armed only for the service-name
    // collision.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(routerErrors(errorSpy)).toHaveLength(1)
  }, 20000)
})
