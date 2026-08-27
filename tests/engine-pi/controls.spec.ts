/**
 * Control-flow coverage for the Pi driver: steering, injection, cancellation,
 * maintenance, multi-step turns, commit vetoes, configuration boundaries, and
 * defensive guards that the happy-path suite cannot reach.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { PiLoop, PI_SANDBOX_MODES } from '../../src/engine-pi/loop.ts'
import type { PiMessage } from '../../src/engine-pi/rpc/types.ts'

/** Local plugin wrapper: mount constructs the Pi loop factory (the engine module is a library, not a Cordis plugin). */
const loopPlugin = {
  inject: ['agents', 'sessions', 'systemPrompt', 'subprocess'],
  apply: (ctx: Context, config: Record<string, unknown>): void => {
    void new PiLoop(ctx, config as Parameters<typeof PiLoop>[1])
  },
}

const mock = vi.hoisted(() => {
  const defaultEvents = async function* (): AsyncGenerator<Record<string, unknown>> {
    for (const event of mock.eventsYield()) yield event
  }
  const client = {
    closed: false,
    newSession: vi.fn(async () => ({ type: 'response', command: 'new_session', success: true, id: 1 })),
    prompt: vi.fn(async () => ({ type: 'response', command: 'prompt', success: true, id: 2 })),
    abort: vi.fn(async () => ({ type: 'response', command: 'abort', success: true, id: 3 })),
    clearEvents: vi.fn(),
    dispose: vi.fn(),
    events: defaultEvents,
  }
  return {
    client,
    eventsYield: vi.fn<() => Record<string, unknown>[]>(),
    created: [] as Array<{ spec: Record<string, unknown> }>,
    resetEvents: (): void => { client.events = defaultEvents },
  }
})

vi.mock('../../src/engine-pi/rpc/client.ts', () => ({
  PiRpcClient: {
    create: vi.fn((spec: Record<string, unknown>) => {
      mock.created.push({ spec })
      return mock.client
    }),
  },
}))

beforeEach(() => {
  mock.created.length = 0
  mock.eventsYield.mockReset()
  mock.resetEvents()
  mock.client.newSession.mockClear()
  mock.client.prompt.mockClear()
  mock.client.abort.mockClear()
  mock.client.clearEvents.mockClear()
  mock.client.dispose.mockClear()
  mock.client.closed = false
})

