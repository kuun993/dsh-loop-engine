/**
 * Lifecycle tests for the Kimi ACP driver: a mocked AcpClient serves the
 * session/update stream, and the session log records the mapped transcript
 * (streamed text, thinking, tool calls, and tool results).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { KimiLoop } from '../../src/engine-kimi/loop.ts'

/** Local plugin wrapper: mount constructs the Kimi loop factory. */
const loopPlugin = {
  inject: ['agents', 'sessions', 'systemPrompt', 'subprocess'],
  apply: (ctx: Context, config: Record<string, unknown>): void => {
    void new KimiLoop(ctx, config as Parameters<typeof KimiLoop>[1])
  },
}

/** Hoisted mock client plus the per-step update stream and capture of create specs. */
const mock = vi.hoisted(() => {
  const client = {
    initialize: vi.fn(async () => ({})),
    newSession: vi.fn(async () => 'sess_1'),
    // Deliver every scripted update to the registered onUpdate handler before
    // the prompt response settles (mirrors the real prompt-result-after-updates
    // ordering).
    prompt: vi.fn(async () => {
      for (const update of mock.updates()) mock.updateHandler?.(update)
      return {}
    }),
    cancel: vi.fn(),
    onPermission: vi.fn((handler: (request: unknown) => boolean | Promise<boolean>) => { mock.permissionHandler = handler }),
    onUpdate: vi.fn((handler: (update: Record<string, unknown>) => void) => { mock.updateHandler = handler }),
    dispose: vi.fn(),
    closed: false,
  }
  return {
    client,
    updates: vi.fn<() => Record<string, unknown>[]>(() => []),
    created: [] as Array<{ spec: Record<string, unknown>; spawn: unknown }>,
    permissionHandler: undefined as ((request: unknown) => boolean | Promise<boolean>) | undefined,
    updateHandler: undefined as ((update: Record<string, unknown>) => void) | undefined,
  }
})

vi.mock('../../src/engine-kimi/acp/client.ts', () => ({
  AcpClient: {
    create: vi.fn((spec: Record<string, unknown>, spawn: unknown) => {
      mock.created.push({ spec, spawn })
      return mock.client
    }),
  },
}))

/** Text chunk update. */
const text = (delta: string): Record<string, unknown> => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } })
/** Thought chunk update. */
const thought = (delta: string): Record<string, unknown> => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta } })
/** Tool-call announcement. */
const toolCall = (id: string, name: string): Record<string, unknown> => ({ sessionUpdate: 'tool_call', toolCallId: id, title: name, kind: 'execute', status: 'pending', content: [] })
/** Tool-call stream/result update. */
const toolStream = (id: string, status: string, text: string): Record<string, unknown> => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status, content: [{ type: 'content', content: { type: 'text', text } }] })

/** Bind a fresh harness context with the loop plugin mounted. */
async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  ctx.provide('subprocess', { spawn: vi.fn() })
  await ctx.plugin(loopPlugin, config)
  return ctx
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Text of a single-block user message, for content assertions. */
function textOf(input: UserMessage): string {
  const block = input.content[0]
  return block?.type === 'text' ? block.text : ''
}

/** Collect the durable user messages injected by the skill-invocation seam. */
function injectedSkillMessages(session: Session): UserMessage[] {
  return session.events
    .filter((event): event is Extract<typeof event, { type: 'user/message' }> => event.type === 'user/message')
    .map(event => event.data)
    .filter(input => (input.source as { kind: string }).kind === 'skill-invocation')
}

/** Minimal fake skill definition matching the driver's inline shape. */
function fakeSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'review-pr',
    description: 'a fake skill',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: 'kimi',
    content: '# Do the review',
    ...overrides,
  }
}

beforeEach(() => {
  mock.created.length = 0
  mock.updates.mockReset()
  mock.updates.mockReturnValue([])
  mock.permissionHandler = undefined
  mock.client.initialize.mockClear()
  mock.client.newSession.mockClear()
  mock.client.prompt.mockClear()
  mock.client.cancel.mockClear()
  mock.client.onPermission.mockClear()
  mock.client.onUpdate.mockClear()
  mock.client.dispose.mockClear()
  mock.client.closed = false
  mock.updateHandler = undefined
})

