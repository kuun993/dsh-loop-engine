/**
 * The hosted drivers' protected system head. It is a 0.1.7-line need (format v4
 * requires a system message, when present, to be the FIRST surface event), so
 * the whole helper is a no-op on the 0.1.5 line — every case below expects ZERO
 * appends there and one where a head is due.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { LEGACY_HARNESS } from '../../src/compat.ts'
import { appendSystemHeadIfMissing } from '../../src/driver-core/system-head.ts'

interface FakeEvent {
  readonly type: string
  readonly surfaceOp?: unknown
}

/** How many appends a head-due case produces on the running generation. */
const HEAD_APPENDS = LEGACY_HARNESS ? 0 : 1

/** A session whose event log and appends are recorded, standing in for the durable log. */
function fakeSession(events: readonly FakeEvent[]): { session: Session; appended: unknown[][] } {
  const appended: unknown[][] = []
  const session = {
    snapshotEvents: () => events,
    append: (...args: unknown[]) => { appended.push(args) },
  } as unknown as Session
  return { session, appended }
}

describe('appendSystemHeadIfMissing', () => {
  it('appends an empty system head before any surface event', () => {
    const { session, appended } = fakeSession([{ type: 'session' }, { type: 'agent/inbox/spliced' }])
    appendSystemHeadIfMissing(session, 1, 1)
    expect(appended).toHaveLength(HEAD_APPENDS)
    if (LEGACY_HARNESS) return
    const [type, data, intent] = appended[0] as [string, { turn: number; step: number; message: unknown }, unknown]
    expect(type).toBe('system/message')
    expect(data.turn).toBe(1)
    expect(data.step).toBe(1)
    // `source.kind` is producer-owned and differs between generations; the
    // load-bearing facts are the role and the EMPTY content that keeps the head
    // out of the derived model history.
    expect(data.message).toMatchObject({ role: 'system', content: [] })
    expect(intent).toEqual({ surfaceOp: 'append' })
  })

  it('leaves a session that already carries a surface event untouched', () => {
    const { session, appended } = fakeSession([
      { type: 'session' },
      { type: 'user/message', surfaceOp: 'append' },
    ])
    appendSystemHeadIfMissing(session, 1, 1)
    expect(appended).toHaveLength(0)
  })

  it('ignores a surface-typed event that carries no surfaceOp', () => {
    const { session, appended } = fakeSession([{ type: 'user/message' }])
    appendSystemHeadIfMissing(session, 2, 3)
    expect(appended).toHaveLength(HEAD_APPENDS)
    if (LEGACY_HARNESS) return
    expect((appended[0] as [string])[0]).toBe('system/message')
  })

  it('skips a session whose head is already a system message', () => {
    const { session, appended } = fakeSession([
      { type: 'system/message', surfaceOp: 'append' },
      { type: 'user/message', surfaceOp: 'append' },
    ])
    appendSystemHeadIfMissing(session, 1, 1)
    expect(appended).toHaveLength(0)
  })
})
