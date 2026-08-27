/**
 * Unit tests for the CodexSkillProvider: AGENTS.md discovery from the project
 * root and user home, and content loading for matched candidates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSkillProvider } from '../../src/engine-codex/skills.ts'
import type { SkillCandidate, SkillLookupOptions, SkillProviderControl } from '../../src/skills.ts'

/** Hoisted home path so the os homedir mock can return it. */
const mockHome = vi.hoisted(() => ({ path: '' }))

vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>()
  return { ...mod, homedir: () => mockHome.path }
})

/** Minimal control: a never-aborted signal and a no-op invalidate. */
function control(): SkillProviderControl {
  return { signal: new AbortController().signal, invalidate: () => {} }
}

let project: string
let home: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'codex-skill-'))
  home = await mkdtemp(join(tmpdir(), 'codex-home-'))
  mockHome.path = home
  await mkdir(join(home, '.codex'), { recursive: true })
})

afterEach(async () => {
  await rm(project, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('CodexSkillProvider.list', () => {
  it('discovers the project AGENTS.md when present', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Project instructions\nDo the thing.')
    const provider = new CodexSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      name: 'agents-md',
      description: 'Codex project/user instructions (AGENTS.md)',
      provider: 'codex',
      rank: 140,
    })
  })

  it('ignores an empty AGENTS.md', async () => {
    await writeFile(join(project, 'AGENTS.md'), '   \n')
    const provider = new CodexSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('does not fail when the project AGENTS.md is missing', async () => {
    const provider = new CodexSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('discovers the user AGENTS.md from the home directory', async () => {
    await writeFile(join(home, '.codex', 'AGENTS.md'), '# User instructions')
    const provider = new CodexSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ rank: 160 })
  })

  it('walks up to the git root for the project AGENTS.md', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, 'sub', 'dir'), { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), '# Root instructions')
    const provider = new CodexSkillProvider(control())
    const candidates = await provider.list({ cwd: join(project, 'sub', 'dir') } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.path).toBe(join(project, 'AGENTS.md'))
  })

  it('lists only user-level AGENTS.md when no cwd is provided', async () => {
    await writeFile(join(home, '.codex', 'AGENTS.md'), '# User instructions')
    const provider = new CodexSkillProvider(control())
    const candidates = await provider.list({} satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.rank).toBe(160)
  })

  it('returns an empty list when the abort signal fires', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const provider = new CodexSkillProvider({ signal: aborted.signal, invalidate: () => {} })
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })
})

describe('CodexSkillProvider.get', () => {
  it('loads the AGENTS.md content for a matched candidate', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Instructions\nBody text.')
    const provider = new CodexSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    const definition = await provider.get(candidates[0] as SkillCandidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toMatchObject({
      name: 'agents-md',
      provider: 'codex',
      content: '# Instructions\nBody text.',
    })
    expect(definition?.resourceBase).toEqual({ kind: 'file', path: join(project, 'AGENTS.md') })
  })

  it('returns undefined when the file is gone', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Instructions')
    const provider = new CodexSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    await rm(join(project, 'AGENTS.md'))
    const definition = await provider.get(candidates[0] as SkillCandidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toBeUndefined()
  })
})
