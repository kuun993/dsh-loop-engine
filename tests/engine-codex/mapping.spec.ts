/**
 * Pure mapping tests for the Codex thread-item → dsh session-event translation.
 * @module tests/engine-codex/mapping
 */

import { describe, expect, it } from 'vitest'
import type {
  AgentMessageItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ReasoningItem,
  Usage,
} from '@openai/codex-sdk'
import {
  mapAgentMessage,
  mapCommandExecution,
  mapFileChange,
  mapMcpToolCall,
  mapReasoning,
  mapUsage,
} from '../../src/engine-codex/mapping.ts'

function commandExecution(overrides: Partial<CommandExecutionItem> = {}): CommandExecutionItem {
  return {
    id: 'cmd-1',
    type: 'command_execution',
    command: 'ls -la',
    aggregated_output: 'total 0',
    exit_code: 0,
    status: 'completed',
    ...overrides,
  }
}

describe('mapAgentMessage', () => {
  it('maps the full item text to a single text block', () => {
    const item: AgentMessageItem = { id: 'msg-1', type: 'agent_message', text: 'hello world' }
    expect(mapAgentMessage(item)).toEqual([{ type: 'text', text: 'hello world' }])
  })
})

describe('mapReasoning', () => {
  it('extracts the reasoning summary text', () => {
    const item: ReasoningItem = { id: 'r-1', type: 'reasoning', text: 'thinking it through' }
    expect(mapReasoning(item)).toBe('thinking it through')
  })
})

describe('mapCommandExecution', () => {
  it('maps a successful execution to a call/result pair', () => {
    const activity = mapCommandExecution(commandExecution())
    expect(activity.call).toEqual({
      callId: 'cmd-1',
      name: 'command_execution',
      arguments: '{"command":"ls -la"}',
    })
    expect(activity.result).toMatchObject({
      content: [{
        type: 'tool-result',
        toolCallId: 'cmd-1',
        content: [{ type: 'text', text: 'total 0' }],
        isError: false,
      }],
    })
  })

  it('flags a non-zero exit code as an error result', () => {
    const activity = mapCommandExecution(commandExecution({ exit_code: 2 }))
    expect(activity.result.content[0]).toMatchObject({ isError: true })
  })

  it('flags a failed status as an error result', () => {
    const activity = mapCommandExecution(commandExecution({ status: 'failed', exit_code: undefined }))
    expect(activity.result.content[0]).toMatchObject({ isError: true })
  })

  it('renders a placeholder when the output is empty', () => {
    const activity = mapCommandExecution(commandExecution({ aggregated_output: '' }))
    expect(activity.result.content[0]).toMatchObject({
      content: [{ type: 'text', text: '(no output)' }],
    })
  })
})

describe('mapFileChange', () => {
  it('maps the change set to an apply_patch call and a summary result', () => {
    const item: FileChangeItem = {
      id: 'patch-1',
      type: 'file_change',
      changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }],
      status: 'completed',
    }
    const activity = mapFileChange(item)
    expect(activity.call).toEqual({
      callId: 'patch-1',
      name: 'apply_patch',
      arguments: '{"changes":[{"path":"src/a.ts","kind":"update"},{"path":"src/b.ts","kind":"add"}]}',
    })
    expect(activity.result.content[0]).toMatchObject({
      content: [{ type: 'text', text: 'update src/a.ts\nadd src/b.ts' }],
      isError: false,
    })
  })

  it('flags a failed patch and renders an empty change set', () => {
    const item: FileChangeItem = { id: 'patch-2', type: 'file_change', changes: [], status: 'failed' }
    const activity = mapFileChange(item)
    expect(activity.result.content[0]).toMatchObject({
      content: [{ type: 'text', text: '(no changes)' }],
      isError: true,
    })
  })
})

describe('mapMcpToolCall', () => {
  it('names the call server/tool and maps the structured result', () => {
    const item: McpToolCallItem = {
      id: 'mcp-1',
      type: 'mcp_tool_call',
      server: 'docs',
      tool: 'search',
      arguments: { q: 'cordis' },
      result: { content: [], structured_content: { hits: 3 } },
      status: 'completed',
    }
    const activity = mapMcpToolCall(item)
    expect(activity.call).toEqual({
      callId: 'mcp-1',
      name: 'docs/search',
      arguments: '{"q":"cordis"}',
    })
    expect(activity.result.content[0]).toMatchObject({
      content: [{ type: 'text', text: '{"hits":3}' }],
      isError: false,
    })
  })

  it('falls back to the content payload when no structured content exists', () => {
    const item: McpToolCallItem = {
      id: 'mcp-2',
      type: 'mcp_tool_call',
      server: 'docs',
      tool: 'fetch',
      arguments: {},
      result: { content: [{ type: 'text', text: 'page' }], structured_content: undefined },
      status: 'completed',
    }
    const activity = mapMcpToolCall(item)
    expect(activity.result.content[0]).toMatchObject({ isError: false })
  })

  it('falls back to null when the call has no result payload', () => {
    const item: McpToolCallItem = {
      id: 'mcp-3',
      type: 'mcp_tool_call',
      server: 'docs',
      tool: 'ping',
      arguments: {},
      status: 'completed',
    }
    const activity = mapMcpToolCall(item)
    expect(activity.result.content[0]).toMatchObject({
      content: [{ type: 'text', text: 'null' }],
    })
  })

  it('carries the error message on a failed call', () => {
    const item: McpToolCallItem = {
      id: 'mcp-4',
      type: 'mcp_tool_call',
      server: 'docs',
      tool: 'search',
      arguments: {},
      error: { message: 'server exploded' },
      status: 'failed',
    }
    const activity = mapMcpToolCall(item)
    expect(activity.result.content[0]).toMatchObject({
      content: [{ type: 'text', text: 'server exploded' }],
      isError: true,
    })
  })

  it('flags an error payload even without a failed status', () => {
    const item: McpToolCallItem = {
      id: 'mcp-5',
      type: 'mcp_tool_call',
      server: 'docs',
      tool: 'search',
      arguments: {},
      error: { message: 'soft failure' },
      status: 'completed',
    }
    expect(mapMcpToolCall(item).result.content[0]).toMatchObject({ isError: true })
  })
})

describe('mapUsage', () => {
  it('translates the disjoint Codex counters into the dsh usage shape', () => {
    const usage: Usage = {
      input_tokens: 12,
      cached_input_tokens: 5,
      cache_write_input_tokens: 2,
      output_tokens: 7,
      reasoning_output_tokens: 3,
    }
    expect(mapUsage(usage)).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    })
  })
})
