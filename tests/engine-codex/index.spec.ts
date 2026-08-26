/**
 * Factory and lifecycle tests for the Codex loop plugin: registration,
 * HMR-safe disposal, creation options, setup commits, and resume
 * cancellation/ownership paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, symbols, type EffectMeta, type Fiber } from '@deepseek-ai/cordis'
import type { ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk'
import SessionStore, { SessionId, type SessionEvent, type SessionPreparation } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { CodexLoop } from '../../src/engine-codex/loop.ts'

/** Local plugin wrapper: mount constructs the Codex loop factory (the engine module is a library, not a Cordis plugin). */
const loopPlugin = {
  inject: ['agents', 'sessions', 'systemPrompt'],
  apply: (ctx: Context, config: Record<string, unknown>): void => {
    void new CodexLoop(ctx, config as Parameters<typeof CodexLoop>[1])
  },
}

type RunStreamed = (input: string, turnOptions?: { signal?: AbortSignal }) => Promise<{ events: AsyncGenerator<ThreadEvent> }>

const mock = vi.hoisted(() => ({
  runStreamed: vi.fn<RunStreamed>(),
}))

vi.mock('@openai/codex-sdk', () => ({
  Codex: class FakeCodex {
    startThread(): { runStreamed: RunStreamed } {
      return { runStreamed: mock.runStreamed }
    }
  },
}))

beforeEach(() => {
  mock.runStreamed.mockReset()
})

const USAGE: Usage = {
  input_tokens: 3,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 2,
  reasoning_output_tokens: 0,
}

function okStream(): ReturnType<RunStreamed> {
  const events: ThreadEvent[] = [
    { type: 'item.completed', item: { id: 'msg-ok', type: 'agent_message', text: 'ok' } as ThreadItem },
    { type: 'turn.completed', usage: USAGE },
  ]
  async function* inner(): AsyncGenerator<ThreadEvent, void> {
    for (const event of events) yield event
  }
  return Promise.resolve({ events: inner() })
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(loopPlugin, {})
  return ctx
}

/** Reentrantly invoke the `agentLoopCodex.lifecycle(...)` effect. */
function disposeLifecycleEffect(ownerCtx: Context, labelFragment: string): void {
  const lifecycle = [...ownerCtx.fiber._disposables]
    .find((dispose) => {
      const effect = (dispose as typeof dispose & { [symbols.effect]?: EffectMeta })[symbols.effect]
      return effect?.label.includes(labelFragment) === true
    })
  if (lifecycle === undefined) throw new Error(`lifecycle effect ${labelFragment} not found`)
  void lifecycle()
}

const pending = (): Promise<void> => new Promise(() => {})

