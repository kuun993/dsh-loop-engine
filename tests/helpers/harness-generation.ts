/**
 * Test-side generation probe and the shape adapters that let one spec file pass
 * on both harness generations.
 *
 * The specs assert durable facts that the harness GENUATION changes shape on:
 * the 0.1.5 line carries a tool result on a `user`-role message whose single
 * `tool-result` block nests the content and the error flag, while the 0.1.7 line
 * makes it a first-class `tool`-role message with the blocks and the flag on the
 * message itself. {@link toolResultView} reads either shape so an assertion can
 * be written once. The probe mirrors `src/compat.ts`, which the browser half
 * cannot import; a spec may import this module freely.
 *
 * @module tests/helpers/harness-generation
 */

import * as dshSettings from '@deepseek-ai/dsh-settings'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Whether the running harness predates the profile-backed settings rewrite (the 0.1.5 line). */
export const LEGACY_HARNESS: boolean = 'SettingsProvider' in (dshSettings as object)

/** The role a durable tool-result message carries on the running generation. */
export function toolResultRole(): 'tool' | 'user' {
  return LEGACY_HARNESS ? 'user' : 'tool'
}

/** The generation-independent facts of one durable tool-result message. */
export interface ToolResultView {
  /** The message role the running generation uses for a tool result. */
  role: 'tool' | 'user'
  /** The tool call this result answers. */
  toolCallId: string | undefined
  /** Whether the invocation failed. */
  isError: boolean | undefined
  /** The result's own content blocks, unwrapped from either nesting. */
  content: readonly ContentBlock[]
}

/**
 * Read a durable tool-result message's facts regardless of generation.
 * @param message - the message (either shape) to read.
 * @returns its role, call id, error flag, and unwrapped content.
 */
export function toolResultView(message: unknown): ToolResultView {
  const m = message as {
    role?: string
    toolCallId?: string
    isError?: boolean
    content?: unknown
    source?: { callId?: string }
  }
  if (m.role !== 'user') {
    return {
      role: 'tool',
      toolCallId: m.toolCallId ?? m.source?.callId,
      isError: m.isError,
      content: (m.content ?? []) as readonly ContentBlock[],
    }
  }
  // 0.1.5: the single `tool-result` block nests the content and the error flag.
  const block = (Array.isArray(m.content) ? m.content[0] : undefined) as
    | { toolCallId?: string; isError?: boolean; content?: readonly ContentBlock[] }
    | undefined
  return {
    role: 'user',
    toolCallId: block?.toolCallId ?? m.toolCallId ?? m.source?.callId,
    isError: block?.isError,
    content: block?.content ?? [],
  }
}
