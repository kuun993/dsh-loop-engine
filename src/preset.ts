/**
 * Hosted-engine agent presets: one managed copy of the deployment's `standard`
 * preset per hosted engine, with the dsh-native command and skill rows
 * stripped.
 *
 * A hosted engine (Claude Code, Codex, Pi, Kimi) owns its session's command
 * and skill surface: the plugin bridges the engine's own slash commands and
 * skill providers into the session (see `engine-surface.ts`), and the
 * dsh-native equivalents would only duplicate or mislead — dsh `/plan` is
 * advisory prompt text an external engine never assembles, and dsh skills
 * would sit next to the engine's own catalog. Those rows live inside the
 * agent-preset composition, which a profile patch cannot otherwise reach, so
 * the plugin authors a stripped copy of that composition per engine. The
 * compaction group is deliberately NOT stripped: it is what keeps the SESSION
 * LOG bounded, and a hosted engine's own per-turn compaction cannot stand in
 * for it (see {@link STRIPPED_ROWS}).
 *
 * The copy is also where the deployment's summarization model is written
 * ({@link applySummarizerTarget}): compaction summarizes through an ordinary
 * llm call, and a hosted session's routed model is this plugin's placeholder
 * route, so without a real dsh model named at
 * `compaction-basic.config.summarizationProvider` / `summarizationModel` the
 * group can never shrink anything. A profile patch cannot reach that nested
 * row (a row's `config` is replaced whole), which leaves the composition the
 * plugin authors as the one carrier.
 *
 * WHICH mechanism carries that copy is the running harness generation's
 * business, and the two share everything but the carrier:
 *
 *  - the 0.1.5 line reads presets from a DIRECTORY per preset under the user
 *    preset root (`$DSH_HOME/.agent-presets/<id>`), so there it is two files
 *    per engine ({@link ensureEnginePresets});
 *  - the 0.1.7 line replaced that with composed plugin rows: a preset is one
 *    `@deepseek-ai/dsh-agent-preset` row whose `config.plugins` list IS the
 *    composition, declared wherever a composition is declared. Nothing reads
 *    `.agent-presets` any more, so there it is four `insert` rows in the
 *    profile patch the plugin already manages
 *    ({@link ensureEnginePresetRows}). The rows mirror the shipped shape
 *    (`packages/bundle/web-app/presets/standard.patch.yml` in the harness),
 *    with this plugin's own id, order, and stripped composition.
 *
 * Both mechanisms regenerate from the current `standard` composition on every
 * boot: text on disk is never authoritative, so a harness upgrade that changes
 * `standard` flows through. Neither re-parses YAML — the strip is a line
 * transform that preserves everything it does not drop byte for byte, comments
 * included, and the row form only re-indents that text.
 *
 * The preset id is ALSO the per-session engine selector: the harness resolves
 * one preset per session and hands its id to the agent factory at create time
 * (`CreateAgentOptions.meta.agentPreset`), which is the only per-session
 * channel that reaches agent creation. One preset per engine is therefore what
 * makes "session A on Codex, session B on Kimi, concurrently" expressible in a
 * harness that admits exactly one AgentFactory.
 *
 * @module dsh-loop-engine/preset
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { dropSeedPlaceholder, ensureTrailingNewline } from './patch-manager.ts'
import type { HostedEngineId } from './agent-preset-ids.ts'
import { HOSTED_ENGINE_IDS, SOURCE_PRESET_ID, enginePresetId } from './agent-preset-ids.ts'

// The engine↔preset-id mapping is pure identity arithmetic, so it lives in the
// zero-import `./agent-preset-ids.ts` (the browser half needs it; this file
// imports `node:fs/promises`). Re-exported here to keep the node-side import
// paths — this is the module the preset ids belong to.
export {
  HOSTED_PRESET_PREFIX, SOURCE_PRESET_ID,
  engineOfPreset, enginePresetId, hostedEngineOf, sessionEngineOf,
} from './agent-preset-ids.ts'
export type { SessionEngine } from './agent-preset-ids.ts'

/** Harness-home-relative directory of locally authored presets (mirrors `USER_PRESET_DIR` in `dsh-agent-presets`). */
export const USER_PRESET_DIR = '.agent-presets'

