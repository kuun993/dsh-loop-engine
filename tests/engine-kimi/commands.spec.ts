/**
 * Unit tests for the Kimi slash-command bridge: the forwarding handler delivers
 * the raw `/name [args]` line back to the receiving agent, and the built-in
 * commands surface a forwarding handler for each.
 * @module tests/engine-kimi/commands
 */

import { describe, expect, it, vi } from 'vitest'
import { forwardKimiCommand, KIMI_COMMANDS } from '../../src/engine-kimi/commands.ts'
import type { CommandInvocation } from '../../src/commands.ts'

/** A receiving agent stub recording followup deliveries. */
function agent() {
  const followup = vi.fn()
  return { agent: { followup }, followup }
}

describe('forwardKimiCommand', () => {
  it('delivers the full /name line back to the receiving agent as a user message', () => {
    const { agent: receiver, followup } = agent()
    const handler = forwardKimiCommand('compact')
    const invocation: CommandInvocation = { commandId: 'compact', agent: receiver, rawInput: ' keep notes', signal: new AbortController().signal }
    const result = handler(invocation)
    expect(result).toEqual({ kind: 'success' })
    expect(followup).toHaveBeenCalledTimes(1)
    const delivered = followup.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(delivered.content[0].text).toBe('/compact keep notes')
  })

  it('delivers the bare command name when there is no trailing input', () => {
    const { agent: receiver, followup } = agent()
    forwardKimiCommand('status')({ commandId: 'status', agent: receiver, rawInput: '', signal: new AbortController().signal })
    expect((followup.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0].text).toBe('/status')
  })
})

describe('KIMI_COMMANDS', () => {
  it('registers a forwarding handler for every built-in command', () => {
    expect(KIMI_COMMANDS.length).toBeGreaterThan(0)
    for (const command of KIMI_COMMANDS) {
      expect(command.name).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(command.description.length).toBeGreaterThan(0)
      const { agent: receiver, followup } = agent()
      const result = command.handler({ commandId: command.name, agent: receiver, rawInput: ' x', signal: new AbortController().signal })
      expect(result).toEqual({ kind: 'success' })
      expect(followup).toHaveBeenCalledTimes(1)
      expect((followup.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0].text).toBe(`/${command.name} x`)
    }
  })
})
