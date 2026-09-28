/**
 * Closing one step of a hosted driver's transcript.
 *
 * A step may not end while a call it announced has no result (v4:
 * `step/end leaves unresolved tool call …`), and an engine can leave one
 * unanswered for reasons no driver controls — it announced several calls in one
 * model turn and reported fewer outcomes, or the query ended mid-flight, or the
 * step is aborting. The harness closes an interrupted turn the same way and with
 * the same vocabulary (`openTurnClosers` in `@deepseek-ai/dsh-session/repair`):
 * a synthetic ERROR result states the fact to the model, so the transcript stays
 * valid and the next model turn knows the call's outcome is unknown rather than
 * silently believing it succeeded.
 *
 * It is deliberately a closer, not a repair of history: it fixes the step being
 * closed and nothing else.
 *
 * @module dsh-loop-engine/driver-core/step-close
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StepTools } from './step-tools.ts'

/**
 * What the model is told about a call whose outcome never arrived. Mirrors the
 * wording the harness uses for the same fact, so a hosted session and an
 * in-process one describe it the same way.
 */
const UNANSWERED_TOOL_TEXT = 'The engine ended this step without reporting a result for this tool call. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'

/**
 * End one step, closing every call it announced and never resolved.
 *
 * Synthetic results are appended BEFORE `step/end`, in announcement order, each
 * citing nothing but its own call id — the driver has no `tool/call` event to
 * cite because the call was announced by the assistant message that carried it.
 * @param session - the session whose transcript is being written.
 * @param tools - the step's call bookkeeping.
 * @param turn - the turn the step belongs to.
 * @param step - the step being closed.
 */
export function closeStep(session: Session, tools: StepTools, turn: number, step: number): void {
  for (const callId of tools.pending) {
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: UNANSWERED_TOOL_TEXT }],
        isError: true,
      }),
      error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step })
}

/**
 * Write one call's result, unless this step already has one for it.
 *
 * Every driver learns about a result from its engine's stream, and an engine can
 * report the same outcome twice (the Claude Agent SDK redelivers each result
 * ~57 ms later; Pi reports an execution from both `tool_execution_end` and its
 * closing `turn_end`). v4 deletes a call's pending entry on its first result, so
 * the second write is what it refuses (`tool/result … has no advertised tool
 * lifecycle`) — the write goes through {@link StepTools.settle} instead, and the
 * caller supplies only the durable write it would otherwise have made.
 * @param tools - the step's call bookkeeping.
 * @param callId - the call the result answers.
 * @param write - the durable write, run at most once per call per step.
 */
export function settleResult(tools: StepTools, callId: ToolCallId, write: () => void): void {
  if (!tools.settle(callId)) return
  write()
}
