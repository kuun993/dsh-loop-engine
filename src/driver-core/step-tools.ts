/**
 * The tool calls one STEP has announced, and which of them already carry a
 * result.
 *
 * Session format v4 requires every call a step announced to be resolved before
 * that step ends (`step/end leaves unresolved tool call …`,
 * `packages/session/session-format-v3-to-v4/src/relationships.ts`). A hosted
 * driver learns about calls from the engine's stream, one assistant message at
 * a time, and learns about results from a different stream of messages — so
 * "which calls of THIS step are still open" is state the driver has to keep,
 * not something the transcript position can be trusted to imply.
 *
 * Two facts live here, and they are the two directions of the same rule:
 * `settle` keeps a call from being given a SECOND result in one step (the
 * shape v4 rejects as `tool/result … has no advertised tool lifecycle`), and
 * {@link StepTools.pending} is what a step must close before it ends.
 *
 * @module dsh-loop-engine/driver-core/step-tools
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'

/** One step's announced calls and their results. */
export interface StepTools {
  /** Record a call this step announced. */
  announce(callId: ToolCallId): void
  /**
   * Record a result this step wrote.
   * @returns `false` when that call was already settled in this step, i.e.
   *   when writing another result for it would be the duplicate v4 refuses.
   */
  settle(callId: ToolCallId): boolean
  /** Whether every call this step announced now has a result. */
  readonly balanced: boolean
  /** The calls still owed a result, in the order they were announced. */
  readonly pending: readonly ToolCallId[]
  /** Forget everything: the next step owns a new set. */
  clear(): void
}

/**
 * Build one step's call bookkeeping.
 * @returns the set, empty and ready for its step.
 */
export function createStepTools(): StepTools {
  const open = new Set<ToolCallId>()
  const settled = new Set<ToolCallId>()
  return {
    announce: (callId) => { open.add(callId) },
    settle: (callId) => {
      if (settled.has(callId)) return false
      settled.add(callId)
      open.delete(callId)
      return true
    },
    get balanced() { return open.size === 0 },
    get pending() { return [...open] },
    clear: () => { open.clear(); settled.clear() },
  }
}
