/**
 * Unit tests for the PiSkillProvider: context-file discovery (AGENTS.md /
 * CLAUDE.md / AGENTS.override.md across the cwd→git-root walk plus the
 * user-level file), pi SKILL.md skill discovery, and content loading.
 * @module tests/engine-pi/skills
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiSkillProvider, piAgentDir } from '../../src/engine-pi/skills.ts'
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
  project = await mkdtemp(join(tmpdir(), 'pi-skill-'))
  home = await mkdtemp(join(tmpdir(), 'pi-home-'))
  mockHome.path = home
  delete process.env.PI_CODING_AGENT_DIR
  await mkdir(join(home, '.pi', 'agent'), { recursive: true })
})

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR
  await rm(project, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('piAgentDir', () => {
  it('defaults to ~/.pi/agent and honors the PI_CODING_AGENT_DIR override', () => {
    expect(piAgentDir()).toBe(join(home, '.pi', 'agent'))
    process.env.PI_CODING_AGENT_DIR = join(home, 'custom-pi')
    expect(piAgentDir()).toBe(join(home, 'custom-pi'))
  })
})

describe('PiSkillProvider.list context files', () => {
  it('discovers the project AGENTS.md when present', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Project instructions\nDo the thing.')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      name: 'agents-md',
      provider: 'pi',
      rank: 140,
      path: join(project, 'AGENTS.md'),
    })
  })

  it('ignores an empty AGENTS.md', async () => {
    await writeFile(join(project, 'AGENTS.md'), '   \n')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('does not fail when the project AGENTS.md is missing', async () => {
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('prefers AGENTS.override.md in a directory that has one', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), '# Regular instructions')
    await writeFile(join(project, 'AGENTS.override.md'), '# Override instructions')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates[0]?.path).toBe(join(project, 'AGENTS.override.md'))
  })

  it('falls back to CLAUDE.md when AGENTS.md is absent in a directory', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await writeFile(join(project, 'CLAUDE.md'), '# Claude instructions')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates[0]?.path).toBe(join(project, 'CLAUDE.md'))
  })

  it('merges context files from every directory between the cwd and the git root', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, 'sub'), { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), '# Root instructions')
    await writeFile(join(project, 'sub', 'CLAUDE.md'), '# Sub instructions')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: join(project, 'sub') } satisfies SkillLookupOptions)
    const candidate = candidates[0]!
    expect(candidate.path).toBe(join(project, 'sub', 'CLAUDE.md'))
    expect((candidate.locator as { paths: string[] }).paths).toEqual([
      join(project, 'sub', 'CLAUDE.md'),
      join(project, 'AGENTS.md'),
    ])
  })

  it('discovers the user AGENTS.md from the pi agent directory', async () => {
    await writeFile(join(home, '.pi', 'agent', 'AGENTS.md'), '# User instructions')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ rank: 160, path: join(home, '.pi', 'agent', 'AGENTS.md') })
  })

  it('honors the PI_CODING_AGENT_DIR override for user-level files', async () => {
    const alt = join(home, 'alt-pi')
    process.env.PI_CODING_AGENT_DIR = alt
    await mkdir(join(alt, 'skills'), { recursive: true })
    await writeFile(join(alt, 'AGENTS.md'), '# Overridden user instructions')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({} satisfies SkillLookupOptions)
    expect(candidates[0]).toMatchObject({ rank: 160, path: join(alt, 'AGENTS.md') })
  })

  it('lists only user-level files when no cwd is provided', async () => {
    await writeFile(join(home, '.pi', 'agent', 'AGENTS.md'), '# User instructions')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({} satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.rank).toBe(160)
  })
})

describe('PiSkillProvider.list skills', () => {
  it('discovers project and user skills with their SKILL.md catalog entries', async () => {
    await mkdir(join(project, '.pi', 'skills', 'my-skill'), { recursive: true })
    await writeFile(join(project, '.pi', 'skills', 'my-skill', 'SKILL.md'), [
      '---',
      'name: my-skill',
      'description: Do the my-skill thing',
      '---',
      '# My Skill',
      'Body.',
    ].join('\n'))
    await mkdir(join(home, '.pi', 'agent', 'skills', 'personal-magic'), { recursive: true })
    await writeFile(join(home, '.pi', 'agent', 'skills', 'personal-magic', 'SKILL.md'), [
      '---',
      'name: personal-magic',
      'description: Personal magic helper',
      '---',
      '# Magic',
    ].join('\n'))
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    const projectSkill = candidates.find(candidate => candidate.name === 'my-skill')
    const userSkill = candidates.find(candidate => candidate.name === 'personal-magic')
    expect(projectSkill).toMatchObject({ provider: 'pi', rank: 150 })
    expect(projectSkill?.resourceBase).toEqual({ kind: 'directory', path: join(project, '.pi', 'skills', 'my-skill') })
    expect(userSkill).toMatchObject({ provider: 'pi', rank: 170 })
    // Loading a skill without a whenToUse field keeps the metadata lean.
    const definition = await provider.get(projectSkill as SkillCandidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toMatchObject({ name: 'my-skill', content: '# My Skill\nBody.' })
    expect(definition?.whenToUse).toBeUndefined()
  })

  it('discovers flat markdown skills with valid frontmatter', async () => {
    await mkdir(join(project, '.pi', 'skills'), { recursive: true })
    await writeFile(join(project, '.pi', 'skills', 'flat.md'), [
      '---',
      'name: flat-tool',
      'description: A flat skill file',
      '---',
      '# Flat',
    ].join('\n'))
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates.find(candidate => candidate.name === 'flat-tool')).toBeDefined()
  })

  it('skips non-skill and unreadable entries in a skills directory', async () => {
    await mkdir(join(project, '.pi', 'skills'), { recursive: true })
    await writeFile(join(project, '.pi', 'skills', 'notes.txt'), 'not a skill\n')
    await writeFile(join(project, '.pi', 'skills', 'readme.md'), '# Just a heading\n')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('does not fail when the skills directories are missing', async () => {
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('skips a skill directory without a SKILL.md', async () => {
    await mkdir(join(project, '.pi', 'skills', 'empty-dir'), { recursive: true })
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })

  it('returns an empty list when the abort signal fires', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Instructions')
    const aborted = new AbortController()
    aborted.abort()
    const provider = new PiSkillProvider({ signal: aborted.signal, invalidate: () => {} })
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    expect(candidates).toHaveLength(0)
  })
})

describe('PiSkillProvider.get', () => {
  it('loads a SKILL.md body for a skill candidate', async () => {
    await mkdir(join(project, '.pi', 'skills', 'my-skill'), { recursive: true })
    await writeFile(join(project, '.pi', 'skills', 'my-skill', 'SKILL.md'), [
      '---',
      'name: my-skill',
      'description: Do the my-skill thing',
      'whenToUse: when asked about my-skill',
      '---',
      '# My Skill',
      'Body.',
    ].join('\n'))
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    const candidate = candidates.find(c => c.name === 'my-skill') as SkillCandidate
    const definition = await provider.get(candidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toMatchObject({
      name: 'my-skill',
      provider: 'pi',
      whenToUse: 'when asked about my-skill',
      content: '# My Skill\nBody.',
    })
  })

  it('concatenates the merged context files for an agents-md candidate', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, 'sub'), { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), '# Root instructions')
    await writeFile(join(project, 'sub', 'CLAUDE.md'), '# Sub instructions')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: join(project, 'sub') } satisfies SkillLookupOptions)
    const definition = await provider.get(candidates[0] as SkillCandidate, { cwd: join(project, 'sub') } satisfies SkillLookupOptions)
    expect(definition).toMatchObject({
      name: 'agents-md',
      provider: 'pi',
      content: '# Sub instructions\n\n# Root instructions',
    })
    expect(definition?.resourceBase).toEqual({ kind: 'file', path: join(project, 'sub', 'CLAUDE.md') })
  })

  it('returns undefined when the AGENTS.md is gone', async () => {
    await writeFile(join(project, 'AGENTS.md'), '# Instructions')
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    await rm(join(project, 'AGENTS.md'))
    const definition = await provider.get(candidates[0] as SkillCandidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toBeUndefined()
  })

  it('returns undefined when the SKILL.md is gone', async () => {
    await mkdir(join(project, '.pi', 'skills', 'my-skill'), { recursive: true })
    const skillPath = join(project, '.pi', 'skills', 'my-skill', 'SKILL.md')
    await writeFile(skillPath, [
      '---',
      'name: my-skill',
      'description: Do the my-skill thing',
      '---',
      '# My Skill',
    ].join('\n'))
    const provider = new PiSkillProvider(control())
    const candidates = await provider.list({ cwd: project } satisfies SkillLookupOptions)
    await rm(skillPath)
    const definition = await provider.get(candidates.find(c => c.name === 'my-skill') as SkillCandidate, { cwd: project } satisfies SkillLookupOptions)
    expect(definition).toBeUndefined()
  })
})