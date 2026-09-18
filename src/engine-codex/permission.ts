/**
 * Mapping from the dsh session's durable permission knobs to one Codex query's
 * declarative permission stance, plus the replies to every server-initiated
 * interaction Codex can raise. Codex surfaces interactive approval as
 * server-initiated JSON-RPC requests answered through the dsh approval seam
 * (see `approvalReason` / `resolveApprovalRequest` below), while the thread
 * still starts with the `sandboxMode` + `approvalPolicy` pair chosen at
 * creation. The fold maps the session's `sandbox/mode` and `approval/policy`
 * events directly, mirroring the web surface's presets:
 *   - full access → `danger-full-access` + `never` (no native checks at all),
 *   - an `ask` policy → `workspace-write` + `on-request` (approvals are then
 *     routed to the dsh approval seam, failing closed when it is absent),
 *   - anything else fails closed → `read-only` + `never`.
 *
 * The other two interactions (`item/tool/requestUserInput` and
 * `mcpServer/elicitation/request`) have no approval to grant: one asks the human
 * a question, the other asks for MCP input. Both are mapped here so the driver
 * answers them in-vocabulary instead of failing them with a protocol error that
 * the model reads as a broken tool.
 *
 * @module dsh-loop-engine/engine-codex/permission
 */

import type { PermissionEvent } from '../driver-core/permission-knobs.ts'
import { sessionApprovalPolicy, sessionSandboxMode } from '../driver-core/permission-knobs.ts'
import type { CodexApprovalPolicy, CodexSandboxMode } from './types.ts'

/** The declarative permission stance one Codex thread runs under. */
export interface CodexPermission {
  readonly sandboxMode: CodexSandboxMode
  readonly approvalPolicy: CodexApprovalPolicy
}

/** Conservative unattended default: read-only sandbox, never ask. */
export const DEFAULT_CODEX_PERMISSION: CodexPermission = {
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
}

/**
 * One question to put to the human, in the shape the dsh user-questions seam
 * accepts. Declared inline (a structural subset) to avoid a peer dep on
 * `@deepseek-ai/dsh-user-questions`, matching the approval seam's treatment.
 */
export interface UserQuestionItem {
  /** Stable question id, echoed back by the answer and by our reply. */
  readonly id: string
  /** The question to display. */
  readonly question: string
  /** Optional short heading/group label. */
  readonly header?: string
  /** Optional choices a UI renders as a menu. */
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
}

/** The human's answer, in the shape the dsh user-questions seam returns. */
export interface UserQuestionAnswer {
  /** One entry per answered question; unanswered questions are simply absent. */
  readonly answers: readonly {
    readonly id: string
    readonly selected: readonly string[]
    /** Optional free-text answer, carried alongside `selected`. */
    readonly custom?: string
  }[]
}

/** The `item/tool/requestUserInput` result Codex expects. */
export interface CodexUserInputResponse {
  /** Answer lists keyed by question id; an empty map means "no answers given". */
  readonly answers: Record<string, { readonly answers: string[] }>
}

/**
 * Read the answerable questions of one `item/tool/requestUserInput` request. The
 * wire is untrusted, so an entry with no usable id or wording is dropped: the
 * reply is keyed by question id, and a synthesized key would answer a question
 * Codex never asked.
 * @param params - the request params.
 * @returns the questions to put to the human, possibly none.
 */
export function userInputQuestions(params: unknown): UserQuestionItem[] {
  if (typeof params !== 'object' || params === null) return []
  const raw = (params as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  const questions: UserQuestionItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const question = entry as { id?: unknown; question?: unknown; header?: unknown; options?: unknown }
    if (typeof question.id !== 'string' || question.id === '') continue
    if (typeof question.question !== 'string' || question.question === '') continue
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
        if (typeof option !== 'object' || option === null) return []
        const { label, description } = option as { label?: unknown; description?: unknown }
        if (typeof label !== 'string') return []
        return [{ label, ...typeof description === 'string' ? { description } : {} }]
      })
      : []
    questions.push({
      id: question.id,
      question: question.question,
      ...typeof question.header === 'string' && question.header !== '' ? { header: question.header } : {},
      ...options.length > 0 ? { options } : {},
    })
  }
  return questions
}

/**
 * Project one human answer onto Codex's response shape. A free-text answer rides
 * along as a further entry of the question's answer list, and no answer at all
 * (no seam, or the human dismissed it) becomes an empty map — the honest "asked,
 * answered nothing", never an invented answer.
 * @param answer - the seam's answer, or undefined when none was obtained.
 * @returns the response payload.
 */
