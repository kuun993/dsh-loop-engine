/**
 * Control-flow coverage for the Claude Code driver: steering, injection,
 * cancellation, maintenance, multi-step turns, transport messages, and the
 * defensive guards that the happy-path suite cannot reach.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ClaudeCodeLoop, CLAUDE_CODE_PERMISSION_MODES } from '../../src/engine-claude/loop.ts'
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

function errorResult(subtype: string, errors: string[]): SDKMessage {
  return {
    type: 'result',
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: 'error',
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
    errors,
    uuid: 'u-err',
    session_id: 's-err',
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

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('steering and injection', () => {
  it('consumes injected and steered messages in one step batch', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('done'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('steer-s'),
        meta: { cwd: process.cwd() },
      })
      agent.inject(message('queued first')) // no wakeup
      agent.steer(message('steered second')) // wakeup
      await agent.whenIdle()
      const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
      expect(users.map(event => (event as never as { data: { content: Array<{ text: string }> } }).data.content[0]!.text))
        .toEqual(['queued first', 'steered second'])
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears the inbox on a hard cancel and notifies the discarded message', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
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
      const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
      expect(users.map(event => (event as never as { data: { content: Array<{ text: string }> } }).data.content[0]!.text))
        .toEqual(['go'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the inbox when cancel requests it', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('keep-s'),
        meta: { cwd: process.cwd() },
      })
      agent.inject(message('kept'))
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      agent.followup(message('go'))
      await agent.whenIdle()
      const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
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
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
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
      expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(true)
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
      queryMock.mockImplementation(({ options }) => (async function* (): AsyncGenerator<SDKMessage> {
        yield assistantText('first')
        await Promise.race([
          gate,
          new Promise<never>((_, reject) => {
            options.abortController!.signal.addEventListener('abort', () => {
              reject(new Error('query aborted'))
            }, { once: true })
          }),
        ])
        yield assistantText('late')
        yield successResult()
      })() as unknown as Query)
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
      const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
      expect(ends[0]).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
      expect(ends.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
      const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
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
      queryMock.mockImplementation(() => stream([assistantText('ignored'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('no-cwd'),
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
      expect(end).toMatchObject({
        data: { reason: { kind: 'error', error: { code: 'UNKNOWN' } } },
      })
      expect(queryMock).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps an unknown SDK failure subtype to the generic code', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([errorResult('some_future_subtype', [])]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('future-err'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
      expect(end).toMatchObject({
        data: {
          reason: {
            kind: 'error',
            error: {
              message: 'claude code query failed (some_future_subtype)',
              code: 'CLAUDE_CODE_ERROR',
            },
          },
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('SDK transcript mapping edges', () => {
  it('skips empty assistant content and missing usage', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        {
          type: 'assistant',
          parent_tool_use_id: null,
          uuid: 'u-empty',
          session_id: 's-empty',
          message: {
            id: 'msg-empty',
            container: null,
            context_management: null,
            role: 'assistant',
            type: 'message',
            content: [],
            stop_reason: 'end_turn',
            stop_sequence: null,
            stop_details: null,
            model: 'claude-sonnet-4-5',
            usage: undefined as never,
          },
        } as unknown as SDKMessage,
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('skip-empty'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
      if (end?.type === 'turn/end' && end.data.reason.kind === 'error') {
        throw new Error(`DEBUG reason: ${JSON.stringify(end.data.reason.error)}`)
      }
      expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(0)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records an assistant message without usage when the SDK omits it', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        {
          type: 'assistant',
          parent_tool_use_id: null,
          uuid: 'u-no-usage',
          session_id: 's-no-usage',
          message: {
            id: 'msg-no-usage',
            container: null,
            context_management: null,
            role: 'assistant',
            type: 'message',
            content: [{ type: 'text', text: 'no usage here' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            stop_details: null,
            model: 'claude-sonnet-4-5',
            usage: undefined as never,
          },
        } as unknown as SDKMessage,
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('omit-usage'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      const assistant = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({ data: { message: { role: 'assistant' } } })
      expect('usage' in (assistant as never as { data: Record<string, unknown> }).data).toBe(false)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignores SDK transport messages and reports unattended interactions', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(({ options }) => (async function* (): AsyncGenerator<SDKMessage> {
        yield {
          type: 'system',
          subtype: 'init',
          cwd: process.cwd(),
          model: 'claude-sonnet-4-5',
          permissionMode: 'dontAsk',
        } as unknown as SDKMessage
        await options.canUseTool?.('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'req_1' })
        await options.onUserDialog?.({} as never, { signal: new AbortController().signal })
        yield assistantText('answer')
        yield successResult()
      })() as unknown as Query)
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('transport-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a resume header when the session already folded one', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const seed: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'request/header', seq: 1, time: 2,
          data: { header: { config: { provider: 'claude-code', model: 'x' } }, reason: 'initial' },
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

describe('multi-step continuation', () => {
  it('continues into the next step when turn-stopping injects input', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('step one'), assistantText('step two'), successResult()]))
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
      const steps = agent.session.snapshotEvents().filter(event => event.type === 'step/start')
      expect(steps).toHaveLength(2)
      expect(queryMock).toHaveBeenCalledTimes(2)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('configuration and option surfaces', () => {
  it('exposes the permission modes accepted by the plugin config', () => {
    expect(CLAUDE_CODE_PERMISSION_MODES).toEqual([
      'dontAsk', 'acceptEdits', 'auto', 'plan', 'bypassPermissions',
    ])
  })
})
