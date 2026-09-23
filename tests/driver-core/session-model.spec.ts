/**
 * Unit tests for the shared session-model judgement: the host-style selection
 * read (`currentSelection`), the one decision every hosted engine consumes
 * (`sessionModelOverride`), and the context-bound convenience the drivers call
 * (`sessionModelOverrideOf`).
 *
 * @module tests/driver-core/session-model
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, canonicalHeader, type Session } from '@deepseek-ai/dsh-session'
import {
  currentSelection,
  sessionModelOverride,
  sessionModelOverrideOf,
} from '../../src/driver-core/session-model.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'

/** A session plus the reads its context carries, for the assertions. */
interface Fixture {
  readonly ctx: Context
  readonly session: Session
  /** The registry `currentSelection` is handed, when one was composed. */
  readonly projections: ReturnType<typeof modelSelectionProjections> | undefined
}

/**
 * Boot a bare session store, optionally composing the host's `modelSelection`
 * fold, and prepare one session on it.
 * @param withProjections - whether the session-projection registry is composed.
 * @returns the context, a prepared session, and the registry when present.
 */
async function boot(withProjections = true): Promise<Fixture> {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const projections = withProjections ? modelSelectionProjections(ctx) : undefined
  if (projections !== undefined) ctx.provide('sessionProjections', projections)
  const session = ctx.sessions.prepare(SessionId('session-model-s'), { meta: { cwd: process.cwd() } })
  return { ctx, session, projections }
}

/** Contexts to unload after each test. */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Log a request header with the given provider and model. */
function logHeader(session: Session, provider: string, model: string): void {
  session.append('request/header', {
    header: canonicalHeader({ config: { provider, model } }),
    reason: 'initial',
  })
}

describe('sessionModelOverride', () => {
  it('sends nothing when the log records no selection', () => {
    expect(sessionModelOverride(undefined)).toBeUndefined()
  })

  it('passes a real dsh model through, provider and model intact', () => {
    expect(sessionModelOverride({ provider: 'meicloud', model: 'deepseek-flash' }))
      .toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })

  it('sends nothing for the shared hosted label, the engine\'s own default', () => {
    expect(sessionModelOverride({ provider: 'external', model: 'default' })).toBeUndefined()
  })

  it('sends nothing for an earlier build\'s per-engine label', () => {
    for (const provider of ['claude-code', 'codex', 'pi', 'kimi']) {
      expect(sessionModelOverride({ provider, model: 'default' })).toBeUndefined()
    }
  })
})

describe('currentSelection', () => {
  it('prefers a pending selection over the logged header', async () => {
    const { session, projections } = await boot()
    logHeader(session, 'external', 'default')
    session.append('model/selection', { provider: 'meicloud', model: 'deepseek-flash' })
    expect(currentSelection(session, projections)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })

  it('falls back to the logged header when nothing is pending', async () => {
    const { session, projections } = await boot()
    logHeader(session, 'meicloud', 'deepseek-flash')
    expect(currentSelection(session, projections)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })

  it('answers undefined when the log records neither a pending selection nor a header', async () => {
    const { session, projections } = await boot()
    expect(currentSelection(session, projections)).toBeUndefined()
  })

  it('reads the header when no projection registry is composed', async () => {
    const { session } = await boot()
    logHeader(session, 'meicloud', 'deepseek-flash')
    expect(currentSelection(session, undefined)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })
})

describe('sessionModelOverrideOf', () => {
  it('resolves the pending selection through the composed registry', async () => {
    const { ctx, session } = await boot()
    session.append('model/selection', { provider: 'meicloud', model: 'deepseek-flash' })
    expect(sessionModelOverrideOf(ctx, session)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })

  it('sends nothing when the selection names the hosted seat', async () => {
    const { ctx, session } = await boot()
    logHeader(session, 'external', 'default')
    expect(sessionModelOverrideOf(ctx, session)).toBeUndefined()
  })

  it('reads the header when the deployment composes no projection registry', async () => {
    const { ctx, session } = await boot(false)
    logHeader(session, 'meicloud', 'deepseek-flash')
    expect(sessionModelOverrideOf(ctx, session)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })
})
