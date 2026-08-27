/**
 * Unit tests for the app-server mapping functions: delta events → dsh chunks,
 * completed items → durable content, usage → TokenUsage.
 */

import { describe, expect, it } from 'vitest'
import {
  mapCommandExecution,
  mapFileChange,
  mapMcpToolCall,
  mapUsage,
} from '../../../src/engine-codex/appserver/mapping.ts'

describe('mapUsage', () => {
  it('maps all fields', () => {
    const usage = mapUsage({
      inputTokens: 12,
      outputTokens: 7,
      cachedInputTokens: 5,
      reasoningOutputTokens: 3,
    })
    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 5,
      reasoningTokens: 3,
    })
  })

  it('omits absent optional fields', () => {
    const usage = mapUsage({ inputTokens: 1, outputTokens: 2 })
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(usage).not.toHaveProperty('cacheReadTokens')
    expect(usage).not.toHaveProperty('reasoningTokens')
  })
})

describe('mapCommandExecution', () => {
  it('maps a completed command', () => {
    const result = mapCommandExecution({
      id: 'cmd-1',
      command: 'ls -la',
      aggregatedOutput: 'file.txt',
      exitCode: 0,
      status: 'completed',
    })
    expect(result.call).toMatchObject({
      callId: 'cmd-1',
      name: 'command_execution',
      arguments: '{"command":"ls -la"}',
    })
    expect(result.result.content).toEqual([{
      type: 'tool-result',
      toolCallId: 'cmd-1',
      content: [{ type: 'text', text: 'file.txt' }],
      isError: false,
    }])
  })

  it('marks non-zero exit codes as errors', () => {
    const result = mapCommandExecution({
      id: 'cmd-1',
      command: 'false',
      aggregatedOutput: '',
      exitCode: 1,
      status: 'completed',
    })
    expect(result.result.content[0]).toMatchObject({ isError: true })
  })
})

describe('mapFileChange', () => {
  it('maps a completed patch', () => {
    const result = mapFileChange({
      id: 'patch-1',
      changes: [{ path: 'src/a.ts', kind: 'update' }],
      status: 'completed',
    })
    expect(result.call).toMatchObject({
      callId: 'patch-1',
      name: 'apply_patch',
    })
    expect(result.result.content[0]).toMatchObject({ isError: false })
  })
})

describe('mapMcpToolCall', () => {
  it('maps a successful tool call', () => {
    const result = mapMcpToolCall({
      id: 'mcp-1',
      server: 'docs',
      tool: 'search',
      arguments: { q: 'cordis' },
      result: { content: [{ type: 'text', text: 'ok' }] },
    })
    expect(result.call).toMatchObject({
      callId: 'mcp-1',
      name: 'docs/search',
    })
    expect(result.result.content[0]).toMatchObject({ isError: false })
  })

  it('maps a failed tool call', () => {
    const result = mapMcpToolCall({
      id: 'mcp-1',
      server: 'docs',
      tool: 'search',
      arguments: {},
      error: { message: 'not found' },
    })
    expect(result.result.content[0]).toMatchObject({ isError: true })
  })

  it('maps a tool call without server/tool to mcp_tool_call name', () => {
    const result = mapMcpToolCall({
      id: 'mcp-1',
      arguments: {},
      result: { content: [] },
    })
    expect(result.call.name).toBe('mcp_tool_call')
  })

  it('maps a tool call with server but no tool to mcp_tool_call name', () => {
    const result = mapMcpToolCall({
      id: 'mcp-1',
      server: 'docs',
      arguments: {},
      result: { content: [] },
    })
    expect(result.call.name).toBe('mcp_tool_call')
  })

  it('maps a tool call with no arguments', () => {
    const result = mapMcpToolCall({
      id: 'mcp-1',
      server: 'docs',
      tool: 'search',
    })
    expect(result.call.arguments).toBe('{}')
  })

  it('maps a tool call with null error', () => {
    const result = mapMcpToolCall({
      id: 'mcp-1',
      server: 'docs',
      tool: 'search',
      arguments: {},
      error: null as unknown as { message?: string },
    })
    expect(result.result.content[0]).toMatchObject({ isError: false })
  })

  it('maps a tool call with error but no message', () => {
    const result = mapMcpToolCall({
      id: 'mcp-1',
      server: 'docs',
      tool: 'search',
      arguments: {},
      error: {},
    })
    expect(result.result.content[0]).toMatchObject({ isError: true })
  })

  it('maps a tool call with null result', () => {
    const result = mapMcpToolCall({
      id: 'mcp-1',
      server: 'docs',
      tool: 'search',
      arguments: {},
      result: null as unknown as { content?: unknown[] },
    })
    expect(result.result.content[0]).toMatchObject({ isError: false })
  })
})

describe('mapCommandExecution edge cases', () => {
  it('maps a command with null aggregatedOutput', () => {
    const result = mapCommandExecution({
      id: 'cmd-1',
      command: 'ls',
      aggregatedOutput: null,
      exitCode: 0,
      status: 'completed',
    })
    expect(result.result.content[0]).toMatchObject({ content: [{ type: 'text', text: '' }] })
  })

  it('maps a command with null exitCode', () => {
    const result = mapCommandExecution({
      id: 'cmd-1',
      command: 'ls',
      aggregatedOutput: 'ok',
      exitCode: null,
      status: 'completed',
    })
    expect(result.result.content[0]).toMatchObject({ isError: false })
  })

  it('maps a command with failed status', () => {
    const result = mapCommandExecution({
      id: 'cmd-1',
      command: 'false',
      aggregatedOutput: '',
      exitCode: 0,
      status: 'failed',
    })
    expect(result.result.content[0]).toMatchObject({ isError: true })
  })

  it('maps a command with undefined command', () => {
    const result = mapCommandExecution({
      id: 'cmd-1',
      aggregatedOutput: 'ok',
      exitCode: 0,
      status: 'completed',
    })
    expect(result.call.arguments).toBe('{"command":""}')
  })
})

describe('mapFileChange edge cases', () => {
  it('maps a patch with null changes', () => {
    const result = mapFileChange({
      id: 'patch-1',
      changes: null as unknown as unknown[],
      status: 'completed',
    })
    expect(result.call.arguments).toBe('[]')
  })

  it('maps a patch with undefined status', () => {
    const result = mapFileChange({
      id: 'patch-1',
      changes: [],
    })
    expect(result.result.content[0]).toMatchObject({ isError: false })
  })

  it('maps a patch with failed status', () => {
    const result = mapFileChange({
      id: 'patch-1',
      changes: [],
      status: 'failed',
    })
    expect(result.result.content[0]).toMatchObject({ isError: true })
  })
})
