/**
 * Unit tests for the KimiSkillProvider: context-file discovery (AGENTS.md across
 * the cwd→git-root walk), kimi SKILL.md skill discovery, and content loading.
 * @module tests/engine-kimi/skills
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KimiSkillProvider, kimiAgentDir } from '../../src/engine-kimi/skills.ts'
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
  project = await mkdtemp(join(tmpdir(), 'kimi-skill-'))
  home = await mkdtemp(join(tmpdir(), 'kimi-home-'))
  mockHome.path = home
  delete process.env.KIMI_CODE_HOME
  await mkdir(join(home, '.kimi-code'), { recursive: true })
})

afterEach(async () => {
  delete process.env.KIMI_CODE_HOME
  await rm(project, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('kimiAgentDir', () => {
  it('defaults to ~/.kimi-code and honors the KIMI_CODE_HOME override', () => {
    expect(kimiAgentDir()).toBe(join(home, '.kimi-code'))
    process.env.KIMI_CODE_HOME = join(home, 'custom-kimi')
    expect(kimiAgentDir()).toBe(join(home, 'custom-kimi'))
  })
})

describe('KimiSkillProvider.list context files', () => {
  it('discovers the project AGENTS.md when present', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Project instructions\nDo the thing.')
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      name: 'agents-md',
      provider: 'kimi',
      rank: 140,
      path: join(project, 'AGENTS.md'),
    })
  })

  it('ignores an empty AGENTS.md', async () => {
    await writeFile(join(project, 'AGENTS.md'), '   \n')
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('does not fail when the project AGENTS.md is missing', async () => {
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('merges AGENTS.md files from every directory between the cwd and the git root', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, 'sub'), { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), '# Root instructions')
    await writeFile(join(project, 'sub', 'AGENTS.md'), '# Sub instructions')
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: join(project, 'sub') } satisfies SkillLookupOptions)
    const candidate = candidates[0]!
    expect(candidate.path).toBe(join(project, 'sub', 'AGENTS.md'))
    expect((candidate.locator as { paths: string[] }).paths).toEqual([
      join(project, 'sub', 'AGENTS.md'),
      join(project, 'AGENTS.md'),
    ])
  })
})

describe('KimiSkillProvider.list skills', () => {
  it('discovers project and user skills with their SKILL.md catalog entries', async () => {
    await mkdir(join(project, '.kimi-code', 'skills', 'my-skill'), { recursive: true })
    await writeFile(join(project, '.kimi-code', 'skills', 'my-skill', 'SKILL.md'), [
      '---',
      'name: my-skill',
      'description: Do the my-skill thing',
      '---',
      '# My Skill',
      'Body.',
    ].join('\n'))
    await mkdir(join(home, '.kimi-code', 'skills', 'personal-magic'), { recursive: true })
    await writeFile(join(home, '.kimi-code', 'skills', 'personal-magic', 'SKILL.md'), [
      '---',
      'name: personal-magic',
      'description: Personal magic helper',
      '---',
      '# Magic',
    ].join('\n'))
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    const projectSkill = candidates.find(candidate => candidate.name === 'my-skill')
    const userSkill = candidates.find(candidate => candidate.name === 'personal-magic')
    expect(projectSkill).toMatchObject({ provider: 'kimi', rank: 150 })
    expect(projectSkill?.resourceBase).toEqual({ kind: 'directory', path: join(project, '.kimi-code', 'skills', 'my-skill') })
    expect(userSkill).toMatchObject({ provider: 'kimi', rank: 160 })
    const definition = await provider.get(projectSkill as SkillCandidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toMatchObject({ name: 'my-skill', content: '# My Skill\nBody.' })
    expect(definition?.whenToUse).toBeUndefined()
  })

  it('honors the KIMI_CODE_HOME override for user-level skills', async () => {
    const alt = join(home, 'alt-kimi')
    process.env.KIMI_CODE_HOME = alt
    await mkdir(join(alt, 'skills', 'alt-skill'), { recursive: true })
    await writeFile(join(alt, 'skills', 'alt-skill', 'SKILL.md'), [
      '---',
      'name: alt-skill',
      'description: Overridden user skill',
      '---',
      '# Alt',
    ].join('\n'))
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({} satisfies SkillLookupOptions)
    const altSkill = candidates.find(candidate => candidate.name === 'alt-skill')
    expect(altSkill).toMatchObject({ provider: 'kimi', rank: 160 })
  })

  it('discovers flat markdown skills with valid frontmatter', async () => {
    await mkdir(join(project, '.kimi-code', 'skills'), { recursive: true })
    await writeFile(join(project, '.kimi-code', 'skills', 'flat.md'), [
      '---',
      'name: flat-tool',
      'description: A flat skill file',
      '---',
      '# Flat',
    ].join('\n'))
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates.find(candidate => candidate.name === 'flat-tool')).toBeDefined()
  })

  it('skips non-skill and unreadable entries in a skills directory', async () => {
    await mkdir(join(project, '.kimi-code', 'skills'), { recursive: true })
    await writeFile(join(project, '.kimi-code', 'skills', 'notes.txt'), 'not a skill\n')
    await writeFile(join(project, '.kimi-code', 'skills', 'readme.md'), '# Just a heading\n')
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('does not fail when the skills directories are missing', async () => {
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('skips a skill directory without a SKILL.md', async () => {
    await mkdir(join(project, '.kimi-code', 'skills', 'empty-dir'), { recursive: true })
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('returns an empty list when the abort signal fires', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Instructions')
    const aborted = new AbortController()
    aborted.abort()
    const provider = new KimiSkillProvider({ signal: aborted.signal, invalidate: () => {} })
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })
})

describe('KimiSkillProvider.get', () => {
  it('loads a SKILL.md body for a skill candidate', async () => {
    await mkdir(join(project, '.kimi-code', 'skills', 'my-skill'), { recursive: true })
    await writeFile(join(project, '.kimi-code', 'skills', 'my-skill', 'SKILL.md'), [
      '---',
      'name: my-skill',
      'description: Do the my-skill thing',
      'whenToUse: when asked about my-skill',
      '---',
      '# My Skill',
      'Body.',
    ].join('\n'))
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    const candidate = candidates.find(c => c.name === 'my-skill') as SkillCandidate
    const definition = await provider.get(candidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toMatchObject({
      name: 'my-skill',
      provider: 'kimi',
      whenToUse: 'when asked about my-skill',
      content: '# My Skill\nBody.',
    })
  })

  it('concatenates the merged AGENTS.md files for an agents-md candidate', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, 'sub'), { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), '# Root instructions')
    await writeFile(join(project, 'sub', 'AGENTS.md'), '# Sub instructions')
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: join(project, 'sub') } satisfies SkillLookupOptions)
    const definition = await provider.get(candidates[0] as SkillCandidate, { cwd: join(project, 'sub') } satisfies SkillLookupOptions)
    expect(definition).toMatchObject({
      name: 'agents-md',
      provider: 'kimi',
      content: '# Sub instructions\n\n# Root instructions',
    })
    expect(definition?.resourceBase).toEqual({ kind: 'file', path: join(project, 'sub', 'AGENTS.md') })
  })

  it('returns undefined when the AGENTS.md is gone', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Instructions')
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    await rm(join(project, 'AGENTS.md'))
    const definition = await provider.get(candidates[0] as SkillCandidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toBeUndefined()
  })

  it('returns undefined when the SKILL.md is gone', async () => {
    await mkdir(join(project, '.kimi-code', 'skills', 'my-skill'), { recursive: true })
    const skillPath = join(project, '.kimi-code', 'skills', 'my-skill', 'SKILL.md')
    await writeFile(skillPath, [
      '---',
      'name: my-skill',
      'description: Do the my-skill thing',
      '---',
      '# My Skill',
    ].join('\n'))
    const provider = new KimiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    await rm(skillPath)
    const definition = await provider.get(candidates.find(c => c.name === 'my-skill') as SkillCandidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toBeUndefined()
  })
})
