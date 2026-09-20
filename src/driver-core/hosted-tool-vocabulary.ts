/**
 * Projection of a hosted engine's tool vocabulary onto dsh's, plus the plan
 * snapshot a hosted plan tool carries.
 *
 * The durable `tool/call` event is what the Web client's tool rows
 * (`@deepseek-ai/dsh-client-ui-chat`'s tool Definition), the produced-files row
 * and inline file links (`@deepseek-ai/dsh-client-ui-deliverables`'
 * `mutationPath`), and the trajectory view read. Those consumers recognize only
 * dsh's own tool names and argument shapes, while a hosted engine names its
 * tools differently: Claude's `Write`/`Edit`/`Read`/`Bash`, Codex's
 * `apply_patch`/`command_execution`, Kimi's title-cased `Bash`, Pi's
 * `path`-keyed arguments. This module normalizes the event a driver appends
 * while leaving the durable assistant message — and therefore the next step's
 * serialized prompt — in the engine's own vocabulary. Session pairing is by
 * callId, so the two spellings coexist.
 *
 * Only lossless projections are applied. A call whose arguments do not carry
 * the dsh fields is passed through unchanged and simply renders as a generic
 * row, so a new engine-side tool degrades instead of mis-rendering.
 *
 * Plan extraction is separate: dsh's todo panel is driven by the `todo/write`
 * session event, not by the tool row, so a driver appends that event for the
 * plan tool it recognizes.
 *
 * @module dsh-loop-engine/driver-core/hosted-tool-vocabulary
 */

/** A hosted loop engine id — the settings engine union without `in-process`. */
export type HostedEngineId = 'claude-code' | 'codex' | 'pi' | 'kimi'

/** One tool call projected into dsh's vocabulary for the durable `tool/call` event. */
export interface NormalizedHostedToolCall {
  /** dsh tool name when the projection recognizes the call, else the engine's own spelling. */
  readonly name: string
  /** dsh-shaped arguments JSON when the projection rewrites them, else the engine's own string. */
  readonly arguments: string
}

/** One plan entry in the shape the `todo/write` event and the todo panel consume. */
export interface HostedPlanTodo {
  /** The task line, verbatim. */
  readonly content: string
  /** Lifecycle state, restricted to dsh's three-state union. */
  readonly status: 'pending' | 'in_progress' | 'completed'
}

// The `todo/write` event's one home is `@deepseek-ai/dsh-tool-todo/types`, which
// is not one of this plugin's peers (the plugin appends the event but never
// imports the package). Mirroring the single-event shape here types the append
// without taking a dependency; a profile always composes the real package, and
// the two identical declarations merge into one interface.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'todo/write': { todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  }
}

/**
 * One engine's projection: a rename table plus optional argument reshaping and
 * plan extraction. Renames are keyed by the engine's own tool name; a name
 * absent from the table keeps its spelling and can still be reshaped when
 * `reshape` recognizes it.
 */
interface HostedToolVocabulary {
  /** Engine tool name to dsh tool name. */
  readonly names: Readonly<Record<string, string>>
  /**
   * Rewrite an engine call's arguments into the dsh shape, when the engine's
   * own fields carry the same facts. Returning `undefined` keeps the original
   * arguments (the call renders generically instead of mis-rendering).
   * @param engineName - the engine's own tool name.
   * @param args - the parsed arguments object.
   * @returns the dsh-shaped arguments, or `undefined` to keep the original.
   */
  readonly reshape?: (engineName: string, args: Readonly<Record<string, unknown>>) => Record<string, unknown> | undefined
  /**
   * Extract the whole todo list a plan tool carries, in dsh's item shape.
   * @param engineName - the engine's own tool name.
   * @param args - the parsed arguments object.
   * @returns the plan entries, or `undefined` when the call is not a plan write.
   */
  readonly plan?: (engineName: string, args: Readonly<Record<string, unknown>>) => readonly HostedPlanTodo[] | undefined
}

/** dsh's three todo statuses, used to reject an engine's unknown status value. */
const TODO_STATUSES = new Set<HostedPlanTodo['status']>(['pending', 'in_progress', 'completed'])

/** Parse arguments JSON to a plain object; malformed JSON is not a projection input. */
function recordOf(argumentsJson: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson) as unknown
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

/** A non-empty string field reader that never widens to the string `"undefined"`. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Claude Code's file and shell tools already carry dsh's exact argument fields
 * (`file_path`/`content`, `file_path`/`old_string`/`new_string`), so only the
 * spelling is projected. `TodoWrite` maps to dsh's `todo_write` plan tool.
 */
const CLAUDE_NAMES: Readonly<Record<string, string>> = {
  Write: 'write',
  Edit: 'edit',
  Read: 'read',
  Bash: 'bash',
  TodoWrite: 'todo_write',
}

/**
 * Kimi's ACP tool calls carry human-readable titles as their name, so the map
 * covers the title spellings it emits for the dsh-recognized tools.
 */
const KIMI_NAMES: Readonly<Record<string, string>> = {
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
}

