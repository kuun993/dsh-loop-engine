/**
 * Router inject-gate suite: the router's context must be able to serve every
 * service the harness loop declares.
 *
 * The router IS the harness loop for `in-process` sessions, and cordis refuses a
 * service PROPERTY READ on a context whose fiber did not inject that service
 * (`cannot get property "tools" without inject`). Nothing about agent creation
 * touches those accessors, so a gate that lists too few names still mounts, still
 * registers its factory, and still creates agents — and then dies on the first
 * real turn, or the first prompt contribution that reads the loop context.
 *
 * The assertions below are deliberately derived from `AgentLoop.inject` rather
 * than re-listed: a hardcoded list here would reproduce the bug in the test.
 *
 * @module tests/router-inject
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, type Config } from '../src/index.ts'
import { SOURCE_PRESET_ID } from '../src/preset.ts'
import { ROUTER_SERVICES } from '../src/router-loop.ts'
import { createLiveLoopConfig } from './helpers/fake-settings.ts'
import { fakeSessionProjections } from './helpers/session-projections.ts'
import { fakeToolRuntime } from './helpers/tool-runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-router-inject-'))
  cleanups.push(async () => {
    // Renaming a just-written file can leave the Windows directory entry
    // stale; Node's built-in retry handles ENOTEMPTY/EBUSY/EPERM.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/**
 * Boot the services the plugin's composition assumes and mount the plugin, the
 * way its composition row does.
 *
 * A fresh `$DSH_HOME` is stubbed per test, so the presets `apply` authors land in
 * the test's temp directory instead of the developer's real `~/.dsh`.
 * @returns the booted context, with the router already on `agentLoop`.
 */
async function boot(): Promise<Context> {
  vi.stubEnv('DSH_HOME', await tempDir())
  const ctx = new Context()
  // Unload the whole root last, so every service and fiber this test composed
  // is torn down instead of leaving a `process` exit listener per test behind.
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  ctx.provide('sessionProjections', fakeSessionProjections(ctx))
  ctx.provide('tools', fakeToolRuntime())

  // A minimal profile still supplies the plugin's own live Config fields.
  const live = createLiveLoopConfig(ctx, { engine: 'in-process' })
  const config: Config = { patchPath: join(await tempDir(), 'cordis.patch.yml'), ...live.config }
  const fiber = ctx.plugin({
    name: 'loop-engine-under-test',
    apply: (pluginCtx: Context) => { apply(pluginCtx, config) },
  })
  await fiber
  cleanups.push(async () => { await fiber.dispose() })
  // The router claims the single `agentLoop` name; the plugin has an inject gate
  // in front of it, so the registration lands a tick after `apply` returns.
  await vi.waitFor(() => { expect(ctx.get('agentLoop')).toBeDefined() })
  return ctx
}

/** The router's own context, read structurally: `Service` stores it as `this.ctx`. */
function routerContext(ctx: Context): Context {
  return (ctx.get('agentLoop') as unknown as { ctx: Context }).ctx
}

/** Read one service off a context the way a property access resolves it. */
function readService(source: Context, name: string): unknown {
  return (source as unknown as Record<string, unknown>)[name]
}

/** Assert one context resolves every service the harness loop declares. */
function expectResolvesLoopServices(source: Context, label: string): void {
  for (const name of AgentLoop.inject) {
    expect(() => readService(source, name), `${label} must resolve "${name}"`).not.toThrow()
    expect(readService(source, name), `${label} must resolve "${name}" to a service`).toBeDefined()
  }
}

/** Create one in-process session through the router, without running a turn. */
function createSession(ctx: Context, sessionId: string): Promise<AgentHandle> {
  return ctx.agents.create({
    sessionId: SessionId(sessionId),
    meta: { agentPreset: SOURCE_PRESET_ID },
  })
}

describe('the router inject gate', () => {
  it('mounts a router whose context resolves every service the harness loop declares', async () => {
    const ctx = await boot()

    // Read on the mounted router's own context. Cordis recovers an injected
    // name from an ancestor fiber when the context's own gate omitted it, so
    // this read alone does not pin the gate — the agent-scope read below and the
    // roster comparison are what pin it. It stays because the router's context
    // is where the loop's own turn machinery resolves its services.
    expectResolvesLoopServices(routerContext(ctx), 'the router context')
  }, 20000)

  it('resolves those services from the scope context of an agent the router created', async () => {
    const ctx = await boot()
    const handle = await createSession(ctx, 'router-inject-agent')

    // An agent's scope is an isolate boundary: a name the router's gate did not
    // inject is NOT recovered from an ancestor here, which is why a short gate
    // surfaces on the first assembled prompt or the first turn rather than at
    // agent creation. The harness's own agent-scoped contributions read these
    // services through exactly this context (`packages/context/file-reference-local`
    // reads `agent.ctx.tools` while a prompt is assembled).
    expectResolvesLoopServices(handle.agent.ctx as Context, 'the agent scope context')

    await handle.dispose()
  }, 20000)

  it('names exactly the services the harness loop declares', async () => {
    // Belt and braces for the two reads above: the exported gate is what
    // `apply` hands cordis, and a future edit that shortens it must fail here
    // rather than at someone's first turn.
    expect([...ROUTER_SERVICES].sort()).toEqual([...AgentLoop.inject].sort())
  }, 20000)
})
