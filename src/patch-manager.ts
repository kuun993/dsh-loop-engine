/**
 * Managed-block editing for a profile's `cordis.patch.yml`.
 *
 * The plugin owns one contiguous block inside the user's patch file, delimited
 * by a begin/end marker pair, and rewrites only that span on engine switches
 * — everything else the user wrote (other patches, their comments) survives
 * byte for byte. The block's content is the loader patch that takes the loop
 * engine over: it disables the base bundle's `agent-loop` row so this plugin's
 * factory (hosted by dsh-loop-engine) can register without colliding, because
 * the harness admits exactly one AgentFactory:
 *
 *   # -- dsh-loop-engine managed block: claude-code --
 *   - id: agent-loop
 *     disabled: true
 *   # -- /dsh-loop-engine managed block --
 *
 * `in-process` renders an absent block (the base bundle's `agent-loop` row
 * stays active and supplies the factory), so switching back removes the span
 * entirely. Engine ids other than `in-process` render the same disable block
 * — the specific engine (claude-code, codex) is chosen by the stored
 * setting, and the block only records that a non-default engine owns the
 * factory. All functions here are pure string transforms — file I/O and
 * durability live in the plugin's apply.
 *
 * @module @deepseek-ai/dsh-loop-engine/patch-manager
 */

import type { LoopEngineId } from './settings.ts'
import { LOOP_ENGINE_IDS } from './settings.ts'

/** Begin marker of the plugin-managed span inside a profile patch file. */
export const MANAGED_BLOCK_BEGIN = '# -- dsh-loop-engine managed block: '

/** End marker of the plugin-managed span inside a profile patch file. */
export const MANAGED_BLOCK_END = '# -- /dsh-loop-engine managed block --'

/** The block's trailing newline convention (one blank line before the end marker). */
const END_MARKER_LINE = `${MANAGED_BLOCK_END}\n`

/** Render the managed block for one engine; `in-process` returns the empty span. */
export function renderManagedBlock(engine: LoopEngineId): string {
  if (engine === 'in-process') return ''
  return [
    `${MANAGED_BLOCK_BEGIN}${engine} --`,
    '- id: agent-loop',
    '  disabled: true',
    END_MARKER_LINE,
  ].join('\n')
}

/** Whether a patch-file text contains the managed block span. */
export function hasManagedBlock(text: string): boolean {
  return text.includes(MANAGED_BLOCK_BEGIN)
}

/** Begin-marker line pattern carrying the engine name (`<name>` is the engine id). */
const BEGIN_MARKER_RE = /^# -- dsh-loop-engine managed block: (\S+) --$/m

/** Derive the current engine from a patch-file text by the managed block's begin marker. */
export function currentEngineOf(text: string): LoopEngineId {
  const engine = BEGIN_MARKER_RE.exec(text)?.[1]
  return (LOOP_ENGINE_IDS as readonly string[]).includes(engine ?? '')
    ? engine as LoopEngineId
    : 'in-process'
}

/** Split a patch-file text at the managed span; absent span means it appends. */
function managedSpan(
  text: string,
): { head: string; tail: string; present: boolean; blankBefore: boolean } {
  const begin = text.indexOf(MANAGED_BLOCK_BEGIN)
  if (begin === -1) return { head: text, tail: '', present: false, blankBefore: false }
  const afterBegin = begin + MANAGED_BLOCK_BEGIN.length
  const endAt = text.indexOf(MANAGED_BLOCK_END, afterBegin)
  const spanEnd = endAt === -1 ? text.length : endAt + END_MARKER_LINE.length
  // The plugin writes one blank line before its begin marker; preserve it when
  // removing the span so the file does not accumulate blank lines.
  const before = text.slice(0, begin)
  const blankBefore = before.endsWith('\n\n')
  return {
    head: blankBefore ? before.slice(0, -1) : before,
    tail: text.slice(spanEnd),
    present: true,
    blankBefore,
  }
}

/** Normalize a file so the managed span sits on its own lines with a blank separator. */
function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Produce the next patch-file text for a target engine, preserving every byte
 * outside the managed span. Appends the span when absent; replaces or removes
 * it when present.
 * @param text - current patch-file text.
 * @param engine - target engine.
 * @returns the rewritten patch-file text.
 */
export function applyManagedBlock(text: string, engine: LoopEngineId): string {
  const block = renderManagedBlock(engine)
  const span = managedSpan(text)
  if (!span.present) {
    if (block === '') return text
    const base = ensureTrailingNewline(text)
    return `${base}\n${block}`
  }
  if (block === '') {
    // Collapse the blank separator that preceded the removed span so repeated
    // switches do not accumulate blank lines; the head already shed one blank
    // in managedSpan, and the tail's leading blank is the span's own newline.
    return span.tail.startsWith('\n') ? `${span.head}${span.tail.slice(1)}` : `${span.head}${span.tail}`
  }
  return `${span.head}${span.blankBefore ? '\n' : ''}${block}${span.tail}`
}