describe('KimiLoop factory registration', () => {
  it('registers the factory on ctx.agents so create works', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('factory-s'), meta: { cwd: process.cwd() } })
      expect(agent.status).toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects create when no factory is registered', async () => {
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(AgentRegistry)
    try {
      await expect(fresh.agents.create({ sessionId: SessionId('no-factory') })).rejects.toThrow('no agent factory registered')
    } finally {
      await fresh.fiber.dispose()
    }
  })
})

describe('KimiAgent turn mapping (streamed)', () => {
  it('records streamed text chunks as a single assistant/message', async () => {
    mock.updates.mockReturnValue([text('Hello '), text('world')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('text-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const types = agent.session.events.map(event => event.type)
      expect(types).toContain('assistant/chunk')
      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: {
          message: {
            role: 'assistant',
            source: { kind: 'model', provider: 'kimi' },
            content: [{ type: 'text', text: 'Hello world' }],
          },
        },
      })
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      // The prompt was delivered to the ACP session.
      expect(mock.client.newSession).toHaveBeenCalledWith(process.cwd())
      expect(mock.client.prompt).toHaveBeenCalledWith('sess_1', expect.stringContaining('<user>'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('streams thinking before text into reasoning + text content blocks', async () => {
    mock.updates.mockReturnValue([thought('think '), thought('hard'), text('answer')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('think-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: { message: { content: [{ type: 'reasoning', text: 'think hard' }, { type: 'text', text: 'answer' }] } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps a tool call and its settled stream into tool/call and tool/result', async () => {
    mock.updates.mockReturnValue([
      text('Let me '),
      toolCall('0:call_1', 'Bash'),
      toolStream('0:call_1', 'in_progress', 'a'),
      toolStream('0:call_1', 'complete', 'b'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const toolCall_ = agent.session.events.find(event => event.type === 'tool/call')
      expect(toolCall_).toMatchObject({ data: { callId: '0:call_1', name: 'Bash' } })
      const toolResult_ = agent.session.events.find(event => event.type === 'tool/result')
      expect(toolResult_).toMatchObject({ data: { message: { content: [{ content: [{ type: 'text', text: 'ab' }] }] } } })
      // A tool-only step still publishes an (empty) assistant/message parent.
      expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips meta/unknown update kinds without emitting content', async () => {
    mock.updates.mockReturnValue([
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'config_option_update', configIds: ['model'] },
      text('kept'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('skip-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({ data: { message: { content: [{ type: 'text', text: 'kept' }] } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('throws KIMI_NO_RESULT when the step produced neither content nor tools', async () => {
    mock.updates.mockReturnValue([])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('empty-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent permission and client lifecycle', () => {
  it('answers ACP permission requests from the session approval knobs (auto)', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('auto-perm'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      expect(mock.client.onPermission).toHaveBeenCalledTimes(1)
      expect(mock.permissionHandler!({})).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('denies ACP permission requests when the session policy is ask', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('ask-perm'),
        seed: [{ type: 'approval/policy', seq: 0, time: 1, data: { policy: 'ask' } }],
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()
      expect(mock.permissionHandler!({})).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels the ACP session when the turn is aborted', async () => {
    // A prompt that never settles: the turn is stopped by the abort signal, and
    // the abandoned prompt promise simply never settles (no unhandled rejection).
    mock.client.prompt.mockImplementationOnce(() => new Promise<unknown>(() => {}))
    mock.updates.mockReturnValue([])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('abort-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      const idle = agent.whenIdle()
      await new Promise(resolve => setTimeout(resolve, 10))
      agent.cancel({ kind: 'cancelled' })
      await idle
      expect(mock.client.cancel).toHaveBeenCalledWith('sess_1')
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reuses the cached ACP client across steps of a session', async () => {
    mock.updates.mockReturnValue([text('first')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('reuse-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      mock.updates.mockReturnValue([text('second')])
      agent.followup(message('again'))
      await agent.whenIdle()
      expect(mock.created).toHaveLength(1)
      expect(mock.client.prompt).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent error edges', () => {
  it('ends the turn in error when the ACP initialize rejects', async () => {
    mock.client.initialize.mockRejectedValueOnce(new Error('init fail'))
    mock.updates.mockReturnValue([text('never')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('init-fail'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
      // The rejected client is disposed and the cached reference is cleared.
      expect(mock.client.dispose).toHaveBeenCalled()
      expect(mock.client.newSession).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the turn in error when the session has no working directory', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      // No meta → session.header.cwd is undefined; step() must reject before
      // any ACP client is created.
      const { agent } = await ctx.agents.create({ sessionId: SessionId('no-cwd') })
      agent.followup(message('hi'))
      await agent.whenIdle()
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
      expect(mock.client.initialize).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent skill injection', () => {
  it('injects rendered skill content for a /name gesture into the session log', async () => {
    const ctx = await harness()
    try {
      const get = vi.fn((name: string) => Promise.resolve(fakeSkill({ name })))
      ctx.provide('skills', { get })
      mock.updates.mockReturnValue([text('ok')])
      const { agent } = await ctx.agents.create({ sessionId: SessionId('skill-ok'), meta: { cwd: process.cwd() } })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '/review-pr fix this' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(get).toHaveBeenCalledTimes(1)
      expect(get).toHaveBeenCalledWith('review-pr', expect.objectContaining({ cwd: process.cwd() }))
      const injected = injectedSkillMessages(agent.session)
      expect(injected).toHaveLength(1)
      expect(injected[0]).toMatchObject({ source: { kind: 'skill-invocation', name: 'review-pr', form: 'instructions' } })
      expect(textOf(injected[0])).toContain('# Do the review')
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the batch untouched when no skills service is provided', async () => {
    const ctx = await harness()
    try {
      mock.updates.mockReturnValue([text('ok')])
      const { agent } = await ctx.agents.create({ sessionId: SessionId('skill-unserved'), meta: { cwd: process.cwd() } })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '/ghost fix this' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(injectedSkillMessages(agent.session)).toEqual([])
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips skills that fail to load, resolve undefined, or are not user-invocable', async () => {
    const ctx = await harness()
    try {
      const get = vi.fn((name: string): Promise<Record<string, unknown> | undefined> => {
        if (name === 'boom-skill') return Promise.reject(new Error('load failed'))
        if (name === 'ghost-skill') return Promise.resolve(undefined)
        return Promise.resolve(fakeSkill({ name, invocation: { modelInvocable: true, userInvocable: false } }))
      })
      ctx.provide('skills', { get })
      mock.updates.mockReturnValue([text('ok')])
      const { agent } = await ctx.agents.create({ sessionId: SessionId('skill-skip'), meta: { cwd: process.cwd() } })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'try /boom-skill /ghost-skill /hidden-skill' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(get).toHaveBeenCalledTimes(3)
      expect(injectedSkillMessages(agent.session)).toEqual([])
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops the whole injection when the step is cancelled while a skill loads', async () => {
    const ctx = await harness()
    try {
      let cancel: (() => void) | undefined
      const get = vi.fn(() => {
        cancel?.()
        return Promise.resolve(fakeSkill({ name: 'review-pr' }))
      })
      ctx.provide('skills', { get })
      mock.updates.mockReturnValue([text('ok')])
      const { agent } = await ctx.agents.create({ sessionId: SessionId('skill-cancel'), meta: { cwd: process.cwd() } })
      cancel = () => { agent.cancel({ kind: 'user' }) }
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run /review-pr' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(get).toHaveBeenCalledTimes(1)
      expect(injectedSkillMessages(agent.session)).toEqual([])
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('looks skills up without a cwd hint and still fails the step on the missing working directory', async () => {
    const ctx = await harness()
    try {
      const get = vi.fn((_name: string, _options?: Record<string, unknown>) => Promise.resolve(fakeSkill({ name: 'review-pr' })))
      ctx.provide('skills', { get })
      mock.updates.mockReturnValue([text('ok')])
      const { agent } = await ctx.agents.create({ sessionId: SessionId('skill-nocwd') })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run /review-pr' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(get).toHaveBeenCalledTimes(1)
      expect(get.mock.calls[0]?.[1]).not.toHaveProperty('cwd')
      // Injection happens at pre-step, before the step itself fails on the
      // missing working directory.
      expect(injectedSkillMessages(agent.session)).toHaveLength(1)
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent tool and chunk edges', () => {
  it('ignores a tool_call with an empty id and a tool_call_update for an unknown call', async () => {
    mock.updates.mockReturnValue([
      toolCall('', 'Bash'),
      toolStream('unknown-id', 'complete', 'x'),
      text('ok'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-edge'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      expect(agent.session.events.some(event => event.type === 'tool/call')).toBe(false)
      expect(agent.session.events.some(event => event.type === 'tool/result')).toBe(false)
      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({ data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a settled tool stream that arrives without an in-progress update', async () => {
    mock.updates.mockReturnValue([
      toolCall('0:call_s', 'Bash'),
      toolStream('0:call_s', 'complete', 'abc'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-stream'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      const toolResult = agent.session.events.find(event => event.type === 'tool/result')
      expect(toolResult).toMatchObject({ data: { message: { content: [{ content: [{ type: 'text', text: 'abc' }] }] } } })
      // A tool-only step still publishes an (empty) assistant/message parent.
      expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores empty chunk deltas without opening a block', async () => {
    mock.updates.mockReturnValue([text(''), thought(''), text('real')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('empty-delta'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({ data: { message: { content: [{ type: 'text', text: 'real' }] } } })
      const chunks = agent.session.events.filter(event => event.type === 'assistant/chunk')
      // Only 'real' opened blocks: a block-start + text-delta + block-end.
      expect(chunks.filter(event => (event.data.chunk as { type: string }).type === 'block-start')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent driver control', () => {
  it('processes a message queued with steer (next-step, waking)', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('steer-s'), meta: { cwd: process.cwd() } })
      agent.steer(message('hi'))
      await agent.whenIdle()
      expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('processes a message queued with inject alongside a followup wake', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('inject-s'), meta: { cwd: process.cwd() } })
      agent.inject(message('injected'))
      agent.followup(message('wake'))
      await agent.whenIdle()
      const users = agent.session.events.filter(event => event.type === 'user/message')
      expect(users).toHaveLength(2)
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects runMaintenance while a turn is running', async () => {
    mock.client.prompt.mockImplementationOnce(() => new Promise<unknown>(() => {}))
    mock.updates.mockReturnValue([])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('maint-running'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      expect(() => agent.runMaintenance(async () => 'x')).toThrow(/already has active work/)
      // Let the running turn reach the (never-settling) prompt so its one-shot
      // implementation is consumed before we abort, keeping it off the next test.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      agent.cancel({ kind: 'cancelled' })
      await agent.whenIdle()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs a maintenance job while idle and latches a wake into a new turn', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('maint-s'), meta: { cwd: process.cwd() } })
      const result = await agent.runMaintenance(async () => {
        agent.followup(message('after-maint'))
        return 'job-result'
      })
      expect(result).toBe('job-result')
      await agent.whenIdle()
      expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs a maintenance job without latching a wake when nothing is queued', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('maint-quiet'), meta: { cwd: process.cwd() } })
      const result = await agent.runMaintenance(async () => 'quiet')
      expect(result).toBe('quiet')
      expect(agent.inbox.hasPending).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('discards a pending message on cancel without keepInbox', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('discard-s'), meta: { cwd: process.cwd() } })
      agent.inject(message('pending'))
      agent.cancel({ kind: 'user' })
      expect(agent.inbox.hasPending).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves the inbox when cancel is called with keepInbox', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('keep-s'), meta: { cwd: process.cwd() } })
      agent.inject(message('kept'))
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      expect(agent.inbox.hasPending).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent mid-turn input chaining', () => {
  it('chains into a second turn when a followup arrives mid-turn', async () => {
    let entered: (() => void) | undefined
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    let releasePrompt: (() => void) | undefined
    mock.client.prompt.mockImplementationOnce(async () => {
      for (const update of mock.updates()) mock.updateHandler?.(update)
      entered?.()
      return await new Promise<unknown>((resolve) => { releasePrompt = () => resolve({}) })
    })
    mock.client.prompt.mockImplementationOnce(async () => {
      for (const update of mock.updates()) mock.updateHandler?.(update)
      return {}
    })
    mock.updates.mockReturnValue([text('first')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('chain-turn'), meta: { cwd: process.cwd() } })
      agent.followup(message('one'))
      const idle = agent.whenIdle()
      await enteredPromise
      mock.updates.mockReturnValue([text('second')])
      agent.followup(message('two'))
      releasePrompt?.()
      await idle
      const starts = agent.session.events.filter(event => event.type === 'turn/start')
      expect(starts).toHaveLength(2)
      expect(mock.client.prompt).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('continues into a next step when a steer arrives mid-turn', async () => {
    let entered: (() => void) | undefined
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    let releasePrompt: (() => void) | undefined
    mock.client.prompt.mockImplementationOnce(async () => {
      for (const update of mock.updates()) mock.updateHandler?.(update)
      entered?.()
      return await new Promise<unknown>((resolve) => { releasePrompt = () => resolve({}) })
    })
    mock.client.prompt.mockImplementationOnce(async () => {
      for (const update of mock.updates()) mock.updateHandler?.(update)
      return {}
    })
    mock.updates.mockReturnValue([text('first')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('chain-steer'), meta: { cwd: process.cwd() } })
      agent.followup(message('one'))
      const idle = agent.whenIdle()
      await enteredPromise
      mock.updates.mockReturnValue([text('second')])
      agent.steer(message('interrupt'))
      releasePrompt?.()
      await idle
      const steps = agent.session.events.filter(event => event.type === 'step/start')
      expect(steps).toHaveLength(2)
      expect(mock.client.prompt).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not latch a wake after a disposed cancel', async () => {
    let entered: (() => void) | undefined
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    let releasePrompt: (() => void) | undefined
    mock.client.prompt.mockImplementationOnce(async () => {
      for (const update of mock.updates()) mock.updateHandler?.(update)
      entered?.()
      return await new Promise<unknown>((resolve) => { releasePrompt = () => resolve({}) })
    })
    mock.updates.mockReturnValue([text('first')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('disposed-latch'), meta: { cwd: process.cwd() } })
      agent.followup(message('one'))
      const idle = agent.whenIdle()
      await enteredPromise
      agent.cancel({ kind: 'disposed' })
      agent.followup(message('after'))
      releasePrompt?.()
      await idle
      // The disposed cancel does not latch a replay, so the followup stays queued.
      expect(agent.inbox.nextTurn).toHaveLength(1)
      const ends = agent.session.events.filter(event => event.type === 'turn/end')
      expect(ends[0]).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
      expect(ends).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent empty-step completion', () => {
  it('closes an emptied first proposal as a completed turn without a query', async () => {
    const ctx = await harness()
    try {
      ctx.on('agent/pre-step', async () => ({ kind: 'enter', messages: [] }))
      const { agent } = await ctx.agents.create({ sessionId: SessionId('empty-first'), meta: { cwd: process.cwd() } })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(mock.client.prompt).not.toHaveBeenCalled()
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('breaks a completed turn when the next proposal is emptied', async () => {
    const ctx = await harness()
    try {
      mock.updates.mockReturnValue([text('step one')])
      let proposals = 0
      ctx.on('agent/pre-step', async (_payload, next) => {
        proposals += 1
        return proposals === 2 ? { kind: 'enter', messages: [] } : next()
      })
      const { agent } = await ctx.agents.create({ sessionId: SessionId('empty-second'), meta: { cwd: process.cwd() } })
      let injected = false
      ctx.on('agent/turn-stopping', () => {
        if (injected) return
        injected = true
        agent.inject(message('continue'))
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(proposals).toBe(2)
      expect(mock.client.prompt).toHaveBeenCalledTimes(1)
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('closes a rejected proposal as a blocked turn without a query', async () => {
    const ctx = await harness()
    try {
      ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
      const { agent } = await ctx.agents.create({ sessionId: SessionId('reject-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(mock.client.prompt).not.toHaveBeenCalled()
      expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'blocked' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent commit vetoes', () => {
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
      const { agent } = await ctx.agents.create({ sessionId: SessionId('turnstart-veto'), meta: { cwd: process.cwd() } })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(agent.session.events.some(event => event.type === 'turn/start' || event.type === 'user/message')).toBe(false)
      expect(agent.inbox.nextTurn).toHaveLength(1)
      expect(errors.map(error => error.message)).toEqual(['reject turn-start before commit'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a turn/end commit veto without dropping the next turn', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
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
      const { agent } = await ctx.agents.create({ sessionId: SessionId('turnend-veto'), meta: { cwd: process.cwd() } })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(errors.map(error => error.message)).toEqual(['reject turn-end before commit'])
      // The loop survives: a second turn commits its boundary normally.
      mock.updates.mockReturnValue([text('again')])
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

describe('KimiAgent request header', () => {
  it('logs a resume request header when the session already has one', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('resume-header'),
        seed: [{ type: 'request/header', seq: 0, time: 1, data: { header: { config: { provider: 'kimi', model: 'm' } }, reason: 'initial' } }],
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()
      const headers = agent.session.events.filter(event => event.type === 'request/header')
      expect(headers).toHaveLength(2)
      expect(headers[1]).toMatchObject({ data: { reason: 'resume' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
