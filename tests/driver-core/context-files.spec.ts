/**
 * Unit tests for the shared context-file walk and body loading used by the
 * codex and pi skill providers.
 * @module tests/driver-core/context-files
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  anySourceNonEmpty,
  collectProjectContextFiles,
  fileNonEmpty,
  projectAncestors,
  readOptionalFile,
  readSources,
} from '../../src/driver-core/context-files.ts'

let project: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'ctx-files-'))
})

afterEach(async () => {
  await rm(project, { recursive: true, force: true })
})

describe('projectAncestors', () => {
  it('walks from cwd up to the git root, nearest first', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, 'a', 'b'), { recursive: true })
    const dirs = await projectAncestors(join(project, 'a', 'b'))
    expect(dirs).toEqual([join(project, 'a', 'b'), join(project, 'a'), project])
  })

  it('returns just the cwd when no repository exists', async () => {
    const dirs = await projectAncestors(project)
    expect(dirs).toEqual([project])
  })
})

describe('collectProjectContextFiles', () => {
  const policy = { override: 'AGENTS.override.md', primary: ['AGENTS.md', 'CLAUDE.md'] } as const

  it('prefers the per-directory override over the primary files', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), 'primary')
    await writeFile(join(project, 'AGENTS.override.md'), 'override')
    expect(await collectProjectContextFiles(project, policy)).toEqual([join(project, 'AGENTS.override.md')])
  })

  it('falls back through the primary files in order', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await writeFile(join(project, 'CLAUDE.md'), 'claude')
    expect(await collectProjectContextFiles(project, policy)).toEqual([join(project, 'CLAUDE.md')])
  })

  it('collects one file per directory while walking up, skipping empty directories', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, 'sub', 'deep'), { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), 'root')
    await writeFile(join(project, 'sub', 'CLAUDE.md'), 'intermediate')
    expect(await collectProjectContextFiles(join(project, 'sub', 'deep'), policy))
      .toEqual([join(project, 'sub', 'CLAUDE.md'), join(project, 'AGENTS.md')])
  })

  it('returns an empty list without a repository or context files', async () => {
    expect(await collectProjectContextFiles(project, policy)).toEqual([])
  })
})

describe('body loading helpers', () => {
  it('readOptionalFile returns the body or undefined', async () => {
    const path = join(project, 'a.txt')
    await writeFile(path, 'hello')
    expect(await readOptionalFile(path)).toBe('hello')
    expect(await readOptionalFile(join(project, 'missing.txt'))).toBeUndefined()
  })

  it('fileNonEmpty is false for missing and blank files and true for content', async () => {
    expect(await fileNonEmpty(join(project, 'missing.txt'))).toBe(false)
    const blank = join(project, 'blank.txt')
    await writeFile(blank, '   \n')
    expect(await fileNonEmpty(blank)).toBe(false)
    const text = join(project, 'text.txt')
    await writeFile(text, 'body')
    expect(await fileNonEmpty(text)).toBe(true)
  })

  it('anySourceNonEmpty is false when all sources are empty or missing', async () => {
    const blank = join(project, 'blank.txt')
    await writeFile(blank, '   \n')
    expect(await anySourceNonEmpty([blank, join(project, 'missing.txt')])).toBe(false)
  })

  it('anySourceNonEmpty is true when any source carries content', async () => {
    const text = join(project, 'text.txt')
    await writeFile(text, 'body')
    const blank = join(project, 'blank.txt')
    await writeFile(blank, '   \n')
    expect(await anySourceNonEmpty([blank, text])).toBe(true)
  })

  it('readSources concatenates non-empty bodies in order', async () => {
    const first = join(project, 'a.md')
    await writeFile(first, 'first')
    const blank = join(project, 'blank.md')
    await writeFile(blank, '   ')
    const second = join(project, 'b.md')
    await writeFile(second, 'second')
    const content = await readSources([first, blank, second, join(project, 'missing.md')])
    expect(content).toBe('first\n\nsecond')
  })

  it('readSources returns undefined when nothing is readable', async () => {
    expect(await readSources([join(project, 'missing.md')])).toBeUndefined()
  })
})