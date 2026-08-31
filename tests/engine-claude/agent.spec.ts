/**
 * Lifecycle tests for the Claude Code driver: a mocked official SDK serves the
 * query stream, and the session log records the mapped transcript.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { ClaudeCodeLoop } from '../../src/engine-claude/loop.ts'
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

function assistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: 'u-a1',
    session_id: 's-a1',
    message: {
      id: 'msg-a1',
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
        cache_read_input_tokens: 5,
        inference_geo: null,
        input_tokens: 12,
        iterations: null,
        output_tokens: 7,
        server_tool_use: null,
      },
    },
  } as unknown as SDKMessage
}

/** A thinking-only assistant message, as emitted by providers that split thinking into its own message. */
function thinkingOnlyMessage(thinking: string | readonly string[], outputTokens: number): SDKMessage {
  const blocks = (typeof thinking === 'string' ? [thinking] : thinking)
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: 'u-thinking',
    session_id: 's-thinking',
    message: {
      id: 'msg-thinking',
      container: null,
      context_management: null,
      role: 'assistant',
      type: 'message',
      content: blocks.map(text => ({ type: 'thinking', thinking: text, signature: 'sig' })),
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      model: 'claude-sonnet-4-5',
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        inference_geo: null,
        input_tokens: 12,
        iterations: null,
        output_tokens: outputTokens,
        server_tool_use: null,
      },
    },
  } as unknown as SDKMessage
}

function successResult(): SDKMessage {  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 10,
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
      input_tokens: 12,
      iterations: null,
      output_tokens: 7,
      server_tool_use: null,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: 'u-result',
    session_id: 's-result',
  } as unknown as SDKMessage
}

function streamEvent(event: unknown): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: null,
    uuid: 'u-partial',
    session_id: 's-partial',
    ttft_ms: 5,
    event,
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