function assistantMessage(text: string): PiMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function ok(text: string): Record<string, unknown>[] {
  return [
    { type: 'message_start', message: assistantMessage(text) },
    { type: 'message_end', message: assistantMessage(text) },
    { type: 'turn_end', message: assistantMessage(text) },
    { type: 'agent_settled' },
  ]
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

describe('steering and injection', () => {
  it('consumes injected and steered messages in one step batch', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(ok('done'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('steer-s'),
        meta: { cwd: process.cwd() },
      })
      agent.inject(message('queued first'))
      agent.steer(message('steered second'))
      await agent.whenIdle()
      const users = agent.session.events.filter(event => event.type === 'user/message')
      expect(users.map(event => (event as never as { data: { content: Array<{ text: string }> } }).data.content[0]!.text))
        .toEqual(['queued first', 'steered second'])
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears the inbox on a hard cancel and notifies the discarded message', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(ok('ok'))
      const discarded: string[] = []
      ctx.on('agent/inbox/discarded', ({ message: subject }) => {
        discarded.push(subject.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
      })
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('discard-s'),
        meta: { cwd: process.cwd() },
      })
      agent.inject(message('to be discarded'))
      agent.cancel({ kind: 'user' })
      expect(discarded).toEqual(['to be discarded'])
      agent.followup(message('go'))
      await agent.whenIdle()
      const users = agent.session.events.filter(event => event.type === 'user/message')
      expect(users.map(event => (event as never as { data: { content: Array<{ text: string }> } }).data.content[0]!.text))
        .toEqual(['go'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the inbox when cancel requests it', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(ok('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('keep-s'),
        meta: { cwd: process.cwd() },
      })
      agent.inject(message('kept'))
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      agent.followup(message('go'))
      await agent.whenIdle()
      const users = agent.session.events.filter(event => event.type === 'user/message')
      expect(users.map(event => (event as never as { data: { content: Array<{ text: string }> } }).data.content[0]!.text))
        .toEqual(['kept', 'go'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('maintenance', () => {
  it('runs a job against the maintenance signal and returns to idle', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('maintain-s'),
        meta: { cwd: process.cwd() },
      })
      const result = await agent.runMaintenance(async (signal) => {
        expect(signal.aborted).toBe(false)
        return 'maintained'
      })
      expect(result).toBe('maintained')
      expect(agent.status).toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a second job while one is active', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('maintain-busy'),
        meta: { cwd: process.cwd() },
      })
      const second = agent.runMaintenance(async () => {})
      expect(() => agent.runMaintenance(async () => {})).toThrow('already has active work')
      await second
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('latch-wakes the driver when a message arrives during maintenance', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(ok('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('maintain-wake'),
        meta: { cwd: process.cwd() },
      })
      const job = agent.runMaintenance(async () => {
        agent.followup(message('wake me'))
        return undefined
      })
      await job
      await agent.whenIdle()
      expect(agent.session.events.some(event => event.type === 'user/message')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not wake without a pending message', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('maintain-quiet'),
        meta: { cwd: process.cwd() },
      })
      await agent.runMaintenance(async () => undefined)
      expect(agent.status).toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('cancellation during a running turn', () => {
  it('aborts the phase and starts a new turn when input arrives', async () => {
    const ctx = await harness()
    try {
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      mock.client.events = async function* (): AsyncGenerator<Record<string, unknown>> {
        yield { type: 'message_start', message: assistantMessage('first') }
        await gate
        yield { type: 'turn_end', message: assistantMessage('late') }
      }
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('running-cancel'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      agent.cancel({ kind: 'user' })
      agent.followup(message('two'))
      release?.()
      mock.resetEvents()
      mock.eventsYield.mockReturnValue(ok('second'))
      await agent.whenIdle()
      const ends = agent.session.events.filter(event => event.type === 'turn/end')
      expect(ends[0]).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
      expect(ends.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
      const users = agent.session.events.filter(event => event.type === 'user/message')
      expect(users).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('swallows a rejected abort() when the client is disposed mid-teardown', async () => {
    const ctx = await harness()
    const originalAbort = mock.client.abort
    try {
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      // Keep the step in-flight so cancellation fires the best-effort abort()
      // while the RPC client is still busy — then reject that abort, exactly as
      // PiRpcClient.dispose() does during an engine switch / scope teardown.
      mock.client.events = async function* (): AsyncGenerator<Record<string, unknown>> {
        yield { type: 'message_start', message: assistantMessage('first') }
        await gate
        yield { type: 'turn_end', message: assistantMessage('late') }
      }
      mock.client.abort = vi.fn(async () => { throw new Error('pi RPC client is disposed') })
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('abort-reject'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      agent.cancel({ kind: 'user' })
      release?.()
      await agent.whenIdle()
      const end = agent.session.events.findLast(event => event.type === 'turn/end')
      expect(end).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    } finally {
      mock.client.abort = originalAbort
      await ctx.fiber.dispose()
    }
  })
})

describe('defensive guards', () => {
  it('rejects a direct turn invocation without a driver reservation', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('turn-guard'),
        meta: { cwd: process.cwd() },
      })
      await expect((agent as unknown as { turn(): Promise<boolean> }).turn())
        .rejects.toThrow('turn without driver reservation')
      expect(agent.status).toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails a step without a working directory', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(ok('ignored'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('no-cwd'),
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const end = agent.session.events.findLast(event => event.type === 'turn/end')
      expect(end).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'UNKNOWN' } } } })
      expect(mock.client.prompt).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

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
      expect(agent.session.events.some(event => event.type === 'turn/start'
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
      mock.eventsYield.mockReturnValue(ok('ok'))
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
      mock.eventsYield.mockReturnValue(ok('again'))
      agent.followup(message('again'))
      await agent.whenIdle()
      const ends = agent.session.events.filter(event => event.type === 'turn/end')
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
      expect(mock.client.prompt).not.toHaveBeenCalled()
      const end = agent.session.events.at(-1)
      expect(end).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('breaks a completed multi-step turn when the next proposal is emptied', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(ok('step one'))
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
      expect(mock.client.prompt).toHaveBeenCalledTimes(1)
      const end = agent.session.events.at(-1)
      expect(end).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('mid-turn input chaining', () => {
  it('does not latch a wake after a disposed cancel', async () => {
    const ctx = await harness()
    try {
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      mock.client.events = async function* (): AsyncGenerator<Record<string, unknown>> {
        yield { type: 'message_start', message: assistantMessage('first') }
        await gate
        yield { type: 'turn_end', message: assistantMessage('late') }
      }
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('disposed-latch'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      agent.cancel({ kind: 'disposed' })
      agent.followup(message('after'))
      release?.()
      await agent.whenIdle()
      expect(agent.inbox.nextTurn).toHaveLength(1)
      const ends = agent.session.events.filter(event => event.type === 'turn/end')
      expect(ends).toHaveLength(1)
      expect(ends[0]).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('chains into the next turn when a followup arrives mid-turn', async () => {
    const ctx = await harness()
    try {
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      let first = true
      mock.client.events = async function* (): AsyncGenerator<Record<string, unknown>> {
        if (first) {
          first = false
          yield { type: 'message_start', message: assistantMessage('first') }
          await gate
          yield { type: 'turn_end', message: assistantMessage('first done') }
          yield { type: 'agent_settled' }
        } else {
          for (const event of mock.eventsYield()) yield event
        }
      }
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('chain-next-turn'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      agent.followup(message('two')) // queued in next-turn while turn 1 runs
      mock.eventsYield.mockReturnValue(ok('second'))
      release?.()
      await agent.whenIdle()
      const starts = agent.session.events.filter(event => event.type === 'turn/start')
      expect(starts).toHaveLength(2)
      const users = agent.session.events.filter(event => event.type === 'user/message')
      expect(users).toHaveLength(2)
      expect(mock.client.prompt).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('continues into the next step when turn-stopping injects input', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(ok('step one'))
      let injected = false
      ctx.on('agent/turn-stopping', ({ agent: subject }) => {
        if (injected) return
        injected = true
        subject.inject(message('continue'))
      })
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('multi-step'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const steps = agent.session.events.filter(event => event.type === 'step/start')
      expect(steps).toHaveLength(2)
      expect(mock.client.prompt).toHaveBeenCalledTimes(2)
      expect(agent.session.events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('configuration validation', () => {
  it('exposes the sandbox modes accepted by the plugin config', () => {
    expect(PI_SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('resolves an explicit deployment configuration', async () => {
    const ctx = await harness(false)
    try {
      await ctx.plugin(loopPlugin, {
        sandboxMode: 'workspace-write',
        provider: 'anthropic',
        model: 'deployment-model',
        thinkingLevel: 'high',
        env: { PI_ENV: '1' },
      })
      expect(ctx.agentLoopPi.config).toMatchObject({
        sandboxMode: 'workspace-write',
        provider: 'anthropic',
        model: 'deployment-model',
        thinkingLevel: 'high',
        env: { PI_ENV: '1' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves schema defaults when constructed without the plugin schema', async () => {
    const ctx = await harness(false)
    try {
      const loop = new PiLoop(ctx, {})
      expect(loop.config).toMatchObject({ env: {} })
      expect(loop.config.sandboxMode).toBeUndefined()
      expect(loop.config.provider).toBeUndefined()
      expect(loop.config.model).toBeUndefined()
      expect(loop.config.thinkingLevel).toBeUndefined()
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
        agentOptions: { provider: 'pi', model: 'pi-model' },
      })
      const withAgent = await ctx.systemPrompt.assemble(assembleContextFor(agent))
      expect(withAgent.variables.provider).toBe('pi')
      expect(withAgent.variables.model).toBe('pi-model')
      expect(withAgent.variables.cwd).toBe(process.cwd())
      const withoutAgent = await ctx.systemPrompt.assemble({})
      expect(withoutAgent.variables.provider).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
