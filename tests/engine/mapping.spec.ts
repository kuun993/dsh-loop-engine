/**
 * Pure-function tests for the SDK → dsh mapping and prompt serialization.
 */

import { describe, expect, it } from 'vitest'
import type { BetaMessage, BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { MessageParam } from '@anthropic-ai/sdk/resources'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import {
  mapAssistantMessage,
  mapStreamEvent,
  mapToolResults,
  stringifyToolInput,
  type StreamToolCall,
} from '../../src/engine/mapping.ts'
import { serializeHistory, OMITTED_IMAGE_TEXT } from '../../src/engine/prompt.ts'

function assistantMessage(overrides: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: 'msg_1',
    container: null,
    content: [{ type: 'text', text: 'hello', citations: null }],
    context_management: null,
    model: 'claude-sonnet-4-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 10,
      inference_geo: null,
      input_tokens: 100,
      iterations: null,
      output_tokens: 50,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
    ...overrides,
  }
}

const userParamWithToolResult = (overrides: Partial<MessageParam> = {}): MessageParam => ({
  role: 'user',
  content: [{
    type: 'tool_result',
    tool_use_id: 'toolu_01ABC',
    content: '42',
    is_error: false,
  }],
  ...overrides,
})

describe('stringifyToolInput', () => {
  it('renders JSON values verbatim', () => {
    expect(stringifyToolInput({ path: 'a.ts', lines: [1, 2] }))
      .toBe(JSON.stringify({ path: 'a.ts', lines: [1, 2] }))
  })

  it('falls back for non-serializable values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(stringifyToolInput(cyclic)).toBe('[unserializable tool input]')
  })

  it('stringifies undefined to null', () => {
    expect(stringifyToolInput(undefined)).toBe('null')
  })
})

describe('mapAssistantMessage', () => {
  it('maps text blocks verbatim and no tool calls', () => {
    const mapped = mapAssistantMessage(assistantMessage())
    expect(mapped).toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
      toolCalls: [],
      model: 'claude-sonnet-4-5',
    })
    expect(mapped.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
    })
  })

  it('surfaces tool_use blocks as tool-call blocks and calls', () => {
    const mapped = mapAssistantMessage(assistantMessage({
      content: [
        { type: 'text', text: 'reading', citations: null },
        { type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: 'a.ts' } },
      ],
    }))
    expect(mapped.content).toEqual([
      { type: 'text', text: 'reading' },
      { type: 'tool-call', id: CallId('toolu_001'), name: 'Read', arguments: '{"file_path":"a.ts"}' },
    ])
    expect(mapped.toolCalls).toEqual([{
      callId: CallId('toolu_001'),
      name: 'Read',
      arguments: '{"file_path":"a.ts"}',
    }])
  })

  it('drops thinking/unknown blocks', () => {
    const mapped = mapAssistantMessage(assistantMessage({
      content: [
        { type: 'thinking', thinking: 'internal reasoning', signature: 'sig' },
        { type: 'text', text: 'visible', citations: null },
      ],
    }))
    expect(mapped.content).toEqual([{ type: 'text', text: 'visible' }])
  })

  it('omits cache counters that are null', () => {
    const mapped = mapAssistantMessage(assistantMessage({
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        inference_geo: null,
        input_tokens: 7,
        iterations: null,
        output_tokens: 3,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      },
    }))
    expect(mapped.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
  })
})

describe('mapToolResults', () => {
  it('maps a tool_result block to a dsh tool-result message', () => {
    const results = mapToolResults(userParamWithToolResult())
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      role: 'user',
      source: { kind: 'tool', callId: 'toolu_01ABC' },
      content: [{
        type: 'tool-result',
        toolCallId: 'toolu_01ABC',
        content: [{ type: 'text', text: '42' }],
        isError: false,
      }],
    })
  })

  it('marks error results', () => {
    const results = mapToolResults(userParamWithToolResult({
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_09',
        content: 'boom',
        is_error: true,
      }],
    }))
    expect(results[0]!.content[0]).toMatchObject({ isError: true })
  })

  it('maps block-array content to text blocks only', () => {
    const results = mapToolResults(userParamWithToolResult({
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_77',
        content: [{ type: 'text', text: 'line' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }],
        is_error: false,
      }],
    }))
    expect(results[0]!.content[0].content).toMatchObject([{ type: 'text', text: 'line' }])
  })

  it('ignores non-tool_result blocks', () => {
    const results = mapToolResults({ role: 'user', content: [{ type: 'text', text: 'plain' }] })
    expect(results).toEqual([])
  })

  it('skips string-content user messages', () => {
    expect(mapToolResults({ role: 'user', content: 'plain text' })).toEqual([])
  })

  it('yields an empty text block for absent content', () => {
    const results = mapToolResults(userParamWithToolResult({
      content: [{ type: 'tool_result', tool_use_id: 'toolu_55' }],
    }))
    expect(results[0]!.content[0].content).toEqual([{ type: 'text', text: '(no content)' }])
  })

  it('skips tool_result children whose text is not a string', () => {
    const results = mapToolResults({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_66',
        content: [{ type: 'text', text: 42 as never }],
        is_error: false,
      }],
    })
    expect(results[0]!.content[0].content).toEqual([{ type: 'text', text: '(no content)' }])
  })
})

