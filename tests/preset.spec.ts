/**
 * Unit tests for the hosted-engine preset authoring: the row-stripping line
 * transform, the engine ↔ preset-id mapping that selects an engine per session,
 * the idempotent per-engine managed-preset writer, and the preset rows the
 * 0.1.7 harness reads instead.
 * @module tests/preset
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyEnginePresetRows,
  applySummarizerTarget,
  COMPOSITION_FILE,
  ENGINE_PRESET_ORDER,
  engineOfPreset,
  enginePresetId,
  ensureEnginePresetRows,
  ensureEnginePresets,
  HOSTED_PRESET_IDS,
  HOSTED_PRESET_PREFIX,
  METADATA_FILE,
  PRESET_ROWS_BEGIN,
  PRESET_ROWS_END,
  renderPresetRows,
  SOURCE_PRESET_ID,
  STRIPPED_ROWS,
  stripPresetRows,
  SUMMARIZER_ENTRY_ID,
  USER_PRESET_DIR,
  type SummarizerTarget,
} from '../src/preset.ts'
import { applyManagedBlock, MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END } from '../src/patch-manager.ts'
import { HOSTED_ENGINE_IDS } from '../src/settings.ts'
import type { HostedEngineId } from '../src/settings.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-preset-'))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/** A small composition in the shape of the shipped `standard` preset. */
const STANDARD = `# The standard preset header.
# Spanning two comment lines.

- id: persona
  name: '@deepseek-ai/dsh-persona'

# ── shell ──

# The shell section comment.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'

# ── skills ──

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'

# ── plan mode ──

- id: planning
  name: cordis:group
  group: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'

- id: compaction
  name: cordis:group
  group: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
`

describe('stripPresetRows', () => {
  it('drops the default rows and their section headings, keeping the rest byte for byte', () => {
    const stripped = stripPresetRows(STANDARD)
    expect(stripped).toContain('- id: persona')
    expect(stripped).toContain('- id: tool-bash')
    expect(stripped).not.toContain('skill-filesystem')
    expect(stripped).not.toContain('tool-skill')
    expect(stripped).not.toContain('planning')
    expect(stripped).not.toContain('tool-goal')
    // The compaction group is KEPT: it bounds the session log, which a hosted
    // step replays in full — the engine's own per-step compaction cannot stand
    // in for it.
    expect(stripped).toContain('- id: compaction')
    expect(stripped).toContain('- id: command-compact')
    // The dropped sections' headings went with them; the kept ones stayed.
    expect(stripped).not.toContain('── skills ──')
    expect(stripped).not.toContain('── plan mode ──')
    expect(stripped).toContain('── shell ──')
    expect(stripped).toContain('The shell section comment.')
    // The file header precedes the first entry and is always kept whole.
    expect(stripped.startsWith(STANDARD.split('\n').slice(0, 2).join('\n'))).toBe(true)
  })

  it('is idempotent over already-stripped text', () => {
    const once = stripPresetRows(STANDARD)
    expect(stripPresetRows(once)).toBe(once)
  })

  it('returns text without any top-level entry unchanged', () => {
    expect(stripPresetRows('# only a comment\n')).toBe('# only a comment\n')
  })

  it('keeps entries whose opener carries no id', () => {
    const text = `- name: '@deepseek-ai/dsh-tool-bash'\n- id: tool-goal\n  name: '@deepseek-ai/dsh-tool-goal'\n`
    const stripped = stripPresetRows(text)
    expect(stripped).toContain(`- name: '@deepseek-ai/dsh-tool-bash'`)
    expect(stripped).not.toContain('tool-goal')
  })

  it('drops a first entry without eating the file header above it', () => {
    const text = `# header\n\n- id: tool-goal\n  name: '@deepseek-ai/dsh-tool-goal'\n- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n`
    const stripped = stripPresetRows(text)
    expect(stripped.startsWith('# header\n')).toBe(true)
    expect(stripped).not.toContain('tool-goal')
    expect(stripped).toContain('- id: tool-bash')
  })

  it('drops a trailing entry without leaving its heading behind', () => {
    const text = `- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n\n# trailing section\n\n- id: tool-goal\n  name: '@deepseek-ai/dsh-tool-goal'\n`
    expect(stripPresetRows(text)).toBe(`- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n`)
  })

  it('keeps entries adjacent to a dropped one separated', () => {
    const text = `- id: persona\n  name: p\n\n# section\n\n- id: planning\n  name: cordis:group\n  group: true\n  config: []\n\n# next section\n\n- id: tool-bash\n  name: t\n`
    const stripped = stripPresetRows(text)
    expect(stripped).toBe(`- id: persona\n  name: p\n\n# next section\n\n- id: tool-bash\n  name: t\n`)
  })

  it('honors a custom id set', () => {
    const stripped = stripPresetRows(STANDARD, ['tool-bash'])
    expect(stripped).not.toContain('tool-bash')
    expect(stripped).toContain('skill-filesystem')
  })
})

