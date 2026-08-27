/**
 * Unit tests for the Pi RPC mapping functions: usage → TokenUsage, result
 * payloads → tool-result text, and tool identities → durable tool/call data.
 * @module tests/engine-pi/rpc/mapping
 */

import { describe, expect, it } from 'vitest'
import {
  mapToolCall,
  mapToolResult,
  mapUsage,
  resultText,
} from '../../../src/engine-pi/rpc/mapping.ts'

describe('mapUsage', () => {
  it('maps all provided fields', () => {
    const usage = mapUsage({ input: 12, output: 7, cacheRead: 5, cacheWrite: 3 })
    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
    })
  })

  it('omits absent optional fields and zeroes missing primitives', () => {
    const usage = mapUsage({ output: 2 })
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 2 })
    expect(usage).not.toHaveProperty('cacheReadTokens')
    expect(usage).not.toHaveProperty('cacheWriteTokens')
  })

  it('omits cache fields when they are zero', () => {
    const usage = mapUsage({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 2 })
  })

  it('defaults missing primitives to zero', () => {
    const usage = mapUsage({ input: 5 })
    expect(usage).toEqual({ inputTokens: 5, outputTokens: 0 })
  })
})

describe('mapToolResult', () => {
  it('maps a tool-execution result with text content', () => {
    const result = mapToolResult({
      toolCallId: 'call-1',
      result: { content: [{ type: 'text', text: 'file.txt' }], details: {} },
      isError: false,
    })
    expect(result.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'file.txt' }],
      isError: false,
    })
  })

  it('marks an error result', () => {
    const result = mapToolResult({
      toolCallId: 'call-2',
      result: { content: [{ type: 'text', text: 'boom' }] },
      isError: true,
    })
    expect(result.content[0]).toMatchObject({ isError: true })
  })

  it('falls back to a placeholder for an empty/unstructured result', () => {
    const result = mapToolResult({ toolCallId: 'call-3', result: {}, isError: false })
    expect(result.content[0]?.content[0]).toMatchObject({ text: '(no content)' })
  })
})

describe('resultText', () => {
  it('joins nested text content blocks', () => {
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\n\nb')
  })

  it('reads a bare text field', () => {
    expect(resultText({ text: 'raw' })).toBe('raw')
  })

  it('reads a top-level string content array', () => {
    expect(resultText([{ type: 'text', text: 'x' }, { type: 'image' }])).toBe('x')
  })

  it('returns an empty string for unstructured payloads', () => {
    expect(resultText(42)).toBe('')
    expect(resultText(undefined)).toBe('')
    // Non-object array blocks contribute no text.
    expect(resultText(['x'])).toBe('')
  })
})

describe('mapToolCall', () => {
  it('maps a message tool call identity and serializes its arguments', () => {
    const call = mapToolCall({ callId: 'call-1', name: 'bash', arguments: { command: 'ls' } })
    expect(call).toEqual({ callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' })
  })

  it('serializes missing arguments to an empty object', () => {
    const call = mapToolCall({ callId: 'call-2', name: 'read' })
    expect(call.arguments).toBe('{}')
  })
})
