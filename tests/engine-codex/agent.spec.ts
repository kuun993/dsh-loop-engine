/**
 * Lifecycle tests for the Codex driver: a mocked Codex SDK serves the thread
 * event stream, and the session log records the mapped transcript.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { CodexLoop } from '../../src/engine-codex/loop.ts'

/** Local plugin wrapper: mount constructs the Codex loop factory (the engine module is a library, not a Cordis plugin). */
const loopPlugin = {
  inject: ['agents', 'sessions', 'systemPrompt'],
  apply: (ctx: Context, config: Record<string, unknown>): void => {
    void new CodexLoop(ctx, config as Parameters<typeof CodexLoop>[1])
  },
}

type RunStreamed = (input: string, turnOptions?: { signal?: AbortSignal }) => Promise<{ events: AsyncGenerator<ThreadEvent> }>

/** Hoisted mock state: every constructed fake Codex plus the runStreamed implementation. */
const mock = vi.hoisted(() => ({
  constructed: [] as Array<{ codexOptions: unknown; threadOptions: Record<string, unknown> }>,
  runStreamed: vi.fn<RunStreamed>(),
}))

vi.mock('@openai/codex-sdk', () => ({
  Codex: class FakeCodex {
    constructor(private readonly codexOptions: unknown) {}
    startThread(threadOptions: Record<string, unknown>): { runStreamed: RunStreamed } {
      mock.constructed.push({ codexOptions: this.codexOptions, threadOptions })
      return { runStreamed: mock.runStreamed }
    }
  },
}))

beforeEach(() => {
  mock.constructed.length = 0
  mock.runStreamed.mockReset()
})

function stream(events: ThreadEvent[]): ReturnType<RunStreamed> {
  async function* inner(): AsyncGenerator<ThreadEvent, void> {
    for (const event of events) yield event
  }
  return Promise.resolve({ events: inner() })
}

const TURN_USAGE: Usage = {
  input_tokens: 12,
  cached_input_tokens: 5,
  cache_write_input_tokens: 2,
  output_tokens: 7,
  reasoning_output_tokens: 3,
}

function itemCompleted(item: ThreadItem): ThreadEvent {
  return { type: 'item.completed', item }
}

function itemStarted(item: ThreadItem): ThreadEvent {
  return { type: 'item.started', item }
}

function agentMessage(text: string): ThreadItem {
  return { id: `msg-${text}`, type: 'agent_message', text }
}

function reasoningItem(text: string): ThreadItem {
  return { id: `reason-${text}`, type: 'reasoning', text }
}

function commandItem(overrides: Record<string, unknown> = {}): ThreadItem {
  return {
    id: 'cmd-1',
    type: 'command_execution',
    command: 'ls -la',
    aggregated_output: 'total 0',
    exit_code: 0,
    status: 'in_progress',
    ...overrides,
  } as ThreadItem
}

function turnCompleted(usage: Usage = TURN_USAGE): ThreadEvent {
  return { type: 'turn.completed', usage }
}