/** The dsh model every hosted session's compaction must summarize through. */
const SUMMARIZER: SummarizerTarget = { provider: 'deepseek-official', model: 'deepseek-flash' }

/** Lines of `text`, for positional assertions on the injected block. */
function linesOf(text: string): string[] {
  return text.split('\n')
}

/** The line index of an exact composition line, or -1. */
function lineAt(text: string, line: string): number {
  return linesOf(text).indexOf(line)
}

/** How many lines of `text` satisfy `match`. */
function countLines(text: string, match: RegExp): number {
  return linesOf(text).filter(line => match.test(line)).length
}

describe('applySummarizerTarget', () => {
  it('appends a config block naming the summarizer to the compaction-basic entry', () => {
    const lines = linesOf(applySummarizerTarget(STANDARD, SUMMARIZER))
    const opener = lineAt(STANDARD, '    - id: compaction-basic')
    expect(opener).toBeGreaterThan(-1)
    // The pair lands inside the entry's own `config:`, one indentation level
    // deeper than the entry's keys, and before the next sibling entry.
    expect(lines[opener]).toBe('    - id: compaction-basic')
    expect(lines[opener + 1]).toBe(`      name: '@deepseek-ai/dsh-compaction-basic'`)
    expect(lines[opener + 2]).toBe('      config:')
    expect(lines[opener + 3]).toBe(`        summarizationProvider: 'deepseek-official'`)
    expect(lines[opener + 4]).toBe(`        summarizationModel: 'deepseek-flash'`)
    expect(lines[opener + 5]).toBe('    - id: command-compact')
  })

  it('is a no-op without a target, and for a composition that lacks the entry', () => {
    expect(applySummarizerTarget(STANDARD, undefined)).toBe(STANDARD)
    expect(applySummarizerTarget('# nothing here\n', SUMMARIZER)).toBe('# nothing here\n')
    // The custom id proves the entry is addressed by name, not by position:
    // `persona` is top-level, so its config block is one level shallower.
    expect(applySummarizerTarget(STANDARD, SUMMARIZER, 'persona')).toContain(
      `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n`
      + `    summarizationProvider: 'deepseek-official'\n    summarizationModel: 'deepseek-flash'\n`,
    )
    expect(applySummarizerTarget(STANDARD, SUMMARIZER, 'absent-row')).toBe(STANDARD)
  })

  it('merges into a config block the entry already owns instead of duplicating the key', () => {
    const text = `- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
`
    const out = applySummarizerTarget(text, SUMMARIZER)
    expect(countLines(out, /^\s*config:\s*$/)).toBe(1)
    // The source's own key survived, and it is still ahead of the injected pair.
    expect(lineAt(out, '    thresholdRatio: 0.8')).toBeLessThan(
      lineAt(out, `    summarizationProvider: 'deepseek-official'`),
    )
    expect(out).toContain(`    summarizationModel: 'deepseek-flash'`)
    // The sibling entry and its keys are untouched.
    expect(out).toContain(`- id: command-compact\n  name: '@deepseek-ai/dsh-command-compact'`)
  })

  it('fills an empty config block without disturbing the sibling that follows', () => {
    const text = `- id: compaction-basic\n  name: n\n  config:\n- id: command-compact\n  name: c\n`
    expect(applySummarizerTarget(text, SUMMARIZER)).toBe(
      `- id: compaction-basic\n  name: n\n  config:\n`
      + `    summarizationProvider: 'deepseek-official'\n    summarizationModel: 'deepseek-flash'\n`
      + `- id: command-compact\n  name: c\n`,
    )
  })

  it('replaces a pair the source composition already ships rather than emitting a duplicate key', () => {
    const text = `- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    summarizationProvider: 'stale-provider'
    summarizationModel: 'stale-model'
`
    const out = applySummarizerTarget(text, SUMMARIZER)
    expect(countLines(out, /summarizationProvider:/)).toBe(1)
    expect(countLines(out, /summarizationModel:/)).toBe(1)
    expect(out).not.toContain('stale-provider')
    expect(out).not.toContain('stale-model')
    expect(out).toContain(`    summarizationProvider: 'deepseek-official'`)
  })

  it('is idempotent over its own output', () => {
    const once = applySummarizerTarget(STANDARD, SUMMARIZER)
    expect(applySummarizerTarget(once, SUMMARIZER)).toBe(once)
    const merged = `- id: compaction-basic\n  name: n\n`
    expect(applySummarizerTarget(applySummarizerTarget(merged, SUMMARIZER), SUMMARIZER))
      .toBe(applySummarizerTarget(merged, SUMMARIZER))
  })

  it('keeps the file’s trailing-newline shape', () => {
    for (const source of ['- id: compaction-basic\n  name: n\n', '- id: compaction-basic\n  name: n']) {
      const out = applySummarizerTarget(source, SUMMARIZER)
      expect(out.endsWith('\n')).toBe(source.endsWith('\n'))
    }
  })

  it('quotes a value that would otherwise break out of the scalar', () => {
    const out = applySummarizerTarget(STANDARD, { provider: "it's: tricky", model: '# not-a-comment' })
    expect(out).toContain(`        summarizationProvider: 'it''s: tricky'`)
    expect(out).toContain(`        summarizationModel: '# not-a-comment'`)
  })

  it('names the entry id it targets', () => {
    expect(SUMMARIZER_ENTRY_ID).toBe('compaction-basic')
  })
})

