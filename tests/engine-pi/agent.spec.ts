/**
 * Lifecycle tests for the Pi driver: a mocked RPC client serves the Pi event
 * stream, and the session log records the mapped transcript.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { PiLoop } from '../../src/engine-pi/loop.ts'
import type { PiAssistantMessageEvent, PiMessage, PiToolResult } from '../../src/engine-pi/rpc/types.ts'

/** Local plugin wrapper: mount constructs the Pi loop factory (the engine module is a library, not a Cordis plugin). */
const loopPlugin = {
  inject: ['agents', 'sessions', 'systemPrompt', 'subprocess'],
  apply: (ctx: Context, config: Record<string, unknown>): void => {
    void new PiLoop(ctx, config as Parameters<typeof PiLoop>[1])
  },
}

/** Hoisted mock client plus the per-step event stream and capture of spawn specs. */
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
    created: [] as Array<{ spec: Record<string, unknown>; spawn: unknown }>,
    resetEvents: (): void => { client.events = defaultEvents },
  }
})

vi.mock('../../src/engine-pi/rpc/client.ts', () => ({
  PiRpcClient: {
    create: vi.fn((spec: Record<string, unknown>, spawn: unknown) => {
      mock.created.push({ spec, spawn })
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

const USAGE = { input: 12, output: 7, cacheRead: 5, cacheWrite: 0 }

function assistantMessage(text: string, usage = USAGE): PiMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], usage }
}

function reasoningMessage(thinking: string, usage = USAGE): PiMessage {
  return { role: 'assistant', content: [{ type: 'thinking', thinking }], usage }
}

function messageDelta(delta: PiAssistantMessageEvent, usage = USAGE): Record<string, unknown> {
  return { type: 'message_update', usage, assistantMessageEvent: delta }
}

function turnEnd(message?: PiMessage, toolResults?: readonly PiToolResult[]): Record<string, unknown> {
  return {
    type: 'turn_end',
    ...message === undefined ? {} : { message },
    ...toolResults === undefined ? {} : { toolResults },
  }
}

async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(loopPlugin, config)
  return ctx
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Run a happy-path step (text assistant message + settled). */
function okStream(text: string): Record<string, unknown>[] {
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: assistantMessage(text) },
    messageDelta({ type: 'text_delta', contentIndex: 0, delta: text }),
    { type: 'message_end', message: assistantMessage(text) },
    turnEnd(assistantMessage(text)),
    { type: 'agent_end' },
    { type: 'agent_settled' },
  ]
}

describe('PiLoop factory registration', () => {
  it('registers the factory on ctx.agents so create works', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('factory-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hello'))
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects create when no factory is registered', async () => {
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(AgentRegistry)
    try {
      await expect(fresh.agents.create({
        sessionId: SessionId('no-factory'),
      })).rejects.toThrow('no agent factory registered')
    } finally {
      await fresh.fiber.dispose()
    }
  })
})

