/**
 * Unit tests for the driver-owned durable inbox shared by the hosted engines:
 * pending work is folded from the session's own `agent/inbox/spliced` events
 * and every mutation commits a normalized splice back into that log.
 * @module tests/driver-core/inbox
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { DriverInbox, type InboxNotifications } from '../../src/driver-core/inbox.ts'

/** One identified user message. */
function message(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Live notifications recorded in publish order. */
interface Recorded {
  inserted: UserMessage[]
  discarded: UserMessage[]
  claimed: { message: UserMessage; turn: number }[]
}

/** A notification sink plus the arrays it fills. */
function recorder(): { notifications: InboxNotifications; recorded: Recorded } {
  const recorded: Recorded = { inserted: [], discarded: [], claimed: [] }
  return {
    recorded,
    notifications: {
      inserted: (input) => { recorded.inserted.push(input) },
      discarded: (input) => { recorded.discarded.push(input) },
      claimed: (input, turn) => { recorded.claimed.push({ message: input, turn }) },
    },
  }
}

/** One unpublished session on a fresh store. */
async function freshSession(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return { ctx, session: ctx.sessions.prepare(SessionId('inbox-s'), { meta: { cwd: process.cwd() } }) }
}

describe('DriverInbox pending lists', () => {
  it('appends and prepends into either list and reports pending work', async () => {
    const { ctx, session } = await freshSession()
    try {
      const { notifications, recorded } = recorder()
      const inbox = new DriverInbox(session, notifications)

      expect(inbox.hasPending).toBe(false)
      expect(inbox.nextTurn).toEqual([])
      expect(inbox.nextStep).toEqual([])

      const queued = message('queued')
      const steered = message('steered')
      const injected = message('injected')
      inbox.append('next-turn', queued)
      inbox.prepend('next-step', steered)
      inbox.append('next-step', injected)

      expect(inbox.hasPending).toBe(true)
      expect(inbox.nextTurn.map(item => item.id)).toEqual([queued.id])
      expect(inbox.nextStep.map(item => item.id)).toEqual([steered.id, injected.id])
      expect(recorded.inserted.map(item => item.id)).toEqual([queued.id, steered.id, injected.id])
      expect(recorded.discarded).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replaces and removes by identity, reporting a miss for an unknown id', async () => {
    const { ctx, session } = await freshSession()
    try {
      const { notifications, recorded } = recorder()
      const inbox = new DriverInbox(session, notifications)
      const pending = message('pending')
      const replacement = message('replacement')
      inbox.append('next-turn', pending)

      expect(inbox.replace(replacement.id, message('never'))).toBe(false)
      expect(inbox.remove(replacement.id)).toBe(false)
      expect(inbox.replace(pending.id, replacement)).toBe(true)
      expect(inbox.nextTurn.map(item => item.id)).toEqual([replacement.id])
      expect(recorded.discarded.map(item => item.id)).toEqual([pending.id])
      expect(recorded.inserted.map(item => item.id)).toEqual([pending.id, replacement.id])

      expect(inbox.remove(replacement.id)).toBe(true)
      expect(inbox.hasPending).toBe(false)
      expect(recorded.discarded.map(item => item.id)).toEqual([pending.id, replacement.id])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears next-step before next-turn and discards every cleared message', async () => {
    const { ctx, session } = await freshSession()
    try {
      const { notifications, recorded } = recorder()
      const inbox = new DriverInbox(session, notifications)
      inbox.append('next-turn', message('turn'))
      inbox.append('next-step', message('step'))
      recorded.discarded.length = 0
      const appended = session.ownEvents().filter(event => event.type === 'agent/inbox/spliced').length

      inbox.clear()

      expect(inbox.hasPending).toBe(false)
      expect(recorded.discarded.map(item => item.content[0])).toEqual([
        { type: 'text', text: 'step' },
        { type: 'text', text: 'turn' },
      ])
      // The durable splices are pure cancelations, recorded in clear order.
      expect(session.ownEvents().filter(event => event.type === 'agent/inbox/spliced').slice(appended).map(event => event.data))
        .toEqual([
          { target: 'next-step', start: 0, inserted: [], removedCount: 1, outcome: 'canceled' },
          { target: 'next-turn', start: 0, inserted: [], removedCount: 1, outcome: 'canceled' },
        ])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('DriverInbox claiming', () => {
  it('claims the whole next-step batch then one queued turn for a turn boundary', async () => {
    const { ctx, session } = await freshSession()
    try {
      const { notifications, recorded } = recorder()
      const inbox = new DriverInbox(session, notifications)
      inbox.append('next-turn', message('turn-1'))
      inbox.append('next-turn', message('turn-2'))
      inbox.prepend('next-step', message('steer'))
      recorded.claimed.length = 0

      const claimed = inbox.claim('next-turn', 7)

      // Next-step input first, then exactly one queued turn.
      expect(claimed.map(item => item.content[0])).toEqual([
        { type: 'text', text: 'steer' },
        { type: 'text', text: 'turn-1' },
      ])
      expect(recorded.claimed.map(entry => [entry.message.id, entry.turn])).toEqual(
        claimed.map(item => [item.id, 7]),
      )
      expect(inbox.nextTurn.map(item => item.content[0])).toEqual([{ type: 'text', text: 'turn-2' }])
      expect(inbox.nextStep).toEqual([])
      // A claim is a pure deletion: no discard notification, no cancelation outcome.
      expect(recorded.discarded).toEqual([])
      expect(session.ownEvents().filter(event => event.type === 'agent/inbox/spliced').at(-1)?.data)
        .toEqual({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('claims only the next-step batch for a step boundary', async () => {
    const { ctx, session } = await freshSession()
    try {
      const { notifications } = recorder()
      const inbox = new DriverInbox(session, notifications)
      inbox.append('next-turn', message('queued'))
      inbox.append('next-step', message('steer'))

      expect(inbox.claim('next-step', 1).map(item => item.content[0])).toEqual([{ type: 'text', text: 'steer' }])
      expect(inbox.nextTurn.map(item => item.content[0])).toEqual([{ type: 'text', text: 'queued' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('claims nothing from an empty inbox and commits no splice', async () => {
    const { ctx, session } = await freshSession()
    try {
      const { notifications } = recorder()
      const inbox = new DriverInbox(session, notifications)
      const before = session.ownEvents().length

      expect(inbox.claim('next-turn', 1)).toEqual([])
      expect(session.ownEvents().length).toBe(before)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('DriverInbox splice normalization', () => {
  it('clamps out-of-range coordinates instead of trusting them', async () => {
    const { ctx, session } = await freshSession()
    try {
      const { notifications } = recorder()
      const inbox = new DriverInbox(session, notifications)
      inbox.append('next-turn', message('a'))

      // Infinity is the engines' "append at the end" idiom; a negative offset
      // counts back from the end and NaN resolves to the front, so every
      // durable splice stays in range.
      inbox.splice('next-turn', Infinity, 0, [message('b')])
      inbox.splice('next-turn', -1, 0, [message('c')])
      inbox.splice('next-turn', Number.NaN, 0, [message('d')])
      expect(inbox.nextTurn.map(item => item.content[0])).toEqual([
        { type: 'text', text: 'd' },
        { type: 'text', text: 'a' },
        { type: 'text', text: 'c' },
        { type: 'text', text: 'b' },
      ])

      // NaN delete counts clamp to zero removals; an infinite count removes the rest.
      inbox.splice('next-turn', 0, Number.NaN, [])
      expect(inbox.nextTurn).toHaveLength(4)
      inbox.splice('next-turn', 1, Infinity, [])
      expect(inbox.nextTurn.map(item => item.content[0])).toEqual([{ type: 'text', text: 'd' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a splice that would duplicate a pending identity', async () => {
    const { ctx, session } = await freshSession()
    try {
      const { notifications } = recorder()
      const inbox = new DriverInbox(session, notifications)
      const pending = message('dupe')
      inbox.append('next-turn', pending)

      expect(() => inbox.append('next-step', pending)).toThrow(/is already pending/)
      expect(() => inbox.append('next-turn', pending)).toThrow(/is already pending/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('DriverInbox replay', () => {
  it('folds persisted splices at construction without notifying', async () => {
    const { ctx, session } = await freshSession()
    try {
      const queued = message('queued')
      const steered = message('steered')
      // A non-splice event in the log is skipped by the fold.
      session.append('turn/start', { turn: 1 })
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued] })
      session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [steered] })

      const { notifications, recorded } = recorder()
      const inbox = new DriverInbox(session, notifications)

      expect(inbox.nextTurn.map(item => item.id)).toEqual([queued.id])
      expect(inbox.nextStep.map(item => item.id)).toEqual([steered.id])
      expect(recorded).toEqual({ inserted: [], discarded: [], claimed: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a persisted splice whose coordinates are out of range', async () => {
    const { ctx, session } = await freshSession()
    try {
      const event = session.append('agent/inbox/spliced', { target: 'next-turn', start: 3, inserted: [] })
      const { notifications } = recorder()

      expect(() => new DriverInbox(session, notifications))
        .toThrow(new RegExp(`invalid persisted inbox splice at session seq ${event.seq}`))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a persisted splice that duplicates a pending identity', async () => {
    const { ctx, session } = await freshSession()
    try {
      const pending = message('dupe')
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [pending] })
      const event = session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [pending] })
      const { notifications } = recorder()

      expect(() => new DriverInbox(session, notifications))
        .toThrow(new RegExp(`invalid persisted inbox splice at session seq ${event.seq}`))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
