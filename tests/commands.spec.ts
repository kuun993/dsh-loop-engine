/**
 * Shape tests for the Claude Code slash-command bridge: forwarding built-ins
 * and user-level custom command discovery.
 * @module tests/commands
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_CODE_COMMANDS,
  discoverUserSlashCommands,
  forwardClaudeCodeCommand,
  type CommandInvocation,
} from '../src/commands.ts'

/** Hoisted home path so the os homedir mock can return it. */
const mockHome = vi.hoisted(() => ({ path: '' }))

vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>()
  return { ...mod, homedir: () => mockHome.path }
})

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'commands-home-'))
  mockHome.path = home
  await mkdir(join(home, '.claude', 'commands'), { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Invocation with a recording forwarding agent (inferred shape; cast to CommandInvocation at call sites). */
function invocation(name: string, rawInput = '') {
  const forwarded: string[] = []
  const agent = {
    followup: vi.fn((input: { content: ReadonlyArray<{ type: 'text'; text: string }> }) => {
      forwarded.push(input.content[0]!.text)
    }),
  }
  return { commandId: `cmd-${name}`, agent, rawInput, signal: new AbortController().signal, forwarded }
}

describe('CLAUDE_CODE_COMMANDS', () => {
  it('defines unique kebab-case commands with descriptions', () => {
    const names = CLAUDE_CODE_COMMANDS.map(command => command.name)
    expect(new Set(names).size).toBe(names.length)
    for (const command of CLAUDE_CODE_COMMANDS) {
      expect(command.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(command.description.length).toBeGreaterThan(0)
    }
  })

  it('forwards the raw line to the receiving agent from every handler', async () => {
    for (const command of CLAUDE_CODE_COMMANDS) {
      const call = invocation(command.name, ' extra args')
      const result = await command.handler(call as unknown as CommandInvocation)
      expect(result).toEqual({ kind: 'success' })
      expect(call.agent.followup).toHaveBeenCalledTimes(1)
      expect(call.forwarded).toEqual([`/${command.name} extra args`])
    }
  })
})

describe('forwardClaudeCodeCommand', () => {
  it('preserves the raw input separator and arguments', async () => {
    const handler = forwardClaudeCodeCommand('compact')
    const call = invocation('compact', ' now')
    await handler(call as unknown as CommandInvocation)
    expect(call.forwarded).toEqual(['/compact now'])
  })
})

describe('discoverUserSlashCommands', () => {
  it('returns an empty list when the commands directory does not exist', async () => {
    await rm(join(home, '.claude'), { recursive: true, force: true })
    expect(discoverUserSlashCommands()).toEqual([])
  })

  it('discovers command files with frontmatter descriptions', async () => {
    await writeFile(join(home, '.claude', 'commands', 'review-pr.md'), [
      '---',
      'a bare key without a colon',
      'description: "Review the current PR changes"',
      '---',
      'Review all files changed on this branch.',
    ].join('\n'))
    const definitions = discoverUserSlashCommands()
    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({
      name: 'review-pr',
      description: 'Review the current PR changes',
    })
  })

  it('falls back to the body line when the frontmatter description is empty', async () => {
    await writeFile(join(home, '.claude', 'commands', 'quiet.md'), [
      '---',
      'description:',
      '---',
      'Act quietly.',
    ].join('\n'))
    const definitions = discoverUserSlashCommands()
    expect(definitions[0]?.description).toBe('Act quietly.')
  })

  it('falls back to the first body line when no frontmatter description exists', async () => {
    await writeFile(join(home, '.claude', 'commands', 'triage.md'), [
      '---',
      'argument-hint: suite',
      '---',
      'Triage the failing test suite.',
    ].join('\n'))
    const definitions = discoverUserSlashCommands()
    expect(definitions[0]?.description).toBe('Triage the failing test suite.')
  })

  it('truncates an overlong body line in the fallback description', async () => {
    const body = 'x'.repeat(200)
    await writeFile(join(home, '.claude', 'commands', 'long.md'), body)
    const definitions = discoverUserSlashCommands()
    expect(definitions[0]?.description?.length).toBe(120)
  })

  it('skips non-markdown entries, invalid names, and built-in collisions', async () => {
    await writeFile(join(home, '.claude', 'commands', 'notes.txt'), 'not a command\n')
    await writeFile(join(home, '.claude', 'commands', 'Bad Name.md'), 'bad name\n')
    await writeFile(join(home, '.claude', 'commands', 'clear.md'), 'built-in collision\n')
    const definitions = discoverUserSlashCommands()
    expect(definitions).toEqual([])
  })

  it('skips unreadable entries such as a directory named like a command file', async () => {
    await mkdir(join(home, '.claude', 'commands', 'broken.md'), { recursive: true })
    const definitions = discoverUserSlashCommands()
    expect(definitions).toEqual([])
  })

  it('skips a file whose body is only headings', async () => {
    await writeFile(join(home, '.claude', 'commands', 'empty.md'), '# Title\n## Section\n')
    expect(discoverUserSlashCommands()).toEqual([])
  })

  it('skips an empty file', async () => {
    await writeFile(join(home, '.claude', 'commands', 'blank.md'), '   \n')
    expect(discoverUserSlashCommands()).toEqual([])
  })

  it('skips a dangling frontmatter opener without a body description', async () => {
    await writeFile(join(home, '.claude', 'commands', 'dangling.md'), '---\ndescription: never closed\n')
    expect(discoverUserSlashCommands()).toEqual([])
  })

  it('sorts discovered commands by file name', async () => {
    await writeFile(join(home, '.claude', 'commands', 'b-second.md'), 'Second command\n')
    await writeFile(join(home, '.claude', 'commands', 'a-first.md'), 'First command\n')
    expect(discoverUserSlashCommands().map(def => def.name)).toEqual(['a-first', 'b-second'])
  })

  it('builds forwarding handlers for discovered commands', async () => {
    await writeFile(join(home, '.claude', 'commands', 'ship.md'), 'Ship the build.\n')
    const [command] = discoverUserSlashCommands()
    const call = invocation('ship', ' --fast')
    await command!.handler(call as unknown as CommandInvocation)
    expect(call.forwarded).toEqual(['/ship --fast'])
  })
})