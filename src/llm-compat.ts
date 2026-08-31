/**
 * Cross-version shim for the one dsh-llm export that was renamed mid-line.
 *
 * `dsh-llm` renamed its tool-call brand between the two published lines:
 *
 *   - `0.1.1-rc.2` (dist-tag `latest`, what plain `dsh` installs) exports `CallId`
 *   - `0.1.2-alpha.2` (dist-tag `alpha`, the harness monorepo source) exports `ToolCallId`
 *
 * A named import of either one is a hard ESM link error against the other line
 * ("does not provide an export named ..."), which fails the whole plugin tree at
 * boot before any of our code runs. A namespace import is not checked per-member
 * at link time, so it loads under both and we can pick the survivor at runtime.
 *
 * The brand type is deliberately derived from `ToolResultMessageInput['callId']`
 * rather than hard-coded to either `Branded<'CallId'>` or `Branded<'ToolCallId'>`:
 * the two lines brand with different literals, so only the installed package's
 * own view of the type is assignable to the APIs we hand these values to.
 *
 * @module dsh-loop-engine/llm-compat
 */

import * as llm from '@deepseek-ai/dsh-llm'
import type { ToolResultMessageInput } from '@deepseek-ai/dsh-llm'

/**
 * The tool-call id brand, as the *installed* dsh-llm defines it. Aliased off a
 * consuming API so it stays correct on both the `CallId` and `ToolCallId` lines.
 */
export type CallId = ToolResultMessageInput['callId']

interface LlmBrandExports {
  readonly ToolCallId?: (id: string) => CallId
  readonly CallId?: (id: string) => CallId
}

const brand = llm as unknown as LlmBrandExports
const callIdBrand = brand.ToolCallId ?? brand.CallId

if (!callIdBrand) {
  throw new Error(
    '@deepseek-ai/dsh-llm exports neither ToolCallId nor CallId; ' +
      'this dsh-llm version is not supported by @vidge/dsh-loop-engine',
  )
}

/**
 * Brand a raw string as a tool-call id, resolving to whichever name the
 * installed dsh-llm publishes.
 */
export const CallId: (id: string) => CallId = callIdBrand