describe('enginePresetId', () => {
  it('names the harness loop by the source preset', () => {
    expect(enginePresetId('in-process')).toBe(SOURCE_PRESET_ID)
  })

  it('gives every hosted engine a preset id of its own', () => {
    expect(enginePresetId('codex')).toBe(`${HOSTED_PRESET_PREFIX}codex`)
    expect(enginePresetId('kimi')).toBe('loop-engine-kimi')
    for (const engine of HOSTED_ENGINE_IDS) {
      expect(enginePresetId(engine)).not.toBe(SOURCE_PRESET_ID)
    }
  })
})

describe('engineOfPreset', () => {
  it('resolves each plugin-authored preset id back to its engine', () => {
    for (const engine of HOSTED_ENGINE_IDS) {
      expect(engineOfPreset(enginePresetId(engine))).toBe(engine)
    }
  })

  it('owns no preset id it did not author', () => {
    // A session without a preset, the deployment's own presets, its own ids.
    expect(engineOfPreset(undefined)).toBeUndefined()
    expect(engineOfPreset(SOURCE_PRESET_ID)).toBeUndefined()
    expect(engineOfPreset('deployment-authored')).toBeUndefined()
    expect(engineOfPreset(HOSTED_PRESET_PREFIX)).toBeUndefined()
    expect(engineOfPreset(`${HOSTED_PRESET_PREFIX}in-process`)).toBeUndefined()
    expect(engineOfPreset(`${HOSTED_PRESET_PREFIX}unknown`)).toBeUndefined()
  })
})

describe('HOSTED_PRESET_IDS', () => {
  it('lists exactly one authored preset id per hosted engine, in selection order', () => {
    expect(HOSTED_PRESET_IDS).toEqual([
      'loop-engine-claude-code',
      'loop-engine-codex',
      'loop-engine-pi',
      'loop-engine-kimi',
    ])
    expect(HOSTED_PRESET_IDS).toEqual(HOSTED_ENGINE_IDS.map(engine => enginePresetId(engine)))
    // The harness loop's own preset is the deployment's, not one this plugin owns.
    expect(HOSTED_PRESET_IDS).not.toContain(SOURCE_PRESET_ID)
    expect(new Set(HOSTED_PRESET_IDS).size).toBe(HOSTED_PRESET_IDS.length)
  })
})

