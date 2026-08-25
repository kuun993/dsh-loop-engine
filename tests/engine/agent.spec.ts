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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
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

function successResult(): SDKMessage {
  return {
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
