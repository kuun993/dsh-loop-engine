/**
 * Unit tests for the `kimi acp` event mapping: update kind predicates, chunk
 * delta extraction, tool identity/stream helpers, and the tool-result projection.
 * @module tests/engine-kimi/acp/mapping
 */

import { describe, expect, it } from 'vitest'
import {
  chunkDelta,
  isTextChunk,
  isThoughtChunk,
  isToolCall,
  isToolCallUpdate,
  isToolErrorStatus,
  isToolSettledStatus,
  toolCallIdOf,
  toolCallName,
  toolContentText,
  toolResult,
} from '../../../src/engine-kimi/acp/mapping.ts'
import type { AcpToolCallStreamExt, AcpUpdate } from '../../../src/engine-kimi/acp/types.ts'

const msg = (text: string): AcpUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const thought = (text: string): AcpUpdate => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
const toolCall = (id: string, title: string): AcpUpdate => ({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status: 'pending', content: [] })
const toolStream = (id: string, status: string, text: string): AcpUpdate => ({
  sessionUpdate: 'tool_call_update', toolCallId: id, status,
  content: [{ type: 'content', content: { type: 'text', text } }],
})

describe('update kind predicates', () => {
  it('classifies text, thought, tool call, and tool call update', () => {
    expect(isTextChunk(msg('a'))).toBe(true)
    expect(isThoughtChunk(msg('a'))).toBe(false)
    expect(isThoughtChunk(thought('a'))).toBe(true)
    expect(isTextChunk(thought('a'))).toBe(false)
    expect(isToolCall(toolCall('c1', 'Bash'))).toBe(true)
    expect(isToolCall(toolStream('c1', 'in_progress', ''))).toBe(false)
    expect(isToolCallUpdate(toolStream('c1', 'in_progress', 'x'))).toBe(true)
    expect(isToolCallUpdate(msg('a'))).toBe(false)
  })
})

describe('chunkDelta', () => {
  it('extracts the text delta from a text chunk', () => {
    expect(chunkDelta(msg('hi'))).toBe('hi')
  })

  it('returns empty for a non-text content block or missing content', () => {
    expect(chunkDelta({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } })).toBe('')
    expect(chunkDelta({ sessionUpdate: 'agent_message_chunk' })).toBe('')
  })
})

describe('tool identity', () => {
  it('reads the tool call id and name', () => {
    expect(toolCallIdOf(toolCall('0:call_1', 'Bash'))).toBe('0:call_1')
    expect(toolCallName(toolCall('0:call_1', 'Bash'))).toBe('Bash')
  })

  it('classifies stream statuses as streaming vs settled and error', () => {
    expect(isToolSettledStatus('in_progress')).toBe(false)
    expect(isToolSettledStatus('pending')).toBe(false)
    expect(isToolSettledStatus('running')).toBe(false)
    expect(isToolSettledStatus('complete')).toBe(true)
    expect(isToolSettledStatus('failed')).toBe(true)
    expect(isToolErrorStatus('failed')).toBe(true)
    expect(isToolErrorStatus('error')).toBe(true)
    expect(isToolErrorStatus('denied')).toBe(true)
    expect(isToolErrorStatus('complete')).toBe(false)
  })
})

describe('toolContentText', () => {
  it('joins the nested content-text blocks', () => {
    const update = toolStream('c1', 'in_progress', 'a') as unknown as AcpToolCallStreamExt
    update.content = [
      { type: 'content', content: { type: 'text' as const, text: 'a' } },
      { type: 'content', content: { type: 'text' as const, text: 'b' } },
    ]
    expect(toolContentText(update)).toBe('ab')
  })

  it('returns empty for absent content and for non-matching blocks', () => {
    const absent = { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' } as unknown as AcpToolCallStreamExt
    expect(toolContentText(absent)).toBe('')
    const update = toolStream('c1', 'in_progress', '') as unknown as AcpToolCallStreamExt
    update.content = [
      { type: 'content', content: { type: 'image' as never } } as never,
      { type: 'not-content', content: { type: 'text', text: 'x' } } as never,
    ] as never
    expect(toolContentText(update)).toBe('')
  })
})

describe('toolResult', () => {
  it('projects a successful tool result with the joined text', () => {
    const result = toolResult('0:call_1', 'Command executed successfully.', false)
    expect(result.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: '0:call_1',
      content: [{ type: 'text', text: 'Command executed successfully.' }],
      isError: false,
    })
  })

  it('marks an error result and defaults empty text to a placeholder', () => {
    expect(toolResult('0:call_1', '', true).content[0]).toMatchObject({ isError: true, content: [{ type: 'text', text: '(no content)' }] })
  })
})