describe('mapStreamEvent', () => {
  const event = (value: unknown): BetaRawMessageStreamEvent => value as unknown as BetaRawMessageStreamEvent
  const calls = (): Map<number, StreamToolCall> => new Map<number, StreamToolCall>()

  it('maps a text content_block_start to a block-start chunk', () => {
    expect(mapStreamEvent(event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'hello', citations: null },
    }), calls())).toEqual([{ type: 'block-start', index: 0, blockType: 'text' }])
  })

  it('maps a tool_use content_block_start to a tool-call block-start and records the call identity', () => {
    const tools = calls()
    const chunks = mapStreamEvent(event({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } },
    }), tools)
    expect(chunks).toEqual([{ type: 'block-start', index: 1, blockType: 'tool-call' }])
    expect(tools.get(1)).toEqual({ callId: CallId('toolu_1'), name: 'Read' })
  })

  it('ignores thinking block starts', () => {
    expect(mapStreamEvent(event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: 'inner', signature: 'sig' },
    }), calls())).toEqual([])
  })

  it('maps a text delta to a text-delta chunk', () => {
    expect(mapStreamEvent(event({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'world' },
    }), calls())).toEqual([{ type: 'text-delta', index: 0, text: 'world' }])
  })

  it('maps an input_json_delta to a tool-call-delta named by the recorded call', () => {
    const tools = calls().set(1, { callId: CallId('toolu_1'), name: 'Read' })
    expect(mapStreamEvent(event({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
    }), tools)).toEqual([{
      type: 'tool-call-delta',
      index: 1,
      id: CallId('toolu_1'),
      name: 'Read',
      argumentsDelta: '{"path":"a.ts"}',
    }])
  })

  it('falls back to a synthetic call id for an unmatched input_json_delta', () => {
    expect(mapStreamEvent(event({
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    }), calls())).toEqual([{
      type: 'tool-call-delta',
      index: 3,
      id: CallId('call-3'),
      argumentsDelta: '{}',
    }])
  })

  it('ignores non-text, non-json deltas', () => {
    expect(mapStreamEvent(event({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'citations_delta', citation: null },
    }), calls())).toEqual([])
  })

  it('ignores transport and block-boundary events', () => {
    const tools = calls()
    expect(mapStreamEvent(event({ type: 'message_start', message: {} }), tools)).toEqual([])
    expect(mapStreamEvent(event({ type: 'content_block_stop', index: 0 }), tools)).toEqual([])
    expect(mapStreamEvent(event({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, container: null, stop_details: null },
      usage: { input_tokens: 1, output_tokens: 1 },
      context_management: null,
    }), tools)).toEqual([])
    expect(mapStreamEvent(event({ type: 'message_stop' }), tools)).toEqual([])
  })
})

