/**
 * Router-turn suite: a real in-process turn driven through the mounted router.
 *
 * The inject-gate suite pins the router context's ability to RESOLVE every
 * service the harness loop declares; this one runs the thing that resolution
 * exists for. `apply()` mounts the router, an `in-process` session is created
 * through the registry (so it goes through the router's own `createAgent`), and
 * the turn is driven to a completed `turn/end` against a canned model.
 *
 * Nothing about CREATING an agent reads the loop services through an
 * inject-scoped accessor; assembling the first prompt and running the first step
 * do. A router gate that lists too few names therefore passes every
 * create-time assertion and fails here, as a `turn/end` whose `reason.kind` is
 * `error` carrying `cannot get property "<service>" without inject`.
 *
 * @module tests/router-turn
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, type Config } from '../src/index.ts'
import { SOURCE_PRESET_ID } from '../src/preset.ts'
import { createLiveLoopConfig } from './helpers/fake-settings.ts'
import { fakeSessionProjections } from './helpers/session-projections.ts'
import { fakeToolRuntime } from './helpers/tool-runtime.ts'

/** The provider route the canned adapter serves. */
const PROVIDER = 'canned'
/** The model id every request in this suite asks for. */
const MODEL = 'canned-model'

/** One scripted assistant step: a text block, usage, and a normal stop. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * A model that streams one scripted step per call and records every request.
 *
 * The turn under test declares no tools and the scripted step calls none, so the
 * tool scheduler is never reached; the loop only needs a route that answers.
 */
class CannedAdapter extends LlmAdapter {
  /** Every request this adapter was asked to stream, in order. */
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.script.shift()
    if (step === undefined) throw new Error('CannedAdapter: script exhausted')
    for (const chunk of step) yield chunk
  }
}

/**
 * The slice of the host tool runtime a prompt contribution reads.
 *
 * `@deepseek-ai/dsh-tools` is not a dependency of this package, so the probe
 * reaches the registry structurally, exactly as this package's own sources do.
 */
interface ToolRegistrySlice {
  get(name: string, scope: unknown): unknown
}

/**
 * The agent-scoped prompt contribution a real profile composes.
 *
 * `@deepseek-ai/dsh-file-reference-local` installs a section on a fiber injected
 * with `systemPrompt` and `tools` under `agent.ctx`, and its text provider reads
 * the tool registry through `agent.ctx` — the loop's context, one scope up. This
 * probe reproduces that shape so the live turn below carries an agent-scoped read
 * of a loop service through prompt assembly, which is where the user-visible
 * `cannot get property "tools" without inject` originated.
 */
function toolReadingPromptProbe() {
  return {
    name: 'tool-reading-prompt-probe',
    inject: ['agents'],
    apply: (probeCtx: Context): void => {
      const install = (agent: Agent): void => {
        agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
          scope.systemPrompt.section({
            name: 'probe:tool-roster',
            // Any finite order: sections are concatenated by it.
            order: 1000,
            text: () => {
              const tools = (agent.ctx as unknown as Record<string, unknown>)['tools'] as ToolRegistrySlice
              return tools.get('read', agent) === undefined ? '' : 'tools are available'
            },
          })
        })
      }
      for (const agent of probeCtx.agents.list()) install(agent)
      probeCtx.on('agent/created', ({ agent }) => { install(agent) })
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
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-router-turn-'))
  cleanups.push(async () => {
    // Renaming a just-written file can leave the Windows directory entry stale;
    // Node's built-in retry handles ENOTEMPTY/EBUSY/EPERM.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/** One booted router, mounted through `apply` the way its composition row mounts it. */
interface App {
  readonly ctx: Context
  readonly adapter: CannedAdapter
}

/**
 * Boot the services the plugin's composition assumes, then mount the plugin.
 *
 * A fresh `$DSH_HOME` is stubbed per test, so the presets `apply` authors land in
 * the test's temp directory instead of the developer's real `~/.dsh`.
 * @param script - one scripted assistant step per expected model call.
 */
async function boot(script: StreamChunk[][]): Promise<App> {
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
  ctx.provide('sessionProjections', fakeSessionProjections(ctx))
  ctx.provide('tools', fakeToolRuntime())
  const adapter = new CannedAdapter(script)
  ctx.llm.registerAdapter([PROVIDER], adapter)

  const probeFiber = ctx.plugin(toolReadingPromptProbe())
  await probeFiber
  cleanups.push(async () => { await probeFiber.dispose() })

  // The plugin's own live Config fields: a minimal profile supplies both
  // references, and `in-process` is the composed default.
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
  return { ctx, adapter }
}

/** Create one in-process session through the registry, i.e. through the router. */
function createSession(app: App, sessionId: string): Promise<AgentHandle> {
  return app.ctx.agents.create({
    sessionId: SessionId(sessionId),
    meta: { agentPreset: SOURCE_PRESET_ID },
    agentOptions: { provider: PROVIDER, model: MODEL },
  })
}

/** One user text message, shaped the way a client submits it. */
function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** The last event in a session log, as the turn's own outcome. */
function lastEvent(handle: AgentHandle): SessionEvent | undefined {
  return handle.agent.session.snapshotEvents().at(-1)
}

describe('a turn through the mounted router', () => {
  it('drives an in-process session to a completed turn/end', async () => {
    const app = await boot([textResponse('hello from the router')])
    const handle = await createSession(app, 'router-turn')

    handle.agent.followup(userMessage('hi'))
    await handle.agent.whenIdle()

    // The assistant step ran and the turn closed on its own terms. A service the
    // turn's machinery (or an agent-scoped contribution) cannot resolve does not
    // throw out of this test: the loop converts it into `turn/end` with an
    // `error` reason, and no request ever reaches the adapter.
    expect(app.adapter.requests).toHaveLength(1)
    expect(app.adapter.requests[0]?.model).toBe(MODEL)
    const events = handle.agent.session.snapshotEvents()
    expect(events.map(event => event.type)).toContain('assistant/message')
    expect(lastEvent(handle)).toMatchObject({
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    })

    await handle.dispose()
  }, 30000)
})