/** Stub roster source returning a fixed composition. */
function sourceOf(composition: string): { read(id: string): Promise<string> } {
  return {
    read: (id) => {
      if (id !== SOURCE_PRESET_ID) return Promise.reject(new Error(`unknown preset "${id}"`))
      return Promise.resolve(composition)
    },
  }
}

/** The two files of one authored engine preset, read back from disk. */
async function presetOf(home: string, id: string): Promise<{ composition: string, metadata: string }> {
  const dir = join(home, USER_PRESET_DIR, id)
  return {
    composition: await readFile(join(dir, COMPOSITION_FILE), 'utf8'),
    metadata: await readFile(join(dir, METADATA_FILE), 'utf8'),
  }
}

/** Modification stamp of every file of every authored preset, by relative path. */
async function stamps(home: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const id of [...HOSTED_PRESET_IDS].sort()) {
    for (const file of [COMPOSITION_FILE, METADATA_FILE]) {
      out[`${id}/${file}`] = (await stat(join(home, USER_PRESET_DIR, id, file))).mtimeMs
    }
  }
  return out
}

/** The human-readable preset name each engine's `preset.yml` must render. */
const DISPLAY_NAMES: Readonly<Record<HostedEngineId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  kimi: 'Kimi Code',
}

describe('ensureEnginePresets', () => {
  it('authors one managed preset per hosted engine, and nothing else', async () => {
    const home = await tempDir()
    expect(await ensureEnginePresets(home, sourceOf(STANDARD))).toBe(true)
    expect((await readdir(join(home, USER_PRESET_DIR))).sort()).toEqual([...HOSTED_PRESET_IDS].sort())
  })

  it('writes the stripped standard composition under the managed header, per engine', async () => {
    const home = await tempDir()
    await ensureEnginePresets(home, sourceOf(STANDARD))
    const stripped = stripPresetRows(STANDARD)
    for (const engine of HOSTED_ENGINE_IDS) {
      const { composition } = await presetOf(home, enginePresetId(engine))
      // Byte for byte: the managed header, then the stripped source composition.
      expect(composition.endsWith(stripped)).toBe(true)
      const header = composition.slice(0, composition.length - stripped.length)
      expect(header).toContain('Managed by dsh-loop-engine')
      expect(header.split('\n').every(line => line === '' || line.startsWith('#'))).toBe(true)
      // The stripped rows are gone; the kept rows survived verbatim.
      for (const row of STRIPPED_ROWS) expect(composition).not.toContain(`- id: ${row}`)
      expect(composition).toContain('- id: persona')
      expect(composition).toContain('- id: tool-bash')
    }
  })

  it('bakes the deployment’s summarizer into every authored copy', async () => {
    const home = await tempDir()
    await ensureEnginePresets(home, sourceOf(STANDARD), SUMMARIZER)
    for (const engine of HOSTED_ENGINE_IDS) {
      const { composition } = await presetOf(home, enginePresetId(engine))
      // The directory carrier keeps the source composition's own indentation.
      expect(composition).toContain('    - id: compaction-basic')
      expect(composition).toContain(`        summarizationProvider: 'deepseek-official'`)
      expect(composition).toContain(`        summarizationModel: 'deepseek-flash'`)
    }
  })

  it('names each engine preset for a human in its metadata', async () => {
    const home = await tempDir()
    await ensureEnginePresets(home, sourceOf(STANDARD))
    for (const engine of HOSTED_ENGINE_IDS) {
      const name = DISPLAY_NAMES[engine]
      const { metadata } = await presetOf(home, enginePresetId(engine))
      const [first, second] = metadata.split('\n')
      expect(first).toBe(`name: ${name}`)
      expect(second!.startsWith(`description: ${name}, `)).toBe(true)
      expect(metadata.endsWith('\n')).toBe(true)
    }
  })

  it('is idempotent: a second run over the same source writes nothing', async () => {
    const home = await tempDir()
    await ensureEnginePresets(home, sourceOf(STANDARD))
    const before = await stamps(home)
    expect(await ensureEnginePresets(home, sourceOf(STANDARD))).toBe(false)
    // Untouched means untouched: no standing mount sees a spurious file stamp.
    expect(await stamps(home)).toEqual(before)
  })

  it('rewrites every engine preset when the source composition changed', async () => {
    const home = await tempDir()
    await ensureEnginePresets(home, sourceOf(STANDARD))
    const updated = `${STANDARD}- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n`
    expect(await ensureEnginePresets(home, sourceOf(updated))).toBe(true)
    for (const engine of HOSTED_ENGINE_IDS) {
      const { composition } = await presetOf(home, enginePresetId(engine))
      expect(composition).toContain('- id: tool-web')
    }
  })

  it('overwrites hand edits: text on disk is never authoritative', async () => {
    const home = await tempDir()
    await ensureEnginePresets(home, sourceOf(STANDARD))
    const path = join(home, USER_PRESET_DIR, enginePresetId('kimi'), COMPOSITION_FILE)
    await writeFile(path, '# hand edited\n')
    expect(await ensureEnginePresets(home, sourceOf(STANDARD))).toBe(true)
    const composition = await readFile(path, 'utf8')
    expect(composition).not.toContain('# hand edited')
    expect(composition).toContain('Managed by dsh-loop-engine')
  })

  it('repairs a missing metadata file on the next run', async () => {
    const home = await tempDir()
    await ensureEnginePresets(home, sourceOf(STANDARD))
    await rm(join(home, USER_PRESET_DIR, enginePresetId('codex'), METADATA_FILE))
    expect(await ensureEnginePresets(home, sourceOf(STANDARD))).toBe(true)
    expect((await presetOf(home, enginePresetId('codex'))).metadata).toContain('name: Codex')
  })

  it('authors from an empty source too', async () => {
    const home = await tempDir()
    expect(await ensureEnginePresets(home, sourceOf(''))).toBe(true)
    for (const engine of HOSTED_ENGINE_IDS) {
      const { composition } = await presetOf(home, enginePresetId(engine))
      expect(composition).toContain('Managed by dsh-loop-engine')
    }
  })

  it('propagates a source read failure without writing anything', async () => {
    const home = await tempDir()
    await expect(ensureEnginePresets(home, {
      read: () => Promise.reject(new Error(`unknown preset "${SOURCE_PRESET_ID}"`)),
    })).rejects.toThrow('unknown preset')
    await expect(readdir(join(home, USER_PRESET_DIR))).rejects.toThrow()
  })

  it('reads the composition through readDocument when the 0.1.7 roster exposes it', async () => {
    const home = await tempDir()
    const changed = await ensureEnginePresets(home, {
      readDocument: (id) => id === SOURCE_PRESET_ID
        ? Promise.resolve({ content: '- id: persona\n' })
        : Promise.reject(new Error(`unknown preset "${id}"`)),
    })
    expect(changed).toBe(true)
    expect((await presetOf(home, enginePresetId('claude-code'))).composition)
      .toContain('Managed by dsh-loop-engine')
  })

  it('throws when the roster exposes neither read seam', async () => {
    const home = await tempDir()
    await expect(ensureEnginePresets(home, {})).rejects.toThrow('neither readDocument() nor read()')
  })

  it('propagates an unwritable target instead of swallowing it', async () => {
    const home = await tempDir()
    // A directory occupying the first engine's composition path: the read fails
    // (falling through to the write) and the rename over a non-empty directory fails.
    const dir = join(home, USER_PRESET_DIR, enginePresetId(HOSTED_ENGINE_IDS[0]!))
    await mkdir(join(dir, COMPOSITION_FILE), { recursive: true })
    await writeFile(join(dir, COMPOSITION_FILE, 'occupant'), 'x')
    await expect(ensureEnginePresets(home, sourceOf(STANDARD))).rejects.toThrow()
  })
})

