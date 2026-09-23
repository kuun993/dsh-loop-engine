/**
 * Unit tests for the hosted-engine preset authoring: the row-stripping line
 * transform, the engine ↔ preset-id mapping that selects an engine per session,
 * and the idempotent per-engine managed-preset writer.
 * @module tests/preset
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPOSITION_FILE,
  engineOfPreset,
  enginePresetId,
  ensureEnginePresets,
  HOSTED_PRESET_IDS,
  HOSTED_PRESET_PREFIX,
  METADATA_FILE,
  SOURCE_PRESET_ID,
  STRIPPED_ROWS,
  stripPresetRows,
  USER_PRESET_DIR,
} from '../src/preset.ts'
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
    expect(stripped).not.toContain('compaction')
    expect(stripped).not.toContain('tool-goal')
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
