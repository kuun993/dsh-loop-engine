/**
 * The two halves of the step-balance rule the hosted drivers must satisfy:
 * which calls a step still owes a result (`step-tools.ts`), and what closing
 * such a step writes (`step-close.ts`). Session format v4 refuses a `step/end`
 * that leaves an announced call unresolved, so these are the units that decide
 * whether a driver's transcript is loadable at all.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createStepTools } from '../../src/driver-core/step-tools.ts'
import { closeStep, settleResult } from '../../src/driver-core/step-close.ts'
import { toolResultView } from '../helpers/harness-generation.ts'

/** A call id, branded the way the drivers brand theirs. */
const call = (id: string): ToolCallId => id as ToolCallId

/** A session that records what was appended, standing in for the durable log. */
function fakeSession(): { session: Session; appended: Array<{ type: string; data: Record<string, unknown> }> } {
  const appended: Array<{ type: string; data: Record<string, unknown> }> = []
  const session = {
    append: vi.fn((type: string, data: Record<string, unknown>) => {
      appended.push({ type, data })
      return { seq: appended.length }
    }),
  } as unknown as Session
  return { session, appended }
}

describe('createStepTools', () => {
  it('owes every announced call until it is settled', () => {
    const tools = createStepTools()
    expect(tools.balanced).toBe(true)

    tools.announce(call('a'))
    expect(tools.balanced).toBe(false)
    expect(tools.pending).toEqual(['a'])

    expect(tools.settle(call('a'))).toBe(true)
    expect(tools.balanced).toBe(true)
    expect(tools.pending).toEqual([])
  })

  it('refuses a second result for a call settled in the same step', () => {
    const tools = createStepTools()
    tools.announce(call('a'))
    expect(tools.settle(call('a'))).toBe(true)
    // The Claude Agent SDK redelivers each result ~57 ms later; V4 refuses the
    // duplicate, so the second write must be refused here instead.
    expect(tools.settle(call('a'))).toBe(false)
  })

  it('keeps the pending calls in announcement order', () => {
    const tools = createStepTools()
    for (const id of ['first', 'second', 'third']) tools.announce(call(id))
    expect(tools.pending).toEqual(['first', 'second', 'third'])
    tools.settle(call('second'))
    expect(tools.pending).toEqual(['first', 'third'])
  })

  it('settles a result for a call this step never announced', () => {
    const tools = createStepTools()
    // A result arriving in a step that did not announce it is not a duplicate:
    // the log advertised the call elsewhere, so the write must go through.
    expect(tools.settle(call('elsewhere'))).toBe(true)
  })

  it('forgets everything on clear, for the next step', () => {
    const tools = createStepTools()
    tools.announce(call('a'))
    tools.settle(call('b'))
    tools.clear()
    expect(tools.balanced).toBe(true)
    expect(tools.pending).toEqual([])
    // `settle` forgets the duplicate mark too: a call id is unique per session,
    // so a cleared step can never see the same one again.
    expect(tools.settle(call('b'))).toBe(true)
  })
})

describe('settleResult', () => {
  it('writes the first result of a call and drops a repeat', () => {
    const tools = createStepTools()
    const write = vi.fn()

    settleResult(tools, call('a'), write)
    // The engine reports the same outcome twice (the SDK redelivers it, or Pi
    // reports one execution from two events); v4 refuses the second write.
    settleResult(tools, call('a'), write)

    expect(write).toHaveBeenCalledTimes(1)
    expect(tools.balanced).toBe(true)
  })

  it('writes each call of a step once', () => {
    const tools = createStepTools()
    const written: string[] = []
    for (const id of ['a', 'b']) settleResult(tools, call(id), () => { written.push(id) })

    expect(written).toEqual(['a', 'b'])
  })
})

describe('closeStep', () => {
  it('ends a balanced step without inventing anything', () => {
    const { session, appended } = fakeSession()
    const tools = createStepTools()
    tools.announce(call('a'))
    tools.settle(call('a'))

    closeStep(session, tools, 2, 3)

    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ type: 'step/end', data: { turn: 2, step: 3 } })
  })

  it('closes every unanswered call before the step ends', () => {
    const { session, appended } = fakeSession()
    const tools = createStepTools()
    tools.announce(call('answered'))
    tools.announce(call('lost'))
    tools.settle(call('answered'))

    closeStep(session, tools, 5, 4)

    expect(appended.map(entry => entry.type)).toEqual(['tool/result', 'step/end'])
    const result = appended[0]!.data
    expect(result).toMatchObject({
      turn: 5,
      step: 4,
      error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
    })
    const view = toolResultView(result.message)
    expect(view.toolCallId).toBe('lost')
    expect(view.isError).toBe(true)
    // The model is told the outcome is unknown and how to decide about a retry.
    expect(JSON.stringify(view.content)).toContain('outcome is unknown')
  })

  it('closes several unanswered calls in announcement order', () => {
    const { session, appended } = fakeSession()
    const tools = createStepTools()
    for (const id of ['one', 'two']) tools.announce(call(id))

    closeStep(session, tools, 1, 1)

    expect(appended.map(entry => entry.type)).toEqual(['tool/result', 'tool/result', 'step/end'])
    expect(appended
      .filter(entry => entry.type === 'tool/result')
      .map(entry => toolResultView(entry.data.message).toolCallId))
      .toEqual(['one', 'two'])
  })
})