describe('PiAgent turn mapping', () => {
  it('records turn, step, assistant message, usage, and completion in the session log', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('hello world'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('turn-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const types = agent.session.snapshotEvents().map(event => event.type)
      expect(types).toContain('turn/start')
      expect(types).toContain('step/start')
      expect(types).toContain('user/message')
      expect(types).toContain('assistant/message')
      expect(types).toContain('step/end')
      expect(types).toContain('turn/end')

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: {
          message: {
            role: 'assistant',
            source: { kind: 'model', provider: 'pi' },
            content: [{ type: 'text', text: 'hello world' }],
          },
          usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 5 },
        },
        surfaceOp: 'append',
      })

      expect(mock.client.newSession).toHaveBeenCalled()
      const promptText = String(mock.client.prompt.mock.calls[0]?.[0])
      // Pi owns its system prompt natively; the driver sends only the serialized
      // history (no dsh system-prompt assembly, which would pull dsh tools).
      expect(promptText).not.toContain('You are the deployment.')
      expect(promptText).toContain('<user>')
      expect(promptText).toContain('hi')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('streams text deltas and links the durable message to them', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_start', message: assistantMessage('hello world') },
        messageDelta({ type: 'text_start', contentIndex: 0 }),
        messageDelta({ type: 'text_delta', contentIndex: 0, delta: 'hello ' }),
        messageDelta({ type: 'text_delta', contentIndex: 0, delta: 'world' }),
        { type: 'message_end', message: assistantMessage('hello world') },
        turnEnd(assistantMessage('hello world')),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('stream-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const chunks = agent.session.snapshotEvents().filter(
        (event): event is Extract<typeof event, { type: 'assistant/chunk' }> => event.type === 'assistant/chunk',
      )
      expect(chunks.map(event => event.data.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'hello ' },
        { type: 'text-delta', index: 0, text: 'world' },
      ])
      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({ sourceEventSeqs: chunks.map(event => event.seq) })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a streamed reasoning block into the assistant message', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_start', message: reasoningMessage('split thinking') },
        messageDelta({ type: 'thinking_start', contentIndex: 0 }),
        messageDelta({ type: 'thinking_delta', contentIndex: 0, delta: 'split thinking' }),
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage: USAGE } },
        turnEnd({ role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage: USAGE }),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-fold-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      // The streamed thinking folds in because the authoritative message omits it.
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'split thinking' },
        { type: 'text', text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a tool call and its result from the message + execution events', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_start', message: assistantMessage('running') },
        messageDelta({ type: 'toolcall_start', contentIndex: 1, id: 'call-1', toolName: 'bash' }),
        messageDelta({ type: 'toolcall_delta', contentIndex: 1, delta: '{"command":"ls"}' }),
        messageDelta({ type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'call-1', name: 'bash', arguments: { command: 'ls' } } }),
        { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } },
        { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'file.txt' }] }, isError: false },
        { type: 'message_end', message: assistantMessage('done') },
        turnEnd(assistantMessage('done')),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('tool-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('list it'))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const call = events.find(event => event.type === 'tool/call')
      expect(call).toMatchObject({ data: { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' } })
      expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
      const result = events.find(event => event.type === 'tool/result')
      expect(result).toMatchObject({
        data: {
          message: {
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: 'call-1',
              content: [{ type: 'text', text: 'file.txt' }],
              isError: false,
            }],
          },
        },
        surfaceOp: 'append',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps a tool execution result as an error and emits the call lazily', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'read', args: { path: 'x' } },
        { type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'read', result: { content: [{ type: 'text', text: 'boom' }] }, isError: true },
        turnEnd(),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('tool-lazy-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const call = agent.session.snapshotEvents().find(event => event.type === 'tool/call')
      expect(call).toMatchObject({ data: { callId: 'call-2', name: 'read', arguments: '{"path":"x"}' } })
      const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
      expect(result?.data.message.content[0]).toMatchObject({ isError: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flushes an assistant message carried only by turn_end', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        turnEnd({ role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage: USAGE }),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('turnonly-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'answer' }])
      expect(assistants[0]?.data.usage).toMatchObject({ inputTokens: 12 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records turn_end toolResults as durable tool/result messages', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: {} },
        turnEnd(
          { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: USAGE },
          [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'ran' }], isError: false }] as PiToolResult[],
        ),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('turnresult-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
      expect(result?.data.message.content[0]?.content[0]).toMatchObject({ text: 'ran' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the step with no-result when the stream closes without settling', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_start', message: assistantMessage('dangling') },
        messageDelta({ type: 'text_delta', contentIndex: 0, delta: 'think' }),
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('no-settle-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code: 'PI_NO_RESULT' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores transport and compaction events', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'compaction_start', reason: 'threshold' },
        { type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false },
        { type: 'auto_retry_start', attempt: 1 },
        { type: 'auto_retry_end', success: true, attempt: 1 },
        { type: 'queue_update', steering: ['x'], followUp: ['y'] },
        { type: 'bash_execution_update', id: 'b1', delta: 'out' },
        { type: 'extension_ui_request', id: 'u1', method: 'notify', message: 'hi' },
        { type: 'turn_start' },
        { type: 'agent_start' },
        turnEnd(assistantMessage('ok')),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('transport-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps consuming past a retrying agent_end and settles on the follow-up', async () => {
    const ctx = await harness()
    try {
      // A willRetry agent_end is not terminal: the agent comes back (auto-retry
      // then a fresh agent run) and only settles on the eventual agent_settled.
      mock.eventsYield.mockReturnValue([
        { type: 'agent_start' },
        { type: 'turn_start' },
        { type: 'message_start', message: assistantMessage('first') },
        messageDelta({ type: 'text_delta', contentIndex: 0, delta: 'first' }),
        { type: 'message_end', message: assistantMessage('first') },
        turnEnd(assistantMessage('first')),
        { type: 'agent_end', willRetry: true },
        { type: 'auto_retry_start', attempt: 1 },
        { type: 'auto_retry_end', success: true, attempt: 1 },
        { type: 'agent_start' },
        { type: 'turn_start' },
        { type: 'message_start', message: assistantMessage('retried') },
        messageDelta({ type: 'text_delta', contentIndex: 0, delta: 'retried' }),
        { type: 'message_end', message: assistantMessage('retried') },
        turnEnd(assistantMessage('retried')),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('retry-settle-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(2)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('logs the request header once per lifecycle', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('header-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await agent.whenIdle()
      agent.followup(message('two'))
      await agent.whenIdle()

      const headers = agent.session.snapshotEvents().filter(event => event.type === 'request/header')
      expect(headers).toHaveLength(1)
      expect(headers[0]).toMatchObject({
        data: { header: { config: { provider: 'pi', model: 'pi-native' } }, reason: 'initial' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a resume header when the session already folded one', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const seed: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'request/header', seq: 1, time: 2,
          data: { header: { config: { provider: 'pi', model: 'x' } }, reason: 'initial' },
        },
      ]
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('resume-header'),
        seed,
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const headers = agent.session.snapshotEvents().filter(event => event.type === 'request/header')
      expect(headers).toHaveLength(2)
      expect(headers.at(-1)).toMatchObject({ data: { reason: 'resume' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('PiAgent cancellation and pre-step interception', () => {
  it('aborts an in-flight query and ends the turn aborted', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('first'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('cancel-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      mock.eventsYield.mockImplementation(() => [])
      // A blocking stream: the phase abort rejects the iteration.
      mock.client.events = async function* (): AsyncGenerator<Record<string, unknown>> {
        yield { type: 'message_start', message: assistantMessage('starting') }
        await gate
        yield turnEnd(assistantMessage('late'))
      }

      agent.followup(message('second'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      agent.cancel({ kind: 'user' })
      release?.()
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
      expect(mock.client.abort).toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a proposed step through the agent/pre-step waterfall', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('never'))
      const disposeReject = ctx.on('agent/pre-step', async (): Promise<{ kind: 'reject' }> => ({ kind: 'reject' }))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reject-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      disposeReject()
      expect(mock.client.prompt).not.toHaveBeenCalled()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'blocked' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('PiAgent session permission mapping', () => {
  function appendKnob(session: Session, type: string, data: unknown): void {
    const append = session.append.bind(session) as unknown as (type: string, data: unknown) => void
    append(type, data)
  }

  it('re-folds the session permission knobs for every query, including mid-session switches', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('perm-switch-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await agent.whenIdle()
      expect(String(mock.created[0]?.spec.argv)).toContain('--tools')
      expect(String(mock.created[0]?.spec.argv)).toContain('read,grep,find,ls')

      appendKnob(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
      agent.followup(message('two'))
      await agent.whenIdle()
      expect(String(mock.created[1]?.spec.argv)).not.toContain('--tools')

      appendKnob(agent.session, 'sandbox/mode', { mode: 'workspace-write' })
      appendKnob(agent.session, 'approval/policy', { policy: 'ask' })
      agent.followup(message('three'))
      await agent.whenIdle()
      const argv3 = String(mock.created[2]?.spec.argv)
      expect(argv3).toContain('--tools')
      // An ask policy degrades to a read-only denial.
      expect(argv3).toContain('read,grep,find,ls')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets a deployment-pinned sandbox mode override the session per field', async () => {
    const ctx = await harness({ sandboxMode: 'danger-full-access' })
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('perm-pinned-s'),
        meta: { cwd: process.cwd() },
      })
      appendKnob(agent.session, 'sandbox/mode', { mode: 'read-only' })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(String(mock.created[0]?.spec.argv)).not.toContain('--tools')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('PiAgent deployment pinning', () => {
  it('forwards provider, model, thinking, and the tool set into the spawn argv', async () => {
    const ctx = await harness({
      provider: 'anthropic',
      model: 'claude-sonnet',
      thinkingLevel: 'high',
    })
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('pinned-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const argv = mock.created[0]?.spec.argv as string[]
      expect(argv).toContain('--provider')
      expect(argv).toContain('anthropic')
      expect(argv).toContain('--model')
      expect(argv).toContain('claude-sonnet:high')
      expect(mock.created[0]?.spec.cwd).toBe(process.cwd())
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the pinned model in the request header', async () => {
    const ctx = await harness({ model: 'pi-deployment-model' })
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('header-pinned-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().filter(e => e.type === 'request/header')[0]).toMatchObject({
        data: { header: { config: { provider: 'pi', model: 'pi-deployment-model' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('PiAgent defensive guards', () => {
  it('fails a step without a working directory', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('ignored'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('no-cwd'),
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
      expect(end).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'UNKNOWN' } } } })
      expect(mock.client.prompt).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

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
})

/** Extract the text of a single-block user message. */
function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
  const block = message.content[0]
  return block?.type === 'text' ? (block.text ?? '') : ''
}

/** Collect the durable user messages injected by the skill-invocation seam. */
function injectedSkillMessages(session: Session): Array<{ source: { kind: string; name?: string }; content: readonly { type: string; text: string }[] }> {
  return session.snapshotEvents()
    .filter((event): event is Extract<typeof event, { type: 'user/message' }> => event.type === 'user/message')
    .map(event => event.data)
    .filter(message => (message.source as { kind: string }).kind === 'skill-invocation')
}

/** Minimal fake skill definition matching the driver's inline shape. */
function fakeSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'fake-skill',
    description: 'a fake skill',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: 'test-provider',
    content: 'SKILL INSTRUCTIONS',
    ...overrides,
  }
}

describe('PiAgent skill injection', () => {
  it('injects rendered skill content for /name gestures into the session log', async () => {
    const ctx = await harness()
    try {
      const skills: Record<string, Record<string, unknown>> = {
        'dir-skill': fakeSkill({
          name: 'dir&"<skill',
          content: 'DIRECTORY INSTRUCTIONS',
          resourceBase: { kind: 'directory', path: '/base/<dir>&' },
        }),
        'prov-skill': fakeSkill({
          name: 'prov-skill',
          provider: 'acme&<co>',
          content: 'PROVIDER INSTRUCTIONS',
        }),
      }
      const get = vi.fn((name: string) => Promise.resolve(skills[name]))
      ctx.provide('skills', { get })
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skill-inject-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run /dir-skill then /prov-skill and /dir-skill again' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      expect(get).toHaveBeenCalledTimes(2)
      expect(get).toHaveBeenCalledWith('dir-skill', expect.objectContaining({ cwd: process.cwd() }))

      const injected = injectedSkillMessages(agent.session)
      expect(injected.map(message => (message.source as { name: string }).name))
        .toEqual(['dir-skill', 'prov-skill'])
      expect(injected[0]).toMatchObject({
        source: { kind: 'skill-invocation', name: 'dir-skill', form: 'instructions' },
      })
      const texts = injected.map(textOf)
      expect(texts[0]).toContain('<skill_content name="dir&amp;&quot;&lt;skill">')
      expect(texts[0]).toContain('Base directory for this skill: /base/&lt;dir&gt;&amp;.')
      expect(texts[0]).toContain('DIRECTORY INSTRUCTIONS')
      expect(texts[1]).toContain('Resources for this skill are managed by provider "acme&amp;&lt;co&gt;".')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips skills that fail to load, are unknown, or are not user-invocable', async () => {
    const ctx = await harness()
    try {
      const get = vi.fn((name: string): Promise<Record<string, unknown> | undefined> => {
        if (name === 'boom-skill') return Promise.reject(new Error('load failed'))
        if (name === 'ghost-skill') return Promise.resolve(undefined)
        return Promise.resolve(fakeSkill({ name, invocation: { modelInvocable: true, userInvocable: false } }))
      })
      ctx.provide('skills', { get })
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skill-skip-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'try /boom-skill /ghost-skill /hidden-skill' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      expect(get).toHaveBeenCalledTimes(3)
      expect(injectedSkillMessages(agent.session)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the batch untouched when no skills service is provided', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skill-unserved-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run /unserved-skill' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      expect(injectedSkillMessages(agent.session)).toEqual([])
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores gestures in non-user sources and non-text blocks', async () => {
    const ctx = await harness()
    try {
      const get = vi.fn()
      ctx.provide('skills', { get })
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skill-filter-s'),
        meta: { cwd: process.cwd() },
      })
      agent.send(createUserMessage({
        content: [{ type: 'text', text: '/trapped-skill' }],
        source: { kind: 'skill-invocation', name: 'trapped-skill', form: 'instructions' },
      }), 'next-turn', false)
      agent.followup(createUserMessage({
        content: [{ type: 'reasoning', text: '/shadow-skill' }, { type: 'text', text: 'plain text' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      expect(get).not.toHaveBeenCalled()
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
        return Promise.resolve(fakeSkill({ name: 'dir-skill' }))
      })
      ctx.provide('skills', { get })
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skill-cancel-s'),
        meta: { cwd: process.cwd() },
      })
      cancel = () => { agent.cancel({ kind: 'user' }) }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run /dir-skill' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      expect(get).toHaveBeenCalledTimes(1)
      expect(injectedSkillMessages(agent.session)).toEqual([])
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds multiple streamed thinking blocks before the assistant text', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: USAGE } },
        messageDelta({ type: 'thinking_delta', contentIndex: 0, delta: 'a' }),
        messageDelta({ type: 'thinking_delta', contentIndex: 0, delta: 'b' }),
        messageDelta({ type: 'thinking_delta', contentIndex: 1, delta: 'c' }),
        messageDelta({ type: 'thinking_end', contentIndex: 1, thinking: 'c' }),
        messageDelta({ type: 'text_delta', contentIndex: 2, delta: 'x' }),
        messageDelta({ type: 'text_end', contentIndex: 2, content: 'x' }),
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: USAGE } },
        turnEnd({ role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: USAGE }),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('multi-thinking-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const chunks = agent.session.snapshotEvents().filter(
        (event): event is Extract<typeof event, { type: 'assistant/chunk' }> => event.type === 'assistant/chunk',
      )
      expect(chunks.map(event => event.data.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'a' },
        { type: 'reasoning-delta', index: 0, text: 'b' },
        { type: 'block-start', index: 1, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 1, text: 'c' },
        { type: 'block-start', index: 2, blockType: 'text' },
        { type: 'text-delta', index: 2, text: 'x' },
      ])
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'ab' },
        { type: 'reasoning', text: 'c' },
        { type: 'text', text: 'x' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores non-assistant message starts and usage-less updates', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_start', message: { role: 'user', content: 'hi' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'y' } },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
        turnEnd({ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('usage-less-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'answer' }])
      expect(assistants[0]?.data.usage).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps an assistant message carrying a tool-call block', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }, { type: 'text', text: 'done' }], usage: USAGE } },
        turnEnd({ role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: USAGE }),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('toolcall-block-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'done' }])
      // The tool-call block is skipped from the assistant content (it is a separate tool/call event).
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps a tool execution update and a string-argument tool call', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: '{"command":"ls"}' },
        { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'bash', args: {}, partialResult: { content: [{ type: 'text', text: 'partial' }] } },
        { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'out' }] }, isError: false },
        turnEnd(),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('string-args-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const call = agent.session.snapshotEvents().find(event => event.type === 'tool/call')
      expect(call).toMatchObject({ data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } })
      const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
      expect(result?.data.message.content[0]?.content[0]).toMatchObject({ text: 'out' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('emits a tool result from a string tool-result content', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        turnEnd(undefined, [{ role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: 'ran' as unknown as PiToolResult['content'], isError: false }] as PiToolResult[]),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('string-toolresult-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
      expect(result?.data.message.content[0]?.content[0]).toMatchObject({ text: 'ran' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('looks skills up without a cwd hint when the session has no working directory', async () => {
    const ctx = await harness()
    try {
      const get = vi.fn((_name: string, _options?: Record<string, unknown>) => Promise.resolve(fakeSkill({ name: 'dir-skill' })))
      ctx.provide('skills', { get })
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skill-nocwd-s'),
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run /dir-skill' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      expect(get).toHaveBeenCalledTimes(1)
      expect((get.mock.calls[0]?.[1] as { cwd?: unknown }).cwd).toBeUndefined()
      // Injection happens at pre-step, before the step itself fails on the
      // missing working directory.
      expect(injectedSkillMessages(agent.session)).toHaveLength(1)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('PiAgent edge mapping', () => {
  it('derives the tool set from a pinned workspace-write sandbox', async () => {
    const ctx = await harness({ sandboxMode: 'workspace-write' })
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('pinned-write-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(String(mock.created[0]?.spec.argv)).toContain('read,grep,find,ls,write,edit')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('appends a model-less thinking level to the spawn argv', async () => {
    const ctx = await harness({ thinkingLevel: 'high' })
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('thinking-only-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const argv = mock.created[0]?.spec.argv as string[]
      expect(argv).toContain('--model')
      expect(argv).toContain(':high')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores a non-assistant message_end and treats a string content as text', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_end', message: { role: 'user', content: 'user text' } },
        { type: 'message_end', message: { role: 'assistant', content: 'plain answer' } },
        turnEnd({ role: 'assistant', content: 'plain answer' }),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('string-content-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'plain answer' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps a message whose content already contains a thinking block', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought' }, { type: 'text', text: 'done' }], usage: USAGE } },
        turnEnd({ role: 'assistant', content: [{ type: 'thinking', thinking: 'thought' }, { type: 'text', text: 'done' }], usage: USAGE }),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('content-thinking-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'thought' },
        { type: 'text', text: 'done' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores an assistant message whose content is neither a string nor an array', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'message_end', message: { role: 'assistant', content: null as never } },
        turnEnd({ role: 'assistant', content: null as never }),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('null-content-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps a non-text tool-result block to an empty text', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        turnEnd(undefined, [{ role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'image' }], isError: false }] as PiToolResult[]),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('nontext-result-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
      expect(result?.data.message.content[0]?.content[0]).toMatchObject({ text: '(no content)' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('emits a tool call lazily from a lone tool_execution_end with no arguments', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue([
        { type: 'tool_execution_end', toolCallId: 'c9', toolName: 'read', result: { content: [{ type: 'text', text: 'z' }] }, isError: false },
        turnEnd(),
        { type: 'agent_settled' },
      ])
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('lone-end-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const call = agent.session.snapshotEvents().find(event => event.type === 'tool/call')
      expect(call).toMatchObject({ data: { callId: 'c9', name: 'read', arguments: '{}' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
