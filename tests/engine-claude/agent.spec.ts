/**
 * Lifecycle tests for the Claude Code driver: a mocked official SDK serves the
 * query stream, and the session log records the mapped transcript.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, expandAssistantStream, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { ClaudeCodeLoop } from '../../src/engine-claude/loop.ts'
import { LEGACY_HARNESS } from '../../src/compat.ts'
import { loopPluginFor, mountHarness } from '../helpers/agent-harness.ts'
import { toolResultRole, toolResultView } from '../helpers/harness-generation.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'
import { DSH_ENDPOINT, provideDshEndpoint } from '../helpers/dsh-model-endpoint.ts'

const loopPlugin = loopPluginFor(ClaudeCodeLoop, ['agents', 'sessions', 'systemPrompt', 'subprocess'])

type QueryFactory = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => Query

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

/**
 * Drain the streaming-input prompt the driver hands the SDK: the messages it
 * would receive, in order, and the proof that the stream completes by itself.
 * @param prompt - the `prompt` a query mock was called with.
 * @returns the yielded user messages.
 */
async function drainPrompt(prompt: string | AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage[]> {
  if (typeof prompt === 'string') throw new Error('expected the streaming input form, got a string prompt')
  const messages: SDKUserMessage[] = []
  for await (const message of prompt) messages.push(message)
  return messages
}

/**
 * One durable image reference, as a user message's image block carries it.
 * @param id - opaque attachment id, also this spec's path key.
 * @param name - display name.
 * @param mediaType - the image's media type.
 * @returns the reference.
 */
function imageRef(id: string, name: string, mediaType: 'image/png' | 'image/jpeg') {
  return {
    attachmentId: AttachmentId(id),
    mediaType,
    bytes: 1234,
    width: 800,
    height: 600,
    name,
  }
}

/**
 * A user message carrying one image block, keyed by display name so a fake
 * attachment service can resolve it to a real file.
 * @param name - display name, also this spec's path key.
 * @param mediaType - the image's media type.
 * @param id - opaque attachment id.
 * @returns the user message.
 */
function imageMessage(
  name: string,
  mediaType: 'image/png' | 'image/jpeg',
  id: string,
): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', attachment: imageRef(id, name, mediaType) },
    ],
    source: { kind: 'user' },
  })
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

/** An assistant message carrying one tool_use block. */
function assistantToolUse(id: string, name: string, input: unknown): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: `u-${id}`,
    session_id: `s-${id}`,
    message: {
      id: `msg-${id}`,
      container: null,
      context_management: null,
      role: 'assistant',
      type: 'message',
      content: [{ type: 'tool_use', id, name, input }],
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
  } as unknown as SDKMessage
}

