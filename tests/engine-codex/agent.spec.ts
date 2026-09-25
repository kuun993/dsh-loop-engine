/**
 * Lifecycle tests for the Codex driver: a mocked app-server serves the turn
 * event stream, and the session log records the mapped transcript.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, expandAssistantStream, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { CodexLoop } from '../../src/engine-codex/loop.ts'
import type { AppServerEvent } from '../../src/engine-codex/appserver/thread.ts'
import { loopPluginFor, mountHarness, userMessage as message } from '../helpers/agent-harness.ts'
import { toolResultRole, toolResultView } from '../helpers/harness-generation.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'
import { DSH_ENDPOINT, provideDshEndpoint } from '../helpers/dsh-model-endpoint.ts'

const loopPlugin = loopPluginFor(CodexLoop, ['agents', 'sessions', 'systemPrompt'])

type RunStreamed = (
  input: string,
  turnOptions?: { signal?: AbortSignal; params?: Record<string, unknown> },
) => AsyncGenerator<AppServerEvent>

/** Hoisted mock state: every constructed fake client plus the runStreamed implementation. */
const mock = vi.hoisted(() => ({
  constructed: [] as Array<{ threadParams: Record<string, unknown> }>,
  spawns: [] as Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }>,
  runStreamed: vi.fn<RunStreamed>(),
  requestHandler: undefined as undefined | ((method: string, params: unknown) => Promise<{ result?: unknown; error?: { code: number; message: string } }>),
}))

vi.mock('../../src/engine-codex/appserver/client.ts', () => ({
  AppServerClient: {
    create: async (argv: readonly string[], env: NodeJS.ProcessEnv) => {
      mock.spawns.push({ argv, env })
      return {
      threadStart: async () => ({ thread: { id: 'mock-thread-1' } }),
      threadResume: async () => ({ thread: { id: 'mock-thread-1' } }),
      turnStart: async () => ({ turn: { id: 'mock-turn-1', status: 'inProgress' } }),
      turnInterrupt: async () => ({}),
      onNotification: () => {},
      onRequest: (handler: (method: string, params: unknown) => Promise<{ result?: unknown; error?: { code: number; message: string } }>) => {
        mock.requestHandler = handler
      },
      onStderr: () => {},
      dispose: () => {},
      }
    },
  },
}))

vi.mock('../../src/engine-codex/appserver/thread.ts', () => ({
  AppServerThread: {
    create: async (_client: unknown, threadParams: Record<string, unknown>) => {
      mock.constructed.push({ threadParams })
      return {
        threadId: 'mock-thread-1',
        async *turn(_input: unknown, _options: unknown): AsyncGenerator<AppServerEvent> {
          for await (const event of mock.runStreamed(_input, _options)) {
            yield event
          }
        },
        async dispose() {},
      }
    },
  },
}))

beforeEach(() => {
  mock.constructed.length = 0
  mock.spawns.length = 0
  mock.runStreamed.mockReset()
  mock.requestHandler = undefined
})

function stream(events: AppServerEvent[]): RunStreamed {
  async function* inner(): AsyncGenerator<AppServerEvent, void> {
    for (const event of events) yield event
  }
  return inner()
}

/** Step-scoped event types, in the order a reader sees them. */
const STEP_SCOPED = new Set(['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end'])

/**
 * The log's step-scoped events as ordered `type@step` tags, so a test can read
 * the step structure directly: which step each message and tool event landed in.
 */
function stepStructure(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => STEP_SCOPED.has(event.type))
    .map(event => `${event.type}@${(event.data as { step: number }).step}`)
}

const TURN_USAGE = {
  inputTokens: 12,
  cachedInputTokens: 5,
  outputTokens: 7,
  reasoningOutputTokens: 3,
}

function itemCompleted(item: { type: string; id: string; text?: string; [key: string]: unknown }): AppServerEvent {
  return { kind: 'item-completed', item: item as AppServerEvent extends { kind: 'item-completed'; item: infer T } ? T : never }
}

function itemStarted(itemType: string, itemId: string): AppServerEvent {
  return { kind: 'item-started', itemType, itemId }
}

function agentMessage(text: string): { type: string; id: string; text: string } {
  return { type: 'agentMessage', id: `msg-${text}`, text }
}

function agentDelta(itemId: string, delta: string): AppServerEvent {
  return { kind: 'agent-delta', itemId, delta }
}

function reasoningItem(text: string): { type: string; id: string; summary: string[]; content: string[] } {
  return { type: 'reasoning', id: `reason-${text}`, summary: [text], content: [] }
}

function reasoningSummaryDelta(itemId: string, delta: string): AppServerEvent {
  return { kind: 'reasoning-summary-delta', itemId, delta, summaryIndex: 0 }
}

function commandItem(overrides: Record<string, unknown> = {}): { type: string; id: string; [key: string]: unknown } {
  return {
    type: 'commandExecution',
    id: 'cmd-1',
    command: 'ls -la',
    aggregatedOutput: 'total 0',
    exitCode: 0,
    status: 'completed',
    ...overrides,
  }
}

