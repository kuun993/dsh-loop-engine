/**
 * Unit tests for the hosted tool-vocabulary projection: the rename tables, the
 * Pi argument reshaping, the Claude plan extraction, and the pass-through that
 * keeps an unknown or malformed call degradable.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeHostedToolCall,
  planTodosOfHostedTool,
} from '../../src/driver-core/hosted-tool-vocabulary.ts'

describe('normalizeHostedToolCall', () => {
  it('renames Claude Code tools, keeping their dsh-shaped arguments verbatim', () => {
    expect(normalizeHostedToolCall('claude-code', 'Write', '{"file_path":"a.txt","content":"x"}'))
      .toEqual({ name: 'write', arguments: '{"file_path":"a.txt","content":"x"}' })
    expect(normalizeHostedToolCall('claude-code', 'Edit', '{"file_path":"a.txt","old_string":"a","new_string":"b"}'))
      .toEqual({ name: 'edit', arguments: '{"file_path":"a.txt","old_string":"a","new_string":"b"}' })
    expect(normalizeHostedToolCall('claude-code', 'Read', '{"file_path":"a.txt"}'))
      .toEqual({ name: 'read', arguments: '{"file_path":"a.txt"}' })
    expect(normalizeHostedToolCall('claude-code', 'Bash', '{"command":"ls"}'))
      .toEqual({ name: 'bash', arguments: '{"command":"ls"}' })
    expect(normalizeHostedToolCall('claude-code', 'TodoWrite', '{"todos":[]}'))
      .toEqual({ name: 'todo_write', arguments: '{"todos":[]}' })
  })

  it('passes an unrecognized Claude tool through unchanged', () => {
    expect(normalizeHostedToolCall('claude-code', 'WebSearch', '{"query":"x"}'))
      .toEqual({ name: 'WebSearch', arguments: '{"query":"x"}' })
  })

  it('maps a Codex command execution to bash and leaves a multi-file patch alone', () => {
    expect(normalizeHostedToolCall('codex', 'command_execution', '{"command":"ls"}'))
      .toEqual({ name: 'bash', arguments: '{"command":"ls"}' })
    expect(normalizeHostedToolCall('codex', 'apply_patch', '[{"path":"a.ts"}]'))
      .toEqual({ name: 'apply_patch', arguments: '[{"path":"a.ts"}]' })
    expect(normalizeHostedToolCall('codex', 'mcp_tool_call', '{}'))
      .toEqual({ name: 'mcp_tool_call', arguments: '{}' })
  })

  it("maps Kimi's title-cased tool names", () => {
    expect(normalizeHostedToolCall('kimi', 'Bash', '{"command":"ls"}'))
      .toEqual({ name: 'bash', arguments: '{"command":"ls"}' })
    expect(normalizeHostedToolCall('kimi', 'Read', '{"path":"a"}'))
      .toEqual({ name: 'read', arguments: '{"path":"a"}' })
    expect(normalizeHostedToolCall('kimi', 'Write', '{"path":"a"}'))
      .toEqual({ name: 'write', arguments: '{"path":"a"}' })
    expect(normalizeHostedToolCall('kimi', 'Edit', '{"path":"a"}'))
      .toEqual({ name: 'edit', arguments: '{"path":"a"}' })
    expect(normalizeHostedToolCall('kimi', 'Search', '{"query":"x"}'))
      .toEqual({ name: 'Search', arguments: '{"query":"x"}' })
  })

  it("reshapes Pi's path-keyed arguments while keeping its own tool names", () => {
    expect(normalizeHostedToolCall('pi', 'write', '{"path":"a.txt","content":"x"}'))
      .toEqual({ name: 'write', arguments: '{"file_path":"a.txt","content":"x"}' })
    expect(normalizeHostedToolCall('pi', 'read', '{"path":"a.txt","offset":2,"limit":3}'))
      .toEqual({ name: 'read', arguments: '{"file_path":"a.txt","offset":2,"limit":3}' })
    expect(normalizeHostedToolCall('pi', 'edit', '{"path":"a.txt","edits":[{"oldText":"a","newText":"b"}]}'))
      .toEqual({ name: 'edit', arguments: '{"file_path":"a.txt","old_string":"a","new_string":"b"}' })
  })

  it('keeps Pi arguments when the projection would lose facts', () => {
    // No path at all.
    expect(normalizeHostedToolCall('pi', 'write', '{"content":"x"}'))
      .toEqual({ name: 'write', arguments: '{"content":"x"}' })
    // A write without content.
    expect(normalizeHostedToolCall('pi', 'write', '{"path":"a"}'))
      .toEqual({ name: 'write', arguments: '{"path":"a"}' })
    // A multi-entry edit has no single dsh edit equivalent.
    expect(normalizeHostedToolCall('pi', 'edit', '{"path":"a","edits":[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]}'))
      .toEqual({ name: 'edit', arguments: '{"path":"a","edits":[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]}' })
    // A malformed edits entry.
    expect(normalizeHostedToolCall('pi', 'edit', '{"path":"a","edits":[42]}'))
      .toEqual({ name: 'edit', arguments: '{"path":"a","edits":[42]}' })
    // A single entry missing one side.
    expect(normalizeHostedToolCall('pi', 'edit', '{"path":"a","edits":[{"oldText":"a"}]}'))
      .toEqual({ name: 'edit', arguments: '{"path":"a","edits":[{"oldText":"a"}]}' })
    // A non-edit tool that carries a path but no projection.
    expect(normalizeHostedToolCall('pi', 'bash', '{"path":"a","command":"ls"}'))
      .toEqual({ name: 'bash', arguments: '{"path":"a","command":"ls"}' })
    // An empty edits array is not a single replacement.
    expect(normalizeHostedToolCall('pi', 'edit', '{"path":"a","edits":[]}'))
      .toEqual({ name: 'edit', arguments: '{"path":"a","edits":[]}' })
    // A non-string content.
    expect(normalizeHostedToolCall('pi', 'write', '{"path":"a","content":7}'))
      .toEqual({ name: 'write', arguments: '{"path":"a","content":7}' })
  })

  it('renames without parsing when the arguments are not a JSON object', () => {
    expect(normalizeHostedToolCall('claude-code', 'Write', 'not json'))
      .toEqual({ name: 'write', arguments: 'not json' })
    expect(normalizeHostedToolCall('claude-code', 'Write', '["a"]'))
      .toEqual({ name: 'write', arguments: '["a"]' })
    expect(normalizeHostedToolCall('pi', 'write', 'null'))
      .toEqual({ name: 'write', arguments: 'null' })
  })
})

describe('planTodosOfHostedTool', () => {
  it("extracts Claude Code's TodoWrite list into dsh's item shape", () => {
    const todos = planTodosOfHostedTool(
      'claude-code',
      'TodoWrite',
      '{"todos":[{"content":"a","status":"pending","activeForm":"A"},{"content":"b","status":"in_progress"}]}',
    )
    expect(todos).toEqual([{ content: 'a', status: 'pending' }, { content: 'b', status: 'in_progress' }])
  })

  it('returns an empty list for a plan tool that wrote nothing', () => {
    expect(planTodosOfHostedTool('claude-code', 'TodoWrite', '{"todos":[]}')).toEqual([])
  })

  it('drops malformed entries and unknown statuses instead of failing the turn', () => {
    const todos = planTodosOfHostedTool(
      'claude-code',
      'TodoWrite',
      '{"todos":[42,{"status":"pending"},{"content":"a","status":"done"},{"content":"b","status":"completed"}]}',
    )
    expect(todos).toEqual([{ content: 'b', status: 'completed' }])
  })

  it('is undefined when the call is not a plan write or carries no todo array', () => {
    expect(planTodosOfHostedTool('claude-code', 'Read', '{"file_path":"a"}')).toBeUndefined()
    expect(planTodosOfHostedTool('claude-code', 'TodoWrite', '{"todos":"none"}')).toBeUndefined()
    expect(planTodosOfHostedTool('claude-code', 'TodoWrite', 'nope')).toBeUndefined()
    expect(planTodosOfHostedTool('codex', 'command_execution', '{"command":"ls"}')).toBeUndefined()
    expect(planTodosOfHostedTool('pi', 'write', '{"path":"a","content":"x"}')).toBeUndefined()
    expect(planTodosOfHostedTool('kimi', 'Bash', '{"command":"ls"}')).toBeUndefined()
  })
})