/** The composition file that makes a directory a preset. */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/** The display-metadata file beside a preset's composition. */
export const METADATA_FILE = 'preset.yml'

/** Every preset id this plugin owns, whether or not it is currently authored. */
export const HOSTED_PRESET_IDS: readonly string[] =
  HOSTED_ENGINE_IDS.map(engine => enginePresetId(engine))


/**
 * Top-level rows stripped from the source preset for hosted engines:
 * - `skill-filesystem` / `tool-skill`: the dsh skill surface — each engine
 *   registers its own skill provider in the session's agent scope;
 * - `tool-goal` / `command-goal`: dsh's goal mode. The model-facing tool only
 *   works while an in-process loop drives the session, and the human command
 *   would sit in the menu with nothing behind it — no hosted engine here
 *   implements `/goal`, so there is nothing for it to hand over to. The
 *   `command-goal` row lives HERE, in the preset layer, because that is where
 *   the human command is registered; disabling the host-plane row from the
 *   profile patch does not reach it (`standard` carries its own row);
 * - `planning`: dsh plan mode — its only model-visible effect is a system
 *   prompt section an external engine never assembles.
 *
 * The `compaction` group is KEPT, and must stay kept: it is what bounds the
 * SESSION LOG, which every hosted step replays in full as its engine prompt
 * (`src/driver-core/prompt.ts`). A hosted engine's own compaction cannot stand
 * in for it — the engine's context is thrown away, because the driver opens a
 * fresh engine session per step (`session/new` for Kimi, a new thread / query
 * for the others), so its shrink lasts one step while the log keeps growing and
 * each later step replays everything again. Measured on a real 33-turn Kimi
 * session: ~3.3 MB replayed per step (tool results 2.0 MB + tool-call lines
 * 1.19 MB), which the Kimi CLI auto-compacted from ~918k tokens down to ~47k at
 * the start of every turn — and discarded. Keeping this group is what lets dsh
 * write its own durable checkpoints instead. The route needs a declared
 * capacity for that to fire: see `DEFAULT_ENGINE_CONTEXT_WINDOW`
 * (`src/provider-route.ts`) and the `engineContextWindow` Config field
 * (`src/index.ts`).
 */
export const STRIPPED_ROWS = ['skill-filesystem', 'tool-skill', 'tool-goal', 'command-goal', 'planning'] as const

/** Header comment marking the managed compositions; also makes rewrites idempotent. */
const MANAGED_HEADER = `# Managed by dsh-loop-engine: the deployment's "${SOURCE_PRESET_ID}" preset minus
# the dsh-native command/skill rows a hosted loop engine replaces. Regenerated
# from "${SOURCE_PRESET_ID}" on boot — hand edits are overwritten. The preset id
# names the engine this session runs.
`

/**
 * Begin marker of the plugin-managed preset-rows region inside a profile patch
 * file. The region is what registers the hosted engines' presets on the 0.1.7
 * line, where a preset is a composed row rather than a directory.
 *
 * Deliberately NOT the managed block's marker: the two regions are located and
 * rewritten independently, so editing one never rewrites the other's bytes.
 */
export const PRESET_ROWS_BEGIN = '# -- dsh-loop-engine presets --'

/** End marker of the plugin-managed preset-rows region inside a profile patch file. */
export const PRESET_ROWS_END = '# -- /dsh-loop-engine presets --'

/**
 * Roster order of every preset this plugin authors. The shipped presets occupy
 * 1..4 (`standard` 1, `ptc` 2, `minimal` 3, `cordis` 4), and the roster sorts
 * by order and then by id, so one constant past that range puts every managed
 * preset after every shipped one — the deployment's own presets stay at the top
 * of the picker and the engines' copies trail it, which is also where the
 * order they are listed in (selection order) is readable.
 */
export const ENGINE_PRESET_ORDER = 100

/**
 * Entry id of the harness plugin whose `config` names the dsh model a hosted
 * session's compaction summarizes through
 * (`@deepseek-ai/dsh-compaction-basic`, a child of the `compaction` group).
 * See {@link applySummarizerTarget} for why the plugin writes it.
 */