async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(loopPlugin, config)
  return ctx
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('CodexLoop factory registration', () => {
  it('registers the factory on ctx.agents so create works', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('factory-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hello'))
      await agent.whenIdle()
      expect(agent.session.events.at(-1)).toMatchObject({
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

describe('CodexAgent turn mapping', () => {
  it('records turn, step, assistant message, usage, and completion in the session log', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        itemCompleted(agentMessage('hello world')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('turn-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const types = agent.session.events.map(event => event.type)
      expect(types).toContain('turn/start')
      expect(types).toContain('step/start')
      expect(types).toContain('user/message')
      expect(types).toContain('assistant/message')
      expect(types).toContain('step/end')
      expect(types).toContain('turn/end')

      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: {
          message: {
            role: 'assistant',
            source: { kind: 'model', provider: 'codex' },
            content: [{ type: 'text', text: 'hello world' }],
          },
          usage: {
            inputTokens: 12,
            outputTokens: 7,
            cacheReadTokens: 5,
            cacheWriteTokens: 2,
            reasoningTokens: 3,
          },
        },
        surfaceOp: 'append',
      })

      expect(mock.runStreamed).toHaveBeenCalledTimes(1)
      const [input, turnOptions] = mock.runStreamed.mock.calls[0]!
      expect(input).toContain('<user>')
      expect(input).toContain('hi')
      expect(turnOptions?.signal).toBeInstanceOf(AbortSignal)

      const constructed = mock.constructed[0]!
      expect(constructed.threadOptions).toMatchObject({
        workingDirectory: process.cwd(),
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('streams the full-text chunks of an agent message and links the durable message to them', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(agentMessage('hello world')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('stream-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const chunks = agent.session.events.filter(
        (event): event is Extract<typeof event, { type: 'assistant/chunk' }> => event.type === 'assistant/chunk',
      )
      expect(chunks.map(event => event.data.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'hello world' },
      ])

      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        surfaceOp: 'append',
        sourceEventSeqs: chunks.map(event => event.seq),
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a reasoning item into the following agent message', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(reasoningItem('split thinking')),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-fold-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.events.filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'split thinking' },
        { type: 'text', text: 'answer' },
      ])
      const chunks = agent.session.events.filter(event => event.type === 'assistant/chunk')
      expect(chunks.map(event => event.data.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'split thinking' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flushes trailing reasoning as its own durable message carrying the turn usage', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(agentMessage('answer')),
        itemCompleted(reasoningItem('trailing thought')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-trailing-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.events.filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(2)
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'answer' }])
      expect(assistants[0]?.data.usage).toBeUndefined()
      expect(assistants[1]?.data.message.content).toEqual([{ type: 'reasoning', text: 'trailing thought' }])
      expect(assistants[1]?.data.usage).toMatchObject({ outputTokens: 7 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flushes an earlier agent message without usage when a later item completes', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(agentMessage('first')),
        itemCompleted(agentMessage('second')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('two-messages-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.events.filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(2)
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'first' }])
      expect(assistants[0]?.data.usage).toBeUndefined()
      expect(assistants[1]?.data.message.content).toEqual([{ type: 'text', text: 'second' }])
      expect(assistants[1]?.data.usage).toMatchObject({ inputTokens: 12 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a command execution started/completed pair as tool/call and tool/result', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted(commandItem()),
        itemCompleted(commandItem({ status: 'completed', aggregated_output: 'file.txt' })),
        itemCompleted(agentMessage('done')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('tool-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('list it'))
      await agent.whenIdle()

      const events = agent.session.events
      const call = events.find(event => event.type === 'tool/call')
      expect(call).toMatchObject({
        data: { callId: 'cmd-1', name: 'command_execution', arguments: '{"command":"ls -la"}' },
      })
      const result = events.find(event => event.type === 'tool/result')
      expect(result).toMatchObject({
        data: {
          message: {
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: 'cmd-1',
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

  it('emits the tool/call lazily when only the terminal item event arrives', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(commandItem({ status: 'completed', exit_code: 3 })),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('tool-lazy-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const call = agent.session.events.find(event => event.type === 'tool/call')
      expect(call).toMatchObject({ data: { callId: 'cmd-1', name: 'command_execution' } })
      const result = agent.session.events.find(event => event.type === 'tool/result')
      expect(result?.data.message.content[0]).toMatchObject({ isError: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records MCP tool calls and file changes beside the assistant message', async () => {
    const ctx = await harness()
    try {
      const mcp: ThreadItem = {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'docs',
        tool: 'search',
        arguments: { q: 'cordis' },
        result: { content: [], structured_content: { hits: 2 } },
        status: 'in_progress',
      } as ThreadItem
      const patch: ThreadItem = {
        id: 'patch-1',
        type: 'file_change',
        changes: [{ path: 'src/a.ts', kind: 'update' }],
        status: 'completed',
      }
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted(mcp),
        itemCompleted({ ...mcp, status: 'completed' } as ThreadItem),
        itemCompleted(patch),
        itemCompleted(agentMessage('done')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('tool-mix-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const calls = agent.session.events.filter(event => event.type === 'tool/call')
      expect(calls.map(event => event.data.name)).toEqual(['docs/search', 'apply_patch'])
      const results = agent.session.events.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(2)
      expect(results[0]?.data.message.content[0]).toMatchObject({ isError: false })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores transport events and items without transcript content', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'item.updated', item: agentMessage('partial') },
        itemStarted(agentMessage('answer')),
        itemCompleted({ id: 'ws-1', type: 'web_search', query: 'cordis' }),
        itemCompleted({ id: 'todo-1', type: 'todo_list', items: [{ text: 'x', completed: false }] }),
        itemCompleted({ id: 'err-1', type: 'error', message: 'non-fatal' }),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('transport-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const assistants = agent.session.events.filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(agent.session.events.filter(event => event.type === 'tool/call')).toHaveLength(0)
      expect(agent.session.events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the turn with an error when the thread reports a failed turn', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(agentMessage('partial answer')),
        { type: 'turn.failed', error: { message: 'model overloaded' } },
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('failed-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { message: 'model overloaded', code: 'CODEX_TURN_FAILED' },
          },
        },
      })
      // The partial transcript survived the failure.
      expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the turn with an error when the stream emits a fatal error event', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        { type: 'error', message: 'stream broke' },
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('error-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: 'stream broke', code: 'CODEX_ERROR' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the step with no-result when the event stream closes without a completed turn', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(reasoningItem('dangling thought')),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('empty-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      // Trailing reasoning still lands durably before the failure surfaces.
      expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(true)
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code: 'CODEX_NO_RESULT' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('logs the request header once per lifecycle', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('header-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await agent.whenIdle()
      agent.followup(message('two'))
      await agent.whenIdle()

      const headers = agent.session.events.filter(event => event.type === 'request/header')
      expect(headers).toHaveLength(1)
      expect(headers[0]).toMatchObject({
        data: {
          header: { config: { provider: 'codex', model: 'codex-native' } },
          reason: 'initial',
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a resume header when the session already folded one', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const seed: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'request/header', seq: 1, time: 2,
          data: { header: { config: { provider: 'codex', model: 'x' } }, reason: 'initial' },
        },
      ]
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('resume-header'),
        seed,
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const headers = agent.session.events.filter(event => event.type === 'request/header')
      expect(headers).toHaveLength(2)
      expect(headers.at(-1)).toMatchObject({ data: { reason: 'resume' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('CodexAgent cancellation and pre-step interception', () => {
  it('aborts an in-flight query and ends the turn aborted', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('first')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('cancel-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      // Arm a query that blocks until released; the SDK cancels a running
      // turn through the TurnOptions signal, so the mock races its gate
      // against it.
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      mock.runStreamed.mockImplementation((_input, turnOptions) => Promise.resolve({
        events: (async function* (): AsyncGenerator<ThreadEvent> {
          yield itemCompleted(agentMessage('starting'))
          await Promise.race([
            gate,
            new Promise<never>((_, reject) => {
              turnOptions?.signal?.addEventListener('abort', () => {
                reject(new Error('query aborted'))
              }, { once: true })
            }),
          ])
          yield itemCompleted(agentMessage('after gate'))
          yield turnCompleted()
        })(),
      }))

      agent.followup(message('second'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      agent.cancel({ kind: 'user' })
      release?.()
      await agent.whenIdle()
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a proposed step through the agent/pre-step waterfall', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('never')), turnCompleted()]))
      const disposeReject = ctx.on('agent/pre-step', async (): Promise<{ kind: 'reject' }> => ({ kind: 'reject' }))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reject-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      disposeReject()
      expect(mock.runStreamed).not.toHaveBeenCalled()
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'blocked' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('CodexAgent session permission mapping', () => {
  /** Append a durable permission knob whose event key is augmented by packages this compilation does not depend on. */
  function appendKnob(session: Session, type: string, data: unknown): void {
    const append = session.append.bind(session) as unknown as (type: string, data: unknown) => void
    append(type, data)
  }

  it('re-folds the session permission knobs for every query, including mid-session switches', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('perm-switch-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('one'))
      await agent.whenIdle()
      expect(mock.constructed[0]?.threadOptions).toMatchObject({
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
      })

      appendKnob(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
      agent.followup(message('two'))
      await agent.whenIdle()
      expect(mock.constructed[1]?.threadOptions).toMatchObject({
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      })

      appendKnob(agent.session, 'sandbox/mode', { mode: 'workspace-write' })
      appendKnob(agent.session, 'approval/policy', { policy: 'ask' })
      agent.followup(message('three'))
      await agent.whenIdle()
      expect(mock.constructed[2]?.threadOptions).toMatchObject({
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets a deployment-pinned stance override the session per field', async () => {
    const ctx = await harness({ sandboxMode: 'workspace-write' })
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('perm-pinned-s'),
        meta: { cwd: process.cwd() },
      })
      appendKnob(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
      agent.followup(message('go'))
      await agent.whenIdle()
      // The pinned sandbox mode wins; the unpinned policy still follows the session.
      expect(mock.constructed[0]?.threadOptions).toMatchObject({
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('CodexAgent deployment pinning', () => {
  it('forwards model, apiKey, baseUrl, and network access to the SDK', async () => {
    const ctx = await harness({
      model: 'gpt-5.2-codex',
      apiKey: 'sk-pinned',
      baseUrl: 'https://codex.example.test/v1',
      networkAccessEnabled: false,
    })
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('pinned-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const constructed = mock.constructed[0]!
      expect(constructed.threadOptions).toMatchObject({
        model: 'gpt-5.2-codex',
        networkAccessEnabled: false,
      })
      const codexOptions = constructed.codexOptions as { env: Record<string, string>; baseUrl: string }
      expect(codexOptions.env.CODEX_API_KEY).toBe('sk-pinned')
      expect(codexOptions.baseUrl).toBe('https://codex.example.test/v1')

      expect(agent.session.events.filter(e => e.type === 'request/header')[0]).toMatchObject({
        data: { header: { config: { provider: 'codex', model: 'gpt-5.2-codex' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/** Extract the text of a single-block user message for content assertions. */
function textOf(message: UserMessage): string {
  const block = message.content[0]
  return block?.type === 'text' ? block.text : ''
}

/** Collect the durable user messages injected by the skill-invocation seam. */
function injectedSkillMessages(session: Session): UserMessage[] {
  return session.events
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

describe('CodexAgent skill injection', () => {
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
        'file-skill': fakeSkill({
          name: 'file-skill',
          provider: 'file-provider',
          content: 'FILE INSTRUCTIONS',
          resourceBase: { kind: 'file', path: '/x/file.md' },
        }),
      }
      const get = vi.fn((name: string) => Promise.resolve(skills[name]))
      ctx.provide('skills', { get })
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skill-inject-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run /dir-skill then /prov-skill and /file-skill plus /dir-skill again' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      // First-seen order, deduplicated across repeated gestures.
      expect(get).toHaveBeenCalledTimes(3)
      expect(get).toHaveBeenCalledWith('dir-skill', expect.objectContaining({ cwd: process.cwd() }))

      const injected = injectedSkillMessages(agent.session)
      expect(injected.map(message => (message.source as { name: string }).name))
        .toEqual(['dir-skill', 'prov-skill', 'file-skill'])
      expect(injected[0]).toMatchObject({
        source: { kind: 'skill-invocation', name: 'dir-skill', form: 'instructions' },
      })

      const texts = injected.map(textOf)
      expect(texts[0]).toContain('<skill_content name="dir&amp;&quot;&lt;skill">')
      expect(texts[0]).toContain('Base directory for this skill: /base/&lt;dir&gt;&amp;.')
      expect(texts[0]).toContain('DIRECTORY INSTRUCTIONS')
      expect(texts[1]).toContain('Resources for this skill are managed by provider "acme&amp;&lt;co&gt;".')
      expect(texts[1]).toContain('PROVIDER INSTRUCTIONS')
      expect(texts[2]).toContain('Resources for this skill are managed by provider "file-provider".')

      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
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
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
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
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the batch untouched when no skills service is provided', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
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
      expect(agent.session.events.at(-1)).toMatchObject({
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
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skill-filter-s'),
        meta: { cwd: process.cwd() },
      })
      // Queue without waking so both messages land in the same claimed batch.
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
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
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
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
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
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('looks skills up without a cwd hint when the session has no working directory', async () => {
    const ctx = await harness()
    try {
      const get = vi.fn((_name: string, _options?: Record<string, unknown>) => Promise.resolve(fakeSkill({ name: 'dir-skill' })))
      ctx.provide('skills', { get })
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skill-nocwd-s'),
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run /dir-skill' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      expect(get).toHaveBeenCalledTimes(1)
      expect(get.mock.calls[0]?.[1]).not.toHaveProperty('cwd')
      // Injection happens at pre-step, before the step itself fails on the
      // missing working directory.
      expect(injectedSkillMessages(agent.session)).toHaveLength(1)
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
