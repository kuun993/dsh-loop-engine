/**
 * Coverage edges for the Claude Code driver and factory: commit vetoes,
 * empty-step completion, mid-turn input chaining, ownership races, and the
 * resume cancellation paths that the happy-path suites cannot reach.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  Context,
  type Fiber,
} from '@deepseek-ai/cordis'
import type {
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry, {
  assembleContextFor,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ClaudeCodeLoop } from '../../src/engine-claude/loop.ts'
/** Local plugin wrapper: mount constructs the Claude Code loop factory (the engine module is a library, not a Cordis plugin). */
const loopPlugin = {
  inject: ['agents', 'sessions', 'systemPrompt', 'subprocess'],
  apply: (ctx: Context, config: Record<string, unknown>): void => {
    void new ClaudeCodeLoop(ctx, config as Parameters<typeof ClaudeCodeLoop>[1])
  },
}
import { DEFAULT_DISPOSE_GRACE_MS } from '../../src/engine-claude/sdk.ts'

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

function assistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: `u-${text}`,
    session_id: 's-1',
    message: {
      id: 'msg-1',
      container: null,
      context_management: null,
      role: 'assistant',
      type: 'message',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      model: 'claude-sonnet-4-5',
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        inference_geo: null,
        input_tokens: 3,
        iterations: null,
        output_tokens: 2,
        server_tool_use: null,
      },
    },
  } as unknown as SDKMessage
}

function successResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: null,
      input_tokens: 3,
      iterations: null,
      output_tokens: 2,
      server_tool_use: null,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: 'u-result',
    session_id: 's-result',
  } as unknown as SDKMessage
}