export function userInputResponse(answer: UserQuestionAnswer | undefined): CodexUserInputResponse {
  if (answer === undefined) return { answers: {} }
  const answers: Record<string, { answers: string[] }> = {}
  for (const item of answer.answers) {
    answers[item.id] = { answers: [...item.selected, ...item.custom === undefined || item.custom === '' ? [] : [item.custom]] }
  }
  return { answers }
}

/**
 * The reply to one `mcpServer/elicitation/request`. An unattended driver cannot
 * render an elicitation form, so it declines — the same stance the Claude Code
 * driver takes for the equivalent callback, and the one answer that never
 * fabricates input the user did not give.
 * @returns the response payload.
 */
export function elicitationResponse(): { action: 'decline' } {
  return { action: 'decline' }
}

/**
 * Resolve the session's effective Codex permission stance. Full access wins
 * outright; otherwise an `ask` policy maps to the CLI's on-request approval
 * inside a workspace-write sandbox; anything else — including a session with
 * no recorded knobs — fails closed.
 * @param events - the durable session log.
 * @returns the stance one query should run under.
 */
export function resolveSessionPermission(events: readonly PermissionEvent[]): CodexPermission {
  if (sessionSandboxMode(events) === 'danger-full-access') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  if (sessionApprovalPolicy(events) === 'ask') {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
  }
  return DEFAULT_CODEX_PERMISSION
}

/** The closed outcome of one dsh approval request (mirrors the dsh-user-approval seam). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Cap in characters for the detail excerpt attached to an approval request. */
const REASON_INPUT_CAP = 200

/** Short tool identity for the dsh approval request carrying one native Codex approval. */
export function approvalToolName(method: string): string {
  switch (method) {
    case 'item/commandExecution/requestApproval': return 'command'
    case 'item/fileChange/requestApproval': return 'file-change'
    case 'item/permissions/requestApproval': return 'permissions'
    default: return method
  }
}

/** Human label for one approval method, used in the approval reason. */
function approvalKind(method: string): string {
  switch (method) {
    case 'item/commandExecution/requestApproval': return 'command execution'
    case 'item/fileChange/requestApproval': return 'file change'
    case 'item/permissions/requestApproval': return 'permission change'
    default: return method
  }
}

/** The bounded detail excerpt shown for one approval method's params. */
function approvalDetail(method: string, params: unknown): string {
  if (typeof params !== 'object' || params === null) return String(params)
  const record = params as Record<string, unknown>
  if (method === 'item/commandExecution/requestApproval' && typeof record.command === 'string') {
    return record.command
  }
  if (typeof record.reason === 'string') return record.reason
  if (method === 'item/fileChange/requestApproval' && typeof record.grantRoot === 'string') {
    return record.grantRoot
  }
  return JSON.stringify(params)
}

/** Human-readable reason for one native Codex approval request. */
export function approvalReason(method: string, params: unknown): string {
  const detail = approvalDetail(method, params)
  const bounded = detail.length > REASON_INPUT_CAP ? `${detail.slice(0, REASON_INPUT_CAP - 3)}...` : detail
  return `Codex requests permission for ${approvalKind(method)}: ${bounded}`
}

/** The native decision a command/file-change approval resolves to. */
export function approvalDecision(outcome: ApprovalOutcome): 'accept' | 'decline' {
  return outcome === 'allowed-once' ? 'accept' : 'decline'
}

/** The native permissions-request response for one approval outcome. */
export function permissionsGrant(
  outcome: ApprovalOutcome,
  requested: unknown,
): { permissions: unknown; scope: 'turn' } {
  return outcome === 'allowed-once'
    ? { permissions: requested, scope: 'turn' }
    : { permissions: {}, scope: 'turn' }
}

/** Build the JSON-RPC reply payload for one inbound Codex approval request. */
export function resolveApprovalRequest(
  method: string,
  params: unknown,
  outcome: ApprovalOutcome,
): { result: unknown } | { error: { code: number; message: string } } {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { result: { decision: approvalDecision(outcome) } }
    case 'item/fileChange/requestApproval':
      return { result: { decision: approvalDecision(outcome) } }
    case 'item/permissions/requestApproval': {
      const requested = typeof params === 'object' && params !== null
        ? (params as { permissions?: unknown }).permissions ?? {}
        : {}
      return { result: permissionsGrant(outcome, requested) }
    }
    default:
      return { error: { code: -32601, message: 'Method not found' } }
  }
}
