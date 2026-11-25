/**
 * Raise an `LlmError` carrying a code the harness does not know.
 *
 * The four drivers and the hosted route adapter report engine-specific failures
 * (`PI_NO_RESULT`, `CODEX_ERROR`, `HOSTED_ENGINE_ROUTE`, …). Those are the
 * plugin's own vocabulary and deliberately not the harness's: an engine failure
 * is not one of dsh's provider-neutral failure classes, and pretending otherwise
 * would let a retry policy treat it as one.
 *
 * The 0.2.2 line closed the constructor's `code` parameter to
 * `BuiltinLlmFailureCode` and moved every other code onto
 * `LlmError.fromFailure` (`docs/upgrade-guide/v0.2.2-alpha.2/llm-error-builtin-codes`).
 * Runtime behaviour is unchanged either way — the constructor still accepts any
 * non-empty string — so this module picks the factory when the build has it and
 * falls back to the constructor on the older lines, where `fromFailure` does not
 * exist at all. Neither branch is version-parsed; the probe is the presence of
 * the static method.
 *
 * @module dsh-loop-engine/driver-core/llm-failure
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** Whether this harness build carries the failure-carrying factory, added on the 0.2.2 line. */
const HAS_FAILURE_FACTORY = typeof (LlmError as unknown as { fromFailure?: unknown }).fromFailure === 'function'

/** One serializable llm failure as the 0.2.2 factory takes it (only the fields this plugin sets). */
interface FailureFacts {
  readonly message: string
  readonly code: string
}

/** The factory view of the static entry point, which the installed type declares. */
interface FailureFactory {
  fromFailure(failure: FailureFacts, options?: ErrorOptions): LlmError
}

/** The constructor view of the older lines, whose `code` parameter was `string`. */
type OpenCodeConstructor = new (message: string, code: string, options?: ErrorOptions) => LlmError

/**
 * Build the error for an engine-specific failure code.
 * @param message - human-readable failure summary.
 * @param code - the plugin's own stable machine code.
 * @param options - optional cause.
 * @returns an `LlmError` whose `failure.code` is exactly `code`.
 */
export function llmFailure(message: string, code: string, options?: ErrorOptions): LlmError {
  /* v8 ignore start -- only one arm of this constant probe can be taken on a given harness line: the coverage line has `fromFailure`, and vitest.config.compat015.ts / compat017.ts / compat020.ts / compat021.ts take the constructor arm */
  if (HAS_FAILURE_FACTORY) return (LlmError as unknown as FailureFactory).fromFailure({ message, code }, options)
  return new (LlmError as unknown as OpenCodeConstructor)(message, code, options)
  /* v8 ignore stop */
}
