/**
 * Remaining SDK-era constants kept for the loop config schema. The driver no
 * longer uses the `@openai/codex-sdk` query path — it speaks JSON-RPC to the
 * `codex app-server` child process directly — but `disposeGraceMs` remains a
 * deployment knob for symmetry with the Claude Code driver.
 *
 * @module @kuun993/dsh-loop-engine/engine-codex/sdk
 */

/** Grace in milliseconds kept for config symmetry with the Claude Code driver. */
export const DEFAULT_DISPOSE_GRACE_MS = 3000
