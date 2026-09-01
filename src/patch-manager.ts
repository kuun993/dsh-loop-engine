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
 * entirely. Any other engine renders the same disable block, and the begin
 * marker carries the specific engine id (`# -- dsh-loop-engine managed block:
 * claude-code --`) so `currentEngineOf` can read which non-default engine owns
 * the slot from the file alone. All functions here are pure string transforms —
 * file I/O and durability live in the plugin's apply.
 *
 * @module dsh-loop-engine/patch-manager
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
 * A root-level entry: a column-0 block-sequence item (`- id: …`) or flow array
 * (`[ … ]`). Used to decide whether a patch-file text already carries a
 * top-level collection, so the plugin never leaves a file that the harness
 * rejects (a comment- or whitespace-only file parses to `null`, and the loader
 * demands a top-level array).
 */
function hasRootEntry(text: string): boolean {
  return /^(?:- |\[)/m.test(text)
}

/**
 * The profile seed template (`cordis.patch.yml` on a fresh profile) is a lone
 * root-level empty flow sequence `[]`. The plugin's managed block is itself a
 * root-level block sequence of loader entries, so a block coexisting with a
 * surviving `[]` is TWO root collections in one document — YAML the harness
 * rejects with "end of the stream or a document separator is expected", and the
 * web app then fails to boot whenever a non-default engine is selected.
 * Remove a whole-line root `[]` placeholder so the managed block is the sole
 * top-level collection. Anchored to column 0 so an indented `[]` that is a real
 * value inside an entry's nested config is never touched.
 */
function dropSeedPlaceholder(text: string): string {
  // Drop only the `[]` line itself; a following blank separator (the one the
  // file's base and the managed block already share) is preserved.
  return text.replace(/^\[\]\n/m, '')
}

/**
 * Re-seed a patch file that a removal left with no entries at all: the harness
 * loads a top-level array, and a bare or comment-only text is `null` to it.
 * Preserve any comments and append an empty root array on its own line.
 */
function seedEmptyArray(text: string): string {
  const head = text.replace(/\n+$/, '')
  return head === '' ? '[]\n' : `${head}\n[]\n`
}

/**
 * Produce the next patch-file text for a target engine, preserving every byte
 * outside the managed span. Appends the span when absent; replaces or removes
 * it when present. The managed block is a root-level collection, so a leftover
 * seed `[]` is dropped when adding it, and a removal that leaves no entries is
 * re-seeded back to `[]` — either way the file stays a single valid top-level
 * array the harness can boot.
 * @param text - current patch-file text.
 * @param engine - target engine.
 * @returns the rewritten patch-file text.
 */
export function applyManagedBlock(text: string, engine: LoopEngineId): string {
  const block = renderManagedBlock(engine)
  const span = managedSpan(text)
  let result: string
  if (!span.present) {
    if (block === '') {
      result = text
    } else {
      const base = ensureTrailingNewline(text)
      result = `${base}\n${block}`
    }
  } else if (block === '') {
    // Collapse the blank separator that preceded the removed span so repeated
    // switches do not accumulate blank lines; the head already shed one blank
    // in managedSpan, and the tail's leading blank is the span's own newline.
    result = span.tail.startsWith('\n') ? `${span.head}${span.tail.slice(1)}` : `${span.head}${span.tail}`
  } else {
    result = `${span.head}${span.blankBefore ? '\n' : ''}${block}${span.tail}`
  }
  if (block !== '') return dropSeedPlaceholder(result)
  // An empty/whitespace input is "no layer" and stays bare; anything else —
  // a comment-only file, or a removal that left no entries — is a present file
  // the harness must still load as a top-level array, so re-seed `[]`.
  if (text.trim() === '') return result
  return hasRootEntry(result) ? result : seedEmptyArray(result)
}