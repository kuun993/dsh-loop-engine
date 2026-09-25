/**
 * Lifecycle tests for the Kimi ACP driver: a mocked AcpClient serves the
 * session/update stream, and the session log records the mapped transcript
 * (streamed text, thinking, tool calls, and tool results).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, expandAssistantStream, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent, type Session } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { KimiLoop } from '../../src/engine-kimi/loop.ts'
import { loopPluginFor, mountHarness, userMessage as message } from '../helpers/agent-harness.ts'
import { toolResultView } from '../helpers/harness-generation.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'
import { DSH_ENDPOINT, provideDshEndpoint } from '../helpers/dsh-model-endpoint.ts'

const loopPlugin = loopPluginFor(KimiLoop, ['agents', 'sessions', 'systemPrompt', 'subprocess'])

/** Hoisted mock client plus the per-step update stream and capture of create specs. */
const mock = vi.hoisted(() => {
  const client = {
    initialize: vi.fn(async () => ({})),
    newSession: vi.fn(async () => 'sess_1'),
    setModel: vi.fn(async () => ({})),
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
/**
 * Tool-call stream/result update. `rawInput` is the call's real input, which
 * the live wire only carries on an update (never on the announcement).
 */
const toolStream = (id: string, status: string, text: string, rawInput?: unknown): Record<string, unknown> => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  status,
  content: [{ type: 'content', content: { type: 'text', text } }],
  ...(rawInput === undefined ? {} : { rawInput }),
})

/** Bind a fresh harness context with the loop plugin mounted. */
async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = await mountHarness(loopPlugin, config, 'stub')
  // The host's `modelSelection` fold, so a `model/selection` appended to the
  // session is read back as the pending selection the driver resolves a model
  // from — the same read the host's own `selectionFor` makes.
  ctx.provide('sessionProjections', modelSelectionProjections(ctx))
  return ctx
}