export const SUMMARIZER_ENTRY_ID = 'compaction-basic'

/**
 * The dsh model a hosted session's compaction summarizes through: a real dsh
 * provider route and an exact model id on it, never this plugin's placeholder
 * route.
 *
 * The pair exists because compaction summarizes by making an ordinary llm call
 * (`packages/compaction/compaction-basic/src/summarizer.ts` `resolveTarget`),
 * and a hosted session's routed model is this plugin's own placeholder
 * (`external/default`), whose `stream()` fails loud
 * (`src/provider-route.ts`). See {@link applySummarizerTarget}.
 */
export interface SummarizerTarget {
  /** Dsh provider route the summarization request is sent to. */
  readonly provider: string
  /** Exact model id on that route. */
  readonly model: string
}

/**
 * Indentation that puts an entry list directly under `config.plugins:` of an
 * `insert` row (`- insert:` 0, the row 4, `config:` 6, `plugins:` 8, its
 * entries 10), matching the harness's own preset patch files.
 */
const PLUGIN_LIST_INDENT = ' '.repeat(10)

/**
 * Render the `plugins:` block of a preset row from a stripped composition:
 * the `plugins:` key line, then the composition re-indented beneath it. Every
 * non-empty line shifts by the same amount, so the entry list keeps its
 * relative shape (nested groups, block scalars) and every comment in the source
 * survives as a comment at the list's own level. Blank lines stay blank rather
 * than becoming whitespace-only.
 * @param composition - the stripped composition text.
 * @returns the block's lines.
 */
function pluginListLines(composition: string): string[] {
  const text = composition.replace(/\n+$/, '')
  const lines = text.split('\n')
  // A composition with no entry opener at column 0 cannot be a YAML list: it
  // would render `plugins:` with nothing under it, which the preset schema
  // rejects (and a rejected row fails the whole profile boot, not just this
  // plugin). `plugins: []` is the honest rendering of "no rows survived".
  if (!lines.some(line => line.startsWith('- '))) return ['        plugins: []']
  return ['        plugins:', ...lines.map(line => (line.trim() === '' ? '' : `${PLUGIN_LIST_INDENT}${line}`))]
}

/**
 * Render one hosted engine's preset as an `insert` row: a
 * `@deepseek-ai/dsh-agent-preset` entry declaring the stripped composition,
 * exactly the shape the harness ships its own presets in. The row's own id is
 * `preset-<preset id>` (distinct from the preset's `config.id`, which is what a
 * session records and what the roster lists).
 * @param engine - the engine the preset selects.
 * @param composition - the source `standard` composition.
 * @returns the row's text.
 */
function renderEnginePresetRow(
  engine: HostedEngineId,
  composition: string,
  target: SummarizerTarget | undefined,
): string {
  const id = enginePresetId(engine)
  return [
    '- insert:',
    `    - id: preset-${id}`,
    `      name: '@deepseek-ai/dsh-agent-preset'`,
    '      config:',
    `        id: ${id}`,
    `        order: ${ENGINE_PRESET_ORDER}`,
    ...pluginListLines(applySummarizerTarget(stripPresetRows(composition), target)),
  ].join('\n')
}

/**
 * The managed preset-rows region: one preset row per hosted engine, bracketed
 * by the markers that make it locatable and rewritable.
 * @param composition - the source `standard` composition.
 * @param target - the summarization model to write into every copy, or
 *   undefined to leave the copies exactly as the strip left them.
 * @returns the region's text, ending in a newline.
 */
export function renderPresetRows(composition: string, target?: SummarizerTarget): string {
  return [
    PRESET_ROWS_BEGIN,
    '# One `@deepseek-ai/dsh-agent-preset` declaration per hosted engine: the',
    `# deployment's "${SOURCE_PRESET_ID}" preset minus the dsh-native command/skill rows a`,
    `# hosted loop engine replaces. Regenerated from "${SOURCE_PRESET_ID}" on boot — hand`,
    '# edits are overwritten. The preset id names the engine a session runs.',
    ...HOSTED_ENGINE_IDS.map(engine => renderEnginePresetRow(engine, composition, target)),
    `${PRESET_ROWS_END}\n`,
  ].join('\n')
}