describe('factory registration and HMR-safe disposal', () => {
  it('clears the factory slot when the owner fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
    await ctx.plugin(AgentRegistry)
    const loopFiber = await ctx.plugin(loopPlugin, {})
    try {
      mock.runStreamed.mockImplementation(() => okStream())
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('hmr-live'),
        meta: { cwd: process.cwd() },
      })
      expect(agent.status).toBe('idle')
      await loopFiber.dispose()
      await expect(ctx.agents.create({
        sessionId: SessionId('hmr-after'),
      })).rejects.toThrow('no agent factory registered')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('createAgent options', () => {
  it('forwards seed and meta into the prepared session', async () => {
    const ctx = await harness()
    try {
      const seed: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      ]
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('seed-s'),
        seed,
        meta: { cwd: process.cwd() },
      })
      expect(agent.session.events.map(event => event.type)).toContain('turn/start')
      expect(agent.session.header.cwd).toBe(process.cwd())
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an already-aborted creation signal before preparing', async () => {
    const ctx = await harness()
    try {
      const reason = new Error('cancelled before creation')
      const controller = new AbortController()
      controller.abort(reason)
      await expect(ctx.agents.create({
        sessionId: SessionId('pre-abort'),
        signal: controller.signal,
      })).rejects.toBe(reason)
      expect(ctx.agents.get(SessionId('pre-abort'))).toBeUndefined()
      expect(ctx.sessions.get(SessionId('pre-abort'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a create whose caller signal pre-aborted with a non-Error reason', async () => {
    const ctx = await harness()
    try {
      const controller = new AbortController()
      controller.abort('operator string reason')
      await expect(ctx.agents.create({
        sessionId: SessionId('pre-aborted-string'),
        signal: controller.signal,
      })).rejects.toThrow(/creation aborted/)
      expect(ctx.agents.get(SessionId('pre-aborted-string'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs a setup commit before publishing', async () => {
    const ctx = await harness()
    try {
      let committed = 0
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('setup-commit'),
        meta: { cwd: process.cwd() },
        setup: () => ({ commit: () => { committed += 1 } }),
      })
      expect(committed).toBe(1)
      expect(agent.status).toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('disposes and rethrows when setup fails', async () => {
    const ctx = await harness()
    try {
      await expect(ctx.agents.create({
        sessionId: SessionId('setup-throw'),
        meta: { cwd: process.cwd() },
        setup: () => { throw new Error('setup failed') },
      })).rejects.toThrow('setup failed')
      expect(ctx.agents.get(SessionId('setup-throw'))).toBeUndefined()
      expect(ctx.sessions.get(SessionId('setup-throw'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('aborts a hanging setup and rethrows the cancellation reason', async () => {
    const ctx = await harness()
    try {
      const controller = new AbortController()
      const creating = ctx.agents.create({
        sessionId: SessionId('setup-hang'),
        meta: { cwd: process.cwd() },
        signal: controller.signal,
        setup: pending,
      })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      controller.abort(new Error('cancel setup'))
      await expect(creating).rejects.toThrow('cancel setup')
      expect(ctx.agents.get(SessionId('setup-hang'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('wraps a non-Error abort reason that arrives during a hanging setup', async () => {
    const ctx = await harness()
    try {
      const controller = new AbortController()
      const creating = ctx.agents.create({
        sessionId: SessionId('setup-string-abort'),
        meta: { cwd: process.cwd() },
        signal: controller.signal,
        setup: () => new Promise(() => {}),
      })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      controller.abort('mid-setup string reason')
      await expect(creating).rejects.toThrow(/creation aborted/)
      expect(ctx.agents.get(SessionId('setup-string-abort'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rolls back a mid-setup lifecycle when the owner fiber unloads', async () => {
    const ctx = await harness()
    try {
      const creating = ctx.agents.create({
        sessionId: SessionId('mid-setup'),
        meta: { cwd: process.cwd() },
        setup: pending,
      })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      disposeLifecycleEffect(ctx, 'agentLoopCodex.lifecycle(mid-setup)')
      await expect(creating).rejects.toThrow(/setup aborted: owner disposed during setup/)
      expect(ctx.agents.get(SessionId('mid-setup'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rolls back a half-built agent when the caller unloads during scope minting', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
    await ctx.plugin(AgentRegistry)
    try {
      const loopFiber = await ctx.plugin(loopPlugin, {})
      const gate = Promise.withResolvers<undefined>()
      const cleanupStarted = Promise.withResolvers<undefined>()
      let ownerFiber: Fiber | undefined
      let ownerDisposal: Promise<void> | undefined
      let creating: Promise<AgentHandle> | undefined
      ctx.on('internal/plugin', (fiber) => {
        if (fiber.name !== 'scope' || ownerFiber === undefined) return
        fiber.ctx.effect(() => async () => {
          cleanupStarted.resolve(undefined)
          await gate.promise
        })
        ownerDisposal = ownerFiber.dispose()
      })
      const owner = ctx.plugin(Object.assign((inner: Context) => {
        ownerFiber = inner.fiber
        creating = inner.agents.create({
          sessionId: SessionId('mint-race'),
          meta: { cwd: process.cwd() },
        })
      }, { inject: ['agents'] }))
      await cleanupStarted.promise
      gate.resolve(undefined)
      await expect(creating).rejects.toThrow(/owner disposed during setup/)
      await ownerDisposal
      await owner
      expect(ctx.agents.get(SessionId('mint-race'))).toBeUndefined()
      expect(ctx.sessions.get(SessionId('mint-race'))).toBeUndefined()
      await loopFiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('resume', () => {
  async function persistentHarness(root: string): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(loopPlugin, {})
    await ctx.plugin(JsonlSessionPersistence, { root })
    return ctx
  }

  async function seedSession(root: string, sessionId: SessionId): Promise<void> {
    const ctx = await persistentHarness(root)
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const session = ctx.sessions.create(sessionId, { seed })
    await ctx.sessions.flush(session)
    await ctx.fiber.dispose()
  }

  it('fails loudly when no persistence backend is configured', async () => {
    const ctx = await harness()
    try {
      await expect(ctx.agents.resume({
        resumeSessionId: SessionId('no-persistence'),
      })).rejects.toThrow('session persistence is not configured')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resumes an owned agent from the JSONL backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-resume-'))
    try {
      const sessionId = SessionId('resume-s')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        const { agent } = await ctx.agents.resume({ resumeSessionId: sessionId })
        expect(agent.session.id).toBe(sessionId)
        expect(agent.status).toBe('idle')
        expect(ctx.agents.get(sessionId)).toBe(agent)
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a resume with a pre-aborted signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-resume-'))
    try {
      const sessionId = SessionId('resume-pre-aborted')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        const errorReason = new AbortController()
        errorReason.abort(new Error('resume abandoned'))
        await expect(ctx.agents.resume({
          resumeSessionId: sessionId,
          signal: errorReason.signal,
        })).rejects.toThrow('resume abandoned')

        const stringReason = new AbortController()
        stringReason.abort('resume string reason')
        await expect(ctx.agents.resume({
          resumeSessionId: sessionId,
          signal: stringReason.signal,
        })).rejects.toThrow(/creation aborted/)
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('releases an abandoned preparation when the resume caller cancels the load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-resume-'))
    try {
      const sessionId = SessionId('resume-abandoned')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        const gate = Promise.withResolvers<SessionPreparation>()
        const started = Promise.withResolvers<undefined>()
        const released = vi.fn()
        ctx.sessionPersistence.prepare = () => {
          started.resolve(undefined)
          return gate.promise
        }
        const controller = new AbortController()
        const resuming = ctx.agents.resume({
          resumeSessionId: sessionId,
          signal: controller.signal,
        })
        await started.promise
        controller.abort(new Error('cancel load'))
        gate.resolve({ session: null, [Symbol.dispose]: released } as unknown as SessionPreparation)
        await expect(resuming).rejects.toThrow('cancel load')
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        expect(released).toHaveBeenCalledTimes(1)
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a resume when the loop deactivates after load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-resume-'))
    try {
      const sessionId = SessionId('resume-loop-inactive')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        const loop = ctx.agentLoopCodex as unknown as {
          ownership: { isActive: () => boolean }
        }
        vi.spyOn(loop.ownership, 'isActive').mockReturnValueOnce(false)
        await expect(ctx.agents.resume({
          resumeSessionId: sessionId,
        })).rejects.toThrow('agent loop is not active')
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('propagates a preparation failure that is not a cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-resume-'))
    try {
      const sessionId = SessionId('resume-prepare-boom')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        ctx.sessionPersistence.prepare = () => Promise.reject(new Error('prepare boom'))
        await expect(ctx.agents.resume({
          resumeSessionId: sessionId,
        })).rejects.toThrow('prepare boom')
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('swallows a preparation that fails after the resume caller cancels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-resume-'))
    try {
      const sessionId = SessionId('resume-late-failure')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        const gate = Promise.withResolvers<SessionPreparation>()
        const started = Promise.withResolvers<undefined>()
        const released = vi.fn()
        ctx.sessionPersistence.prepare = () => {
          started.resolve(undefined)
          return gate.promise
        }
        const controller = new AbortController()
        const resuming = ctx.agents.resume({
          resumeSessionId: sessionId,
          signal: controller.signal,
        })
        await started.promise
        controller.abort(new Error('cancel load'))
        gate.reject(new Error('late failure'))
        await expect(resuming).rejects.toThrow('cancel load')
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        expect(released).not.toHaveBeenCalled()
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
