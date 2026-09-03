/**
 * Hosted-engine agent preset: a managed copy of the deployment's `standard`
 * preset with the dsh-native command and skill rows stripped.
 *
 * A hosted engine (Claude Code, Codex, Pi, Kimi) owns its session's command
 * and skill surface: the engine's own slash commands and skill providers are
 * registered globally by the plugin, and the dsh-native equivalents would only
 * duplicate or mislead — dsh `/plan` is advisory prompt text an external
 * engine never assembles, dsh `/compact` cannot shrink a context the engine's
 * child process holds, and dsh skills would sit next to the engine's own
 * catalog. Those rows live inside the agent-preset composition, which a
 * profile patch cannot reach, so the plugin authors a stripped preset into the
 * user preset root (`$DSH_HOME/.agent-presets/<id>`) and steers the roster's
 * default at runtime (see the plugin's apply).
 *
 * The preset is REGENERATED from the current `standard` composition on every
 * boot that needs it: text on disk is never authoritative, so a harness
 * upgrade that changes `standard` flows through. The file is plain YAML the
 * loader already accepts — the strip is a line transform that preserves
 * everything it does not drop byte for byte, comments included.
 *
 * @module dsh-loop-engine/preset
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/** Preset id the plugin authors into the user preset root. */
export const HOSTED_PRESET_ID = 'loop-engine'

/** Harness-home-relative directory of locally authored presets (mirrors `USER_PRESET_DIR` in `dsh-agent-presets`). */
export const USER_PRESET_DIR = '.agent-presets'

/** The composition file that makes a directory a preset. */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/** The display-metadata file beside a preset's composition. */
export const METADATA_FILE = 'preset.yml'

/** Source preset the hosted preset derives from. */
export const SOURCE_PRESET_ID = 'standard'

/**
 * Top-level rows stripped from the source preset for hosted engines:
 * - `skill-filesystem` / `tool-skill`: the dsh skill surface — each engine
 *   registers its own skill provider globally;
 * - `tool-goal`: the model-facing goal tool — the managed block already
 *   disables dsh's `/goal` command for hosted engines;
 * - `planning`: dsh plan mode — its only model-visible effect is a system
 *   prompt section an external engine never assembles;
 * - `compaction`: dsh `/compact` and auto-compaction — a hosted engine owns
 *   its context and its own `/compact` (Claude, Kimi).
 */
export const STRIPPED_ROWS = ['skill-filesystem', 'tool-skill', 'tool-goal', 'planning', 'compaction'] as const

/** Header comment marking the managed composition; also makes rewrites idempotent. */
const MANAGED_HEADER = `# Managed by dsh-loop-engine: the deployment's "${SOURCE_PRESET_ID}" preset minus
# the dsh-native command/skill rows a hosted loop engine replaces. Regenerated
# from "${SOURCE_PRESET_ID}" on boot — hand edits are overwritten.
`

/** Display metadata of the managed preset, rendered as the `preset.yml` document. */
const MANAGED_METADATA = 'name: Hosted Engine\ndescription: Standard preset minus the dsh-native commands and skills a hosted loop engine replaces.\n'

/** A top-level entry opener (`- …` at column 0). */
function isEntryStart(line: string): boolean {
  return line.startsWith('- ')
}

/** The id of the entry one opener line starts, or undefined for an idless row. */
function entryId(line: string): string | undefined {
  return /^- id:\s*(\S+)\s*$/.exec(line)?.[1]
}

/**
 * Remove top-level entries by id from a preset composition, preserving every
 * other byte. Each entry owns the comment/blank run directly above its opener
 * — that run is the entry's section heading and drops with it — except the
 * run above the FIRST entry, which is the file header and stays. Entries
 * without an `id` opener are always kept: the transform touches only what it
 * can name.
 * @param text - the source composition.
 * @param ids - top-level row ids to strip.
 * @returns the stripped composition.
 */
export function stripPresetRows(text: string, ids: readonly string[] = STRIPPED_ROWS): string {
  const lines = text.split('\n')
  const starts: number[] = []
  for (const [index, line] of lines.entries()) {
    if (isEntryStart(line)) starts.push(index)
  }
  if (starts.length === 0) return text
  const drop = new Set(ids)

  // Split each entry's span into its body and the trailing blank/comment run;
  // the run heads the NEXT entry (or is end-of-file filler after the last).
  interface Entry {
    id: string | undefined
    heading: string[]
    body: string[]
  }
  const entries: Entry[] = []
  let heading = lines.slice(0, starts[0]!)
  for (const [index, start] of starts.entries()) {
    const end = index + 1 < starts.length ? starts[index + 1]! : lines.length
    const span = lines.slice(start, end)
    let bodyEnd = span.length
    while (bodyEnd > 1) {
      const line = span[bodyEnd - 1]!
      if (line.trim() !== '' && !line.trimStart().startsWith('#')) break
      bodyEnd -= 1
    }
    entries.push({ id: entryId(span[0]!), heading, body: span.slice(0, bodyEnd) })
    heading = span.slice(bodyEnd)
  }

  const out: string[] = []
  // The file header (the first entry's "heading") is never a section heading.
  out.push(...entries[0]!.heading)
  let lastKept = -1
  for (const [index, entry] of entries.entries()) {
    if (entry.id !== undefined && drop.has(entry.id)) continue
    if (index > 0) out.push(...entry.heading)
    out.push(...entry.body)
    lastKept = index
  }
  // End-of-file filler (the final newline) survives only with the last entry.
  if (lastKept === entries.length - 1) out.push(...heading)
  // A strip that removed the tail keeps the file's trailing-newline shape.
  if (out.length > 0 && out[out.length - 1] !== '') out.push('')
  return out.join('\n')
}

/** Write `text` to `path` atomically (same-directory temp + rename) when it differs. */
async function writeIfDifferent(path: string, text: string): Promise<boolean> {
  try {
    if ((await readFile(path, 'utf8')) === text) return false
  } catch {
    // Absent or unreadable — fall through to the write.
  }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
  return true
}

/** Minimal read seam over the host's preset roster (`AgentPresets.read`). */
export interface PresetCompositionSource {
  /** Read one preset's composition text; throws when the id is unknown. */
  read(id: string): Promise<string>
}

/**
 * Regenerate the hosted-engine preset under the dsh home's user preset root
 * from the roster's `standard` preset. Idempotent: an up-to-date directory is
 * untouched, so no standing mount sees a spurious file-stamp change.
 * @param dshHome - the resolved harness home.
 * @param source - the roster's composition reader.
 * @returns whether any file was written.
 * @throws when the source preset cannot be read or the writes fail.
 */
export async function ensureHostedPreset(dshHome: string, source: PresetCompositionSource): Promise<boolean> {
  const composition = await source.read(SOURCE_PRESET_ID)
  const stripped = `${MANAGED_HEADER}\n${stripPresetRows(composition)}`
  const dir = join(dshHome, USER_PRESET_DIR, HOSTED_PRESET_ID)
  const compositionChanged = await writeIfDifferent(join(dir, COMPOSITION_FILE), stripped)
  const metadataChanged = await writeIfDifferent(join(dir, METADATA_FILE), MANAGED_METADATA)
  return compositionChanged || metadataChanged
}