describe('ClaudeCodeLoop factory registration', () => {
  it('registers the factory on ctx.agents so create works', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('factory-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
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

describe('ClaudeCodeAgent turn mapping', () => {
  it('records turn, step, assistant message, and completion in the session log', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('hello world'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('turn-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
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
            source: { kind: 'model', provider: 'claude-code' },
            content: [{ type: 'text', text: 'hello world' }],
          },
          usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 5 },
        },
        surfaceOp: 'append',
      })

      const params = queryMock.mock.calls[0]?.[0]
      expect(params).toBeDefined()
      expect(params!.prompt).toContain('<user>')
      expect(params!.prompt).toContain('hi')
      expect(params!.options.persistSession).toBe(false)
      expect(params!.options.permissionMode).toBe('dontAsk')
      expect(params!.options.disallowedTools).toContain('AskUserQuestion')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('streams assistant chunks and links the final message to them', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } }),
        streamEvent({ type: 'content_block_stop', index: 0 }),
        assistantText('hello world'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('stream-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const chunks = agent.session.events.filter(
        (event): event is Extract<typeof event, { type: 'assistant/chunk' }> => event.type === 'assistant/chunk',
      )
      expect(chunks.map(event => event.data.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'hello ' },
        { type: 'text-delta', index: 0, text: 'world' },
      ])

      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        surfaceOp: 'append',
        sourceEventSeqs: chunks.map(event => event.seq),
      })
      expect(assistant?.data.message.content).toEqual([{ type: 'text', text: 'hello world' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retains streamed reasoning when the final assistant message omits thinking blocks', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'sig' } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first ', signature: 'sig' } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'second', signature: 'sig' } }),
        streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } }),
        streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }),
        streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'later', signature: 'sig' } }),
        // The final message carries no thinking block (provider strips it).
        assistantText('answer'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-retain-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant?.data.message.content).toEqual([
        { type: 'reasoning', text: 'first second' },
        { type: 'reasoning', text: 'later' },
        { type: 'text', text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prefers the final message thinking block over the streamed fallback', async () => {
    const ctx = await harness()
    try {
      const withThinking = {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'u-think',
        session_id: 's-think',
        message: {
          id: 'msg-think',
          container: null,
          context_management: null,
          role: 'assistant',
          type: 'message',
          content: [
            { type: 'thinking', thinking: 'from message', signature: 'sig' },
            { type: 'text', text: 'answer', citations: null },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          model: 'claude-sonnet-4-5',
          usage: {
            cache_creation: null,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            inference_geo: null,
            input_tokens: 5,
            iterations: null,
            output_tokens: 5,
            server_tool_use: null,
          },
        },
      } as unknown as SDKMessage
      queryMock.mockImplementation(() => stream([
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'streamed ', signature: 'sig' } }),
        withThinking,
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-dup-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const assistant = agent.session.events.find(event => event.type === 'assistant/message')
      expect(assistant?.data.message.content).toEqual([
        { type: 'reasoning', text: 'from message' },
        { type: 'text', text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a reasoning-only assistant message into the following message', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        thinkingOnlyMessage('split thinking', 3),
        assistantText('answer'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-split-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // The reasoning-only message was held, not appended: exactly one
      // durable assistant message carries both the thinking and the answer.
      const assistants = agent.session.events.filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'split thinking' },
        { type: 'text', text: 'answer' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flushes trailing streamed reasoning without a usage stash', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'chunked', signature: 'sig' } }),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-chunk-trailing-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const assistants = agent.session.events.filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([{ type: 'reasoning', text: 'chunked' }])
      expect(assistants[0]?.data.usage).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flushes trailing reasoning-only content at the step result', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        thinkingOnlyMessage(['trailing thinking', 'second thought'], 4),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reasoning-trailing-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const assistants = agent.session.events.filter(event => event.type === 'assistant/message')
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.data.message.content).toEqual([
        { type: 'reasoning', text: 'trailing thinking' },
        { type: 'reasoning', text: 'second thought' },
      ])
      // The suppressed message's usage survived on the flushed one.
      expect(assistants[0]?.data.usage).toMatchObject({ outputTokens: 4 })
    } finally {
      await ctx.fiber.dispose()
    }
  })


  it('records tool calls and tool results beside the assistant message', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        {
          type: 'assistant',
          parent_tool_use_id: null,
          uuid: 'u-tool',
          session_id: 's-tool',
          message: {
            id: 'msg-tool',
            container: null,
            context_management: null,
            role: 'assistant',
            type: 'message',
            content: [{
              type: 'tool_use',
              id: 'toolu_999',
              name: 'Read',
              input: { file_path: 'x.txt' },
            }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            stop_details: null,
            model: 'claude-sonnet-4-5',
            usage: {
              cache_creation: null,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              inference_geo: null,
              input_tokens: 9,
              iterations: null,
              output_tokens: 4,
              server_tool_use: null,
            },
          },
        } as unknown as SDKMessage,
        {
          type: 'user',
          parent_tool_use_id: 'toolu_999',
          uuid: 'u-tr',
          session_id: 's-tr',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_999',
              content: 'the file contents',
              is_error: false,
            }],
          },
        } as unknown as SDKMessage,
        assistantText('done reading'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('tool-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read it' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const events = agent.session.events
      const call = events.find(event => event.type === 'tool/call')
      expect(call).toMatchObject({
        data: { callId: 'toolu_999', name: 'Read', arguments: '{"file_path":"x.txt"}' },
      })
      const result = events.find(event => event.type === 'tool/result')
      expect(result).toMatchObject({
        data: {
          message: {
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: 'toolu_999',
              content: [{ type: 'text', text: 'the file contents' }],
            }],
          },
        },
        surfaceOp: 'append',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the turn with an error when the SDK reports an execution failure', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        {
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: 5,
          duration_api_ms: 5,
          is_error: true,
          num_turns: 1,
          stop_reason: 'too_many_requests',
          total_cost_usd: 0,
          usage: {
            cache_creation: null,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            inference_geo: null,
            input_tokens: 4,
            iterations: null,
            output_tokens: 1,
            server_tool_use: null,
          },
          modelUsage: {},
          permission_denials: [],
          errors: ['the tool chain broke'],
          uuid: 'u-err',
          session_id: 's-err',
        } as unknown as SDKMessage,
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('err-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { message: 'the tool chain broke', code: 'CLAUDE_CODE_ERROR_DURING_EXECUTION' },
          },
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the step with no-result when the query stream is empty', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('empty-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code: 'CLAUDE_CODE_NO_RESULT' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('logs the request header once per lifecycle', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('header-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const headers = agent.session.events.filter(event => event.type === 'request/header')
      expect(headers).toHaveLength(1)
      expect(headers[0]).toMatchObject({
        data: {
          header: { config: { provider: 'claude-code', model: 'claude-code-native' } },
          reason: 'initial',
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ClaudeCodeAgent cancellation and pre-step interception', () => {
  it('aborts an in-flight query and ends the turn aborted', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('first'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('cancel-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // Arm a query that blocks until released; the official SDK aborts a
      // running query through the query controller, so the mock races its
      // gate against the controller signal.
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      queryMock.mockImplementation(({ options }) => (async function* (): AsyncGenerator<SDKMessage> {
        yield assistantText('starting')
        await Promise.race([
          gate,
          new Promise<never>((_, reject) => {
            options.abortController!.signal.addEventListener('abort', () => {
              reject(new Error('query aborted'))
            }, { once: true })
          }),
        ])
        yield assistantText('after gate')
        yield successResult()
      })() as unknown as Query)

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
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
      queryMock.mockImplementation(() => stream([assistantText('never'), successResult()]))
      const disposeReject = ctx.on('agent/pre-step', async (): Promise<{ kind: 'reject' }> => ({ kind: 'reject' }))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('reject-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      disposeReject()
      expect(queryMock).not.toHaveBeenCalled()
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'blocked' } },
      })
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
    await fresh.plugin(LocalSubprocessRuntime)
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

  it('accepts a valid configuration with an explicit model and permission mode', async () => {
    const fresh = await bareContext()
    try {
      await fresh.plugin(loopPlugin, {
        permissionMode: 'plan',
        model: 'claude-opus-4-6',
        maxTurns: 4,
      })
      queryMock.mockImplementation(() => stream([successResult()]))
      const { agent } = await fresh.agents.create({
        sessionId: SessionId('plan-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan it' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const params = queryMock.mock.calls[0]?.[0]
      expect(params!.options).toMatchObject({
        permissionMode: 'plan',
        model: 'claude-opus-4-6',
        maxTurns: 4,
        disallowedTools: ['AskUserQuestion', 'ExitPlanMode'],
      })
      expect(agent.session.events.filter(e => e.type === 'request/header')[0]).toMatchObject({
        data: { header: { config: { provider: 'claude-code', model: 'claude-opus-4-6' } } },
      })
    } finally {
      await fresh.fiber.dispose()
    }
  })
})

describe('model resolution', () => {
  /** Mount the default-model service the dsh base layer normally provides. */
  function withDefaultModel(ctx: Context, selection: { provider: string; model: string }): void {
    ctx.provide('agentDefaultModel', { currentSelection: () => selection }, true)
  }

  /** Run one turn and return the options the SDK query was called with. */
  async function queriedOptions(ctx: Context, sessionId: string, options: Record<string, unknown> = {}): Promise<Options> {
    queryMock.mockImplementation(() => stream([successResult()]))
    const { agent } = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: process.cwd() },
      ...options,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    return queryMock.mock.calls[0]![0].options
  }

  it('runs the model the dsh selection names', async () => {
    // The point of the whole chain: picking a model in the UI has to reach the
    // child, which owned its model natively before.
    const ctx = await harness()
    try {
      withDefaultModel(ctx, { provider: 'copilot-proxy', model: 'claude-opus-4.7' })
      const options = await queriedOptions(ctx, 'default-model-s')
      expect(options.model).toBe('claude-opus-4.7')
      expect(options.env?.ANTHROPIC_MODEL).toBe('claude-opus-4.7')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets a session choice beat the global default', async () => {
    const ctx = await harness()
    try {
      withDefaultModel(ctx, { provider: 'copilot-proxy', model: 'claude-opus-4.7' })
      const options = await queriedOptions(ctx, 'session-model-s', {
        agentOptions: { provider: 'copilot-proxy', model: 'claude-haiku-4.5' },
      })
      expect(options.model).toBe('claude-haiku-4.5')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the resolved model in the request header', async () => {
    const ctx = await harness()
    try {
      withDefaultModel(ctx, { provider: 'copilot-proxy', model: 'claude-opus-4.7' })
      queryMock.mockImplementation(() => stream([successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('header-model-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(agent.session.events.filter(e => e.type === 'request/header')[0]).toMatchObject({
        data: { header: { config: { provider: 'claude-code', model: 'claude-opus-4.7' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the model to the CLI when no layer chose one', async () => {
    // A minimal profile need not mount the service; resolving must degrade to
    // the CLI's own default rather than throw.
    const ctx = await harness()
    try {
      const options = await queriedOptions(ctx, 'native-model-s')
      expect('model' in options).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the configured model when no selection exists', async () => {
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SystemPrompt, { persona: 'You are the deployment.' })
    await fresh.plugin(AgentRegistry)
    await fresh.plugin(LocalSubprocessRuntime)
    await fresh.plugin(loopPlugin, { model: 'claude-opus-4-6' })
    try {
      const options = await queriedOptions(fresh, 'config-model-s')
      expect(options.model).toBe('claude-opus-4-6')
    } finally {
      await fresh.fiber.dispose()
    }
  })

  it('survives a default-model service that faults', async () => {
    const ctx = await harness()
    try {
      ctx.provide('agentDefaultModel', {
        currentSelection: () => { throw new Error('provider registry unavailable') },
      }, true)
      const options = await queriedOptions(ctx, 'faulting-model-s')
      expect('model' in options).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/** Append a durable permission knob whose event key is augmented by packages this compilation does not depend on. */
function appendKnob(session: Session, type: string, data: unknown): void {
  const append = session.append.bind(session) as unknown as (type: string, data: unknown) => void
  append(type, data)
}

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

describe('ClaudeCodeAgent session permission mapping', () => {
  it('forwards native permission requests to the approval service under an ask policy', async () => {
    const ctx = await harness()
    try {
      const requests: Array<{ agent: unknown; toolName: string; reason?: string; signal?: AbortSignal }> = []
      let outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once'
      ctx.provide('approval', {
        request: (req: { agent: unknown; toolName: string; reason?: string; signal?: AbortSignal }) => {
          requests.push(req)
          return Promise.resolve(outcome)
        },
      })
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('perm-ask-s'),
        meta: { cwd: process.cwd() },
      })
      appendKnob(agent.session, 'approval/policy', { policy: 'ask' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const options = queryMock.mock.calls[0]?.[0].options
      expect(options).toBeDefined()
      expect(options!.permissionMode).toBe('default')
      expect('allowDangerouslySkipPermissions' in options!).toBe(false)

      const signal = new AbortController().signal
      const allowed = await options!.canUseTool!('Bash', { command: 'ls' }, { signal, toolUseID: 't1', requestId: 'r1' })
      expect(allowed).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
      expect(requests).toHaveLength(1)
      expect(requests[0]!.agent).toBe(agent)
      expect(requests[0]!.toolName).toBe('Bash')
      expect(requests[0]!.signal).toBe(signal)
      expect(requests[0]!.reason).toContain('Bash')
      expect(requests[0]!.reason).toContain('ls')

      outcome = 'rejected'
      const denied = await options!.canUseTool!('Write', { path: 'x' }, { signal, toolUseID: 't2', requestId: 'r2' })
      expect(denied).toMatchObject({ behavior: 'deny' })
      expect(requests).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed with dontAsk under an ask policy when no approval service exists', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('perm-ask-absent-s'),
        meta: { cwd: process.cwd() },
      })
      appendKnob(agent.session, 'approval/policy', { policy: 'ask' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const options = queryMock.mock.calls[0]?.[0].options
      expect(options!.permissionMode).toBe('dontAsk')
      const denied = await options!.canUseTool!('Bash', {}, {
        signal: new AbortController().signal,
        toolUseID: 't1',
        requestId: 'r1',
      })
      expect(denied).toMatchObject({ behavior: 'deny' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-folds the session permission knobs for every query, including mid-session switches', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('perm-switch-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(queryMock.mock.calls[0]?.[0].options.permissionMode).toBe('dontAsk')

      appendKnob(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const switched = queryMock.mock.calls[1]?.[0].options
      expect(switched).toBeDefined()
      expect(switched!.permissionMode).toBe('bypassPermissions')
      expect(switched!.allowDangerouslySkipPermissions).toBe(true)
      expect(switched!.canUseTool).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ClaudeCodeAgent skill injection', () => {
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
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
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
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
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
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
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
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
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
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
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
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
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