/** Split a patch-file text at the preset-rows span; absent span means it appends. */
function presetRowsSpan(
  text: string,
): { head: string; tail: string; present: boolean; blankBefore: boolean } {
  const begin = text.indexOf(PRESET_ROWS_BEGIN)
  if (begin === -1) return { head: text, tail: '', present: false, blankBefore: false }
  const endAt = text.indexOf(PRESET_ROWS_END, begin)
  const spanEnd = endAt === -1 ? text.length : endAt + PRESET_ROWS_END.length + 1
  // One blank line separates the region from what precedes it; preserve that
  // separation on rewrite so the file never accumulates blank lines.
  const before = text.slice(0, begin)
  const blankBefore = before.endsWith('\n\n')
  return {
    head: blankBefore ? before.slice(0, -1) : before,
    tail: text.slice(spanEnd),
    present: true,
    blankBefore,
  }
}

/**
 * Produce the next patch-file text carrying the preset-rows region, preserving
 * every byte outside that span — including the managed block, which is located
 * by its own markers. Appends the region when absent and replaces it when
 * present, so an unchanged composition leaves the text byte for byte identical.
 *
 * The region is a root-level collection like the managed block, so a leftover
 * seed `[]` is dropped with it: two root collections in one document is YAML
 * the harness rejects, and the profile would stop booting.
 * @param text - current patch-file text.
 * @param composition - the source `standard` composition.
 * @param target - the summarization model to write into every copy, or
 *   undefined to leave the copies exactly as the strip left them.
 * @returns the rewritten patch-file text.
 */
export function applyEnginePresetRows(
  text: string,
  composition: string,
  target?: SummarizerTarget,
): string {
  const region = renderPresetRows(composition, target)
  const span = presetRowsSpan(text)
  if (!span.present) {
    // An empty or absent layer gains the region alone, with no leading filler.
    if (text === '') return region
    return dropSeedPlaceholder(`${ensureTrailingNewline(text)}\n${region}`)
  }
  return dropSeedPlaceholder(`${span.head}${span.blankBefore ? '\n' : ''}${region}${span.tail}`)
}

/** Display metadata one managed preset renders, as its `preset.yml` document. */
function managedMetadata(engine: HostedEngineId): string {
  return `name: ${ENGINE_DISPLAY_NAMES[engine]}\n`
    + `description: ${ENGINE_DISPLAY_NAMES[engine]}, with the dsh-native commands and skills it replaces removed.\n`
}

/** Human-readable engine names for the preset picker. */
const ENGINE_DISPLAY_NAMES: Readonly<Record<HostedEngineId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  kimi: 'Kimi Code',
}

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

/** The id of the entry an opener line starts, at whatever indentation. */
function anyEntryId(line: string): string | undefined {
  return /^\s*- id:\s*(\S+)\s*$/.exec(line)?.[1]
}

/** Count of a line's leading spaces (a composition file is space-indented). */
function leadingSpaces(line: string): number {
  return /^ */.exec(line)![0].length
}

/** Whether a line carries no entry content (blank, or a comment-only line). */
function isFiller(line: string): boolean {
  return line.trim() === '' || line.trimStart().startsWith('#')
}

/** Index of the last content line in `[from, to)`, or -1 when that range is filler only. */
function lastContentLine(lines: readonly string[], from: number, to: number): number {
  for (let index = to - 1; index >= from; index -= 1) {
    if (!isFiller(lines[index]!)) return index
  }
  return -1
}

/**
 * End of the block that starts at `from`: the first content line indented no
 * deeper than `indent` (a sibling of what `from` belongs to), or `to`.
 * @param lines - the whole text's lines.
 * @param from - first line of the block's body.
 * @param to - upper bound (exclusive).
 * @param indent - indentation the block owns.
 * @returns the exclusive end of the block.
 */
function blockEnd(lines: readonly string[], from: number, to: number, indent: number): number {
  for (let index = from; index < to; index += 1) {
    const line = lines[index]!
    if (isFiller(line)) continue
    if (leadingSpaces(line) <= indent) return index
  }
  return to
}

