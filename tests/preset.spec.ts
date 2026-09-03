/**
 * Unit tests for the hosted-engine preset authoring: the row-stripping line
 * transform and the idempotent managed-preset writer.
 * @module tests/preset
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPOSITION_FILE,
  ensureHostedPreset,
  HOSTED_PRESET_ID,
  METADATA_FILE,
  stripPresetRows,
  USER_PRESET_DIR,
} from '../src/preset.ts'

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

/** Stub roster source returning a fixed composition. */
function sourceOf(composition: string): { read(id: string): Promise<string> } {
  return {
    read: (id) => {
      if (id !== 'standard') return Promise.reject(new Error(`unknown preset "${id}"`))
      return Promise.resolve(composition)
    },
  }
}

describe('ensureHostedPreset', () => {
  it('writes the stripped composition and metadata into the user preset root', async () => {
    const home = await tempDir()
    const changed = await ensureHostedPreset(home, sourceOf(STANDARD))
    expect(changed).toBe(true)
    const dir = join(home, USER_PRESET_DIR, HOSTED_PRESET_ID)
    const composition = await readFile(join(dir, COMPOSITION_FILE), 'utf8')
    expect(composition).toContain('Managed by dsh-loop-engine')
    expect(composition).toContain('- id: persona')
    expect(composition).not.toContain('skill-filesystem')
    const metadata = await readFile(join(dir, METADATA_FILE), 'utf8')
    expect(metadata).toContain('Hosted Engine')
  })

  it('is idempotent: a second run over the same source writes nothing', async () => {
    const home = await tempDir()
    await ensureHostedPreset(home, sourceOf(STANDARD))
    expect(await ensureHostedPreset(home, sourceOf(STANDARD))).toBe(false)
  })

  it('rewrites when the source composition changed', async () => {
    const home = await tempDir()
    await ensureHostedPreset(home, sourceOf(STANDARD))
    const updated = `${STANDARD}- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n`
    expect(await ensureHostedPreset(home, sourceOf(updated))).toBe(true)
    const composition = await readFile(join(home, USER_PRESET_DIR, HOSTED_PRESET_ID, COMPOSITION_FILE), 'utf8')
    expect(composition).toContain('- id: tool-web')
  })

  it('propagates a source read failure without writing anything', async () => {
    const home = await tempDir()
    await expect(ensureHostedPreset(home, sourceOf(''))).resolves.toBe(true) // empty source still authors
    await expect(ensureHostedPreset(home, {
      read: () => Promise.reject(new Error('unknown preset "standard"')),
    })).rejects.toThrow('unknown preset')
  })

  it('propagates an unwritable target instead of swallowing it', async () => {
    const home = await tempDir()
    // A directory occupying the composition path: the read fails (falling
    // through to the write) and the rename over a non-empty directory fails.
    const dir = join(home, USER_PRESET_DIR, HOSTED_PRESET_ID)
    await mkdir(join(dir, COMPOSITION_FILE), { recursive: true })
    await writeFile(join(dir, COMPOSITION_FILE, 'occupant'), 'x')
    await expect(ensureHostedPreset(home, sourceOf(STANDARD))).rejects.toThrow()
  })
})