/** The SDK's tool-result delivery (a `user` message echoing one tool_use_id). */
function toolResultMessage(id: string, content: string): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: id,
    uuid: `u-${id}-r`,
    session_id: `s-${id}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }],
    },
  } as unknown as SDKMessage
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

async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = await mountHarness(loopPlugin, config)
  // The host's `modelSelection` fold, so a `model/selection` appended to the
  // session is read back as the pending selection the driver resolves a model
  // from — the same read the host's own `selectionFor` makes.
  ctx.provide('sessionProjections', modelSelectionProjections(ctx))
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

      const types = agent.session.snapshotEvents().map(event => event.type)
      expect(types).toContain('turn/start')
      expect(types).toContain('step/start')
      expect(types).toContain('user/message')
      expect(types).toContain('assistant/message')
      expect(types).toContain('step/end')
      expect(types).toContain('turn/end')

      // A session STARTED on a hosted engine gets the protected system head the
      // harness loop would have logged, so switching it to in-process later does
      // not leave a mid-surface `system/message` the v3→v4 migration refuses.
      // The head is a 0.1.7-line (format v4) need; the 0.1.5 line stays headless.
      const firstSurface = agent.session.snapshotEvents()
        .find(event => (event as { surfaceOp?: unknown }).surfaceOp !== undefined)
      expect(firstSurface?.type).toBe(LEGACY_HARNESS ? 'user/message' : 'system/message')

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: {
          message: {
            role: 'assistant',
            source: { kind: 'model', provider: 'external' },
            content: [{ type: 'text', text: 'hello world' }],
          },
          usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 5 },
        },
        surfaceOp: 'append',
      })

      const params = queryMock.mock.calls[0]?.[0]
      expect(params).toBeDefined()
      // A step that carries no image keeps the one-shot string prompt, so the
      // streaming form cannot creep into ordinary steps.
      expect(typeof params!.prompt).toBe('string')
      expect(params!.prompt).toContain('<user>')
      expect(params!.prompt).toContain('hi')
      expect(params!.options.persistSession).toBe(false)
      expect(params!.options.permissionMode).toBe('dontAsk')
      expect(params!.options.disallowedTools).toContain('AskUserQuestion')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hands an image-carrying step one streaming message: transcript text, then the step\'s own bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-image-'))
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const paths: Record<string, string> = {
      'img-png': join(dir, 'shot.png'),
      'img-jpeg': join(dir, 'other.jpg'),
    }
    await writeFile(paths['img-png']!, pngBytes)
    await writeFile(paths['img-jpeg']!, jpegBytes)
    const ctx = await harness()
    try {
      // The host's attachment service: the driver asks it for the path behind
      // the durable reference the log carries, and reads those bytes itself.
      ctx.provide('attachments', { imageHostPath: (ref: { attachmentId: string }) => paths[ref.attachmentId] })
      queryMock.mockImplementation(() => stream([assistantText('seen'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('image-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', attachment: imageRef('img-png', 'shot.png', 'image/png') },
          { type: 'image', attachment: imageRef('img-jpeg', 'other.jpg', 'image/jpeg') },
        ],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      // Claude Code takes images only on its streaming input channel, so the
      // prompt is the SDK's single-message streaming form — and it COMPLETES,
      // which is what keeps the query's own lifecycle unchanged.
      const messages = await drainPrompt(queryMock.mock.calls[0]![0].prompt)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: 'user',
        parent_tool_use_id: null,
        // The shape the SDK itself writes for a `string` prompt, `session_id: ''`
        // included — a one-shot query owns no session id here.
        session_id: '',
        message: { role: 'user' },
      })

      // The transcript stays the first block, placeholder lines and all: the
      // bytes are an addition to it, never a replacement for the path the
      // engine's own file tool can still follow.
      const content = messages[0]!.message.content
      expect(Array.isArray(content)).toBe(true)
      const [text, ...images] = content as Exclude<typeof content, string>
      expect(text).toMatchObject({ type: 'text' })
      const transcript = (text as { text: string }).text
      expect(transcript).toContain('look at this')
      expect(transcript).toContain('image "shot.png" (image/png, 800x600px, 1234 bytes)')
      expect(transcript).toContain(`read ${JSON.stringify(paths['img-png'])} to view it`)
      expect(transcript).toContain(`read ${JSON.stringify(paths['img-jpeg'])} to view it`)

      // One base64 block per image, in order, each under its own media type.
      expect(images).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBytes.toString('base64') } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBytes.toString('base64') } },
      ])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sends an image step\'s bytes for that step only, leaving an older image as a placeholder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-image-'))
    const bytes = Buffer.from([1, 2, 3, 4])
    const imagePath = join(dir, 'shot.png')
    await writeFile(imagePath, bytes)
    const ctx = await harness()
    try {
      ctx.provide('attachments', { imageHostPath: () => imagePath })
      queryMock.mockImplementation(() => stream([assistantText('first'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('image-steps-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(imageMessage('shot.png', 'image/png', 'img-1'))
      await agent.whenIdle()
      // The image was this step's own, so step one carried its bytes.
      const first = await drainPrompt(queryMock.mock.calls[0]![0].prompt)
      expect(first[0]!.message.content).toHaveLength(2)

      // A later text-only step replays the same history — the image is still in
      // the transcript as a path-bearing placeholder, but its bytes are not
      // re-uploaded.
      queryMock.mockImplementation(() => stream([assistantText('second'), successResult()]))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'and now?' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const prompt = queryMock.mock.calls[1]![0].prompt
      expect(typeof prompt).toBe('string')
      expect(prompt).toContain(`read ${JSON.stringify(imagePath)} to view it`)
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sends no image block when the step\'s image has no resolvable host path', async () => {
    const ctx = await harness()
    try {
      // No attachment service at all: the placeholder says so, the step still
      // runs, and an image the driver cannot read must not switch the query to
      // the streaming form.
      queryMock.mockImplementation(() => stream([assistantText('seen'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('image-nopath-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(imageMessage('shot.png', 'image/png', 'img-1'))
      await agent.whenIdle()

      const prompt = queryMock.mock.calls[0]![0].prompt
      expect(typeof prompt).toBe('string')
      expect(prompt).toContain('image "shot.png" (image/png, 800x600px, 1234 bytes)')
      expect(prompt).toContain('no readable path is available — ask the user to attach the image again if it is needed')
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends the bare slash line — never an image — when a slash command closes an image-bearing step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-claude-image-'))
    const imagePath = join(dir, 'shot.png')
    await writeFile(imagePath, Buffer.from([7, 7, 7]))
    const ctx = await harness()
    try {
      ctx.provide('attachments', { imageHostPath: () => imagePath })
      queryMock.mockImplementation(() => stream([assistantText('seen'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('slash-image-s'),
        meta: { cwd: process.cwd() },
      })
      // One step batch holding both: the image first, the command line last, so
      // the step is a command step.
      agent.inject(imageMessage('shot.png', 'image/png', 'img-1'))
      agent.steer(createUserMessage({ content: [{ type: 'text', text: '/help' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // The command line must stay at the head of the prompt for the CLI's
      // local-command dispatch, so a slash step reads no images at all.
      expect(queryMock.mock.calls[0]![0].prompt).toBe('/help')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sends a live slash command verbatim, bypassing the transcript framing', async () => {
    const ctx = await harness()
    try {
      // The CLI answers a recognized command with a synthetic assistant message
      // (no model turn), which the driver maps like any other assistant message.
      queryMock.mockImplementation(() => stream([assistantText('/help isn\'t available in this environment.'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('slash-s'),
        meta: { cwd: process.cwd() },
      })
      // Claude Code dispatches a local command only when the prompt OPENS with
      // `/`, so the framed transcript would hand `/help` to the model instead.
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '/help' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(queryMock.mock.calls[0]?.[0].prompt).toBe('/help')
      expect(agent.session.snapshotEvents().find(event => event.type === 'assistant/message')).toMatchObject({
        data: { message: { content: [{ type: 'text', text: '/help isn\'t available in this environment.' }] } },
      })

      // The bypass is per step: a following ordinary message replays the
      // transcript, command line and all.
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'and now?' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(queryMock.mock.calls[1]?.[0].prompt).toContain('<user>\n/help\n</user>')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('streams assistant chunks and embeds the attempt stream in the final message', async () => {
    const ctx = await harness()
    try {
      const frames: AssistantStreamFrame[] = []
      const disposeFrames = ctx.on('agent/assistant-stream', ({ frame }) => { frames.push(frame) })
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

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({ surfaceOp: 'append' })
      // The durable message embeds its exact timed stream; `assistant/chunk`
      // log events and `sourceEventSeqs` no longer exist.
      expect(expandAssistantStream(assistant!.data.stream).map(member => member.chunk)).toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'hello ' },
        { type: 'text-delta', index: 0, text: 'world' },
      ])
      expect(assistant?.data.message.content).toEqual([{ type: 'text', text: 'hello world' }])

      // The same attempt publishes live frames: open, one per chunk, settled.
      expect(frames.map(frame => frame.type)).toEqual(['start', 'chunk', 'chunk', 'chunk', 'end'])
      expect(frames.at(-1)).toMatchObject({ outcome: { kind: 'committed', eventType: 'assistant/message', seq: assistant!.seq } })
      disposeFrames()
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

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
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

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
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
      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
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

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
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

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
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


  it('gives each assistant segment its own step', async () => {
    // One Claude Code query runs the model's whole agentic loop, so a single
    // dsh step would otherwise hold every segment. The chat view keys an
    // assistant node by `${turn}:${step}` and replaces its blocks on each
    // message, so N messages in one step render only the last — the fix is one
    // step per segment, matching the in-process engine's shape.
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        assistantToolUse('toolu_1', 'Read', { file_path: 'a.txt' }),
        toolResultMessage('toolu_1', 'contents of a'),
        assistantToolUse('toolu_2', 'Bash', { command: 'ls' }),
        toolResultMessage('toolu_2', 'b.txt'),
        assistantText('both read'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('segments-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read both' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(stepStructure(agent.session)).toEqual([
        'step/start@1', 'assistant/message@1', 'tool/call@1', 'tool/result@1', 'step/end@1',
        'step/start@2', 'assistant/message@2', 'tool/call@2', 'tool/result@2', 'step/end@2',
        'step/start@3', 'assistant/message@3', 'step/end@3',
      ])
      // The assistant message that requested each call still precedes it, in
      // the same step, carrying its tool-call block.
      const events = agent.session.snapshotEvents()
      const first = events.find(event => event.type === 'assistant/message')!
      expect(first).toMatchObject({
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"file_path":"a.txt"}' }] },
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('writes one tool/result when the SDK redelivers the same result', async () => {    // The Claude Agent SDK delivers the same tool result in two `user`
    // messages ~57 ms apart. Session V4 deletes a call's pending entry on the
    // first result, so a second one for the same call is refused
    // (`tool/result <id> has no advertised tool lifecycle`) and the whole log
    // fails to load — the driver keeps exactly one result per call.
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        assistantToolUse('toolu_dup', 'Read', { file_path: 'a.txt' }),
        toolResultMessage('toolu_dup', 'contents of a'),
        toolResultMessage('toolu_dup', 'contents of a'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('dup-result-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read a.txt' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
      expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
      expect(toolResultView(events.find(event => event.type === 'tool/result')?.data.message)).toMatchObject({
        toolCallId: 'toolu_dup',
        content: [{ type: 'text', text: 'contents of a' }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('closes a step whose announced calls the engine never answered', async () => {
    // Session V4 refuses a `step/end` that leaves an announced call unresolved
    // (`step/end leaves unresolved tool call …`), and the whole log then fails
    // to load. A model turn that announces several calls and reports fewer
    // outcomes than it announced is exactly that shape, so the closing pass
    // states the missing outcome instead of leaving the step unbalanced.
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        assistantToolUse('toolu_a', 'Read', { file_path: 'a.txt' }),
        assistantToolUse('toolu_b', 'Read', { file_path: 'b.txt' }),
        toolResultMessage('toolu_a', 'contents of a'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('unanswered-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read both' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // Both announcements stay in one step (the second could not rotate past an
      // unresolved first call), and the step ends balanced.
      expect(stepStructure(agent.session).filter(tag => tag.endsWith('@1'))).toEqual([
        'step/start@1', 'assistant/message@1', 'tool/call@1',
        'assistant/message@1', 'tool/call@1', 'tool/result@1', 'tool/result@1', 'step/end@1',
      ])
      const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      expect(results.map(event => toolResultView(event.data.message).toolCallId)).toEqual(['toolu_a', 'toolu_b'])
      expect(results.map(event => toolResultView(event.data.message).isError)).toEqual([false, true])
      expect(results[1]!.data).toMatchObject({ error: { code: 'TOOL_OUTCOME_UNKNOWN' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not rotate away from a step that owes a result', async () => {
    // A settled result lets the next assistant content rotate — that is how one
    // segment per step is built — but a call announced since then is still open,
    // and rotating again would strand it in a step that can never resolve it.
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        assistantToolUse('toolu_a', 'Read', { file_path: 'a.txt' }),
        toolResultMessage('toolu_a', 'contents of a'),
        assistantToolUse('toolu_b', 'Read', { file_path: 'b.txt' }),
        assistantText('and b is next'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('owed-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read a then b' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const announcedB = events.find(event => event.type === 'tool/call' && event.data.callId === 'toolu_b')!
      const trailingText = events.find(event => event.type === 'assistant/message'
        && JSON.stringify(event.data).includes('and b is next'))!
      const answeredB = events.find(event => event.type === 'tool/result'
        && toolResultView(event.data.message).toolCallId === 'toolu_b')!

      // `b` was announced in the step the settled `a` opened...
      expect(announcedB.data.step).toBe(2)
      // ...and the content that arrived while `b` was still owed stayed there,
      // as did the outcome `b` never produced.
      expect(trailingText.data.step).toBe(announcedB.data.step)
      expect(answeredB.data.step).toBe(announcedB.data.step)
      expect(toolResultView(answeredB.data.message).isError).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('writes the same projected name and arguments to the message block and the tool/call event', async () => {
    // Session V4 pairs the two by id and refuses a log whose block and event
    // disagree, so the assistant block and the event must both carry dsh's
    // projected spelling (`Read` → `read`).
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        assistantToolUse('toolu_1', 'Read', { file_path: 'a.txt' }),
        toolResultMessage('toolu_1', 'contents of a'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('invariant-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read a.txt' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const call = events.find(event => event.type === 'tool/call')!
      const block = events
        .filter(event => event.type === 'assistant/message')
        .flatMap(event => (event.data as { message: { content: { type: string; id?: string; name?: string; arguments?: string }[] } }).message.content)
        .find(entry => entry.type === 'tool-call' && entry.id === 'toolu_1')!
      expect(block).toEqual({ type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"file_path":"a.txt"}' })
      expect(block).toMatchObject({
        name: (call.data as { name: string }).name,
        arguments: (call.data as { arguments: string }).arguments,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports the query usage total only while a step holds the whole query', async () => {
    // `result` appends a usage-only attempt carrying the QUERY's totals. With
    // one step per segment that total belongs to no single step, so it is only
    // reported when the query stayed in a single step (each segment's message
    // already carries its own request usage).
    const run = async (messages: SDKMessage[]): Promise<{ attempts: number; usageSteps: number[] }> => {
      const ctx = await harness()
      try {
        queryMock.mockImplementation(() => stream(messages))
        const { agent } = await ctx.agents.create({
          sessionId: SessionId(`usage-${Math.random()}`),
          meta: { cwd: process.cwd() },
        })
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
        await agent.whenIdle()
        const events = agent.session.snapshotEvents()
        return {
          attempts: events.filter(event => event.type === 'assistant/attempt').length,
          usageSteps: events
            .filter(event => event.type === 'assistant/attempt')
            .map(event => (event.data as { step: number }).step),
        }
      } finally {
        await ctx.fiber.dispose()
      }
    }

    // Single segment: the total is that step's own total, so it is kept.
    expect(await run([assistantText('hi'), successResult()])).toEqual({ attempts: 1, usageSteps: [1] })
    // Multi segment: per-step usage comes from each segment's message.
    expect(await run([
      assistantToolUse('toolu_u', 'Read', { file_path: 'a.txt' }),
      toolResultMessage('toolu_u', 'x'),
      assistantText('done'),
      successResult(),
    ])).toEqual({ attempts: 0, usageSteps: [] })
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

      const events = agent.session.snapshotEvents()
      const call = events.find(event => event.type === 'tool/call')
      expect(call).toMatchObject({
        data: { callId: 'toolu_999', name: 'read', arguments: '{"file_path":"x.txt"}' },
      })
      const result = events.find(event => event.type === 'tool/result')
      expect(result).toMatchObject({ surfaceOp: 'append' })
      expect(toolResultView(result?.data.message)).toMatchObject({
        role: toolResultRole(),
        toolCallId: 'toolu_999',
        content: [{ type: 'text', text: 'the file contents' }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('projects a plan tool call to todo_write and appends its list as todo/write', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        {
          type: 'assistant',
          parent_tool_use_id: null,
          uuid: 'u-todo',
          session_id: 's-todo',
          message: {
            id: 'msg-todo',
            container: null,
            context_management: null,
            role: 'assistant',
            type: 'message',
            content: [{
              type: 'tool_use',
              id: 'toolu_todo',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'first', status: 'pending', activeForm: 'First' },
                  { content: 'second', status: 'completed' },
                ],
              },
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
          parent_tool_use_id: 'toolu_todo',
          uuid: 'u-todo-tr',
          session_id: 's-todo-tr',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_todo', content: 'ok', is_error: false }],
          },
        } as unknown as SDKMessage,
        assistantText('planned'),
        successResult(),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('todo-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan it' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      expect(events.find(event => event.type === 'tool/call')).toMatchObject({
        data: { callId: 'toolu_todo', name: 'todo_write' },
      })
      expect(events.find(event => event.type === 'todo/write')).toMatchObject({
        data: { todos: [{ content: 'first', status: 'pending' }, { content: 'second', status: 'completed' }] },
      })
      // The assistant block and the tool/call event both carry dsh's projected
      // spelling: they must agree for Session V4 to pair them by id.
      expect(events.find(event => event.type === 'assistant/message')).toMatchObject({
        data: { message: { content: [{ type: 'tool-call', id: 'toolu_todo', name: 'todo_write' }] } },
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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

  it('abandons the live attempt when a step streams chunks but commits no message', async () => {
    const ctx = await harness()
    try {
      const frames: AssistantStreamFrame[] = []
      const disposeFrames = ctx.on('agent/assistant-stream', ({ frame }) => { frames.push(frame) })
      queryMock.mockImplementation(() => stream([
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
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
          errors: ['stream broke'],
          uuid: 'u-abandon',
          session_id: 's-abandon',
        } as unknown as SDKMessage,
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('abandon-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // No assistant message ever claimed the streamed chunks, so the attempt
      // closes its live frames as abandoned instead of staying open.
      expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
      expect(frames.map(frame => frame.type)).toEqual(['start', 'chunk', 'chunk', 'end'])
      expect(frames.at(-1)).toMatchObject({ outcome: { kind: 'abandoned' } })
      disposeFrames()
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
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
})

describe('ClaudeCodeAgent model selection', () => {
  /** The `Options` the Nth query ran with. */
  function queryOptionsAt(index: number): Record<string, unknown> {
    const args = queryMock.mock.calls[index]?.[0] as { options: Record<string, unknown> } | undefined
    if (args === undefined) throw new Error(`no query ran at index ${index}`)
    return args.options
  }

  it('hands the session-selected dsh model to the SDK, over the deployment pin', async () => {
    const ctx = await harness({ model: 'deployment-pinned' })
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-s'),
        meta: { cwd: process.cwd() },
      })
      // A harness `session.selectModel` appends a model/selection event.
      agent.session.append('model/selection', { provider: 'meicloud', model: 'deepseek-flash' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // Claude Code takes a bare model id/alias, so the model half of the
      // override travels and the session wins over the deployment's pin.
      expect(queryOptionsAt(0).model).toBe('deepseek-flash')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends no model for the hosted seat, falling back to the deployment pin', async () => {
    const ctx = await harness({ model: 'deployment-pinned' })
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-hosted-s'),
        meta: { cwd: process.cwd() },
      })
      agent.session.append('model/selection', { provider: 'external', model: 'default' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // `external` means "the engine decides": the pin governs instead of the
      // routed label being handed to the SDK.
      expect(queryOptionsAt(0).model).toBe('deployment-pinned')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends no model at all when the deployment pins none and no real model is selected', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-none-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect('model' in queryOptionsAt(0)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-resolves the model on every step, so a mid-session change reaches the next query', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-change-s'),
        meta: { cwd: process.cwd() },
      })
      agent.session.append('model/selection', { provider: 'meicloud', model: 'model-a' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(queryOptionsAt(0).model).toBe('model-a')

      agent.session.append('model/selection', { provider: 'meicloud', model: 'model-b' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(queryOptionsAt(1).model).toBe('model-b')
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'blocked' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ClaudeCodeAgent dsh endpoint handover', () => {
  /** The `Options` the Nth query ran with. */
  function queryOptionsAt(index: number): { env: Record<string, string | undefined>; model?: string } {
    const args = queryMock.mock.calls[index]?.[0] as { options: { env: Record<string, string | undefined>; model?: string } } | undefined
    if (args === undefined) throw new Error(`no query ran at index ${index}`)
    return args.options
  }

  /** Every durable event rendered as JSON, for the "no credential escapes" assertions. */
  function sessionLogJson(session: Session): string {
    return JSON.stringify(session.snapshotEvents())
  }

  it('hands the selected dsh model\'s endpoint and credential to the SDK environment', async () => {
    const ctx = await harness({ model: 'deployment-pinned' })
    try {
      provideDshEndpoint(ctx)
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const options = queryOptionsAt(0)
      expect(options.model).toBe(DSH_ENDPOINT.model)
      expect(options.env.ANTHROPIC_BASE_URL).toBe(DSH_ENDPOINT.baseURL)
      expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe(DSH_ENDPOINT.apiKey)
      // The credential is handed to the child's environment, never to the log.
      expect(sessionLogJson(agent.session)).not.toContain(DSH_ENDPOINT.apiKey)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('injects no endpoint for the hosted seat, leaving Claude Code its own configuration', async () => {
    const ctx = await harness()
    try {
      provideDshEndpoint(ctx)
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-hosted-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: 'external', model: 'default' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const options = queryOptionsAt(0)
      expect('ANTHROPIC_BASE_URL' in options.env).toBe(false)
      expect('ANTHROPIC_AUTH_TOKEN' in options.env).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('injects nothing and warns once when the endpoint cannot be resolved', async () => {
    const ctx = await harness()
    try {
      const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-unresolved-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      for (const index of [0, 1]) {
        const options = queryOptionsAt(index)
        expect('ANTHROPIC_BASE_URL' in options.env).toBe(false)
        // The model name still travels; only the endpoint stayed behind.
        expect(options.model).toBe(DSH_ENDPOINT.model)
      }
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(DSH_ENDPOINT.model)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-resolves the endpoint every step, so a mid-session change reaches the next query', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('ok'), successResult()]))
      const { agent } = await ctx.agents.create({ sessionId: SessionId('handover-change-s'), meta: { cwd: process.cwd() } })
      agent.session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      const endpoint = provideDshEndpoint(ctx, { baseURL: 'https://first.example.com/litellm' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(queryOptionsAt(0).env.ANTHROPIC_BASE_URL).toBe('https://first.example.com/litellm')

      endpoint.update({ baseURL: 'https://second.example.com/litellm' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(queryOptionsAt(1).env.ANTHROPIC_BASE_URL).toBe('https://second.example.com/litellm')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ClaudeCodeAgent token usage reporting', () => {
  /** The zero-filled placeholder the SDK puts on streamed assistant messages. */
  const ZERO_USAGE = {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    input_tokens: 0,
    iterations: null,
    output_tokens: 0,
    server_tool_use: null,
  }

  /** An assistant message carrying the SDK's all-zero usage placeholder. */
  function zeroUsageAssistant(text: string): SDKMessage {
    const message = assistantText(text) as { message: Record<string, unknown> }
    message.message.usage = { ...ZERO_USAGE }
    return message as unknown as SDKMessage
  }

  /** A successful result carrying the query's cumulative usage. */
  function usageResult(usage: Record<string, unknown>): SDKMessage {
    const message = successResult() as Record<string, unknown>
    message.usage = { ...ZERO_USAGE, ...usage }
    return message as unknown as SDKMessage
  }

  function usageDelta(usage: Record<string, unknown>): SDKMessage {
    return streamEvent({ type: 'message_delta', usage })
  }

  function usageOfStream(stream: unknown): unknown {
    const records = stream as readonly { type?: string; chunk?: { type?: string; usage?: unknown } }[]
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
    }
    return undefined
  }

  it('takes usage from the stream when the SDK zero-fills the assistant message', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        streamEvent({ type: 'message_start', message: { usage: ZERO_USAGE } }),
        usageDelta({ input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 900 }),
        zeroUsageAssistant('hello'),
        usageResult({ input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 900 }),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('usage-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const events = agent.session.snapshotEvents()
      const assistant = events.find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: { usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 900 } },
      })

      // The step's total rides a usage-only attempt record so per-step
      // projections see the whole query rather than its final request.
      const stepUsage = events
        .filter(event => event.type === 'assistant/attempt')
        .map(event => usageOfStream(event.data.stream))
        .find(usage => usage !== undefined)
      expect(stepUsage).toMatchObject({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 900 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves usage absent when neither the message nor the stream reports any', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([
        zeroUsageAssistant('hello'),
        usageResult({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('usage-none-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant?.data.usage).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stashes the stream sample for a zero-filled reasoning-only message', async () => {
    const ctx = await harness()
    try {
      const thinking = thinkingOnlyMessage('pondering', 0) as { message: Record<string, unknown> }
      thinking.message.usage = { ...ZERO_USAGE }
      queryMock.mockImplementation(() => stream([
        streamEvent({ type: 'message_start', message: { usage: ZERO_USAGE } }),
        usageDelta({ input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 0 }),
        thinking as unknown as SDKMessage,
        zeroUsageAssistant('answer'),
        usageResult({ input_tokens: 40, output_tokens: 4 }),
      ]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('usage-reasoning-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const assistants = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      // The suppressed thinking message carried no usable sample, so the
      // stream's own accounting is what survives onto the settled message.
      expect(assistants[0]?.data.usage).toMatchObject({ inputTokens: 40, outputTokens: 4 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps real assistant-message usage when the SDK reports it directly', async () => {
    const ctx = await harness()
    try {
      queryMock.mockImplementation(() => stream([assistantText('hello'), successResult()]))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('usage-native-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: { usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 5 } },
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
      expect(agent.session.snapshotEvents().filter(e => e.type === 'request/header')[0]).toMatchObject({
        data: { header: { config: { provider: 'external', model: 'claude-opus-4-6' } } },
      })
    } finally {
      await fresh.fiber.dispose()
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
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