function mcpToolCall(overrides: Record<string, unknown> = {}): { type: string; id: string; [key: string]: unknown } {
  return {
    type: 'mcpToolCall',
    id: 'mcp-1',
    server: 'docs',
    tool: 'search',
    arguments: { q: 'cordis' },
    result: { content: [{ type: 'text', text: 'ok' }] },
    status: 'completed',
    ...overrides,
  }
}

function fileChange(overrides: Record<string, unknown> = {}): { type: string; id: string; [key: string]: unknown } {
  return {
    type: 'fileChange',
    id: 'patch-1',
    changes: [{ path: 'src/a.ts', kind: 'update' }],
    status: 'completed',
    ...overrides,
  }
}

function turnCompleted(usage: typeof TURN_USAGE = TURN_USAGE): AppServerEvent {
  return {
    kind: 'turn-completed',
    turn: {
      id: 'turn-1',
      status: 'completed',
      error: null,
      items: [],
      usage,
    },
  }
}

async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = await mountHarness(loopPlugin, config, 'none')
  // The host's `modelSelection` fold, so a `model/selection` appended to the
  // session is read back as the pending selection the driver resolves a model
  // from — the same read the host's own `selectionFor` makes.
  ctx.provide('sessionProjections', modelSelectionProjections(ctx))
  return ctx
}

/** One durable assistant message event, narrowed from the session event union. */
type AssistantMessageEvent = Extract<SessionEvent, { type: 'assistant/message' }>