/** The preset-row region of a patch text, or `undefined` when it is absent. */
function rowsRegionOf(text: string): string | undefined {
  const begin = text.indexOf(PRESET_ROWS_BEGIN)
  const end = text.indexOf(PRESET_ROWS_END)
  return begin === -1 || end === -1 ? undefined : text.slice(begin, end)
}

/** One engine's row inside a patch text, cut at the next row. */
function rowOf(text: string, engine: HostedEngineId): string {
  const id = enginePresetId(engine)
  const start = text.indexOf(`    - id: preset-${id}\n`)
  const next = text.indexOf('\n- insert:', start)
  return text.slice(start, next === -1 ? undefined : next)
}

describe('PRESET_ROWS markers', () => {
  it('are distinct from the managed block markers, so neither region rewrites the other', () => {
    expect(PRESET_ROWS_BEGIN).not.toContain('managed block')
    expect(PRESET_ROWS_END).not.toContain('managed block')
    expect(PRESET_ROWS_END).toBe(`# -- /dsh-loop-engine presets --`)
    expect(applyManagedBlock(applyEnginePresetRows('', STANDARD)))
      .toContain(PRESET_ROWS_BEGIN)
  })
})

describe('renderPresetRows', () => {
  it('renders one insert row per hosted engine, in selection order', () => {
    const region = renderPresetRows(STANDARD)
    expect(region.startsWith(`${PRESET_ROWS_BEGIN}\n`)).toBe(true)
    expect(region.endsWith(`${PRESET_ROWS_END}\n`)).toBe(true)
    const ids = [...region.matchAll(/^ {8}id: (\S+)$/gm)].map(match => match[1])
    expect(ids).toEqual([...HOSTED_PRESET_IDS])
    expect([...region.matchAll(/^    - id: preset-(\S+)$/gm)].map(match => match[1]))
      .toEqual([...HOSTED_PRESET_IDS])
  })

  it('writes the deployment’s summarizer into every engine’s copy, at the entry’s own depth', () => {
    const region = renderPresetRows(STANDARD, SUMMARIZER)
    for (const engine of HOSTED_ENGINE_IDS) {
      const row = rowOf(region, engine)
      // The re-indent shifts the whole composition by ten columns: the entry
      // lands at 14, its own keys and `config:` at 16, the injected pair at 18.
      expect(row).toMatch(/\n {14}- id: compaction-basic\n/)
      expect(row).toMatch(/\n {16}name: '@deepseek-ai\/dsh-compaction-basic'\n/)
      expect(row).toMatch(/\n {16}config:\n/)
      expect(row).toMatch(/\n {18}summarizationProvider: 'deepseek-official'\n/)
      expect(row).toMatch(/\n {18}summarizationModel: 'deepseek-flash'\n/)
    }
  })

  it('leaves the region byte-identical when no summarizer is named', () => {
    expect(renderPresetRows(STANDARD)).toBe(renderPresetRows(STANDARD, undefined))
  })

  it('declares each preset through the harness’s own row plugin, at one order past the shipped ones', () => {
    const region = renderPresetRows(STANDARD)
    expect([...region.matchAll(/^ +name: '@deepseek-ai\/dsh-agent-preset'$/gm)]).toHaveLength(HOSTED_ENGINE_IDS.length)
    for (const line of region.split('\n')) {
      if (line.trimStart().startsWith('order:')) expect(line).toBe(`        order: ${ENGINE_PRESET_ORDER}`)
    }
    // Past every order the harness ships its own presets at (1 standard, 2 ptc,
    // 3 minimal, 4 cordis), so the engines' copies sort last.
    expect(ENGINE_PRESET_ORDER).toBeGreaterThan(4)
  })

  it('re-indents the stripped composition under `plugins:`, keeping its relative shape', () => {
    const nested = '- id: delegation\n  name: cordis:group\n  group: true\n  config:\n    - id: tool-subagent-control\n      name: tool\n'
    const row = rowOf(renderPresetRows(`${STANDARD}${nested}`), 'kimi')
    // The source's own column 0 becomes the list's first level.
    expect(row).toMatch(/\n {10}- id: persona\n/)
    expect(row).toMatch(/\n {12}name: '@deepseek-ai\/dsh-persona'\n/)
    // A nested group keeps its extra level, and its own children one deeper.
    expect(row).toMatch(/\n {10}- id: delegation\n/)
    expect(row).toMatch(/\n {12}group: true\n/)
    expect(row).toMatch(/\n {14}- id: tool-subagent-control\n/)
    expect(row).toMatch(/\n {16}name: tool\n/)
    // Blank lines stay blank rather than becoming whitespace-only.
    expect(row.slice(row.indexOf('plugins:'))).not.toMatch(/[ \t]+\n/)
  })

  it('keeps the compaction group’s rows in the authored composition', () => {
    // The preset a hosted session runs must carry the compaction group: the
    // plugin's provider route declares the capacity it needs, and this group is
    // what turns that into durable checkpoints that shrink the session log.
    expect(STRIPPED_ROWS).not.toContain('compaction')
    for (const engine of HOSTED_ENGINE_IDS) {
      const row = rowOf(renderPresetRows(STANDARD), engine)
      expect(row).toMatch(/\n {10}- id: compaction\n/)
      expect(row).toMatch(/\n {12}name: cordis:group\n/)
      expect(row).toMatch(/\n {14}- id: command-compact\n/)
    }
  })

  it('carries the leading comments of the source composition as comments inside the list', () => {
    const row = rowOf(renderPresetRows(STANDARD), 'codex')
    expect(row).toMatch(/\n {10}# The standard preset header\.\n/)
    expect(row).toMatch(/\n {10}# ── shell ──\n/)
    // The comment above a stripped entry went with it.
    expect(row).not.toContain('── skills ──')
  })

  it('renders an empty plugins list when no entry survives the strip', () => {
    for (const source of ['', '# only a comment\n', '- id: planning\n  name: cordis:group\n']) {
      const region = renderPresetRows(source)
      expect([...region.matchAll(/^ {8}plugins: \[\]$/gm)]).toHaveLength(HOSTED_ENGINE_IDS.length)
      expect(region).not.toMatch(/^ +plugins:\s*$/m)
    }
  })
})

describe('applyEnginePresetRows', () => {
  it('appends the region to an empty layer without leading filler', () => {
    expect(applyEnginePresetRows('', STANDARD)).toBe(renderPresetRows(STANDARD))
  })

  it('appends to a layer that does not end in a newline, separated by one blank line', () => {
    const text = applyEnginePresetRows('# my patches\n- id: tool-x', STANDARD)
    expect(text.startsWith(`# my patches\n- id: tool-x\n\n${PRESET_ROWS_BEGIN}\n`)).toBe(true)
  })

  it('drops a surviving seed `[]` so the file stays one top-level array', () => {
    // A file whose managed-block write failed is still the fresh-profile seed;
    // a region appended beside it would be a second root collection, which is
    // YAML the harness refuses to boot.
    const text = applyEnginePresetRows('[]\n', STANDARD)
    expect(text).not.toMatch(/^\[\]$/m)
    expect(text.trimStart().startsWith(PRESET_ROWS_BEGIN)).toBe(true)
  })

  it('rewrites the region in place, preserving every byte around it', () => {
    const before = applyManagedBlock('# my patches\n- id: tool-x\n')
    const once = applyEnginePresetRows(before, STANDARD)
    const twice = applyEnginePresetRows(`${once}\n- id: tool-after\n`, STANDARD)
    expect(twice).toContain('# my patches')
    expect(twice).toContain('- id: tool-after')
    // The managed block kept its own markers and bytes untouched.
    expect(twice).toContain(MANAGED_BLOCK_BEGIN)
    expect(twice).toContain('- id: agent-loop\n  disabled: true')
    expect(twice).toContain(MANAGED_BLOCK_END)
    // One region, not two.
    expect(twice.split(PRESET_ROWS_BEGIN)).toHaveLength(2)
  })

  it('is idempotent over its own output', () => {
    const once = applyEnginePresetRows('', STANDARD)
    expect(applyEnginePresetRows(once, STANDARD)).toBe(once)
    // A region whose end marker went missing is rewritten to the end of file.
    const truncated = once.slice(0, once.indexOf('- insert:'))
    expect(applyEnginePresetRows(truncated, STANDARD)).toBe(renderPresetRows(STANDARD))
  })

  it('replaces the region when the source composition changed', () => {
    const once = applyEnginePresetRows('', STANDARD)
    const updated = `${STANDARD}- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n`
    const twice = applyEnginePresetRows(once, updated)
    expect(twice).not.toBe(once)
    expect(rowOf(twice, 'pi')).toContain('- id: tool-web')
  })
})

describe('ensureEnginePresetRows', () => {
  /** A profile patch path inside a fresh temp directory. */
  async function patchPath(): Promise<string> {
    return join(await tempDir(), 'profiles', 'web', 'cordis.patch.yml')
  }

  it('bakes the deployment’s summarizer into every authored row', async () => {
    const path = await patchPath()
    expect(await ensureEnginePresetRows(path, sourceOf(STANDARD), SUMMARIZER)).toBe(true)
    const text = await readFile(path, 'utf8')
    expect(text).toBe(renderPresetRows(STANDARD, SUMMARIZER))
    // One pair per engine, never more: a repeat run must not stack keys.
    expect(countLines(text, /^ {18}summarizationProvider: 'deepseek-official'$/)).toBe(HOSTED_ENGINE_IDS.length)
    expect(countLines(text, /^ {18}summarizationModel: 'deepseek-flash'$/)).toBe(HOSTED_ENGINE_IDS.length)
    expect(await ensureEnginePresetRows(path, sourceOf(STANDARD), SUMMARIZER)).toBe(false)
  })

  it('writes the region into a patch file that does not exist yet, creating its parent', async () => {
    const path = await patchPath()
    expect(await ensureEnginePresetRows(path, sourceOf(STANDARD))).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(renderPresetRows(STANDARD))
  })

  it('appends the region beside the managed block a boot already wrote', async () => {
    const path = await patchPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, applyManagedBlock('[]\n'))
    expect(await ensureEnginePresetRows(path, sourceOf(STANDARD))).toBe(true)
    const text = await readFile(path, 'utf8')
    expect(text).toContain(MANAGED_BLOCK_BEGIN)
    expect(text).toContain(PRESET_ROWS_BEGIN)
  })

  it('is idempotent: a second run over the same source writes nothing', async () => {
    const path = await patchPath()
    await ensureEnginePresetRows(path, sourceOf(STANDARD))
    const before = (await stat(path)).mtimeMs
    expect(await ensureEnginePresetRows(path, sourceOf(STANDARD))).toBe(false)
    expect((await stat(path)).mtimeMs).toBe(before)
  })

  it('overwrites hand edits to the region: text on disk is never authoritative', async () => {
    const path = await patchPath()
    await ensureEnginePresetRows(path, sourceOf(STANDARD))
    const handEdited = (await readFile(path, 'utf8')).replace(PRESET_ROWS_END, '# hand edited\n')
    await writeFile(path, handEdited)
    expect(await ensureEnginePresetRows(path, sourceOf(STANDARD))).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(renderPresetRows(STANDARD))
    expect(rowsRegionOf(await readFile(path, 'utf8'))).toBeDefined()
  })

  it('reads the composition through readDocument when the 0.1.7 roster exposes it', async () => {
    const path = await patchPath()
    expect(await ensureEnginePresetRows(path, {
      readDocument: (id) => id === SOURCE_PRESET_ID
        ? Promise.resolve({ content: '- id: persona\n' })
        : Promise.reject(new Error(`unknown preset "${id}"`)),
    })).toBe(true)
    expect(await readFile(path, 'utf8')).toContain('        plugins:\n          - id: persona\n')
  })

  it('propagates a source read failure without writing anything', async () => {
    const path = await patchPath()
    await expect(ensureEnginePresetRows(path, {
      read: () => Promise.reject(new Error(`unknown preset "${SOURCE_PRESET_ID}"`)),
    })).rejects.toThrow('unknown preset')
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('propagates an unreadable patch file rather than silently rewriting it', async () => {
    const path = await patchPath()
    // A directory where the patch file belongs: the read fails (so the region is
    // built over an empty layer) and the rename over the directory fails.
    await mkdir(path, { recursive: true })
    await expect(ensureEnginePresetRows(path, sourceOf(STANDARD))).rejects.toThrow()
  })

  it('treats a missing patch file as an empty layer rather than failing the read', async () => {
    const path = await patchPath()
    // The parent exists but the file does not: the read is ENOENT, which is the
    // ordinary first-boot case and must not surface as an authoring failure.
    await mkdir(dirname(path), { recursive: true })
    expect(await ensureEnginePresetRows(path, sourceOf(STANDARD))).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(renderPresetRows(STANDARD))
  })
})
