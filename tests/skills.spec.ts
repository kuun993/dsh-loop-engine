/**
 * Discovery and parsing tests for the Claude Code skill provider.
 * @module tests/skills
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCodeSkillProvider, type SkillCandidate, type SkillProviderControl } from '../src/skills.ts'

const mocks = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importActual) => ({
  ...(await importActual<typeof import('node:os')>()),
  homedir: () => mocks.home,
}))

let root: string
let home: string

function control(signal: AbortSignal = new AbortController().signal): SkillProviderControl {
  return { signal, invalidate() {} }
}

function provider(signal?: AbortSignal): ClaudeCodeSkillProvider {
  return new ClaudeCodeSkillProvider(control(signal))
}

/** Write a skill file, creating parent directories as needed. */
async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** A project tree with a git marker at its root. */
async function makeProject(): Promise<string> {
  const project = join(root, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  return project
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-skills-test-'))
  home = join(root, 'home')
  await mkdir(home, { recursive: true })
  mocks.home = home
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('discovery locations', () => {
  it('lists nothing when no skills exist anywhere', async () => {
    expect(await provider().list({ cwd: await makeProject() })).toEqual([])
  })

  it('scans only the user home when cwd is undefined', async () => {
    await put(join(home, '.claude/skills/home-skill/SKILL.md'), '---\nname: home-skill\ndescription: Home\n---\nBody\n')
    const candidates = await provider().list({})
    expect(candidates.map(c => c.name)).toEqual(['home-skill'])
    expect(candidates[0]?.rank).toBe(160)
  })

  it('finds project skills in both layouts, anchored at the git root', async () => {
    const project = await makeProject()
    await put(join(project, '.claude/skills/flat.md'), '---\nname: flat\ndescription: Flat file\n---\nFlat body\n')
    await put(join(project, '.claude/skills/dir-skill/SKILL.md'), '---\nname: dir-skill\ndescription: Directory\n---\nDir body\n')
    const nested = join(project, 'src/deep')
    await mkdir(nested, { recursive: true })
    const candidates = await provider().list({ cwd: nested })
    expect(candidates.map(c => [c.name, c.rank])).toEqual([['dir-skill', 150], ['flat', 150]])
    const byName = new Map(candidates.map(c => [c.name, c]))
    // A directory-layout skill resolves resources against its own directory.
    expect(byName.get('dir-skill')?.resourceBase).toEqual({ kind: 'directory', path: join(project, '.claude/skills/dir-skill') })
    // A flat skill resolves resources against the shared skills directory.
    expect(byName.get('flat')?.resourceBase).toEqual({ kind: 'directory', path: join(project, '.claude/skills') })
  })

  it('falls back to cwd when no git root exists', async () => {
    const lone = join(root, 'lone')
    await put(join(lone, '.claude/skills/lone-skill.md'), '---\nname: lone-skill\ndescription: Lone\n---\nBody\n')
    const candidates = await provider().list({ cwd: lone })
    expect(candidates.map(c => c.name)).toEqual(['lone-skill'])
  })

  it('sorts entries by name within one directory', async () => {
    const project = await makeProject()
    await put(join(project, '.claude/skills/zeta.md'), '---\nname: zeta\ndescription: Z\n---\nZ\n')
    await put(join(project, '.claude/skills/alpha.md'), '---\nname: alpha\ndescription: A\n---\nA\n')
    const candidates = await provider().list({ cwd: project })
    expect(candidates.map(c => c.name)).toEqual(['alpha', 'zeta'])
  })

  it('ignores non-markdown files and directories without SKILL.md', async () => {
    const project = await makeProject()
    await put(join(project, '.claude/skills/readme.txt'), 'not a skill\n')
    await mkdir(join(project, '.claude/skills/empty-dir'), { recursive: true })
    expect(await provider().list({ cwd: project })).toEqual([])
  })

  it('returns an empty catalog when discovery is aborted', async () => {
    const project = await makeProject()
    await put(join(project, '.claude/skills/flat.md'), '---\nname: flat\ndescription: Flat\n---\nBody\n')
    const controller = new AbortController()
    controller.abort()
    expect(await provider(controller.signal).list({ cwd: project })).toEqual([])
  })
})

describe('CLAUDE.md', () => {
  it('collects a CLAUDE.md carrying skill frontmatter', async () => {
    const project = await makeProject()
    await put(join(project, 'CLAUDE.md'), '---\nname: project-notes\ndescription: Notes\n---\nRemember this.\n')
    const candidates = await provider().list({ cwd: project })
    expect(candidates.map(c => c.name)).toEqual(['project-notes'])
    expect(candidates[0]?.resourceBase).toEqual({ kind: 'directory', path: project })
  })

  it('ignores a frontmatter-less CLAUDE.md', async () => {
    const project = await makeProject()
    await put(join(project, 'CLAUDE.md'), 'AGENTS.md\n')
    expect(await provider().list({ cwd: project })).toEqual([])
  })

  it('ignores a CLAUDE.md that is a directory', async () => {
    const project = await makeProject()
    await mkdir(join(project, 'CLAUDE.md'), { recursive: true })
    expect(await provider().list({ cwd: project })).toEqual([])
  })
})

describe('frontmatter parsing', () => {
  async function namesOf(content: string): Promise<readonly SkillCandidate[]> {
    const project = await makeProject()
    await put(join(project, '.claude/skills/probe.md'), content)
    return provider().list({ cwd: project })
  }

  it('rejects files without an opening fence, a closing fence, or any newline', async () => {
    expect(await namesOf('no frontmatter\n')).toEqual([])
    expect(await namesOf('---\nname: x\n')).toEqual([])
    expect(await namesOf('---')).toEqual([])
  })

  it('accepts a closing fence at end of file without a trailing newline', async () => {
    const candidates = await namesOf('---\nname: eof-fence\ndescription: EOF\n---')
    expect(candidates.map(c => c.name)).toEqual(['eof-fence'])
  })

  it('rejects a missing, empty, or invalid name and a missing description', async () => {
    expect(await namesOf('---\ndescription: No name\n---\nB\n')).toEqual([])
    expect(await namesOf('---\nname: ""\ndescription: Empty name\n---\nB\n')).toEqual([])
    expect(await namesOf('---\nname: Not-Kebab\ndescription: Bad name\n---\nB\n')).toEqual([])
    expect(await namesOf('---\nname: no-desc\n---\nB\n')).toEqual([])
  })

  it('skips comments, colon-less lines, and keyless lines', async () => {
    const candidates = await namesOf('---\n# comment\nstray line\n: orphan\nname: ok-skill\ndescription: Fine\n---\nB\n')
    expect(candidates.map(c => c.name)).toEqual(['ok-skill'])
  })

  it('unquotes single- and double-quoted scalars but keeps mismatched quotes', async () => {
    const project = await makeProject()
    await put(join(project, '.claude/skills/dq.md'), '---\nname: dq\ndescription: "Double quoted"\n---\nB\n')
    await put(join(project, '.claude/skills/sq.md'), "---\nname: sq\ndescription: 'Single quoted'\n---\nB\n")
    await put(join(project, '.claude/skills/mq.md'), '---\nname: mq\ndescription: "Mismatched\'\n---\nB\n')
    const candidates = await provider().list({ cwd: project })
    const byName = new Map(candidates.map(c => [c.name, c.description]))
    expect(byName.get('dq')).toBe('Double quoted')
    expect(byName.get('sq')).toBe('Single quoted')
    expect(byName.get('mq')).toBe('"Mismatched\'')
  })

  it('folds `>` block scalars with spaces, including a trailing block', async () => {
    const candidates = await namesOf('---\nname: folded\ndescription: >\n  first line\n  second line\n---\nB\n')
    expect(candidates[0]?.description).toBe('first line second line')
    const trailing = await namesOf('---\nname: trailing\ndescription: >-\n  only line\n---\nB\n')
    expect(trailing[0]?.description).toBe('only line')
  })

  it('keeps newlines in `|` block scalars and skips blank block lines', async () => {
    const candidates = await namesOf('---\nname: literal\ndescription: |\n  one\n\n  two\nwhenToUse: now\n---\nB\n')
    expect(candidates[0]?.description).toBe('one\ntwo')
    expect(candidates[0]?.whenToUse).toBe('now')
    const stripped = await namesOf('---\nname: strip\ndescription: |-\n  x\n---\nB\n')
    expect(stripped[0]?.description).toBe('x')
  })

  it('maps invocation flags from true/yes/false/no and ignores garbage', async () => {
    const project = await makeProject()
    await put(join(project, '.claude/skills/a.md'), '---\nname: a\ndescription: A\ndisable-model-invocation: true\n---\nB\n')
    await put(join(project, '.claude/skills/b.md'), '---\nname: b\ndescription: B\ndisable-model-invocation: yes\nuser-invocable: false\n---\nB\n')
    await put(join(project, '.claude/skills/c.md'), '---\nname: c\ndescription: C\ndisable-model-invocation: no\nuser-invocable: maybe\n---\nB\n')
    const candidates = await provider().list({ cwd: project })
    const byName = new Map(candidates.map(c => [c.name, c.invocation]))
    expect(byName.get('a')).toEqual({ modelInvocable: false, userInvocable: true })
    expect(byName.get('b')).toEqual({ modelInvocable: false, userInvocable: false })
    expect(byName.get('c')).toEqual({ modelInvocable: true, userInvocable: true })
  })
})

describe('get', () => {
  async function candidateOf(content: string, withWhenToUse = false): Promise<SkillCandidate> {
    const project = await makeProject()
    await put(join(project, '.claude/skills/probe.md'), content)
    const candidates = await provider().list({ cwd: project })
    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('no candidate discovered')
    return candidate
  }

  it('loads the full definition, resource base included', async () => {
    const candidate = await candidateOf('---\nname: probe\ndescription: P\nwhenToUse: always\nuser-invocable: false\n---\nBody text\n')
    const definition = await provider().get(candidate, {})
    expect(definition).toEqual({
      name: 'probe',
      description: 'P',
      whenToUse: 'always',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'custom',
      provider: 'claude-code',
      content: 'Body text',
      path: candidate.path,
      resourceBase: candidate.resourceBase,
    })
  })

  it('omits whenToUse and resourceBase when the candidate lacks them', async () => {
    const candidate = await candidateOf('---\nname: probe\ndescription: P\n---\nBody\n')
    const bare: SkillCandidate = {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      rank: candidate.rank,
      locator: candidate.locator,
    }
    const definition = await provider().get(bare, {})
    expect(definition?.whenToUse).toBeUndefined()
    expect(definition?.resourceBase).toBeUndefined()
  })

  it('returns undefined when the file vanished or no longer parses', async () => {
    const candidate = await candidateOf('---\nname: probe\ndescription: P\n---\nBody\n')
    const missing = { ...candidate, locator: { kind: 'file' as const, path: join(root, 'gone.md') } }
    expect(await provider().get(missing, {})).toBeUndefined()
    await put(join(root, 'project/.claude/skills/probe.md'), 'garbled\n')
    expect(await provider().get(candidate, {})).toBeUndefined()
  })
})

describe('default export', () => {
  it('exposes the provider class as default', async () => {
    const module = await import('../src/skills.ts')
    expect(module.default).toBe(ClaudeCodeSkillProvider)
    expect(new module.default(control()).name).toBe('claude-code')
  })
})