/**
 * Codex app-server items are already lower_snake internal names; the shell one
 * projects onto dsh's `bash`. `apply_patch` carries a multi-file patch with no
 * dsh single-file equivalent and deliberately keeps its own name.
 */
const CODEX_NAMES: Readonly<Record<string, string>> = {
  command_execution: 'bash',
}

/** A copy of `args` without its `path` key, for a projection that renames it. */
function withoutPath(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...args }
  delete rest.path
  return rest
}

/**
 * Pi's tools are already dsh-spelled (`read`/`write`/`edit`/`bash`) but key
 * their path as `path` and batch edits as `edits[]`. A single-entry edit is
 * losslessly projected onto dsh's `edit`; a multi-entry one is left alone
 * because dsh's `edit` takes one replacement per call. Unknown fields survive
 * the rename so a read's `offset`/`limit` still reach the row summary.
 * @param engineName - Pi's tool name.
 * @param args - the parsed arguments object.
 * @returns dsh-shaped arguments, or `undefined` to keep Pi's own.
 */
function piReshape(engineName: string, args: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const path = stringField(args.path)
  if (path === undefined) return undefined
  if (engineName === 'write') {
    const content = stringField(args.content)
    return content === undefined ? undefined : { file_path: path, ...withoutPath(args), content }
  }
  if (engineName === 'read') return { file_path: path, ...withoutPath(args) }
  if (engineName !== 'edit') return undefined
  const edits = args.edits
  if (!Array.isArray(edits) || edits.length !== 1) return undefined
  const edit = edits[0]
  if (typeof edit !== 'object' || edit === null) return undefined
  const oldText = stringField((edit as Record<string, unknown>).oldText)
  const newText = stringField((edit as Record<string, unknown>).newText)
  return oldText === undefined || newText === undefined
    ? undefined
    : { file_path: path, old_string: oldText, new_string: newText }
}

/**
 * Extract Claude Code's `TodoWrite` whole list. Unknown statuses and malformed
 * entries are dropped rather than throwing: a plan the UI cannot render must
 * never fail the turn.
 * @param engineName - Claude's tool name.
 * @param args - the parsed arguments object.
 * @returns the plan entries (possibly empty), or `undefined` when not a plan write.
 */
function claudePlan(engineName: string, args: Readonly<Record<string, unknown>>): readonly HostedPlanTodo[] | undefined {
  if (engineName !== 'TodoWrite') return undefined
  const todos = args.todos
  if (!Array.isArray(todos)) return undefined
  const entries: HostedPlanTodo[] = []
  for (const entry of todos) {
    if (typeof entry !== 'object' || entry === null) continue
    const content = stringField((entry as Record<string, unknown>).content)
    const status = (entry as Record<string, unknown>).status
    if (content === undefined || typeof status !== 'string' || !TODO_STATUSES.has(status as HostedPlanTodo['status'])) continue
    entries.push({ content, status: status as HostedPlanTodo['status'] })
  }
  return entries
}

/** Per-engine projection table; an engine absent here passes every call through. */
const VOCABULARIES: Readonly<Record<HostedEngineId, HostedToolVocabulary>> = {
  'claude-code': { names: CLAUDE_NAMES, plan: claudePlan },
  codex: { names: CODEX_NAMES },
  pi: { names: {}, reshape: piReshape },
  kimi: { names: KIMI_NAMES },
}

/**
 * Project one hosted tool call onto dsh's `tool/call` vocabulary. The engine's
 * own assistant-message block is untouched; only the event this returns is
 * normalized, so the next step's serialized prompt keeps the engine's spelling.
 * @param engine - the hosted engine the call came from.
 * @param name - the engine's own tool name.
 * @param argumentsJson - the engine's arguments JSON, verbatim.
 * @returns the dsh name and (when reshaped) dsh-shaped arguments.
 */
export function normalizeHostedToolCall(
  engine: HostedEngineId,
  name: string,
  argumentsJson: string,
): NormalizedHostedToolCall {
  const vocabulary = VOCABULARIES[engine]
  const dshName = vocabulary.names[name] ?? name
  const args = recordOf(argumentsJson)
  const reshaped = args === undefined ? undefined : vocabulary.reshape?.(name, args)
  return {
    name: dshName,
    arguments: reshaped === undefined ? argumentsJson : JSON.stringify(reshaped),
  }
}

/**
 * Read the whole todo list a hosted plan tool wrote, in the shape the
 * `todo/write` session event carries.
 * @param engine - the hosted engine the call came from.
 * @param name - the engine's own tool name.
 * @param argumentsJson - the engine's arguments JSON, verbatim.
 * @returns the plan entries (possibly empty) when the call is a plan write, else `undefined`.
 */
export function planTodosOfHostedTool(
  engine: HostedEngineId,
  name: string,
  argumentsJson: string,
): readonly HostedPlanTodo[] | undefined {
  const plan = VOCABULARIES[engine].plan
  if (plan === undefined) return undefined
  const args = recordOf(argumentsJson)
  return args === undefined ? undefined : plan(name, args)
}