/** The exact chunk sequence a durable assistant message embeds. */
function embeddedChunks(event: AssistantMessageEvent) {
  return expandAssistantStream(event.data.stream).map(member => member.chunk)
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

describe('CodexAgent turn mapping', () => {
  it('records turn, step, assistant message, usage, and completion in the session log', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        { kind: 'turn-started', turnId: 'turn-1' },
        itemCompleted(agentMessage('hello world')),
        turnCompleted(),
      ]))
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
            source: { kind: 'model', provider: 'external' },
            content: [{ type: 'text', text: 'hello world' }],
          },
          usage: {
            inputTokens: 12,
            outputTokens: 7,
            cacheReadTokens: 5,
            reasoningTokens: 3,
          },
        },
        surfaceOp: 'append',
      })

      expect(mock.runStreamed).toHaveBeenCalledTimes(1)
      const [input, turnOptions] = mock.runStreamed.mock.calls[0]!
      const inputText = Array.isArray(input) ? input.map((item: { text?: string }) => item.text ?? '').join('') : String(input)
      expect(inputText).toContain('<user>')
      expect(inputText).toContain('hi')
      expect(turnOptions?.signal).toBeInstanceOf(AbortSignal)
      expect(turnOptions?.params).toEqual({ approvalPolicy: 'never' })
      expect(turnOptions?.params).not.toHaveProperty('sandboxPolicy')

      const constructed = mock.constructed[0]!
      expect(constructed.threadParams).toMatchObject({
        cwd: process.cwd(),
        sandbox: 'read-only',
        approvalPolicy: 'never',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('streams an agent message chunk by chunk and embeds the attempt stream in the durable message', async () => {
    const ctx = await harness()
    try {
      const frames: AssistantStreamFrame[] = []
      const disposeFrames = ctx.on('agent/assistant-stream', ({ frame }) => { frames.push(frame) })
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-hello'),
        agentDelta('msg-hello', 'hello world'),
        itemCompleted(agentMessage('hello world')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('stream-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({ surfaceOp: 'append' })
      // The durable message embeds its exact timed stream; `assistant/chunk`
      // log events and `sourceEventSeqs` no longer exist.
      expect(expandAssistantStream(assistant!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'hello world' },
      ])
      // The same attempt publishes live frames: open, one per chunk, settled.
      expect(frames.map(frame => frame.type)).toEqual(['start', 'chunk', 'chunk', 'end'])
      expect(frames.at(-1)).toMatchObject({
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: assistant!.seq },
      })
      disposeFrames()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a reasoning item into the following agent message', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('reasoning', 'reason-1'),
        reasoningSummaryDelta('reason-1', 'split thinking'),
        itemCompleted(reasoningItem('split thinking')),
        itemStarted('agentMessage', 'msg-answer'),
        agentDelta('msg-answer', 'answer'),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-fold-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'split thinking' },
        { type: 'text', text: 'answer' },
      ])
      // Both blocks streamed into the single message this step committed.
      expect(expandAssistantStream(assistants[0]!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'split thinking' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds trailing reasoning into the turn-closing message carrying the turn usage', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-answer'),
        agentDelta('msg-answer', 'answer'),
        itemCompleted(agentMessage('answer')),
        itemStarted('reasoning', 'reason-1'),
        reasoningSummaryDelta('reason-1', 'trailing thought'),
        itemCompleted(reasoningItem('trailing thought')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-trailing-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      // The trailing reasoning folds into the closing message so the chat view
      // renders the answer and its thinking together (one message per step).
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'trailing thought' },
      ])
      expect(assistants[0]?.data.usage).toMatchObject({ outputTokens: 7 })
      expect(expandAssistantStream(assistants[0]!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'answer' },
        { type: 'block-start', index: 1, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 1, text: 'trailing thought' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('merges consecutive agent messages into one message', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-first'),
        agentDelta('msg-first', 'first'),
        itemCompleted(agentMessage('first')),
        itemStarted('agentMessage', 'msg-second'),
        agentDelta('msg-second', 'second'),
        itemCompleted(agentMessage('second')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('two-messages-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      // Consecutive agent messages in one segment merge into ONE message, so
      // the chat view does not drop the earlier text.
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ])
      expect(assistants[0]?.data.usage).toMatchObject({ inputTokens: 12 })
      expect(expandAssistantStream(assistants[0]!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'first' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'second' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['commandExecution', commandItem()],
    ['fileChange', fileChange()],
    ['mcpToolCall', mcpToolCall()],
  ])('splits the stream at a %s item interleaved between two agent messages', async (kind, toolItem) => {
    const expectedToolCall = {
      commandExecution: { type: 'tool-call', id: 'cmd-1', name: 'command_execution', arguments: '{"command":"ls -la"}' },
      fileChange: { type: 'tool-call', id: 'patch-1', name: 'apply_patch', arguments: '[{"path":"src/a.ts","kind":"update"}]' },
      mcpToolCall: { type: 'tool-call', id: 'mcp-1', name: 'docs/search', arguments: '{"q":"cordis"}' },
    }[kind]
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-first'),
        agentDelta('msg-first', 'first'),
        itemCompleted(agentMessage('first')),
        itemCompleted(toolItem),
        itemStarted('agentMessage', 'msg-second'),
        agentDelta('msg-second', 'second'),
        itemCompleted(agentMessage('second')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(`tool-between-s-${kind}`),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const assistants = events.filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(2)
      // The tool-call block folds into the message that requested it, so the
      // serialized transcript keeps the tool invocation beside its result.
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'first' }, expectedToolCall])
      expect(assistants[0]?.data.usage).toBeUndefined()
      expect(assistants[1]?.data.message.content).toEqual([{ type: 'text', text: 'second' }])
      expect(assistants[1]?.data.usage).toMatchObject({ inputTokens: 12 })
      // The tool item settles the attempt mid-step; neither message may embed
      // chunks streamed for the other one.
      expect(embeddedChunks(assistants[0]!)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'first' },
      ])
      expect(embeddedChunks(assistants[1]!)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'second' },
      ])
      expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('merges a reasoning item interleaved between two agent messages', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-first'),
        agentDelta('msg-first', 'first'),
        itemCompleted(agentMessage('first')),
        itemStarted('reasoning', 'reason-1'),
        reasoningSummaryDelta('reason-1', 'think'),
        itemCompleted(reasoningItem('think')),
        itemStarted('agentMessage', 'msg-second'),
        agentDelta('msg-second', 'second'),
        itemCompleted(agentMessage('second')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-between-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      // Reasoning between two agent messages belongs to the SAME segment, so it
      // folds into the one merged message with its block index after the text.
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'text', text: 'first' },
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'second' },
      ])
      expect(assistants[0]?.data.usage).toMatchObject({ inputTokens: 12 })
      expect(embeddedChunks(assistants[0]!)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'first' },
        { type: 'block-start', index: 1, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 1, text: 'think' },
        { type: 'block-start', index: 2, blockType: 'text' },
        { type: 'text-delta', index: 2, text: 'second' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds trailing reasoning and its tool call into one message when a tool item closes the segment', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-first'),
        agentDelta('msg-first', 'first'),
        itemCompleted(agentMessage('first')),
        itemStarted('reasoning', 'reason-1'),
        reasoningSummaryDelta('reason-1', 'think'),
        itemCompleted(reasoningItem('think')),
        itemCompleted(commandItem()),
        itemStarted('agentMessage', 'msg-second'),
        agentDelta('msg-second', 'second'),
        itemCompleted(agentMessage('second')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-tool-between-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const assistants = events.filter(event => event.type === 'assistant/message')
      // The reasoning and the tool call fold into the message that requested
      // the tool, so a single segment keeps one message (the chat view renders
      // only the last message per step).
      expect(assistants).toHaveLength(2)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'text', text: 'first' },
        { type: 'reasoning', text: 'think' },
        { type: 'tool-call', id: 'cmd-1', name: 'command_execution', arguments: '{"command":"ls -la"}' },
      ])
      expect(assistants[0]?.data.usage).toBeUndefined()
      expect(assistants[1]?.data.message.content).toEqual([{ type: 'text', text: 'second' }])
      expect(assistants[1]?.data.usage).toMatchObject({ inputTokens: 12 })
      // The tool item folds the reasoning and the call into the first message;
      // the following agent message carries only the chunks its own text streamed.
      expect(embeddedChunks(assistants[0]!)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'first' },
        { type: 'block-start', index: 1, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 1, text: 'think' },
      ])
      expect(embeddedChunks(assistants[1]!)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'second' },
      ])
      expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a reasoning item and its tool call into one message when no agent message precedes the tool', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('reasoning', 'reason-1'),
        reasoningSummaryDelta('reason-1', 'think'),
        itemCompleted(reasoningItem('think')),
        itemCompleted(commandItem()),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-tool-no-message-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const assistants = events.filter(event => event.type === 'assistant/message')
      // The reasoning is the only authoring content, so it synthesizes the
      // message that owns the tool call.
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'think' },
        { type: 'tool-call', id: 'cmd-1', name: 'command_execution', arguments: '{"command":"ls -la"}' },
      ])
      expect(embeddedChunks(assistants[0]!)).toEqual([
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'think' },
      ])
      expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("does not leak a plan item's streamed chunks into the merged agent message", async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-first'),
        agentDelta('msg-first', 'first'),
        itemCompleted(agentMessage('first')),
        itemStarted('plan', 'plan-1'),
        { kind: 'plan-delta', itemId: 'plan-1', delta: 'planned' },
        itemCompleted({ type: 'plan', id: 'plan-1', text: 'planned' }),
        itemStarted('agentMessage', 'msg-second'),
        agentDelta('msg-second', 'second'),
        itemCompleted(agentMessage('second')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('plan-between-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      // A plan item contributes no durable content block, and the two agent
      // messages merge into ONE message.
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ])
      expect(assistants[0]?.data.usage).toMatchObject({ inputTokens: 12 })
      // The plan's chunks streamed between the two text blocks belong to
      // neither: the merged message must not embed the plan's reasoning segment.
      expect(embeddedChunks(assistants[0]!)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'first' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'second' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores a plan item that streamed no deltas', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('plan', 'plan-1'),
        itemCompleted({ type: 'plan', id: 'plan-1', text: 'planned' }),
        itemStarted('agentMessage', 'msg-a'),
        agentDelta('msg-a', 'answer'),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('plan-quiet-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'answer' }])
      expect(embeddedChunks(assistants[0]!)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('streams multiple deltas into one text block (no duplicate block-start)', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-multi'),
        agentDelta('msg-multi', 'hello '),
        agentDelta('msg-multi', 'world'),
        itemCompleted(agentMessage('hello world')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('multi-delta-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'hello world' }])
      // Multiple deltas stay separate boundaries inside one attempt stream.
      expect(expandAssistantStream(assistants[0]!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'hello ' },
        { type: 'text-delta', index: 0, text: 'world' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('streams multiple reasoning deltas into one reasoning block', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('reasoning', 'reason-1'),
        reasoningSummaryDelta('reason-1', 'think '),
        reasoningSummaryDelta('reason-1', 'more'),
        itemCompleted(reasoningItem('think more')),
        itemStarted('agentMessage', 'msg-a'),
        agentDelta('msg-a', 'answer'),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('multi-reason-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'think more' },
        { type: 'text', text: 'answer' },
      ])
      expect(expandAssistantStream(assistants[0]!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'think ' },
        { type: 'reasoning-delta', index: 0, text: 'more' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the streamed thinking when the terminal reasoning item carries neither field', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('reasoning', 'reason-1'),
        reasoningSummaryDelta('reason-1', 'think'),
        itemCompleted({ type: 'reasoning', id: 'reason-1' }),
        itemStarted('agentMessage', 'msg-a'),
        agentDelta('msg-a', 'answer'),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('empty-reason-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      // The terminal item said nothing, so the thinking the user already
      // watched streaming is what the transcript keeps.
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('takes the reasoning content when the summary array is present but empty', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('reasoning', 'reason-s'),
        reasoningSummaryDelta('reason-s', 'streamed'),
        itemCompleted({ type: 'reasoning', id: 'reason-s', summary: [], content: ['body'] }),
        itemStarted('agentMessage', 'msg-a'),
        agentDelta('msg-a', 'answer'),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('summary-empty-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      // Both arrays are always present and either may be empty: an empty
      // `summary` must not shadow a populated `content`.
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'body' },
        { type: 'text', text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records an empty reasoning text when nothing streamed and no field carries text', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted({ type: 'reasoning', id: 'reason-quiet', summary: [], content: [] }),
        itemStarted('agentMessage', 'msg-a'),
        agentDelta('msg-a', 'answer'),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('quiet-reason-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: '' },
        { type: 'text', text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a reasoning item that streamed no deltas', async () => {
    const ctx = await harness()
    try {
      // The app-server may report an item only once it completed: no attempt
      // exists yet, so the reasoning contributes content but no chunks.
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(reasoningItem('quiet thought')),
        itemStarted('agentMessage', 'msg-a'),
        agentDelta('msg-a', 'answer'),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('unstreamed-reason-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'quiet thought' },
        { type: 'text', text: 'answer' },
      ])
      expect(expandAssistantStream(assistants[0]!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('handles an agent message item with no text', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-empty'),
        agentDelta('msg-empty', 'x'),
        itemCompleted({ type: 'agentMessage', id: 'msg-empty' }),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('empty-msg-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: '' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('handles a turn completed without usage', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-a'),
        agentDelta('msg-a', 'answer'),
        itemCompleted(agentMessage('answer')),
        { kind: 'turn-completed', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } },
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('no-usage-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'text', text: 'answer' }])
      expect(assistants[0]?.data.usage).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores unknown item types in the item-completed handler', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-a'),
        agentDelta('msg-a', 'answer'),
        itemCompleted(agentMessage('answer')),
        itemCompleted({ type: 'webSearch', id: 'ws-1', query: 'x' }),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('unknown-item-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('gives each assistant segment its own step', async () => {
    // One codex turn runs the model's whole agentic loop, so a single dsh step
    // would otherwise hold every segment. The chat view keys an assistant node
    // by `${turn}:${step}` and replaces its blocks on each message, so N
    // messages in one step render only the last — the fix is one step per
    // segment, matching the in-process engine's shape.
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(reasoningItem('think one')),
        itemCompleted(agentMessage('reading the file')),
        itemCompleted(commandItem()),
        itemCompleted(reasoningItem('think two')),
        itemCompleted(agentMessage('all done')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('segments-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      expect(stepStructure(agent.session)).toEqual([
        'step/start@1', 'assistant/message@1', 'tool/call@1', 'tool/result@1', 'step/end@1',
        'step/start@2', 'assistant/message@2', 'step/end@2',
      ])
      // Each message stays ahead of the tool it requested, in its own step.
      const messages = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(messages.map(event => (event.data as { step: number }).step)).toEqual([1, 2])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rotates the step at the first streamed reasoning of a new segment', async () => {
    // Reasoning streams before its item completes, so the rotation has to
    // happen at the delta — otherwise live reasoning frames would paint into
    // the finished step and only the durable message would move.
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(agentMessage('first')),
        itemCompleted(commandItem()),
        itemStarted('reasoning', 'r-2'),
        reasoningSummaryDelta('r-2', 'think two'),
        itemCompleted(reasoningItem('think two')),
        itemCompleted(agentMessage('second')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('segments-delta-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      expect(stepStructure(agent.session)).toEqual([
        'step/start@1', 'assistant/message@1', 'tool/call@1', 'tool/result@1', 'step/end@1',
        'step/start@2', 'assistant/message@2', 'step/end@2',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a command execution started/completed pair as tool/call and tool/result', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('commandExecution', 'cmd-1'),
        itemCompleted(commandItem({ status: 'completed', aggregatedOutput: 'file.txt' })),
        itemStarted('agentMessage', 'msg-done'),
        agentDelta('msg-done', 'done'),
        itemCompleted(agentMessage('done')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('tool-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('list it'))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const call = events.find(event => event.type === 'tool/call')
      expect(call).toMatchObject({
        data: { callId: 'cmd-1', name: 'bash', arguments: '{"command":"ls -la"}' },
      })
      const result = events.find(event => event.type === 'tool/result')
      expect(result).toMatchObject({ surfaceOp: 'append' })
      expect(toolResultView(result?.data.message)).toMatchObject({
        role: toolResultRole(),
        toolCallId: 'cmd-1',
        isError: false,
        content: [{ type: 'text', text: 'file.txt' }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('emits the tool/call lazily when only the terminal item event arrives', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemCompleted(commandItem({ status: 'completed', exitCode: 3 })),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('tool-lazy-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const call = agent.session.snapshotEvents().find(event => event.type === 'tool/call')
      expect(call).toMatchObject({ data: { callId: 'cmd-1', name: 'bash' } })
      const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
      expect(toolResultView(result?.data.message).isError).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records MCP tool calls and file changes beside the assistant message', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('mcpToolCall', 'mcp-1'),
        itemCompleted(mcpToolCall({ status: 'completed' })),
        itemStarted('fileChange', 'patch-1'),
        itemCompleted(fileChange()),
        itemStarted('agentMessage', 'msg-done'),
        agentDelta('msg-done', 'done'),
        itemCompleted(agentMessage('done')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('tool-mix-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
      expect(calls.map(event => event.data.name)).toEqual(['docs/search', 'apply_patch'])
      const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(2)
      expect(toolResultView(results[0]?.data.message).isError).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores transport events and items without transcript content', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        { kind: 'turn-started', turnId: 'turn-1' },
        itemStarted('agentMessage', 'msg-answer'),
        agentDelta('msg-answer', 'answer'),
        itemCompleted(agentMessage('answer')),
        turnCompleted(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('transport-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the turn with an error when the thread reports a failed turn', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-partial'),
        agentDelta('msg-partial', 'partial answer'),
        itemCompleted(agentMessage('partial answer')),
        { kind: 'error', error: { message: 'model overloaded' }, willRetry: false },
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('failed-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { message: 'model overloaded', code: 'CODEX_ERROR' },
          },
        },
      })
      // The partial transcript survived the failure.
      expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('abandons the live attempt when a step streams chunks but commits no message', async () => {
    const ctx = await harness()
    try {
      const frames: AssistantStreamFrame[] = []
      const disposeFrames = ctx.on('agent/assistant-stream', ({ frame }) => { frames.push(frame) })
      mock.runStreamed.mockImplementation(() => stream([
        itemStarted('agentMessage', 'msg-partial'),
        agentDelta('msg-partial', 'partial answer'),
        itemStarted('reasoning', 'reason-1'),
        reasoningSummaryDelta('reason-1', 'dangling'),
        { kind: 'error', error: { message: 'model overloaded' }, willRetry: false },
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('abandon-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      // Neither item completed, so no durable message claims the streamed
      // chunks: the attempt closes its live frames as abandoned instead.
      expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
      expect(frames.map(frame => frame.type)).toEqual(['start', 'chunk', 'chunk', 'chunk', 'chunk', 'end'])
      expect(frames.at(-1)).toMatchObject({ outcome: { kind: 'abandoned' } })
      disposeFrames()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the turn with an error when the stream emits a fatal error event', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([
        { kind: 'error', error: { message: 'stream broke' }, willRetry: false },
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('error-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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
        itemStarted('reasoning', 'reason-1'),
        reasoningSummaryDelta('reason-1', 'dangling thought'),
        itemCompleted(reasoningItem('dangling thought')),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('empty-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      // Trailing reasoning still lands durably before the failure surfaces.
      expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(true)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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

      const headers = agent.session.snapshotEvents().filter(event => event.type === 'request/header')
      expect(headers).toHaveLength(1)
      expect(headers[0]).toMatchObject({
        data: {
          header: { config: { provider: 'external', model: 'default' } },
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
      const headers = agent.session.snapshotEvents().filter(event => event.type === 'request/header')
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

      // Arm a query that blocks until released; the app-server cancels a
      // running turn through the abort signal, so the mock races its gate
      // against it.
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      mock.runStreamed.mockImplementation((_input, turnOptions) => (async function* (): AsyncGenerator<AppServerEvent> {
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
      })())

      agent.followup(message('second'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      agent.cancel({ kind: 'user' })
      release?.()
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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
      expect(mock.constructed[0]?.threadParams).toMatchObject({
        sandbox: 'read-only',
        approvalPolicy: 'never',
      })

      appendKnob(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
      agent.followup(message('two'))
      await agent.whenIdle()
      expect(mock.constructed[1]?.threadParams).toMatchObject({
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      })

      appendKnob(agent.session, 'sandbox/mode', { mode: 'workspace-write' })
      appendKnob(agent.session, 'approval/policy', { policy: 'ask' })
      agent.followup(message('three'))
      await agent.whenIdle()
      expect(mock.constructed[2]?.threadParams).toMatchObject({
        sandbox: 'workspace-write',
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
      expect(mock.constructed[0]?.threadParams).toMatchObject({
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('CodexAgent deployment pinning', () => {
  it('forwards model to the app-server thread params', async () => {
    const ctx = await harness({
      model: 'gpt-5.2-codex',
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
      expect(constructed.threadParams).toMatchObject({
        model: 'gpt-5.2-codex',
      })

      expect(agent.session.snapshotEvents().filter(e => e.type === 'request/header')[0]).toMatchObject({
        data: { header: { config: { provider: 'external', model: 'gpt-5.2-codex' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('CodexAgent model selection', () => {
  /** The `params` the Nth turn ran with. */
  function turnParamsAt(index: number): Record<string, unknown> {
    const turnOptions = mock.runStreamed.mock.calls[index]?.[1] as { params: Record<string, unknown> } | undefined
    if (turnOptions === undefined) throw new Error(`no turn ran at index ${index}`)
    return turnOptions.params
  }

  it('hands the session-selected dsh model to the thread and turn, over the deployment pin', async () => {
    const ctx = await harness({ model: 'deployment-pinned' })
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-s'),
        meta: { cwd: process.cwd() },
      })
      // A harness `session.selectModel` appends a model/selection event.
      agent.session.append('model/selection', { provider: 'meicloud', model: 'deepseek-flash' })
      agent.followup(message('go'))
      await agent.whenIdle()

      // Codex takes a bare model slug, so the model half of the override
      // travels and the session wins over the deployment's pin.
      expect(mock.constructed[0]?.threadParams.model).toBe('deepseek-flash')
      expect(turnParamsAt(0).model).toBe('deepseek-flash')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends no model for the hosted seat, falling back to the deployment pin', async () => {
    const ctx = await harness({ model: 'deployment-pinned' })
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-hosted-s'),
        meta: { cwd: process.cwd() },
      })
      agent.session.append('model/selection', { provider: 'external', model: 'default' })
      agent.followup(message('go'))
      await agent.whenIdle()

      // `external` means "the engine decides": the pin governs instead of the
      // routed label being handed to the app-server.
      expect(mock.constructed[0]?.threadParams.model).toBe('deployment-pinned')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends no model at all when the deployment pins none and no real model is selected', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-none-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      expect('model' in (mock.constructed[0]?.threadParams ?? {})).toBe(false)
      expect('model' in turnParamsAt(0)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-resolves the model on every step, so a mid-session change reaches the next thread', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-change-s'),
        meta: { cwd: process.cwd() },
      })
      agent.session.append('model/selection', { provider: 'meicloud', model: 'model-a' })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(mock.constructed[0]?.threadParams.model).toBe('model-a')

      agent.session.append('model/selection', { provider: 'meicloud', model: 'model-b' })
      agent.followup(message('again'))
      await agent.whenIdle()
      expect(mock.constructed[1]?.threadParams.model).toBe('model-b')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('CodexAgent dsh endpoint handover', () => {
  /** The spawn arguments the Nth app-server was created with. */
  function spawnAt(index: number): { argv: readonly string[]; env: NodeJS.ProcessEnv } {
    const spawn = mock.spawns[index]
    if (spawn === undefined) throw new Error(`no app-server spawned at index ${index}`)
    return spawn
  }

  it('spawns the app-server with the dsh provider override and the credential env', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      provideDshEndpoint(ctx, { api: 'openai-responses' })
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(message('go'))
      await agent.whenIdle()

      const { argv, env } = spawnAt(0)
      expect(argv).toContain('model_provider="dsh"')
      expect(argv.some(entry => entry.startsWith('model_providers.dsh={'))).toBe(true)
      const profile = argv.find(entry => entry.startsWith('model_providers.dsh={'))!
      expect(profile).toContain('name="dsh"')
      expect(profile).toContain(`base_url="${DSH_ENDPOINT.baseURL}"`)
      expect(profile).toContain('wire_api="responses"')
      expect(profile).toContain('env_key="DSH_LOOP_ENGINE_API_KEY"')
      expect(env.DSH_LOOP_ENGINE_API_KEY).toBe(DSH_ENDPOINT.apiKey)
      // The model itself still travels as the thread's own param.
      expect(mock.constructed[0]?.threadParams.model).toBe(DSH_ENDPOINT.model)
      // The credential reaches the child's environment, never the session log.
      expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain(DSH_ENDPOINT.apiKey)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes the deployment\'s own env entries to the app-server, with the handover layered over them', async () => {
    const ctx = await harness({ env: { CODEX_STATIC: 'from-config' } })
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      provideDshEndpoint(ctx)
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-env-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(message('go'))
      await agent.whenIdle()

      // `config.env` used to be parsed and never consumed; it now reaches the
      // child, which is what makes the argv/env path real.
      expect(spawnAt(0).env.CODEX_STATIC).toBe('from-config')
      expect(spawnAt(0).env.DSH_LOOP_ENGINE_API_KEY).toBe(DSH_ENDPOINT.apiKey)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('spawns a bare app-server when no endpoint is handed over', async () => {
    const ctx = await harness({ model: 'deployment-pinned', env: { CODEX_STATIC: 'from-config' } })
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      provideDshEndpoint(ctx)
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-hosted-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: 'external', model: 'default' })
      agent.followup(message('go'))
      await agent.whenIdle()

      const { argv, env } = spawnAt(0)
      expect(argv).toEqual([])
      expect('DSH_LOOP_ENGINE_API_KEY' in env).toBe(false)
      // The deployment's own env still reaches the child.
      expect(env.CODEX_STATIC).toBe('from-config')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('injects nothing and warns once when the endpoint cannot be resolved', async () => {
    const ctx = await harness()
    try {
      const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-unresolved-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(message('one'))
      await agent.whenIdle()
      agent.followup(message('two'))
      await agent.whenIdle()

      expect(spawnAt(0).argv).toEqual([])
      // The model name still travels; only the endpoint stayed behind.
      expect(mock.constructed[0]?.threadParams.model).toBe(DSH_ENDPOINT.model)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('respawns the app-server when the endpoint changes mid-session', async () => {
    const ctx = await harness()
    try {
      mock.runStreamed.mockImplementation(() => stream([itemCompleted(agentMessage('ok')), turnCompleted()]))
      const endpoint = provideDshEndpoint(ctx, { baseURL: 'https://first.example.com/litellm' })
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-change-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(message('one'))
      await agent.whenIdle()
      expect(spawnAt(0).argv.some(entry => entry.includes('https://first.example.com/litellm'))).toBe(true)

      endpoint.update({ baseURL: 'https://second.example.com/litellm' })
      agent.followup(message('two'))
      await agent.whenIdle()
      expect(mock.spawns).toHaveLength(2)
      expect(spawnAt(1).argv.some(entry => entry.includes('https://second.example.com/litellm'))).toBe(true)

      // An unchanged endpoint reuses the running child rather than respawning.
      agent.followup(message('three'))
      await agent.whenIdle()
      expect(mock.spawns).toHaveLength(2)
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

      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('CodexAgent interactive approvals', () => {
  /** Drive one short turn so the lazily-created client registers its request handler. */
  async function settle(ctx: Context): Promise<void> {
    mock.runStreamed.mockImplementation(() => stream([
      itemStarted('agentMessage', 'msg-a'),
      agentDelta('msg-a', 'ok'),
      itemCompleted(agentMessage('ok')),
      turnCompleted(),
    ]))
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('approval-s'),
      meta: { cwd: process.cwd() },
    })
    agent.followup(message('go'))
    await agent.whenIdle()
  }

  it('answers a command approval from the dsh approval seam', async () => {
    const ctx = await harness()
    try {
      let outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once'
      const requests: Array<{ toolName: string; reason?: string }> = []
      ctx.provide('approval', {
        request: (req: { toolName: string; reason?: string }) => {
          requests.push(req)
          return Promise.resolve(outcome)
        },
      })
      await settle(ctx)

      expect(mock.requestHandler).toBeDefined()
      expect(await mock.requestHandler!('item/commandExecution/requestApproval', { itemId: 'c', command: 'ls -la' }))
        .toEqual({ result: { decision: 'accept' } })
      expect(requests[0]).toMatchObject({ toolName: 'command', reason: expect.stringContaining('ls -la') })

      outcome = 'rejected'
      expect(await mock.requestHandler!('item/commandExecution/requestApproval', { itemId: 'c', command: 'rm -rf /' }))
        .toEqual({ result: { decision: 'decline' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('grants a permissions request only on allow', async () => {
    const ctx = await harness()
    try {
      let outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once'
      ctx.provide('approval', {
        request: () => Promise.resolve(outcome),
      })
      await settle(ctx)

      const requested = { network: { enabled: true } }
      expect(await mock.requestHandler!('item/permissions/requestApproval', { permissions: requested }))
        .toEqual({ result: { permissions: requested, scope: 'turn' } })

      outcome = 'cancelled'
      expect(await mock.requestHandler!('item/permissions/requestApproval', { permissions: requested }))
        .toEqual({ result: { permissions: {}, scope: 'turn' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed to a decline when no approval service is mounted', async () => {
    const ctx = await harness()
    try {
      await settle(ctx)
      expect(await mock.requestHandler!('item/fileChange/requestApproval', {}))
        .toEqual({ result: { decision: 'decline' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails unknown server-request methods with method-not-found', async () => {
    const ctx = await harness()
    try {
      ctx.provide('approval', { request: () => Promise.resolve('allowed-once') })
      await settle(ctx)
      expect(await mock.requestHandler!('item/tool/call', {}))
        .toEqual({ error: { code: -32601, message: 'Method not found' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers a user-input request from the user-questions seam', async () => {
    const ctx = await harness()
    try {
      const asked: unknown[] = []
      ctx.provide('userQuestions', {
        ask: (req: unknown) => {
          asked.push(req)
          return Promise.resolve({ answers: [{ id: 'q1', selected: ['dev'], custom: 'note' }] })
        },
      })
      await settle(ctx)

      expect(await mock.requestHandler!('item/tool/requestUserInput', {
        questions: [{ id: 'q1', header: 'Deploy', question: 'Which env?', options: [{ label: 'dev', description: 'd' }] }],
      })).toEqual({ result: { answers: { q1: { answers: ['dev', 'note'] } } } })
      expect(asked[0]).toMatchObject({
        questions: [{ id: 'q1', header: 'Deploy', question: 'Which env?', options: [{ label: 'dev', description: 'd' }] }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers with no answers when the user-questions seam is absent or refuses', async () => {
    const ctx = await harness()
    try {
      await settle(ctx)
      expect(await mock.requestHandler!('item/tool/requestUserInput', {
        questions: [{ id: 'q1', question: 'Which env?' }],
      })).toEqual({ result: { answers: {} } })

      ctx.provide('userQuestions', { ask: () => Promise.reject(new Error('NO_PROVIDER')) })
      expect(await mock.requestHandler!('item/tool/requestUserInput', {
        questions: [{ id: 'q1', question: 'Which env?' }],
      })).toEqual({ result: { answers: {} } })

      // No usable question on the wire: nothing to ask, still in-vocabulary.
      expect(await mock.requestHandler!('item/tool/requestUserInput', {}))
        .toEqual({ result: { answers: {} } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('declines an MCP elicitation request', async () => {
    const ctx = await harness()
    try {
      await settle(ctx)
      expect(await mock.requestHandler!('mcpServer/elicitation/request', { serverName: 's' }))
        .toEqual({ result: { action: 'decline' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('forwards the running turn signal to the user-questions seam', async () => {
    const ctx = await harness()
    try {
      let receivedSignal: AbortSignal | undefined
      ctx.provide('userQuestions', {
        ask: (req: { signal?: AbortSignal }) => {
          receivedSignal = req.signal
          return Promise.resolve({ answers: [{ id: 'q1', selected: [] }] })
        },
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      mock.runStreamed.mockImplementation(async function* () {
        await gate
        yield turnCompleted()
      })
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('running-question-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await vi.waitFor(() => { expect(mock.requestHandler).toBeDefined() })

      expect(await mock.requestHandler!('item/tool/requestUserInput', {
        questions: [{ id: 'q1', question: 'Which env?' }],
      })).toEqual({ result: { answers: { q1: { answers: [] } } } })
      expect(receivedSignal).toBeInstanceOf(AbortSignal)
      release()
      await agent.whenIdle()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('forwards the running turn signal to the approval seam', async () => {
    const ctx = await harness()
    try {
      let receivedSignal: AbortSignal | undefined
      ctx.provide('approval', {
        request: (req: { signal?: AbortSignal }) => {
          receivedSignal = req.signal
          return Promise.resolve('allowed-once')
        },
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      mock.runStreamed.mockImplementation(async function* () {
        await gate
        yield turnCompleted()
      })
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('running-approval-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await vi.waitFor(() => { expect(mock.requestHandler).toBeDefined() })

      expect(await mock.requestHandler!('item/commandExecution/requestApproval', { itemId: 'c', command: 'ls' }))
        .toEqual({ result: { decision: 'accept' } })
      expect(receivedSignal).toBeInstanceOf(AbortSignal)
      release()
      await agent.whenIdle()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
