/**
 * Factory and lifecycle tests for the Claude Code loop plugin: registration,
 * HMR-safe disposal, creation options, setup commits, and resume.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Context,
  symbols,
  type EffectMeta,
} from '@deepseek-ai/cordis'
import type {
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ClaudeCodeLoop } from '../../src/engine/loop.ts'
/** Local plugin wrapper: mount constructs the Claude Code loop factory (the engine module is a library, not a Cordis plugin). */
const loopPlugin = {
  inject: ['agents', 'sessions', 'systemPrompt', 'subprocess'],
  apply: (ctx: Context, config: Record<string, unknown>): void => {
    void new ClaudeCodeLoop(ctx, config as Parameters<typeof ClaudeCodeLoop>[1])
  },
}

type QueryFactory = (params: { prompt: string; options: Options }) => Query

const queryMock = vi.hoisted(() => vi.fn<QueryFactory>())
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: queryMock,
}))

beforeEach(() => {
  queryMock.mockReset()
})

function stream(messages: SDKMessage[]): Query {
  async function* inner(): AsyncGenerator<SDKMessage, void> {
    for (const message of messages) yield message
  }
  return Object.assign(inner(), { close: vi.fn() }) as unknown as Query
}

function successResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
  } as unknown as SDKMessage
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(loopPlugin, {})
  return ctx
}

/** Reentrantly invoke the `agentLoopClaudeCode.lifecycle(...)` effect. */
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
    await ctx.plugin(LocalSubprocessRuntime)
    const loopFiber = await ctx.plugin(loopPlugin, {})
    try {
      queryMock.mockImplementation(() => stream([successResult()]))
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

  it('rolls back a mid-setup lifecycle when the owner fiber unloads', async () => {
    const ctx = await harness()
    try {
      const creating = ctx.agents.create({
        sessionId: SessionId('mid-setup'),
        meta: { cwd: process.cwd() },
        setup: pending,
      })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      disposeLifecycleEffect(ctx, 'agentLoopClaudeCode.lifecycle(mid-setup)')
      await expect(creating).rejects.toThrow(/setup aborted: owner disposed during setup/)
      expect(ctx.agents.get(SessionId('mid-setup'))).toBeUndefined()
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
    await ctx.plugin(LocalSubprocessRuntime)
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
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-resume-'))
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
})
