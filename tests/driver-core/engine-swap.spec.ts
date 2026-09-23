/**
 * The in-place engine swap on the REAL transaction machinery: one live session's
 * agent is retired and the incoming engine's agent is built onto the SAME
 * `Session`, with the session's store entry and write handle handed across.
 *
 * This is the half no stand-in can establish. What breaks a live session is a
 * lifecycle edge the browser half can see — `session/disposed`, which the host
 * republishes as "this session is gone", taking the row out of its session list
 * and leaving the page on the workspace picker — so these tests count those edges
 * across a swap, and check that the session's write handle (the channel that
 * stores its events) was closed by its LAST owner instead of being closed early
 * or leaked. A leaked claim is not cosmetic either: the next open of that
 * session would be refused as already owned.
 *
 * Two real engines drive it, Claude Code first and Kimi Code second. Neither
 * spawns anything before a turn starts, so the whole swap runs without an engine
 * protocol in the picture.
 *
 * @module tests/driver-core/engine-swap
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ClaudeCodeLoop } from '../../src/engine-claude/loop.ts'
import { KimiLoop } from '../../src/engine-kimi/loop.ts'
import { ClaudeCodeAgent } from '../../src/engine-claude/agent.ts'
import { KimiAgent } from '../../src/engine-kimi/agent.ts'

/** Cleanup hooks for the contexts and temp roots one test created. */
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The services an engine runtime reads through its own fiber. */
const ENGINE_SERVICES = ['agents', 'sessions', 'systemPrompt', 'subprocess']

/**
 * Boot the stack the two engines publish through: the real session store and
 * agent registry, a real JSONL backend (the write handle under test is its), and
 * the subprocess seam both engines resolve when they are constructed. The
 * runtimes themselves are built inside a fiber that injects the services they
 * read — cordis refuses a service property read without it — and are then
 * reachable off the root context under each engine's own host-face key.
 * @returns the booted context.
 */
async function harness(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'loop-engine-swap-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) })
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root })
  const fiber = ctx.plugin({
    name: 'loop-engine-engines-under-test',
    inject: ENGINE_SERVICES,
    apply: (engineCtx: Context) => {
      new ClaudeCodeLoop(engineCtx, {})
      new KimiLoop(engineCtx, {})
    },
  })
  await fiber
  cleanups.push(async () => { await fiber.dispose() })
  return ctx
}

/**
 * Assert this session's write claim is held by a live handle. The backend admits
 * one writer per id, so this is how a handed-over handle is observed to still be
 * open — and, after the last owner releases it, to be really gone.
 * @param ctx - the context carrying the persistence backend.
 * @param id - the session whose claim is probed.
 */
async function expectWriteClaimHeld(ctx: Context, id: string): Promise<void> {
  await expect(ctx.sessionPersistence.open(SessionId(id), 'write'))
    .rejects.toThrow(/is already owned by an active write handle/)
}

describe('swapping a live session between engines', () => {
  it('hands the session over without detaching it, and lets the successor release it', async () => {
    const ctx = await harness()
    const claude = ctx.get('agentLoopClaudeCode') as ClaudeCodeLoop
    const kimi = ctx.get('agentLoopKimi') as KimiLoop
    // The edge that breaks a page: nothing a swap does may publish it.
    const disposed = vi.fn()
    ctx.on('session/disposed', disposed)

    const first = await claude.createAgent(ctx, {
      sessionId: SessionId('swap-1'),
      meta: { cwd: process.cwd() },
    })
    expect(first.agent).toBeInstanceOf(ClaudeCodeAgent)
    const session = first.agent.session
    expect(ctx.sessions.get(SessionId('swap-1'))).toBe(session)
    expect(ctx.agents.get(SessionId('swap-1'))).toBe(first.agent)
    // Materialize the session so its write claim is observable at all.
    session.append('agent-preset/selected', { agentPreset: 'loop-engine-claude-code' })
    await ctx.sessionPersistence.flush()
    await expectWriteClaimHeld(ctx, 'swap-1')

    // Retire the outgoing machine: it leaves the AGENT registry and nothing else.
    await first.retire()
    expect(ctx.agents.get(SessionId('swap-1'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('swap-1'))).toBe(session)
    expect(disposed).not.toHaveBeenCalled()
    // The claim did not change hands to the backend either: the write handle is
    // still open, and now belongs to nobody but the session itself.
    await expectWriteClaimHeld(ctx, 'swap-1')

    // The successor is built onto that very Session — a second `sessions.enter`
    // for a live id is refused, so reaching the assertions below at all is what
    // proves the session was joined rather than entered again.
    const setup = vi.fn()
    const second = await kimi.swap(ctx, { lifetime: first.lifetime, setup })
    expect(second.agent).toBeInstanceOf(KimiAgent)
    expect(second.agent.session).toBe(session)
    expect(setup).toHaveBeenCalledWith(second.agent.ctx, second.agent)
    expect(ctx.agents.get(SessionId('swap-1'))).toBe(second.agent)
    expect(ctx.sessions.get(SessionId('swap-1'))).toBe(session)
    expect(disposed).not.toHaveBeenCalled()
    // The successor inherited the SAME open claim rather than acquiring a second
    // one — which the backend would have refused — or storing events nowhere.
    await expectWriteClaimHeld(ctx, 'swap-1')

    // The successor owns the lifetime now, so IT releases both halves: the store
    // entry goes, and the write handle it inherited is closed. A leaked claim
    // would keep the open below refused, which is why it is asserted.
    await second.dispose()
    expect(ctx.agents.get(SessionId('swap-1'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('swap-1'))).toBeUndefined()
    expect(disposed).toHaveBeenCalledTimes(1)
    const probe = await ctx.sessionPersistence.open(SessionId('swap-1'), 'write')
    await probe.close()

    // Disposing the retired machine again is inert: its teardown already ran and
    // its lifetime belongs to the successor, so it cannot release the session a
    // second time.
    await first.dispose()
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('keeps the session stored through the handed-over write handle', async () => {
    const ctx = await harness()
    const claude = ctx.get('agentLoopClaudeCode') as ClaudeCodeLoop
    const kimi = ctx.get('agentLoopKimi') as KimiLoop
    const first = await claude.createAgent(ctx, {
      sessionId: SessionId('swap-2'),
      meta: { cwd: process.cwd() },
    })
    const session = first.agent.session

    await first.retire()
    const second = await kimi.swap(ctx, { lifetime: first.lifetime })

    // The session appended after the swap — under the successor — reaches disk
    // through the SAME open handle the outgoing machine acquired, so the swap
    // neither dropped events nor went looking for a second writer (which the
    // backend would have refused as an already-owned id).
    session.append('agent-preset/selected', { agentPreset: 'loop-engine-kimi' })
    await ctx.sessionPersistence.flush()
    const reader = await ctx.sessionPersistence.open(SessionId('swap-2'), 'read')
    try {
      const { events } = await reader.read(0)
      expect(events.map(event => event.type)).toEqual(['agent-preset/selected'])
    } finally {
      await reader.close()
    }

    await second.dispose()
  })
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Restated for this fixture's own append; the roster declares it otherwise. */
    'agent-preset/selected': { agentPreset: string }
  }
}
