/**
 * Managed-block editing for a profile's `cordis.patch.yml`.
 *
 * The plugin owns one contiguous block inside the user's patch file, delimited
 * by a begin/end marker pair, and rewrites only that span — everything else the
 * user wrote (other patches, their comments) survives byte for byte. The block
 * is what hands the process-wide AgentFactory slot to this plugin's router: it
 * disables the base bundle's `agent-loop` row, because the harness admits
 * exactly one AgentFactory and the router (which extends the harness loop, and
 * therefore serves `in-process` sessions too) registers itself as that one.
 *
 *   # -- dsh-loop-engine managed block --
 *   - id: agent-loop
 *     disabled: true
 *   - id: command-goal
 *     disabled: true
 *   # -- /dsh-loop-engine managed block --
 *
 * The block names no engine. Which engine a session runs is a PER-SESSION
 * decision carried by its agent preset, so it cannot live in a process-wide
 * configuration file; the block's only job is to free the slot for the router.
 * The `command-goal` row goes down with the loop: it is the host-plane copy of
 * dsh's goal command, and a goal service nothing drives has no business being
 * mounted for a profile whose loop is decided per session. The remaining
 * dsh-native commands (`/export`, `/feedback`, `/permission`) are
 * engine-agnostic session and settings controls that keep working under every
 * engine. Per-session command surfaces are the preset's business — a hosted
 * session joins an engine preset that strips `command-goal` itself, which is the
 * only place that reaches the preset-layer registration.
 *
 * Blocks written before the plugin routed per session carried the single
 * engine's id in the begin marker (`# -- dsh-loop-engine managed block:
 * claude-code --`). {@link legacyBlockEngineOf} reads that form so an upgrade
 * can carry the pinned engine into the settings seed before the block is
 * rewritten to the engine-agnostic form; a legacy block is otherwise treated as
 * a present block by {@link hasManagedBlock}.
 *
 * All functions here are pure string transforms — file I/O and durability live
 * in the plugin's apply.
 *
 * @module dsh-loop-engine/patch-manager
 */

import type { LoopEngineId } from './settings.ts'
import { LOOP_ENGINE_IDS } from './settings.ts'

/** Begin marker of the plugin-managed span inside a profile patch file. */
export const MANAGED_BLOCK_BEGIN = '# -- dsh-loop-engine managed block --'

/**
 * Begin-marker prefix of the pre-routing block form, which named the one engine
 * the profile was pinned to.
 */
export const LEGACY_MANAGED_BLOCK_BEGIN = '# -- dsh-loop-engine managed block: '

/** End marker of the plugin-managed span inside a profile patch file. */
export const MANAGED_BLOCK_END = '# -- /dsh-loop-engine managed block --'

/** The block's trailing newline convention (one blank line before the end marker). */
const END_MARKER_LINE = `${MANAGED_BLOCK_END}\n`

/** The loader patch that frees the single AgentFactory slot for the router. */
export function renderManagedBlock(): string {
  return [
    MANAGED_BLOCK_BEGIN,
    '- id: agent-loop',
    '  disabled: true',
    '- id: command-goal',
    '  disabled: true',
    END_MARKER_LINE,
  ].join('\n')
}

/**
 * Whether a patch-file text contains the LEGACY managed block span, which
 * named the single engine the profile used to be pinned to.
 */
export function hasLegacyManagedBlock(text: string): boolean {
  return text.includes(LEGACY_MANAGED_BLOCK_BEGIN)
}

/**
 * Whether a patch-file text contains the managed block span, in either the
 * current or the legacy form.
 */
export function hasManagedBlock(text: string): boolean {
  return text.includes('# -- dsh-loop-engine managed block')
}

/** Legacy begin-marker line pattern carrying the engine name. */
const LEGACY_BEGIN_MARKER_RE = /^# -- dsh-loop-engine managed block: (\S+) --$/m

/**
 * The engine a LEGACY managed block pinned the profile to, when the block has
 * that form and names an engine this build knows. `undefined` covers the
 * current engine-agnostic block, no block at all, and a legacy block naming an
 * engine this build does not recognize.
 */
export function legacyBlockEngineOf(text: string): LoopEngineId | undefined {
  const engine = LEGACY_BEGIN_MARKER_RE.exec(text)?.[1]
  return (LOOP_ENGINE_IDS as readonly string[]).includes(engine ?? '')
    ? engine as LoopEngineId
    : undefined
}

/** Split a patch-file text at the managed span; absent span means it appends. */
function managedSpan(
  text: string,
): { head: string; tail: string; present: boolean; blankBefore: boolean } {
  const begin = text.indexOf('# -- dsh-loop-engine managed block')
  if (begin === -1) return { head: text, tail: '', present: false, blankBefore: false }
  const afterBegin = begin + LEGACY_MANAGED_BLOCK_BEGIN.length
  // The end marker is what actually closes the span; a legacy begin marker is
  // just a longer first line.
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

/** Normalize a file so a managed span sits on its own lines with a blank separator. */
export function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * The profile seed template (`cordis.patch.yml` on a fresh profile) is a lone
 * root-level empty flow sequence `[]`. The plugin's managed block is itself a
 * root-level block sequence of loader entries, so a block coexisting with a
 * surviving `[]` is TWO root collections in one document — YAML the harness
 * rejects with "end of the stream or a document separator is expected", and the
 * web app then fails to boot. Remove a whole-line root `[]` placeholder so the
 * managed block is the sole top-level collection. Anchored to column 0 so an
 * indented `[]` that is a real value inside an entry's nested config is never
 * touched.
 *
 * Shared with the preset-rows region (`./preset.ts`): both regions are
 * root-level collections appended to the same file, so either one can be the
 * first thing that meets a surviving seed.
 * @param text - the patch-file text.
 * @returns the text without a whole-line root `[]` placeholder.
 */
export function dropSeedPlaceholder(text: string): string {
  // Drop only the `[]` line itself; a following blank separator (the one the
  // file's base and the managed block already share) is preserved.
  return text.replace(/^\[\]\n/m, '')
}

/**
 * Produce the next patch-file text carrying the managed block, preserving every
 * byte outside the managed span. Appends the span when absent and replaces it
 * when present — including a legacy span, which is rewritten to the current
 * form. The managed block is a root-level collection, so a leftover seed `[]`
 * is dropped with it, leaving the file a single valid top-level array the
 * harness can boot: the block's own `- id: agent-loop` is a column-0 entry, so
 * a file carrying it never needs a re-seed.
 * @param text - current patch-file text.
 * @returns the rewritten patch-file text.
 */
export function applyManagedBlock(text: string): string {
  const block = renderManagedBlock()
  const span = managedSpan(text)
  if (!span.present) {
    // A missing or empty layer gains the block alone, with no leading filler.
    if (text === '') return block
    return dropSeedPlaceholder(`${ensureTrailingNewline(text)}\n${block}`)
  }
  return dropSeedPlaceholder(`${span.head}${span.blankBefore ? '\n' : ''}${block}${span.tail}`)
}
