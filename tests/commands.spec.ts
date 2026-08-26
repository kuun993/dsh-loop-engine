/**
 * Shape tests for the Claude Code slash-command stubs.
 * @module tests/commands
 */

import { describe, expect, it } from 'vitest'
import { CLAUDE_CODE_COMMANDS, type CommandInvocation } from '../src/commands.ts'

function invocation(commandId: string): CommandInvocation {
  return { commandId, rawInput: '', signal: new AbortController().signal }
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

  it('returns success from every stub handler', async () => {
    for (const command of CLAUDE_CODE_COMMANDS) {
      await expect(command.handler(invocation(command.name))).resolves.toEqual({ kind: 'success' })
    }
  })
})
