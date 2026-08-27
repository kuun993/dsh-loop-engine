/**
 * Unit tests for the app-server mapping functions: delta events → dsh chunks,
 * completed items → durable content, usage → TokenUsage.
 */

import { describe, expect, it } from 'vitest'
import type { AppServerEvent } from '../../../src/engine-codex/appserver/thread.ts'
import {
  createMappingState,
  mapCommandExecution,
  mapEvent,
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

describe('mapEvent', () => {
  it('maps agent-delta to text-delta chunk', () => {
    const state = createMappingState()
    state.blockIndex = 0
    const result = mapEvent({ kind: 'agent-delta', itemId: 'msg-1', delta: 'hello' }, state)
    expect(result.chunks).toEqual([{ type: 'text-delta', index: 0, text: 'hello' }])
    expect(state.currentText).toBe('hello')
  })

  it('maps reasoning-summary-delta to reasoning-delta chunk', () => {
    const state = createMappingState()
    const result = mapEvent({ kind: 'reasoning-summary-delta', itemId: 'r-1', delta: 'thinking', summaryIndex: 0 }, state)
    expect(result.chunks).toEqual([{ type: 'reasoning-delta', index: 0, text: 'thinking' }])
  })

  it('maps turn-completed with usage', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'turn-completed',
      turn: {
        id: 'turn-1',
        status: 'completed',
        error: null,
        items: [],
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, reasoningOutputTokens: 1 },
      },
    }, state)
    expect(result.turnCompleted).toBe(true)
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('maps error to error result', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'error',
      error: { message: 'model overloaded' },
      willRetry: false,
    }, state)
    expect(result.error).toMatchObject({ message: 'model overloaded' })
  })

  it('maps item-completed for agentMessage', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'agentMessage', id: 'msg-1', text: 'answer' },
    }, state)
    expect(result.itemCompleted).toBe(true)
    expect(result.contentBlocks).toEqual([{ type: 'text', text: 'answer' }])
  })

  it('maps item-completed for agentMessage with no text, falling back to accumulated text', () => {
    const state = createMappingState()
    state.currentText = 'accumulated'
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'agentMessage', id: 'msg-1' },
    }, state)
    expect(result.contentBlocks).toEqual([{ type: 'text', text: 'accumulated' }])
  })

  it('maps item-completed for reasoning with summary', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'reasoning', id: 'r-1', summary: ['thinking'], content: [] },
    }, state)
    expect(result.contentBlocks).toEqual([{ type: 'reasoning', text: 'thinking' }])
  })

  it('maps item-completed for reasoning with content fallback', () => {
    const state = createMappingState()
    state.currentReasoning = 'streamed reasoning'
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'reasoning', id: 'r-1', summary: [], content: ['detailed trace'] },
    }, state)
    expect(result.contentBlocks).toEqual([{ type: 'reasoning', text: 'detailed trace' }])
  })

  it('maps item-completed for reasoning with neither summary nor content', () => {
    const state = createMappingState()
    state.currentReasoning = 'streamed reasoning'
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'reasoning', id: 'r-1' },
    }, state)
    expect(result.contentBlocks).toEqual([{ type: 'reasoning', text: 'streamed reasoning' }])
  })

  it('maps item-completed for commandExecution', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'commandExecution', id: 'cmd-1', command: 'ls', aggregatedOutput: 'ok', exitCode: 0 },
    }, state)
    expect(result.itemCompleted).toBe(true)
  })

  it('maps item-completed for commandExecution with no command', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'commandExecution', id: 'cmd-1', aggregatedOutput: 'ok', exitCode: 0 },
    }, state)
    expect(result.itemCompleted).toBe(true)
  })

  it('maps item-completed for fileChange with no changes', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'fileChange', id: 'patch-1' },
    }, state)
    expect(result.itemCompleted).toBe(true)
  })

  it('maps item-completed for mcpToolCall with no arguments', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'mcpToolCall', id: 'mcp-1', server: 's', tool: 't' },
    }, state)
    expect(result.itemCompleted).toBe(true)
  })

  it('maps turn-completed without usage', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'turn-completed',
      turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
    }, state)
    expect(result.turnCompleted).toBe(true)
    expect(result.usage).toBeUndefined()
  })

  it('maps turn-completed with usage omitting optional token fields', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'turn-completed',
      turn: {
        id: 'turn-1',
        status: 'completed',
        error: null,
        items: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    }, state)
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('maps item-started for agentMessage', () => {
    const state = createMappingState()
    const result = mapEvent({ kind: 'item-started', itemType: 'agentMessage', itemId: 'msg-1' }, state)
    expect(result.chunks).toEqual([{ type: 'block-start', index: 0, blockType: 'text' }])
    expect(state.isTextBlock).toBe(true)
  })

  it('maps item-started for reasoning', () => {
    const state = createMappingState()
    const result = mapEvent({ kind: 'item-started', itemType: 'reasoning', itemId: 'r-1' }, state)
    expect(result.chunks).toEqual([{ type: 'block-start', index: 0, blockType: 'reasoning' }])
    expect(state.isReasoningBlock).toBe(true)
  })

  it('maps turn-started to empty result', () => {
    const state = createMappingState()
    const result = mapEvent({ kind: 'turn-started', turnId: 'turn-1' }, state)
    expect(result.chunks).toEqual([])
    expect(result.turnCompleted).toBe(false)
  })

  it('maps token-usage to empty result', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'token-usage',
      usage: {
        total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5 },
        last: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 2 },
      },
    }, state)
    expect(result.chunks).toEqual([])
  })

  it('maps plan-delta to reasoning-delta chunk', () => {
    const state = createMappingState()
    const result = mapEvent({ kind: 'plan-delta', itemId: 'p-1', delta: 'plan step' }, state)
    expect(result.chunks).toEqual([{ type: 'reasoning-delta', index: 0, text: 'plan step' }])
  })

  it('maps item-started for non-agent/non-reasoning item types', () => {
    const state = createMappingState()
    const result = mapEvent({ kind: 'item-started', itemType: 'commandExecution', itemId: 'cmd-1' }, state)
    expect(result.chunks).toEqual([])
    expect(result.itemType).toBe('commandExecution')
    expect(state.isTextBlock).toBe(false)
    expect(state.isReasoningBlock).toBe(false)
  })

  it('maps item-completed for fileChange', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'fileChange', id: 'patch-1', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' },
    }, state)
    expect(result.itemCompleted).toBe(true)
    expect(result.itemType).toBe('fileChange')
  })

  it('maps item-completed for mcpToolCall', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', arguments: { q: 'x' }, status: 'completed' },
    }, state)
    expect(result.itemCompleted).toBe(true)
    expect(result.itemType).toBe('mcpToolCall')
  })

  it('maps item-completed for mcpToolCall without server/tool', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'mcpToolCall', id: 'mcp-1', arguments: {}, status: 'completed' },
    }, state)
    expect(result.itemCompleted).toBe(true)
  })

  it('maps item-completed for unknown item types', () => {
    const state = createMappingState()
    const result = mapEvent({
      kind: 'item-completed',
      item: { type: 'webSearch', id: 'ws-1', query: 'test' },
    }, state)
    expect(result.itemCompleted).toBe(true)
    expect(result.itemType).toBe('webSearch')
  })
})