/** Index of the `config:` key line an entry owns in `[from, to)`, or -1. */
function configLine(lines: readonly string[], from: number, to: number, indent: number): number {
  for (let index = from; index < to; index += 1) {
    const line = lines[index]!
    if (leadingSpaces(line) === indent && line.trim() === 'config:') return index
  }
  return -1
}

/** Whether a line is one of the two keys this transform writes. */
function isSummarizerKey(line: string): boolean {
  return /^(summarizationProvider|summarizationModel)\s*:/.test(line.trimStart())
}

/** One injected value as a single-quoted YAML scalar (always a valid plain string). */
function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Name the dsh model a hosted session's compaction summarizes through, inside
 * the composition this plugin authors.
 *
 * Compaction summarizes by making an ordinary llm call, and it resolves that
 * call's target from `config.summarizationProvider` / `config.summarizationModel`
 * when both are set — otherwise from the agent's routed model
 * (`packages/compaction/compaction-basic/src/summarizer.ts` `resolveTarget`).
 * For a hosted session the routed model IS this plugin's placeholder route
 * (`external/default`), whose `stream()` fails loud by design, so without this
 * pair every compaction attempt there dies with `HOSTED_ENGINE_ROUTE` — caught
 * by the `agent/pre-step` listener as a warning, so the turn continues but the
 * session log never shrinks.
 *
 * The plugin writes the pair HERE because there is nowhere else to write it: a
 * profile-patch row replaces the whole `config` of the row it names, and the
 * patch index only descends into a `group: true` row's `config` array — a
 * preset's entries live in `config.plugins`, a plain field, so naming the pair
 * from the profile means re-declaring the entire `standard` composition. The
 * composition the plugin authors itself is therefore the one place a
 * deployment-side value can reach a nested row.
 *
 * The two keys land in `entryId`'s own `config:` mapping: an existing `config:`
 * block is merged into (never duplicated, and without emitting a key the entry
 * already carries), and a missing one is appended after the entry's last key at
 * the entry's own indentation. Text without the entry, and any call with an
 * undefined target, comes back byte for byte unchanged.
 * @param text - the composition text (typically the stripped `standard`).
 * @param target - the summarization model to write, or undefined to do nothing.
 * @param entryId - id of the entry whose `config` receives the pair.
 * @returns the composition text carrying the pair under `entryId`.
 */