async function harness(withLoop = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  if (withLoop) await ctx.plugin(loopPlugin, {})
  return ctx
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One query whose generator blocks on a gate after its first assistant turn. */
function gatedQuery(): { query: Query; release: () => void; entered: Promise<void> } {
  let release: (() => void) | undefined
  let markEntered: (() => void) | undefined
  const entered = new Promise<void>((resolve) => { markEntered = resolve })
  return {
    entered,
    release: () => { release?.() },
    query: Object.assign((async function* (): AsyncGenerator<SDKMessage> {
      yield assistantText('first')
      markEntered?.()
      await new Promise<void>((resolve) => { release = resolve })
      yield assistantText('late')
      yield successResult()
    })(), { close: vi.fn() }) as unknown as Query,
  }
}

describe('commit vetoes', () => {
  it('reports a turn/start commit veto and preserves the inbox', async () => {
    const ctx = await harness()
    try {
      let vetoed = false
      ctx.on('internal/dispatch', (_mode, name, args) => {
        if (name !== 'session/event') return
        const event = args[1] as SessionEvent
        if (event.type === 'turn/start' && !vetoed) {
          vetoed = true
          throw new Error('reject turn-start before commit')
        }
      })
      const errors: Error[] = []
      ctx.on('agent/error', ({ error }) => {
        if (error instanceof Error) errors.push(error)
      })
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('turnstart-veto'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start'
        || event.type === 'user/message')).toBe(false)
      expect(agent.inbox.nextTurn).toHaveLength(1)
      expect(errors.map(error => error.message)).toEqual(['reject turn-start before commit'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a turn/end commit veto without dropping the next turn', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      let vetoed = false
      ctx.on('internal/dispatch', (_mode, name, args) => {
        if (name !== 'session/event') return
        const event = args[1] as SessionEvent
        if (event.type === 'turn/end' && !vetoed) {
          vetoed = true
          throw new Error('reject turn-end before commit')
        }
      })
      const errors: Error[] = []
      ctx.on('agent/error', ({ error }) => {
        if (error instanceof Error) errors.push(error)
      })
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('turnend-veto'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(errors.map(error => error.message)).toEqual(['reject turn-end before commit'])
      // The loop survives: a second turn commits its boundary normally.
      queryMock.mockImplementation(() => stream([assistantText('again'), successResult()]))
      agent.followup(message('again'))
      await agent.whenIdle()
      const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
      expect(ends).toHaveLength(1)
      expect(ends[0]).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('empty-step completion', () => {
  it('closes an emptied first proposal as a completed turn without a query', async () => {
    const ctx = await harness()
    try {
      ctx.on('agent/pre-step', async () => ({ kind: 'enter', messages: [] }))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('empty-first'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(queryMock).not.toHaveBeenCalled()
      const end = agent.session.snapshotEvents().at(-1)
      expect(end).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('breaks a completed multi-step turn when the next proposal is emptied', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('step one'), successResult()]))
      let proposals = 0
      ctx.on('agent/pre-step', async (_payload, next) => {
        proposals += 1
        return proposals === 2 ? { kind: 'enter', messages: [] } : next()
      })
      let injected = false
      ctx.on('agent/turn-stopping', ({ agent: subject }) => {
        if (injected) return
        injected = true
        subject.inject(message('continue'))
      })
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('empty-second'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(proposals).toBe(2)
      expect(queryMock).toHaveBeenCalledTimes(1)
      const end = agent.session.snapshotEvents().at(-1)
      expect(end).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('mid-turn input chaining', () => {
  it('chains into the next turn when a followup arrives mid-turn', async () => {
    const ctx = await harness()
    try {
      const g1 = gatedQuery()
      queryMock.mockImplementation(() => g1.query)
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('chain-followup'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await g1.entered
      agent.followup(message('two')) // queued in next-turn while turn 1 runs
      g1.release()
      queryMock.mockImplementation(() => stream([assistantText('second'), successResult()]))
      await agent.whenIdle()
      const starts = agent.session.snapshotEvents().filter(event => event.type === 'turn/start')
      expect(starts).toHaveLength(2)
      const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
      expect(users).toHaveLength(2)
      expect(queryMock).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('continues into the next step when a steer arrives mid-turn', async () => {
    const ctx = await harness()
    try {
      const g1 = gatedQuery()
      queryMock.mockImplementation(() => g1.query)
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('chain-steer'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await g1.entered
      agent.steer(message('interrupt')) // next-step, wakes during running
      g1.release()
      queryMock.mockImplementation(() => stream([assistantText('second'), successResult()]))
      await agent.whenIdle()
      const steps = agent.session.snapshotEvents().filter(event => event.type === 'step/start')
      expect(steps).toHaveLength(2)
      expect(queryMock).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not latch a wake after a disposed cancel', async () => {
    const ctx = await harness()
    try {
      const g1 = gatedQuery()
      queryMock.mockImplementation(() => g1.query)
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('disposed-latch'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await g1.entered
      agent.cancel({ kind: 'disposed' })
      agent.followup(message('after')) // sent while aborted with a disposed cause
      g1.release()
      await agent.whenIdle()
      expect(agent.inbox.nextTurn).toHaveLength(1)
      const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
      expect(ends[0]).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
      expect(ends).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('query controller edges', () => {
  it('projects the SDK spawn request through the shared process owner', async () => {
    const ctx = await harness()
    try {
      const { handle, done } = fakeChild()
      const spawnSpy = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
      queryMock.mockImplementation(({ options }) => (async function* (): AsyncGenerator<SDKMessage> {
        options.spawnClaudeCodeProcess?.({
          command: 'claude',
          args: ['--print'],
          cwd: process.cwd(),
          env: { HOME: '/tmp' },
          signal: new AbortController().signal,
        })
        yield assistantText('ok')
        yield successResult()
      })() as unknown as Query)
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('spawn-projection'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      const spec = spawnSpy.mock.calls[0]![0] as unknown as { argv: string[]; cwd: string; graceMs: number }
      expect(spec.argv).toEqual(['claude', '--print'])
      expect(spec.graceMs).toBeGreaterThan(0)
      expect(done).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('factory ownership races', () => {
  it('rolls back a half-built agent when the caller unloads during scope minting', async () => {
    const ctx = await harness(false)
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
})

describe('resume cancellation and ownership', () => {
  async function persistentHarness(root: string): Promise<Context> {
    const ctx = await harness(false)
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
    // Seed through a write handle directly: an unpublished session's events
    // never route into a backend (live routing starts at agent publication).
    const session = ctx.sessions.prepare(sessionId, { seed })
    const handle = await ctx.sessionPersistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
    })
    await handle.append(session.snapshotEvents())
    await handle.close()
    await ctx.fiber.dispose()
  }

  it('rejects a resume with a pre-aborted signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-cov-resume-'))
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

  it('releases an abandoned write handle when the resume caller cancels the load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-cov-resume-'))
    try {
      const sessionId = SessionId('resume-abandoned')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        const gate = Promise.withResolvers<SessionHandle>()
        const started = Promise.withResolvers<undefined>()
        const closed = vi.fn(async () => {})
        ctx.sessionPersistence.open = () => {
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
        gate.resolve({ close: closed } as unknown as SessionHandle)
        await expect(resuming).rejects.toThrow('cancel load')
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        expect(closed).toHaveBeenCalledTimes(1)
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a resume when the loop deactivates after load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-cov-resume-'))
    try {
      const sessionId = SessionId('resume-loop-inactive')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        const loop = ctx.agentLoopClaudeCode as unknown as {
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

  it('propagates an open failure that is not a cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-cov-resume-'))
    try {
      const sessionId = SessionId('resume-open-boom')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        ctx.sessionPersistence.open = () => Promise.reject(new Error('open boom'))
        await expect(ctx.agents.resume({
          resumeSessionId: sessionId,
        })).rejects.toThrow('open boom')
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the read failure primary when the abandoned handle close also fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-cov-resume-'))
    try {
      const sessionId = SessionId('resume-read-boom')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        const closed = vi.fn(async () => { throw new Error('close boom') })
        ctx.sessionPersistence.open = () => Promise.resolve({
          read: () => Promise.reject(new Error('read boom')),
          close: closed,
        } as unknown as SessionHandle)
        await expect(ctx.agents.resume({
          resumeSessionId: sessionId,
        })).rejects.toThrow('read boom')
        expect(closed).toHaveBeenCalledTimes(1)
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('swallows an open that fails after the resume caller cancels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-cov-resume-'))
    try {
      const sessionId = SessionId('resume-late-failure')
      await seedSession(root, sessionId)
      const ctx = await persistentHarness(root)
      try {
        const gate = Promise.withResolvers<SessionHandle>()
        const started = Promise.withResolvers<undefined>()
        const closed = vi.fn(async () => {})
        ctx.sessionPersistence.open = () => {
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
        expect(closed).not.toHaveBeenCalled()
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('create persistence and cancellation', () => {
  async function persistentHarness(root: string): Promise<Context> {
    const ctx = await harness(false)
    await ctx.plugin(loopPlugin, {})
    await ctx.plugin(JsonlSessionPersistence, { root })
    return ctx
  }

  it('closes an abandoned write handle when the create caller cancels the store claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-cov-create-'))
    try {
      const ctx = await persistentHarness(root)
      try {
        const gate = Promise.withResolvers<SessionHandle>()
        const started = Promise.withResolvers<undefined>()
        // A rejecting close proves the abandonment release swallows it.
        const closed = vi.fn(async () => { throw new Error('close boom') })
        ctx.sessionPersistence.create = () => {
          started.resolve(undefined)
          return gate.promise
        }
        const controller = new AbortController()
        const creating = ctx.agents.create({
          sessionId: SessionId('create-abandoned'),
          meta: { cwd: process.cwd() },
          signal: controller.signal,
        })
        await started.promise
        controller.abort(new Error('cancel create'))
        gate.resolve({ close: closed } as unknown as SessionHandle)
        await expect(creating).rejects.toThrow('cancel create')
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        expect(closed).toHaveBeenCalledTimes(1)
        expect(ctx.agents.get(SessionId('create-abandoned'))).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('closes the claimed handle when agent preparation fails after the store claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-cov-create-'))
    try {
      const ctx = await persistentHarness(root)
      try {
        const closed = vi.fn(async () => { throw new Error('close boom') })
        ctx.sessionPersistence.create = () => Promise.resolve({ close: closed } as unknown as SessionHandle)
        const loop = ctx.agentLoopClaudeCode as unknown as { prepare: (...args: never[]) => unknown }
        vi.spyOn(loop, 'prepare').mockImplementationOnce(() => { throw new Error('prepare boom') })
        await expect(ctx.agents.create({
          sessionId: SessionId('create-prepare-boom'),
          meta: { cwd: process.cwd() },
        })).rejects.toThrow('prepare boom')
        expect(closed).toHaveBeenCalledTimes(1)
        expect(ctx.agents.get(SessionId('create-prepare-boom'))).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('propagates a prepare failure without a backend and leaves no residue', async () => {
    const ctx = await harness()
    try {
      const loop = ctx.agentLoopClaudeCode as unknown as { prepare: (...args: never[]) => unknown }
      vi.spyOn(loop, 'prepare').mockImplementationOnce(() => { throw new Error('prepare boom') })
      await expect(ctx.agents.create({
        sessionId: SessionId('create-prepare-bare'),
        meta: { cwd: process.cwd() },
      })).rejects.toThrow('prepare boom')
      expect(ctx.agents.get(SessionId('create-prepare-bare'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('treats a signal aborted before the store claim settles as a cancelled create', async () => {
    const ctx = await harness()
    try {
      const controller = new AbortController()
      const creating = ctx.agents.create({
        sessionId: SessionId('create-sync-abort'),
        meta: { cwd: process.cwd() },
        signal: controller.signal,
      })
      // No persistence backend: the store claim resolves empty; the abort
      // landing first cancels the create before setup starts.
      controller.abort(new Error('sync abort'))
      await expect(creating).rejects.toThrow('sync abort')
      expect(ctx.agents.get(SessionId('create-sync-abort'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the setup failure primary when the rollback handle close fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-cov-create-'))
    try {
      const ctx = await persistentHarness(root)
      try {
        const closed = vi.fn(async () => { throw new Error('close boom') })
        ctx.sessionPersistence.create = () => Promise.resolve({ close: closed } as unknown as SessionHandle)
        await expect(ctx.agents.create({
          sessionId: SessionId('create-setup-close-boom'),
          meta: { cwd: process.cwd() },
          setup: () => { throw new Error('setup failed') },
        })).rejects.toThrow('setup failed')
        expect(closed).toHaveBeenCalledTimes(1)
        expect(ctx.agents.get(SessionId('create-setup-close-boom'))).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forwards seed and inheritedEventCount into the prepared session', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('create-seeded-count'),
        meta: { cwd: process.cwd(), isSeeded: true },
        seed: [{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }],
        inheritedEventCount: SessionLogOffset(1),
      })
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
      expect(agent.session.inheritedEventCount).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('configuration and assembly surfaces', () => {
  it('resolves an explicit deployment configuration', async () => {
    const ctx = await harness(false)
    try {
      await ctx.plugin(loopPlugin, {
        permissionMode: 'plan',
        env: { CC_ENV: '1' },
        model: 'deployment-model',
        disposeGraceMs: 4321,
        maxTurns: 7,
      })
      expect(ctx.agentLoopClaudeCode.config).toMatchObject({
        permissionMode: 'plan',
        env: { CC_ENV: '1' },
        model: 'deployment-model',
        disposeGraceMs: 4321,
        maxTurns: 7,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves schema defaults when constructed without the plugin schema', async () => {
    const ctx = await harness(false)
    try {
      const loop = new ClaudeCodeLoop(ctx, {})
      expect(loop.config).toMatchObject({
        env: {},
        disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
      })
      // An unpinned permission mode follows the session's dsh permission knobs.
      expect(loop.config.permissionMode).toBeUndefined()
      expect(loop.config.model).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves the loop prompt variables through system prompt assembly', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('assemble-vars'),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: 'claude-code', model: 'claude-sonnet-4-5' },
      })
      const withAgent = await ctx.systemPrompt.assemble(assembleContextFor(agent))
      expect(withAgent.variables.provider).toBe('claude-code')
      expect(withAgent.variables.model).toBe('claude-sonnet-4-5')
      expect(withAgent.variables.cwd).toBe(process.cwd())
      const withoutAgent = await ctx.systemPrompt.assemble({})
      expect(withoutAgent.variables.provider).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

function fakeChild(): {
  handle: SubprocessHandle
  done: Promise<{ exitCode: number; signal: null }>
  resolveDone: (outcome: { exitCode: number; signal: null }) => void
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let resolveDone: (outcome: { exitCode: number; signal: null }) => void = () => {}
  const done = new Promise<{ exitCode: number; signal: null }>((resolve) => { resolveDone = resolve })
  return {
    handle: {
      pid: 4242,
      stdin,
      stdout,
      stderr: undefined,
      collected: { stderr: [], stdout: [] },
      done: done as unknown as Promise<unknown>,
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => true),
    } as unknown as SubprocessHandle,
    done,
    resolveDone,
  }
}
