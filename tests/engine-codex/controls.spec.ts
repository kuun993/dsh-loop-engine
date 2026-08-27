/**
 * Control-flow coverage for the Codex driver: steering, injection,
 * cancellation, maintenance, multi-step turns, commit vetoes, configuration
 * boundaries, and the defensive guards that the happy-path suite cannot reach.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodexLoop, CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES } from '../../src/engine-codex/loop.ts'
import { DEFAULT_DISPOSE_GRACE_MS } from '../../src/engine-codex/sdk.ts'
import type { AppServerEvent } from '../../src/engine-codex/appserver/thread.ts'

/** Local plugin wrapper: mount constructs the Codex loop factory (the engine module is a library, not a Cordis plugin). */
const loopPlugin = {
  inject: ['agents', 'sessions', 'systemPrompt'],
  apply: (ctx: Context, config: Record<string, unknown>): void => {
    void new CodexLoop(ctx, config as Parameters<typeof CodexLoop>[1])
  },
}

type RunStreamed = (input: string, turnOptions?: { signal?: AbortSignal }) => AsyncGenerator<AppServerEvent>

const mock = vi.hoisted(() => ({
  runStreamed: vi.fn<RunStreamed>(),
}))

vi.mock('../../src/engine-codex/appserver/client.ts', () => ({
  AppServerClient: {
    create: async () => ({
      threadStart: async () => ({ thread: { id: 'mock-thread-1' } }),
      threadResume: async () => ({ thread: { id: 'mock-thread-1' } }),
      turnStart: async () => ({ turn: { id: 'mock-turn-1', status: 'inProgress' } }),
      turnInterrupt: async () => ({}),
      onNotification: () => {},
      onStderr: () => {},
      dispose: () => {},
    }),
  },
}))

vi.mock('../../src/engine-codex/appserver/thread.ts', () => ({
  AppServerThread: {
    create: async (_client: unknown, _threadParams: Record<string, unknown>) => ({
      threadId: 'mock-thread-1',
      async *turn(_input: unknown, _options: unknown): AsyncGenerator<AppServerEvent> {
        for await (const event of mock.runStreamed(_input, _options)) {
          yield event
        }
      },
      async dispose() {},
    }),
  },
}))

beforeEach(() => {
  mock.runStreamed.mockReset()
})

function stream(events: AppServerEvent[]): RunStreamed {
  async function* inner(): AsyncGenerator<AppServerEvent, void> {
    for (const event of events) yield event
  }
  return inner()
}

const USAGE = {
  inputTokens: 3,
  cachedInputTokens: 0,
  outputTokens: 2,
  reasoningOutputTokens: 0,
}

function agentMessage(text: string): { type: string; id: string; text: string } {
  return { type: 'agentMessage', id: `msg-${text}`, text }
}

function ok(text: string): AppServerEvent[] {
  return [
    { kind: 'item-completed', item: agentMessage(text) as AppServerEvent extends { kind: 'item-completed'; item: infer T } ? T : never },
    { kind: 'turn-completed', turn: { id: 'turn-1', status: 'completed', error: null, items: [], usage: USAGE } },
  ]
}