export function applySummarizerTarget(
  text: string,
  target: SummarizerTarget | undefined,
  entryId: string = SUMMARIZER_ENTRY_ID,
): string {
  if (target === undefined) return text
  const lines = text.split('\n')
  const opener = lines.findIndex(line => anyEntryId(line) === entryId)
  if (opener === -1) return text
  const keyIndent = leadingSpaces(lines[opener]!) + 2
  const entryEnd = blockEnd(lines, opener + 1, lines.length, leadingSpaces(lines[opener]!))
  const keys = [
    `${' '.repeat(keyIndent + 2)}summarizationProvider: ${yamlScalar(target.provider)}`,
    `${' '.repeat(keyIndent + 2)}summarizationModel: ${yamlScalar(target.model)}`,
  ]
  const existing = configLine(lines, opener + 1, entryEnd, keyIndent)
  if (existing === -1) {
    // No `config:` yet: append the block after the entry's last own key, which
    // keeps any blank/comment run that heads the next entry where it is.
    const last = lastContentLine(lines, opener, entryEnd)
    lines.splice(last + 1, 0, `${' '.repeat(keyIndent)}config:`, ...keys)
    return lines.join('\n')
  }
  // Merge into the mapping the entry already owns. Same-named keys are dropped
  // first so the transform stays idempotent and a source that ships the pair
  // cannot produce a duplicate key.
  const bodyStart = existing + 1
  const bodyLimit = blockEnd(lines, bodyStart, entryEnd, keyIndent)
  const lastBody = lastContentLine(lines, bodyStart, bodyLimit)
  const bodyEnd = lastBody === -1 ? bodyStart : lastBody + 1
  const kept = lines.slice(bodyStart, bodyEnd).filter(line => !isSummarizerKey(line))
  lines.splice(bodyStart, bodyEnd - bodyStart, ...kept, ...keys)
  return lines.join('\n')
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

/** Minimal read seam over the host's preset roster, per harness generation. */
export interface PresetCompositionSource {
  /** 0.1.5 line: read one preset's composition text; throws when the id is unknown. */
  read?(id: string): Promise<string>
  /** 0.1.7 line: read one preset's document; `content` is the composition text. */
  readDocument?(id: string): Promise<{ readonly content: string }>
}

/**
 * Read the named preset's composition text through whichever seam the running
 * roster exposes. The 0.1.5 line's registry answers `read(id)` with the text;
 * the 0.1.7 rewrite replaced it with `readDocument(id)`, whose `content` is the
 * same entry-list YAML.
 * @param source - the roster's composition reader.
 * @param id - the preset identity to read.
 * @returns the composition text.
 * @throws when the running roster exposes neither seam.
 */
async function readComposition(source: PresetCompositionSource, id: string): Promise<string> {
  if (source.readDocument !== undefined) return (await source.readDocument(id)).content
  if (source.read !== undefined) return source.read(id)
  throw new Error('loop-engine: the preset roster exposes neither readDocument() nor read()')
}

/**
 * Regenerate every hosted engine's preset under the dsh home's user preset root
 * from the roster's `standard` preset. Idempotent: an up-to-date directory is
 * untouched, so no standing mount sees a spurious file-stamp change.
 * @param dshHome - the resolved harness home.
 * @param source - the roster's composition reader.
 * @param target - the summarization model to write into every copy, or
 *   undefined to leave the copies exactly as the strip left them.
 * @returns whether any file was written.
 * @throws when the source preset cannot be read or the writes fail.
 */
export async function ensureEnginePresets(
  dshHome: string,
  source: PresetCompositionSource,
  target?: SummarizerTarget,
): Promise<boolean> {
  const composition = await readComposition(source, SOURCE_PRESET_ID)
  const stripped = `${MANAGED_HEADER}\n${applySummarizerTarget(stripPresetRows(composition), target)}`
  let changed = false
  for (const engine of HOSTED_ENGINE_IDS) {
    const dir = join(dshHome, USER_PRESET_DIR, enginePresetId(engine))
    const compositionChanged = await writeIfDifferent(join(dir, COMPOSITION_FILE), stripped)
    const metadataChanged = await writeIfDifferent(join(dir, METADATA_FILE), managedMetadata(engine))
    changed = changed || compositionChanged || metadataChanged
  }
  return changed
}

/** Read a patch file for a rewrite, or `''` when it is absent or unreadable. */
async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    // Absent or unreadable — the region is appended either way, and a target
    // that cannot be written then fails at the write, where the caller reports
    // it once. Same posture as `writeIfDifferent`'s read.
    return ''
  }
}

/**
 * Regenerate every hosted engine's preset as an `insert` row in the profile
 * patch the plugin already manages, from the roster's `standard` preset.
 *
 * This is the 0.1.7 mechanism: a preset there is a composed plugin row, and the
 * user preset root is not read at all — so a preset written as a directory
 * would simply never register, leaving the roster without the id every hosted
 * session records. The rows go in the profile's own `cordis.patch.yml` because
 * that is the one composition layer the plugin owns: it is already the file the
 * managed block lives in, it is applied after the bundle's own preset rows, and
 * a rewrite of it is what the harness's live patch reload picks up.
 *
 * Idempotent: an up-to-date region is left byte for byte alone, so a rewrite
 * that changes nothing does not touch the file's stamp.
 * @param patchPath - absolute path of the profile's patch file.
 * @param source - the roster's composition reader.
 * @param target - the summarization model to write into every copy, or
 *   undefined to leave the copies exactly as the strip left them.
 * @returns whether the patch file was written.
 * @throws when the source preset cannot be read or the write fails.
 */
export async function ensureEnginePresetRows(
  patchPath: string,
  source: PresetCompositionSource,
  target?: SummarizerTarget,
): Promise<boolean> {
  const composition = await readComposition(source, SOURCE_PRESET_ID)
  const current = await readTextOrEmpty(patchPath)
  return writeIfDifferent(patchPath, applyEnginePresetRows(current, composition, target))
}
