/**
 * Unit tests for the `Agent.model` handle a hosted agent owes the 0.2.2
 * harness: the recorded selection outranks the agent's options, `select()`
 * appends the log-only event exactly once, and a step announcement always
 * carries a selection.
 *
 * @module tests/driver-core/agent-model
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, canonicalHeader, type Session } from '@deepseek-ai/dsh-session'
import { HostedAgentModel } from '../../src/driver-core/agent-model.ts'
import { HOSTED_DEFAULT_MODEL, HOSTED_ROUTE_LABEL } from '../../src/agent-preset-ids.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'

/** One booted fixture: the context the handle reads through and its session. */
interface Fixture {
  readonly ctx: Context
  readonly session: Session
}

/** Contexts to unload after each test. */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/**
 * Boot a session store plus the host's `modelSelection` fold and prepare one
 * session, entered and announced as the 0.2.2 line requires before appends.
 * @returns the context and the prepared session.
 */
async function boot(): Promise<Fixture> {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  ctx.provide('sessionProjections', modelSelectionProjections(ctx))
  const session = ctx.sessions.prepare(SessionId('agent-model-s'), { meta: { cwd: process.cwd() } })
  ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  return { ctx, session }
}

/** Every `model/selection` a session's log carries. */
function selections(session: Session): readonly unknown[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'model/selection')
    .map(event => event.data)
}

describe('HostedAgentModel', () => {
  it('reports the selection the session records, over the agent options', async () => {
    const { ctx, session } = await boot()
    session.append('model/selection', { provider: 'meicloud', model: 'flash' })
    const model = new HostedAgentModel(ctx, session, { provider: 'other', model: 'pinned' })

    expect(model.current()).toEqual({ provider: 'meicloud', model: 'flash' })
    expect(model.forStep()).toEqual({ provider: 'meicloud', model: 'flash' })
  })

  it('falls back to the agent options when the log names nothing', async () => {
    const { ctx, session } = await boot()
    const model = new HostedAgentModel(ctx, session, {
      provider: 'meicloud',
      model: 'flash',
      reasoningEffort: 'high' as never,
    })

    expect(model.current()).toEqual({ provider: 'meicloud', model: 'flash', reasoningEffort: 'high' })
    expect(selections(session)).toEqual([])
  })

  it('answers nothing when neither the log nor the options name a route', async () => {
    const { ctx, session } = await boot()
    const model = new HostedAgentModel(ctx, session, { maxTokens: 8 })

    expect(model.current()).toBeUndefined()
  })

  it('reports the options route without an effort key when none is configured', async () => {
    const { ctx, session } = await boot()
    const model = new HostedAgentModel(ctx, session, { provider: 'meicloud', model: 'flash' })

    expect(model.current()).toEqual({ provider: 'meicloud', model: 'flash' })
  })

  it('answers nothing for half an options route', async () => {
    const { ctx, session } = await boot()

    expect(new HostedAgentModel(ctx, session, { provider: 'meicloud' }).current()).toBeUndefined()
    expect(new HostedAgentModel(ctx, session, { model: 'flash' }).current()).toBeUndefined()
  })

  it('announces the hosted placeholder route when nothing names a model', async () => {
    const { ctx, session } = await boot()
    const model = new HostedAgentModel(ctx, session, {})

    expect(model.forStep()).toEqual({ provider: HOSTED_ROUTE_LABEL, model: HOSTED_DEFAULT_MODEL })
  })

  it('appends the selection it is handed, once', async () => {
    const { ctx, session } = await boot()
    const model = new HostedAgentModel(ctx, session, {})

    model.select({ provider: 'meicloud', model: 'flash' })
    // The same choice again is a no-op: it says what the log already says.
    model.select({ provider: 'meicloud', model: 'flash' })

    expect(selections(session)).toEqual([{ provider: 'meicloud', model: 'flash' }])
    expect(model.current()).toEqual({ provider: 'meicloud', model: 'flash' })
  })

  it('writes a selection equal to the options fallback, which is not recorded', async () => {
    const { ctx, session } = await boot()
    const options: AgentOptions = { provider: 'meicloud', model: 'flash' }
    const model = new HostedAgentModel(ctx, session, options)

    model.select({ provider: 'meicloud', model: 'flash' })

    expect(selections(session)).toEqual([{ provider: 'meicloud', model: 'flash' }])
  })

  it('records an explicit reasoning effort beside the route', async () => {
    const { ctx, session } = await boot()
    const model = new HostedAgentModel(ctx, session, {})

    model.select({ provider: 'meicloud', model: 'flash', reasoningEffort: 'high' as never })

    expect(selections(session)).toEqual([{ provider: 'meicloud', model: 'flash', reasoningEffort: 'high' }])
  })

  it('reads the selection the log header recorded last', async () => {
    const { ctx, session } = await boot()
    session.append('request/header', {
      header: canonicalHeader({ config: { provider: 'meicloud', model: 'flash' } }),
      reason: 'initial',
    })
    const model = new HostedAgentModel(ctx, session, {})

    expect(model.current()).toEqual({ provider: 'meicloud', model: 'flash' })
  })
})