async function harness(withLoop = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  if (withLoop) await ctx.plugin(loopPlugin, {})
  return ctx
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One query whose generator blocks on a gate after its first item. */
function gatedQuery(): { release: () => void; entered: Promise<void>; run: RunStreamed } {
  let release: (() => void) | undefined
  let markEntered: (() => void) | undefined
  const entered = new Promise<void>((resolve) => { markEntered = resolve })
  const run: RunStreamed = () => (async function* (): AsyncGenerator<AppServerEvent> {
    yield { kind: 'item-completed', item: agentMessage('first') as AppServerEvent extends { kind: 'item-completed'; item: infer T } ? T : never }
    markEntered?.()
    await new Promise<void>((resolve) => { release = resolve })
    yield { kind: 'item-completed', item: agentMessage('late') as AppServerEvent extends { kind: 'item-completed'; item: infer T } ? T : never }
    yield { kind: 'turn-completed', turn: { id: 'turn-1', status: 'completed', error: null, items: [], usage: USAGE } }
  })()
  return { release: () => { release?.() }, entered, run }
}

describe('steering and injection', () => {
  it('consumes injected and steered messages in one step batch', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream(ok('done')))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('steer-s'),
        meta: { cwd: process.cwd() },
      })
      agent.inject(message('queued first')) // no wakeup
      agent.steer(message('steered second')) // wakeup
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
      mock.runStreamed.mockImplementation(() => stream(ok('ok')))
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
      // Safe followup after the queue was emptied.
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
      mock.runStreamed.mockImplementation(() => stream(ok('ok')))
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
      mock.runStreamed.mockImplementation(() => stream(ok('ok')))
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
      mock.runStreamed.mockImplementation((_input, turnOptions) => (async function* (): AsyncGenerator<AppServerEvent> {
        yield { kind: 'item-completed', item: agentMessage('first') as AppServerEvent extends { kind: 'item-completed'; item: infer T } ? T : never }
        await Promise.race([
          gate,
          new Promise<never>((_, reject) => {
            turnOptions?.signal?.addEventListener('abort', () => {
              reject(new Error('query aborted'))
            }, { once: true })
          }),
        ])
        yield { kind: 'item-completed', item: agentMessage('late') as AppServerEvent extends { kind: 'item-completed'; item: infer T } ? T : never }
        yield { kind: 'turn-completed', turn: { id: 'turn-1', status: 'completed', error: null, items: [], usage: USAGE } }
      })())
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('running-cancel'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      agent.cancel({ kind: 'user' })
      agent.followup(message('two')) // during the aborted running phase
      release?.()
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
      mock.runStreamed.mockImplementation(() => stream(ok('ignored')))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('no-cwd'),
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const end = agent.session.events.findLast(event => event.type === 'turn/end')
      expect(end).toMatchObject({
        data: { reason: { kind: 'error', error: { code: 'UNKNOWN' } } },
      })
      expect(mock.runStreamed).not.toHaveBeenCalled()
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
      mock.runStreamed.mockImplementation(() => stream(ok('ok')))
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
      mock.runStreamed.mockImplementation(() => stream(ok('again')))
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
      expect(mock.runStreamed).not.toHaveBeenCalled()
      const end = agent.session.events.at(-1)
      expect(end).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('breaks a completed multi-step turn when the next proposal is emptied', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream(ok('step one')))
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
      expect(mock.runStreamed).toHaveBeenCalledTimes(1)
      const end = agent.session.events.at(-1)
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
      mock.runStreamed.mockImplementation(g1.run)
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('chain-followup'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await g1.entered
      agent.followup(message('two')) // queued in next-turn while turn 1 runs
      g1.release()
      mock.runStreamed.mockImplementation(() => stream(ok('second')))
      await agent.whenIdle()
      const starts = agent.session.events.filter(event => event.type === 'turn/start')
      expect(starts).toHaveLength(2)
      const users = agent.session.events.filter(event => event.type === 'user/message')
      expect(users).toHaveLength(2)
      expect(mock.runStreamed).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('continues into the next step when a steer arrives mid-turn', async () => {
    const ctx = await harness()
    try {
      const g1 = gatedQuery()
      mock.runStreamed.mockImplementation(g1.run)
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('chain-steer'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await g1.entered
      agent.steer(message('interrupt')) // next-step, wakes during running
      g1.release()
      mock.runStreamed.mockImplementation(() => stream(ok('second')))
      await agent.whenIdle()
      const steps = agent.session.events.filter(event => event.type === 'step/start')
      expect(steps).toHaveLength(2)
      expect(mock.runStreamed).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not latch a wake after a disposed cancel', async () => {
    const ctx = await harness()
    try {
      const g1 = gatedQuery()
      mock.runStreamed.mockImplementation(g1.run)
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
      const ends = agent.session.events.filter(event => event.type === 'turn/end')
      expect(ends[0]).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
      expect(ends).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('multi-step continuation', () => {
  it('continues into the next step when turn-stopping injects input', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream(ok('step one')))
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
      expect(mock.runStreamed).toHaveBeenCalledTimes(2)
      expect(agent.session.events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('configuration validation', () => {
  async function bareContext(): Promise<Context> {
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SystemPrompt, { persona: 'You are the deployment.' })
    await fresh.plugin(AgentRegistry)
    return fresh
  }

  it('rejects a non-finite disposeGraceMs at the config boundary', async () => {
    const fresh = await bareContext()
    try {
      await expect(fresh.plugin(loopPlugin, { disposeGraceMs: Number.NaN }))
        .rejects.toThrow(/disposeGraceMs/)
    } finally {
      await fresh.fiber.dispose()
    }
  })

  it('rejects a disposeGraceMs beyond the timer ceiling', async () => {
    const fresh = await bareContext()
    try {
      await expect(fresh.plugin(loopPlugin, { disposeGraceMs: MAX_TIMER_DELAY_MS + 1 }))
        .rejects.toThrow('disposeGraceMs must be no greater than')
    } finally {
      await fresh.fiber.dispose()
    }
  })

  it('exposes the sandbox modes and approval policies accepted by the plugin config', () => {
    expect(CODEX_SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect(CODEX_APPROVAL_POLICIES).toEqual(['never', 'on-request', 'on-failure', 'untrusted'])
  })

  it('resolves an explicit deployment configuration', async () => {
    const ctx = await harness(false)
    try {
      await ctx.plugin(loopPlugin, {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-failure',
        env: { CX_ENV: '1' },
        model: 'deployment-model',
        apiKey: 'sk-x',
        baseUrl: 'https://codex.example.test/v1',
        networkAccessEnabled: true,
        disposeGraceMs: 4321,
        maxTurns: 7,
      })
      expect(ctx.agentLoopCodex.config).toMatchObject({
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-failure',
        env: { CX_ENV: '1' },
        model: 'deployment-model',
        apiKey: 'sk-x',
        baseUrl: 'https://codex.example.test/v1',
        networkAccessEnabled: true,
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
      const loop = new CodexLoop(ctx, {})
      expect(loop.config).toMatchObject({
        env: {},
        disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
      })
      // Unpinned stances follow the session's dsh permission knobs.
      expect(loop.config.sandboxMode).toBeUndefined()
      expect(loop.config.approvalPolicy).toBeUndefined()
      expect(loop.config.model).toBeUndefined()
      expect(loop.config.apiKey).toBeUndefined()
      expect(loop.config.baseUrl).toBeUndefined()
      expect(loop.config.networkAccessEnabled).toBeUndefined()
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
        agentOptions: { provider: 'codex', model: 'gpt-5.2-codex' },
      })
      const withAgent = await ctx.systemPrompt.assemble(assembleContextFor(agent))
      expect(withAgent.variables.provider).toBe('codex')
      expect(withAgent.variables.model).toBe('gpt-5.2-codex')
      expect(withAgent.variables.cwd).toBe(process.cwd())
      const withoutAgent = await ctx.systemPrompt.assemble({})
      expect(withoutAgent.variables.provider).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