describe('serializeHistory', () => {
  it('serializes an empty history to an empty prompt', () => {
    expect(serializeHistory([])).toBe('')
  })

  it('frames user, assistant, and tool-result messages in order', () => {
    const messages = [
      { role: 'user' as const, id: MessageId('m-user-1'), content: [{ type: 'text' as const, text: 'hello' }], source: { kind: 'user' as const } },
      {
        role: 'assistant' as const,
        id: MessageId('m-assistant-1'),
        content: [
          { type: 'text' as const, text: 'Hi!' },
          { type: 'tool-call' as const, id: CallId('t1'), name: 'Read', arguments: '{}' },
        ],
        source: { kind: 'model' as const, provider: 'claude-code', model: 'x' },
      },
      {
        role: 'user' as const,
        id: MessageId('m-tool-result-1'),
        content: [{
          type: 'tool-result' as const,
          toolCallId: CallId('t1'),
          content: [{ type: 'text' as const, text: 'contents of file' }],
        }],
        source: { kind: 'tool' as const, callId: CallId('t1') },
      },
    ]
    const prompt = serializeHistory(messages)
    expect(prompt).toBe([
      '<user>',
      'hello',
      '</user>',
      '',
      '<assistant>',
      'Hi!',
      '',
      '[tool call: Read({})]',
      '</assistant>',
      '',
      '<tool-result>',
      'contents of file',
      '</tool-result>',
    ].join('\n'))
  })

  it('skips reasoning blocks and empty assistant bodies', () => {
    const prompt = serializeHistory([
      {
        role: 'assistant' as const,
        id: MessageId('m-reasoning'),
        content: [{ type: 'reasoning' as const, text: 'silent thinking' }],
        source: { kind: 'model' as const, provider: 'claude-code', model: 'x' },
      },
      { role: 'user' as const, id: MessageId('m-go'), content: [{ type: 'text' as const, text: 'go' }], source: { kind: 'user' as const } },
    ])
    expect(prompt).toBe('<user>\ngo\n</user>')
  })

  it('marks image blocks and tool errors', () => {
    const prompt = serializeHistory([
      {
        role: 'user' as const,
        id: MessageId('m-image-user'),
        content: [
          { type: 'text' as const, text: 'look' },
          { type: 'image' as const, attachment: { attachmentId: AttachmentId('img-1'), bytes: 2, mediaType: 'image/png', width: 4, height: 4 } },
        ],
        source: { kind: 'user' as const },
      },
      {
        role: 'user' as const,
        id: MessageId('m-tool-error'),
        content: [{
          type: 'tool-result' as const,
          toolCallId: CallId('e1'),
          content: [{ type: 'text' as const, text: 'failed' }],
          isError: true,
        }],
        source: { kind: 'tool' as const, callId: CallId('e1') },
      },
    ])
    expect(prompt).toContain(OMITTED_IMAGE_TEXT)
    expect(prompt).toContain('<tool-result-error>')
  })

  it('omits assistant image blocks from the transcript', () => {
    const prompt = serializeHistory([
      {
        role: 'assistant' as const,
        id: MessageId('m-image-assistant'),
        content: [
          { type: 'image' as const, attachment: { attachmentId: AttachmentId('img-1'), bytes: 2, mediaType: 'image/png', width: 4, height: 4 } },
          { type: 'text' as const, text: 'visible text' },
        ],
        source: { kind: 'model' as const, provider: 'claude-code', model: 'x' },
      },
    ])
    expect(prompt).toContain(OMITTED_IMAGE_TEXT)
    expect(prompt).toContain('visible text')
  })

  it('renders tool-result children: images marked, other blocks blank', () => {
    const prompt = serializeHistory([{
      role: 'user' as const,
      id: MessageId('m-tool-child'),
      content: [{
        type: 'tool-result' as const,
        toolCallId: CallId('c1'),
        content: [
          { type: 'image' as const, attachment: { attachmentId: AttachmentId('img-1'), bytes: 2, mediaType: 'image/png', width: 4, height: 4 } },
          { type: 'reasoning' as const, text: 'quiet thinking' },
        ],
        isError: false,
      }],
      source: { kind: 'tool' as const, callId: CallId('c1') },
    }])
    expect(prompt).toBe(`<tool-result>\n${OMITTED_IMAGE_TEXT}\n</tool-result>`)
  })

  it('renders an empty tool-result body as a placeholder', () => {
    const prompt = serializeHistory([{
      role: 'user' as const,
      id: MessageId('m-empty-tool'),
      content: [{
        type: 'tool-result' as const,
        toolCallId: CallId('c2'),
        content: [],
        isError: false,
      }],
      source: { kind: 'tool' as const, callId: CallId('c2') },
    }])
    expect(prompt).toBe('<tool-result>\n(no content)\n</tool-result>')
  })

  it('renders a user message with no visible blocks as a placeholder', () => {
    const prompt = serializeHistory([
      { role: 'user' as const, id: MessageId('m-empty-user'), content: [], source: { kind: 'user' as const } },
    ])
    expect(prompt).toBe('<user>\n(no content)\n</user>')
  })

  it('blanks non-textual user blocks and keeps only text', () => {
    const prompt = serializeHistory([
      {
        role: 'user' as const,
        id: MessageId('m-blank-reasoning'),
        content: [
          { type: 'reasoning' as const, text: 'silent internals' },
          { type: 'text' as const, text: 'visible' },
        ],
        source: { kind: 'user' as const },
      },
    ])
    expect(prompt).toBe('<user>\nvisible\n</user>')
  })

  it('skips system-role messages in the derived history', () => {
    const prompt = serializeHistory([
      {
        role: 'system' as const,
        id: MessageId('m-system'),
        content: [{ type: 'text' as const, text: 'invisible' }],
        source: { kind: 'plugin' as const, plugin: 'test' },
      },
      { role: 'user' as const, id: MessageId('m-go-2'), content: [{ type: 'text' as const, text: 'go' }], source: { kind: 'user' as const } },
    ])
    expect(prompt).toBe('<user>\ngo\n</user>')
  })
})