/** Text of a single-block user message, for content assertions. */
function textOf(input: UserMessage): string {
  const block = input.content[0]
  return block?.type === 'text' ? block.text : ''
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

/** Collect the durable user messages injected by the skill-invocation seam. */
function injectedSkillMessages(session: Session): UserMessage[] {
  return session.snapshotEvents()
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
  mock.client.setModel.mockReset()
  mock.client.setModel.mockResolvedValue({})
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
      const frames: AssistantStreamFrame[] = []
      const disposeFrames = ctx.on('agent/assistant-stream', ({ frame }) => { frames.push(frame) })
      const { agent } = await ctx.agents.create({ sessionId: SessionId('text-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: {
          message: {
            role: 'assistant',
            source: { kind: 'model', provider: 'external' },
            content: [{ type: 'text', text: 'Hello world' }],
          },
        },
        surfaceOp: 'append',
      })
      // The durable message embeds its exact timed stream; `assistant/chunk`
      // log events and `sourceEventSeqs` no longer exist.
      expect(expandAssistantStream(assistant!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Hello ' },
        { type: 'text-delta', index: 0, text: 'world' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
      ])
      // The same attempt publishes live frames: open, one per chunk, settled.
      expect(frames.map(frame => frame.type)).toEqual(['start', 'chunk', 'chunk', 'chunk', 'chunk', 'end'])
      expect(frames.at(-1)).toMatchObject({ outcome: { kind: 'committed', eventType: 'assistant/message', seq: assistant!.seq } })
      disposeFrames()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      // The prompt was delivered to the ACP session.
      expect(mock.client.newSession).toHaveBeenCalledWith(process.cwd())
      expect(mock.client.prompt).toHaveBeenCalledWith('sess_1', expect.stringContaining('<user>'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends a live slash command verbatim, bypassing the transcript framing', async () => {
    mock.updates.mockReturnValue([text('Session status:\n- Model: kimi-native')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('slash-s'), meta: { cwd: process.cwd() } })
      // A command line is the engine's own control surface: Kimi's ACP adapter
      // only expands a command that OPENS the prompt, so the framed transcript
      // would deliver `/status` to the model as prose instead.
      agent.followup(message('/status'))
      await agent.whenIdle()
      expect(mock.client.prompt).toHaveBeenLastCalledWith('sess_1', '/status')
      // The engine's local report is the step's assistant message.
      expect(agent.session.snapshotEvents().find(event => event.type === 'assistant/message')).toMatchObject({
        data: { message: { content: [{ type: 'text', text: 'Session status:\n- Model: kimi-native' }] } },
      })

      // The bypass is per step: the next ordinary message replays the
      // transcript (now including the command and its report) as usual.
      agent.followup(message('and now?'))
      await agent.whenIdle()
      expect(mock.client.prompt).toHaveBeenLastCalledWith('sess_1', expect.stringContaining('<user>\n/status\n</user>'))
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
      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
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

      const toolCall_ = agent.session.snapshotEvents().find(event => event.type === 'tool/call')
      expect(toolCall_).toMatchObject({ data: { callId: '0:call_1', name: 'bash' } })
      const toolResult_ = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
      // Each update carries the call's whole content, so the settled one wins.
      expect(toolResultView(toolResult_?.data.message).content).toMatchObject([{ type: 'text', text: 'b' }])
      // The step still publishes the assistant message that requested the call,
      // as its parent, exactly once.
      expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('logs the assistant message before its tool call and carries the real arguments', async () => {
    // The ACP announcement has no rawInput, so the call and the assistant
    // message that requested it can only be logged once an update supplies the
    // input. Ordering matters: the durable assistant/message must precede the
    // tool/call it owns, which must precede that call's tool/result — otherwise
    // the model context pairs a result with the wrong (or no) assistant turn.
    mock.updates.mockReturnValue([
      text('Let me '),
      toolCall('0:call_1', 'Bash'),
      toolStream('0:call_1', 'in_progress', '{"command":"ls"}', { command: 'ls' }),
      toolStream('0:call_1', 'completed', 'done'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-order'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const ordered = events
        .filter(event => event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result')
        .map(event => event.type)
      expect(ordered).toEqual(['assistant/message', 'tool/call', 'tool/result'])

      const assistant = events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: {
          message: {
            content: [
              { type: 'text', text: 'Let me ' },
              { type: 'tool-call', id: '0:call_1', name: 'Bash', arguments: '{"command":"ls"}' },
            ],
          },
        },
      })
      const call = events.find(event => event.type === 'tool/call')
      expect(call).toMatchObject({ data: { callId: '0:call_1', name: 'bash', arguments: '{"command":"ls"}' } })
      expect(call!.seq).toBeGreaterThan(assistant!.seq)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to empty arguments when a call settles without raw input', async () => {
    mock.updates.mockReturnValue([
      toolCall('0:call_2', 'Bash'),
      toolStream('0:call_2', 'completed', 'done'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-noinput'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      expect(events
        .filter(event => event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result')
        .map(event => event.type)).toEqual(['assistant/message', 'tool/call', 'tool/result'])
      expect(events.find(event => event.type === 'tool/call')).toMatchObject({ data: { arguments: '{}' } })
      expect(events.find(event => event.type === 'assistant/message')).toMatchObject({
        data: { message: { content: [{ type: 'tool-call', id: '0:call_2', name: 'Bash', arguments: '{}' }] } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('settles a call that carried no input and no content at all', async () => {
    // A call can settle on the single terminal frame with neither rawInput nor
    // a content card: the stored content snapshot is then empty, so the result
    // text falls back to `(no content)`.
    mock.updates.mockReturnValue([
      toolCall('0:call_bare', 'Bash'),
      { sessionUpdate: 'tool_call_update', toolCallId: '0:call_bare', status: 'completed' },
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-bare'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      expect(events
        .filter(event => event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result')
        .map(event => event.type)).toEqual(['assistant/message', 'tool/call', 'tool/result'])
      expect(events.find(event => event.type === 'tool/call')).toMatchObject({ data: { arguments: '{}' } })
      expect(toolResultView(events.find(event => event.type === 'tool/result')?.data.message).content)
        .toMatchObject([{ type: 'text', text: '(no content)' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('interleaves each tool call with the assistant message that requested it', async () => {
    // One ACP prompt runs kimi's whole internal loop, so a single dsh step
    // routinely holds several tool calls. Each must be individually bracketed
    // by its own assistant message rather than all landing after the last one.
    mock.updates.mockReturnValue([
      text('first '),
      toolCall('c1', 'Bash'),
      toolStream('c1', 'in_progress', 'x', { command: 'a' }),
      toolStream('c1', 'completed', 'x'),
      text('second '),
      toolCall('c2', 'Read'),
      toolStream('c2', 'in_progress', 'y', { path: 'f' }),
      toolStream('c2', 'completed', 'y'),
      text('third'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-interleave'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      expect(events
        .filter(event => event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result')
        .map(event => event.type)).toEqual([
        'assistant/message', 'tool/call', 'tool/result',
        'assistant/message', 'tool/call', 'tool/result',
        'assistant/message',
      ])
      const contents = events
        .filter(event => event.type === 'assistant/message')
        .map(event => (event.data as { message: { content: unknown } }).message.content)
      expect(contents).toEqual([
        [{ type: 'text', text: 'first ' }, { type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{"command":"a"}' }],
        [{ type: 'text', text: 'second ' }, { type: 'tool-call', id: 'c2', name: 'Read', arguments: '{"path":"f"}' }],
        [{ type: 'text', text: 'third' }],
      ])
      // Each segment is its OWN dsh step. One ACP prompt runs kimi's whole
      // internal loop, but the chat view keys an assistant node by
      // `${turn}:${step}` and replaces its blocks on every message — so N
      // messages in one step would render only the last one. Splitting the
      // segments into steps reproduces the in-process shape, where a step holds
      // one assistant message followed by its own tool call and result.
      expect(stepStructure(agent.session)).toEqual([
        'step/start@1', 'assistant/message@1', 'tool/call@1', 'tool/result@1', 'step/end@1',
        'step/start@2', 'assistant/message@2', 'tool/call@2', 'tool/result@2', 'step/end@2',
        'step/start@3', 'assistant/message@3', 'step/end@3',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps tool calls announced before any result in the same step', async () => {
    // Two calls announced before either settles are one model turn — they must
    // share a step, so the rotation cannot be keyed on "a call was announced".
    mock.updates.mockReturnValue([
      toolCall('c1', 'Bash'),
      toolCall('c2', 'Read'),
      toolStream('c1', 'in_progress', 'x', { command: 'a' }),
      toolStream('c2', 'in_progress', 'y', { path: 'f' }),
      toolStream('c1', 'completed', 'x'),
      toolStream('c2', 'completed', 'y'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-parallel'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      expect(stepStructure(agent.session)).toEqual([
        'step/start@1',
        'assistant/message@1', 'tool/call@1', 'tool/call@1',
        'tool/result@1', 'tool/result@1',
        'step/end@1',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the last content snapshot, not a concatenation of every update', async () => {
    // The live wire re-sends the tool card with a growing content string on each
    // update (observed against kimi 0.28.1: `{"command": "echo …` → … → the
    // output at completion). Appending them nested the text into garbage.
    mock.updates.mockReturnValue([
      toolCall('0:call_snap', 'Bash'),
      toolStream('0:call_snap', 'in_progress', '{"command": "echo hi'),
      toolStream('0:call_snap', 'in_progress', '{"command": "echo hi"'),
      toolStream('0:call_snap', 'in_progress', '{"command":"echo hi"}'),
      toolStream('0:call_snap', 'completed', 'hi\n'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-snapshot'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      const toolResult_ = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
      expect(toolResultView(toolResult_?.data.message).content).toMatchObject([{ type: 'text', text: 'hi\n' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the last content when the settling update carries no content field', async () => {
    const settleWithoutContent = { sessionUpdate: 'tool_call_update', toolCallId: '0:call_nc', status: 'completed' }
    mock.updates.mockReturnValue([
      toolCall('0:call_nc', 'Bash'),
      toolStream('0:call_nc', 'in_progress', 'partial output'),
      settleWithoutContent,
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-nocontent'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      const toolResult_ = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
      expect(toolResultView(toolResult_?.data.message).content).toMatchObject([{ type: 'text', text: 'partial output' }])
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
      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
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
      expect(agent.session.snapshotEvents().some(event => event.type === 'tool/call')).toBe(false)
      expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(false)
      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({ data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('logs a call the engine announced but never updated', async () => {
    // The engine can announce a call and then end the step (an aborted tool, a
    // dropped session) without ever sending an update carrying the input. The
    // request still belongs in the transcript, logged with empty arguments.
    mock.updates.mockReturnValue([toolCall('0:call_orphan', 'Bash'), text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-orphan'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      expect(events
        .filter(event => event.type === 'assistant/message' || event.type === 'tool/call')
        .map(event => event.type)).toEqual(['assistant/message', 'tool/call'])
      // The orphan call folds into the trailing text's single message, so the
      // chat view still renders the reasoning/text beside its tool row.
      expect(events.find(event => event.type === 'assistant/message')).toMatchObject({
        data: { message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool-call', id: '0:call_orphan', name: 'Bash', arguments: '{}' }] } },
      })
      expect(events.find(event => event.type === 'tool/call')).toMatchObject({
        data: { callId: '0:call_orphan', name: 'bash', arguments: '{}' },
      })
      // Nothing ran, so there is no result to pair it with.
      expect(events.some(event => event.type === 'tool/result')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores an update with an empty id and a content-less update for a logged call', async () => {
    const contentLess = { sessionUpdate: 'tool_call_update', toolCallId: '0:call_cl', status: 'in_progress' }
    mock.updates.mockReturnValue([
      { sessionUpdate: 'tool_call_update', toolCallId: '', status: 'completed' },
      toolCall('0:call_cl', 'Bash'),
      toolStream('0:call_cl', 'in_progress', 'seen', { command: 'ls' }),
      contentLess,
      toolStream('0:call_cl', 'completed', 'seen'),
    ])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-contentless'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      const toolResult_ = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
      // The content-less frame leaves the last snapshot standing.
      expect(toolResultView(toolResult_?.data.message).content).toMatchObject([{ type: 'text', text: 'seen' }])
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
      const toolResult = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
      expect(toolResultView(toolResult?.data.message).content).toMatchObject([{ type: 'text', text: 'abc' }])
      // A tool-only step still publishes an (empty) assistant/message parent.
      expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
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
      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({ data: { message: { content: [{ type: 'text', text: 'real' }] } } })
      // Only 'real' opened a block: one block-start, one text-delta, one block-end.
      expect(expandAssistantStream(assistant!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'real' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'real' } },
      ])
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
      expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(1)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
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
      const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
      expect(users).toHaveLength(2)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
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
      expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(1)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
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
      const starts = agent.session.snapshotEvents().filter(event => event.type === 'turn/start')
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
      const steps = agent.session.snapshotEvents().filter(event => event.type === 'step/start')
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
      const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'blocked' } } })
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
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start' || event.type === 'user/message')).toBe(false)
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
      const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
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
      const headers = agent.session.snapshotEvents().filter(event => event.type === 'request/header')
      expect(headers).toHaveLength(2)
      expect(headers[1]).toMatchObject({ data: { reason: 'resume' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent dsh endpoint handover', () => {
  /** The spawn spec the Nth child was created from. */
  function specAt(index: number): { argv: string[]; env: Record<string, string> } {
    const spec = mock.created[index]?.spec as { argv: string[]; env: Record<string, string> } | undefined
    if (spec === undefined) throw new Error(`no kimi child spawned at index ${index}`)
    return spec
  }

  it('points the child at the dsh endpoint through kimi\'s env-model path', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      provideDshEndpoint(ctx)
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(message('go'))
      await agent.whenIdle()

      expect(specAt(0).env).toMatchObject({
        KIMI_MODEL_NAME: DSH_ENDPOINT.model,
        KIMI_MODEL_API_KEY: DSH_ENDPOINT.apiKey,
        KIMI_MODEL_BASE_URL: DSH_ENDPOINT.baseURL,
        KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
      })
      // The env model is kimi's default, so the raw dsh id is never asked for as
      // a kimi model ALIAS through `session/set_model`.
      expect(mock.client.setModel).not.toHaveBeenCalled()
      // The credential reaches the child's environment, never the session log.
      expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain(DSH_ENDPOINT.apiKey)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hands nothing over for the hosted seat, leaving kimi its own configuration', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness({ model: 'deployment-pinned' })
    try {
      provideDshEndpoint(ctx)
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-hosted-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: 'external', model: 'default' })
      agent.followup(message('go'))
      await agent.whenIdle()

      expect('KIMI_MODEL_NAME' in specAt(0).env).toBe(false)
      expect('KIMI_MODEL_BASE_URL' in specAt(0).env).toBe(false)
      // With nothing handed over, the deployment pin still reaches set_model.
      expect(mock.client.setModel).toHaveBeenCalledWith('sess_1', 'deployment-pinned')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('injects nothing and warns once when the endpoint cannot be resolved', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-unresolved-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(message('go'))
      await agent.whenIdle()
      agent.followup(message('again'))
      await agent.whenIdle()

      expect('KIMI_MODEL_NAME' in specAt(0).env).toBe(false)
      // With no endpoint, the model name is still asked for by name.
      expect(mock.client.setModel).toHaveBeenCalledWith('sess_1', DSH_ENDPOINT.model)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reuses the child while the endpoint is unchanged, and respawns it when it changes', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const endpoint = provideDshEndpoint(ctx, { baseURL: 'https://first.example.com/litellm' })
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-change-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(message('one'))
      await agent.whenIdle()
      expect(specAt(0).env.KIMI_MODEL_BASE_URL).toBe('https://first.example.com/litellm')

      // An unchanged endpoint re-resolves to the SAME environment object, so the
      // cached child is kept rather than respawned for an identical spec.
      agent.followup(message('two'))
      await agent.whenIdle()
      expect(mock.created).toHaveLength(1)

      endpoint.update({ baseURL: 'https://second.example.com/litellm' })
      agent.followup(message('three'))
      await agent.whenIdle()
      expect(mock.created).toHaveLength(2)
      expect(specAt(1).env.KIMI_MODEL_BASE_URL).toBe('https://second.example.com/litellm')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('KimiAgent model selection', () => {
  it('selects the session-selected dsh model on the ACP session, over the deployment pin', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness({ model: 'deployment-pinned' })
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('model-sel-s'), meta: { cwd: process.cwd() } })
      // A harness `session.selectModel` appends a model/selection event.
      agent.session.append('model/selection', { provider: 'meicloud', model: 'deepseek-flash' })
      agent.followup(message('go'))
      await agent.whenIdle()

      // Kimi selects per ACP session: `session/set_model { sessionId, modelId }`.
      // Kimi takes a bare model id, so the session wins over the deployment pin.
      expect(mock.client.setModel).toHaveBeenCalledWith('sess_1', 'deepseek-flash')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('selects nothing for the hosted seat, falling back to the deployment pin', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness({ model: 'deployment-pinned' })
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('model-sel-hosted-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: 'external', model: 'default' })
      agent.followup(message('go'))
      await agent.whenIdle()

      // `external` means "the engine decides": the pin governs instead.
      expect(mock.client.setModel).toHaveBeenCalledWith('sess_1', 'deployment-pinned')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('selects no model at all when the deployment pins none and no real model is selected', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('model-sel-none-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('go'))
      await agent.whenIdle()

      expect(mock.client.setModel).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-resolves the model on every step, so a mid-session change reaches the next session', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('model-sel-change-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: 'meicloud', model: 'model-a' })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(mock.client.setModel).toHaveBeenNthCalledWith(1, 'sess_1', 'model-a')

      agent.session.append('model/selection', { provider: 'meicloud', model: 'model-b' })
      agent.followup(message('again'))
      await agent.whenIdle()
      expect(mock.client.setModel).toHaveBeenNthCalledWith(2, 'sess_1', 'model-b')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the step loud when the engine rejects the model, never running the default', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      mock.client.setModel.mockRejectedValue(new Error('model "deepseek-flash" is not available'))
      const { agent } = await ctx.agents.create({ sessionId: SessionId('model-sel-reject-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: 'meicloud', model: 'deepseek-flash' })
      agent.followup(message('go'))
      await agent.whenIdle()

      // The rejection surfaces as the turn's error, and the prompt never runs
      // under a model the engine refused.
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
      expect(mock.client.prompt).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
