/**
 * The browser half's engine read: what the cache answers, when it re-asks, and
 * what it does with an answer it no longer wants.
 *
 * The surfaces themselves are verified at the real profile-mount smoke, but the
 * cache is the piece the incident ran through — "换完引擎还显示旧引擎" — so its
 * contract is pinned here: a session has NO answer until the host gives one, a
 * successful switch drops the cached answer and re-asks, a read that started
 * before that switch can never publish afterwards, and a host that cannot answer
 * leaves the session unknown rather than claimed.
 *
 * `src/client/session-engine.ts` is deliberately React-free for this reason: the
 * hook that binds it to a component lives in `src/client/use-session-engine.ts`,
 * which needs a browser to run at all.
 *
 * The document-level write that used to sit in the cache is covered here too, and
 * from both sides of the seam it now straddles: `<html data-loop-engine>` is the
 * chat turn-status row's subject (`src/client/turn-status.ts`), and it is painted
 * by the session on screen — through the hook both of that session's surfaces
 * share (`src/client/use-session-engine.ts`, which needs React to run at all).
 * What is pinned here is that the CACHE never touches it, so an answer landing
 * for a session that is not on screen leaves the row alone, plus the focus guard
 * at the module boundary. The fake `document` these tests install is the smallest
 * object that write touches.
 * @module tests/session-engine-cache
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  LOOP_ENGINE_REMOTE_CONTRIBUTION, LOOP_ENGINE_REMOTE_METHOD, LOOP_ENGINE_REMOTE_NAMESPACE,
  LOOP_ENGINE_REMOTE_SELECT_METHOD,
  SessionEngineCache, engineSwitchReady, sessionEngineSwitcher, switchNeedsReload,
  type SessionEngineRemote, type SessionEngineReport, type SessionEngineResult,
} from '../src/client/session-engine.ts'
import {
  blurTurnStatusSession, focusTurnStatusSession, reflectTurnStatusEngine,
} from '../src/client/turn-status.ts'
import {
  RELOAD_RETURN_KEY, armReloadReturn, browserPage, installReloadReturn, restoreReloadReturn,
  takeReloadReturn, type ReloadPage, type ReloadStash, type SessionListFace,
} from '../src/client/reload.ts'
import { engineStateLabelKey, pendingEngineText, refusalFace, zh, en } from '../src/client/locales.ts'
import { LOOP_ENGINE_REFUSAL_CODES, hostedEngineOf, type LoopEngineId } from '../src/agent-preset-ids.ts'

/** One controllable namespace: each call hands out a promise the test resolves. */
function fakeRemote(): {
  remote: SessionEngineRemote
  calls: string[]
  settle: (index: number, result: SessionEngineResult) => void
  reject: (index: number, error: unknown) => void
} {
  const calls: string[] = []
  const pending: Array<{ resolve: (value: SessionEngineResult) => void; reject: (error: unknown) => void }> = []
  const remote: SessionEngineRemote = {
    engine: (request) => {
      calls.push(request.sessionId)
      return new Promise<SessionEngineResult>((resolve, reject) => { pending.push({ resolve, reject }) })
    },
  }
  return {
    remote,
    calls,
    settle: (index, result) => { pending[index]!.resolve(result) },
    reject: (index, error) => { pending[index]!.reject(error) },
  }
}

/** Drain the microtask queue so a settled read has published. */
const flushed = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** One controllable page: the tab storage it offers, and how often it reloaded. */
function fakePage(overrides: Partial<ReloadStash> = {}): ReloadPage & { readonly reloads: number } {
  const held = new Map<string, string>()
  const stash: ReloadStash = {
    getItem: key => held.get(key) ?? null,
    setItem: (key, value) => { held.set(key, value) },
    removeItem: (key) => { held.delete(key) },
    ...overrides,
  }
  const page = {
    stash: stash as ReloadStash | undefined,
    reloads: 0,
    reload(): void { page.reloads += 1 },
  }
  return page
}

/**
 * One controllable client session service: the list snapshot it publishes, the
 * subscribers it wakes, and the ids it was asked to open.
 */
function fakeSessions(initial: { phase: 'pending' | 'ready'; ids: readonly string[] }): {
  sessions: SessionListFace
  opened: string[]
  /** Publish a new list snapshot, waking every subscriber. */
  publish: (next: { phase: 'pending' | 'ready'; ids: readonly string[] }) => void
  /** Refuse the next open, the way `sessions.select` does for an unknown id. */
  failOpen: Error | undefined
} {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const opened: string[] = []
  const host = {
    sessions: {
      list: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      open: (id: string) => {
        if (host.failOpen !== undefined) throw host.failOpen
        opened.push(id)
      },
    },
    opened,
    failOpen: undefined as Error | undefined,
    publish: (next: { phase: 'pending' | 'ready'; ids: readonly string[] }) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
  return host
}

/**
 * The `dataset` key the reflection writes — the CAMELCASED spelling of the
 * `data-loop-engine` attribute the stylesheet selects on (a `DOMStringMap`
 * rejects the literal attribute name, so this is the only write path; a plain
 * object stores exactly this key).
 */
const ENGINE_KEY = 'loopEngine'

/**
 * Install a minimal `document` and hand back the root dataset the turn-status
 * reflection writes to. `reflectTurnStatusEngine` touches nothing else of the
 * document, and the reflection is a no-op without one — which is what the rest of
 * this file (and every node boot) relies on.
 */
function fakeDocument(): Record<string, string | undefined> {
  const dataset: Record<string, string | undefined> = {}
  ;(globalThis as unknown as { document?: unknown }).document = { documentElement: { dataset } }
  return dataset
}

describe('SessionEngineCache', () => {
  it('answers nothing until the host does, then caches the answer per session', async () => {
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)

    const seen: Array<string | undefined> = []
    cache.watch('s1', () => { seen.push(cache.read('s1')?.engine.kind) })
    // Nothing is claimed before the answer arrives — not the in-process default,
    // not a stale hint.
    expect(cache.read('s1')).toBeUndefined()

    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'pi' } } })
    await flushed()
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'pi' } })
    expect(seen).toEqual(['engine'])

    // A second watcher joins the cached value instead of asking again.
    cache.watch('s1', () => {})
    expect(host.calls).toEqual(['s1'])
  })

  it('re-asks after an invalidation, so a switched session cannot keep showing the old engine', async () => {
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)
    cache.watch('s1', () => {})

    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'claude-code' } } })
    await flushed()
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'claude-code' } })

    // The switch landed: the cached answer is stale by definition.
    cache.invalidate('s1')
    expect(cache.read('s1')).toBeUndefined()
    host.settle(1, { ok: true, value: { engine: { kind: 'engine', engine: 'pi' } } })
    await flushed()
    expect(host.calls).toEqual(['s1', 's1'])
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'pi' } })
  })

  it('re-reads the session when its surfaces appear again, so a surface never keeps a stale report', async () => {
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)

    // The page opens s1: its surfaces mount, one read.
    const unsubscribe = cache.watch('s1', () => {})
    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'pi' } } })
    await flushed()
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'pi' } })
    expect(host.calls).toEqual(['s1'])

    // The user leaves for another session — this session's surfaces unmount...
    unsubscribe()

    // ...and comes back. Coming back does NOT rebuild the agent (a live agent
    // outlives the browser entirely: nothing in the host's normal path disposes
    // it, so neither a refresh nor a session switch changes what is running), but
    // the answer this page holds is still only an answer this page took earlier —
    // another window, a hot swap made elsewhere, or a plugin reload can all have
    // moved the session since. Re-reading on the way back is what keeps a surface
    // from rendering a stale report as if it were current.
    cache.watch('s1', () => {})
    expect(host.calls).toEqual(['s1', 's1'])

    host.settle(1, {
      ok: true,
      value: { engine: { kind: 'engine', engine: 'in-process' }, pending: 'codex' },
    })
    await flushed()
    expect(cache.read('s1'))
      .toEqual({ engine: { kind: 'engine', engine: 'in-process' }, pending: 'codex' })
  })

  it('sends one read when a session\'s surfaces mount together, and none while it keeps rendering', async () => {
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)

    // The chip and the composer are two watchers of one session and mount in the
    // same commit: one read, not two. An explicit re-read while that one is in
    // flight joins it instead of queueing a second request.
    cache.watch('s1', () => {})
    cache.watch('s1', () => {})
    cache.refresh('s1')
    expect(host.calls).toEqual(['s1'])

    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'pi' } } })
    await flushed()
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'pi' } })

    // Rendering again reads the cache; it does not ask. Only a session whose
    // surfaces appeared again, or a committed switch, asks the host again.
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'pi' } })
    expect(host.calls).toEqual(['s1'])
  })

  it('re-reads after a committed switch, so the picker gets the engine that runs and its pending half', async () => {
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)
    cache.watch('s1', () => {})

    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'pi' } } })
    await flushed()
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'pi' } })

    // The switch to in-process was committed while the session stayed live on pi:
    // the record names in-process, and the report must arrive carrying both.
    cache.invalidate('s1')
    host.settle(1, {
      ok: true,
      value: { engine: { kind: 'engine', engine: 'pi' }, pending: 'in-process' },
    })
    await flushed()
    expect(host.calls).toEqual(['s1', 's1'])
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'pi' }, pending: 'in-process' })
  })

  it('never publishes a read that started before an invalidation', async () => {
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)
    cache.watch('s1', () => {})

    // The first read is still in flight when the session switches engine.
    cache.invalidate('s1')
    host.settle(1, { ok: true, value: { engine: { kind: 'engine', engine: 'pi' } } })
    await flushed()
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'pi' } })

    // The pre-switch answer arrives last: it must be dropped, not republished.
    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'claude-code' } } })
    await flushed()
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'pi' } })
  })

  it('leaves a session unknown when the host refuses, rejects, or answers nonsense', async () => {
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)
    cache.watch('refused', () => {})
    cache.watch('threw', () => {})
    cache.watch('nonsense', () => {})

    host.settle(0, { ok: false, error: { message: 'no such session' } })
    host.reject(1, new Error('carrier lost'))
    host.settle(2, { ok: true, value: { engine: { kind: 'guess' } } as unknown as never })
    await flushed()

    expect(cache.read('refused')).toBeUndefined()
    expect(cache.read('threw')).toBeUndefined()
    expect(cache.read('nonsense')).toBeUndefined()
  })

  it('reads nothing while no namespace is attached, and nothing after disposal', async () => {
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.watch('s1', () => {})
    expect(host.calls).toEqual([])

    cache.attach(host.remote)
    host.settle(0, { ok: true, value: { engine: { kind: 'unset' } } })
    await flushed()
    expect(cache.read('s1')).toEqual({ engine: { kind: 'unset' } })

    cache.dispose()
    expect(cache.read('s1')).toBeUndefined()
    cache.attach(host.remote)
    cache.invalidate('s1')
    expect(host.calls).toEqual(['s1'])
  })

  it('stops notifying a watcher once it unsubscribed', async () => {
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)
    const listener = vi.fn()
    const unsubscribe = cache.watch('s1', listener)

    unsubscribe()
    host.settle(0, { ok: true, value: { engine: { kind: 'legacy' } } })
    await flushed()

    // The answer is cached (the read was already in flight) but nobody is left
    // to be notified. A later watch is a surface appearing again for a session
    // that had none — a second surface, see above — so that one re-reads.
    expect(cache.read('s1')).toEqual({ engine: { kind: 'legacy' } })
    expect(listener).not.toHaveBeenCalled()
    const rejoined = vi.fn()
    cache.watch('s1', rejoined)
    expect(host.calls).toEqual(['s1', 's1'])
    host.settle(1, { ok: true, value: { engine: { kind: 'engine', engine: 'codex' } } })
    await flushed()
    expect(rejoined).toHaveBeenCalledTimes(1)
    expect(cache.read('s1')).toEqual({ engine: { kind: 'engine', engine: 'codex' } })
  })
})

describe('the engine a surface names', () => {
  it('names the engine the session RUNS, never the one it has not adopted', () => {
    // The label the header chip and the composer's trigger both render comes
    // from the report's ACTUAL engine: a pending engine is carried separately
    // (`SessionEngineReport.pending`) and is rendered as a marker, not a name.
    expect(engineStateLabelKey({ kind: 'engine', engine: 'pi' })).toBe('enginePi')
    expect(engineStateLabelKey({ kind: 'engine', engine: 'in-process' })).toBe('engineInProcess')
    expect(engineStateLabelKey({ kind: 'legacy' })).toBe('engineLegacy')
    expect(engineStateLabelKey({ kind: 'unset' })).toBe('engineUnrecorded')
  })

  it('renders a recorded engine as a marker that names it, in both languages', () => {
    expect(pendingEngineText(key => zh[key], 'in-process')).toBe('切到 进程内引擎（默认） · 尚未接管')
    expect(pendingEngineText(key => en[key], 'in-process'))
      .toBe('→ In-process engine (default) · not in force')
  })

  it('explains a hosted engine\'s model seat for every hosted engine, in both languages', () => {
    // The copy this plugin shipped named Claude Code, which made a general fact
    // ("the engine decides the model") read as a property of one engine — while
    // the model menu now carries one entry per hosted engine. So the copy names
    // none of them, says what that entry means, and describes what a real pick
    // does: it is HANDED to the engine together with its endpoint and credential
    // (and a protocol the engine does not speak is the engine's error to report),
    // rather than the "no effect" the earliest copy claimed or the
    // "engine's own credentials" a later one claimed.
    for (const [lang, dict] of [['zh', zh], ['en', en]] as const) {
      const copy = dict.hostedEngineModelNotice
      expect(`${lang}=${copy}`).not.toMatch(/Claude Code|Codex|Kimi|Pi CLI|claude-code/i)
      expect(copy).toContain('default')
    }
    expect(zh.hostedEngineModelNotice).toContain('端点与凭据')
    expect(zh.hostedEngineModelNotice).toContain('报错')
    expect(en.hostedEngineModelNotice).toContain('endpoint and credential')
    expect(en.hostedEngineModelNotice).toContain('reports an error')
    expect(zh.hostedEngineModelNotice).toContain('引擎')
    expect(en.hostedEngineModelNotice).toMatch(/engine/i)
  })

  it('names the reload, not a restart or a reopened session, for a pick that has to release its agent', () => {
    // The copy this plugin shipped twice described a switch it could not make:
    // the first version promised "reopen this session and it takes over" (false —
    // the host's resolve hands back the live agent), the second promised a
    // `dsh web` restart. The switch now really does land: the host releases this
    // session's agent and the page reloads itself, coming back to the same
    // session. So the copy names the reload, and no sentence may claim a restart
    // or a session the user reopens by hand.
    for (const [lang, dict] of [['zh', zh], ['en', en]] as const) {
      for (const key of Object.keys(dict) as (keyof typeof en)[]) {
        // The assertion carries its own key so a failure names the sentence.
        expect(`${lang}.${key}=${dict[key]}`).not.toMatch(/重开|reopen|重启|restart/i)
      }
    }
    expect(zh.composerHint).toContain('重新载入')
    expect(zh.switchReloadBody).toContain('重新载入')
    expect(zh.switchReloadBody).toContain('回到本会话')
    expect(en.composerHint).toContain('reloads itself')
    expect(en.switchReloadBody).toMatch(/reload/i)
    expect(en.switchReloadBody).toContain('returning to this session')
    // The marker is what a user sees when a release did NOT take, so it must not
    // promise a delivery: the action that retries it is picking the engine again.
    expect(zh.pendingComposerHint).toContain('再选一次')
    expect(en.pendingComposerHint).toContain('again')
    // The menu row's own marker: the trigger may be ellipsised, so the recorded
    // engine has to be readable on its row in the list.
    expect(zh.engineMenuPendingSuffix).toBe('（尚未接管）')
    expect(en.engineMenuPendingSuffix).toBe(' (not in force)')
  })
})

describe('whether a pick has to reload the page', () => {
  it('reloads exactly when the in-process engine is on one side of the move', () => {
    // Between two hosted engines the host swaps the agent in place: the session
    // stays open and NOTHING reloads, which is why a pick there must open no
    // dialog at all.
    expect(switchNeedsReload({ kind: 'engine', engine: 'pi' }, 'kimi')).toBe(false)
    expect(switchNeedsReload({ kind: 'engine', engine: 'claude-code' }, 'codex')).toBe(false)
    // With the in-process engine on either side the session's agent is released
    // and the page reloads to rebuild it — the pick that must be confirmed.
    expect(switchNeedsReload({ kind: 'engine', engine: 'in-process' }, 'kimi')).toBe(true)
    expect(switchNeedsReload({ kind: 'engine', engine: 'pi' }, 'in-process')).toBe(true)
    // The row already in force is a no-op the picker never sends, and it is not a
    // reload either.
    expect(switchNeedsReload({ kind: 'engine', engine: 'in-process' }, 'in-process')).toBe(false)
    expect(switchNeedsReload({ kind: 'engine', engine: 'pi' }, 'pi')).toBe(false)
  })

  it('reads the two states that name no engine as the in-process side', () => {
    // `legacy` and `unset` are built on the harness loop (the router falls back
    // to it for any preset this plugin does not own), so a pick of a hosted
    // engine on such a session really does release it and reload the page.
    expect(switchNeedsReload({ kind: 'legacy' }, 'pi')).toBe(true)
    expect(switchNeedsReload({ kind: 'unset' }, 'codex')).toBe(true)
    // ...and picking the loop itself on one of them reloads nothing.
    expect(switchNeedsReload({ kind: 'legacy' }, 'in-process')).toBe(false)
    expect(switchNeedsReload({ kind: 'unset' }, 'in-process')).toBe(false)
  })

})

describe('whether a session\'s picker may be used at all', () => {
  it('is usable only once the host has named the engine', () => {
    // No answer yet (or a host that cannot answer): there is nothing to judge a
    // pick against, so the picker stays unusable — the composer greys its trigger
    // out and its menu cannot be opened — instead of guessing a direction. A
    // dialog over a switch that did not reload is a promise this control cannot
    // keep, and a silent reload takes the page's unsent draft with it.
    expect(engineSwitchReady(undefined)).toBe(false)
    // Every state that IS an answer is usable, including the two that name no
    // engine: they answer "the in-process side" to the judgement below, which is
    // a decided answer rather than an absent one.
    expect(engineSwitchReady({ engine: { kind: 'engine', engine: 'pi' } })).toBe(true)
    expect(engineSwitchReady({ engine: { kind: 'engine', engine: 'in-process' } })).toBe(true)
    expect(engineSwitchReady({ engine: { kind: 'legacy' } })).toBe(true)
    expect(engineSwitchReady({ engine: { kind: 'unset' } })).toBe(true)
  })

  it('drops a pick that arrives with no answer, and judges every other one', () => {
    // The composer's own commit path, in the order it runs it: gate → judge (or
    // confirm) → send. The order is the whole guarantee — without the gate an
    // unanswered session would reach `switchNeedsReload`, which now cannot take
    // one at all (its parameter is not optional), so nothing may commit either.
    const sent: LoopEngineId[] = []
    const confirmed: LoopEngineId[] = []
    const pick = (report: SessionEngineReport | undefined, target: LoopEngineId): void => {
      if (!engineSwitchReady(report)) return
      if (switchNeedsReload(report.engine, target)) { confirmed.push(target); return }
      sent.push(target)
    }
    // Neither direction: nothing is sent and nothing is staged. That is also what
    // a menu left open across the answer being dropped does — it outlives a pick
    // that committed, because committing invalidates the cached answer.
    pick(undefined, 'kimi')
    pick(undefined, 'in-process')
    expect(sent).toEqual([])
    expect(confirmed).toEqual([])
    // With an answer the same path still does both things it must.
    pick({ engine: { kind: 'engine', engine: 'pi' } }, 'kimi')
    expect(sent).toEqual(['kimi'])
    pick({ engine: { kind: 'engine', engine: 'pi' } }, 'in-process')
    expect(confirmed).toEqual(['in-process'])
    expect(sent).toEqual(['kimi'])
  })
})

describe('the copy one refused switch reads as', () => {
  it('maps every refusal code to this plugin\'s own sentence', () => {
    expect(refusalFace('turn-running')).toEqual({ body: 'refusedTurnRunning', detail: false })
    expect(refusalFace('session-closed')).toEqual({ body: 'refusedSessionClosed', detail: false })
    expect(refusalFace('subagent-session')).toEqual({ body: 'refusedSubagentSession', detail: false })
    // The mount window and a router that is not mounted are one thing to a user.
    expect(refusalFace('not-driven')).toEqual({ body: 'refusedRouterNotReady', detail: false })
    expect(refusalFace('router-unmounted')).toEqual({ body: 'refusedRouterNotReady', detail: false })
    // The two failures whose copy cannot carry the cause keep the host's own
    // sentence ON TOP OF it, as detail.
    expect(refusalFace('record-failed')).toEqual({ body: 'refusedRecordFailed', detail: true })
    expect(refusalFace('rebuild-failed')).toEqual({ body: 'refusedRebuildFailed', detail: true })
    // No code at all (an unknown one, a rejected CALL, a lost connection): there
    // is no local copy to invent, so the host's sentence is the message.
    expect(refusalFace(undefined)).toEqual({ detail: false })
  })

  it('has real copy for every code, in both languages, and never quotes the host', () => {
    for (const code of LOOP_ENGINE_REFUSAL_CODES) {
      const body = refusalFace(code).body
      // Exhaustiveness: a code without copy is a refusal a user cannot read.
      expect(body).toBeDefined()
      for (const [lang, dict] of [['zh', zh], ['en', en]] as const) {
        const text = dict[body!]
        // The host's own framing is detail, never the message: no raw
        // `session "…" is running; …` may reach the user as the body.
        expect(`${lang}.${code}=${text}`).not.toMatch(/session "|is running;|is not open;|already started/)
        expect(text.length).toBeGreaterThan(10)
      }
    }
  })

  it('says what each refusal means, in the user\'s own words', () => {
    expect(zh.refusedTurnRunning).toContain('等这一轮结束后')
    expect(zh.refusedTurnRunning).toContain('不会被打断')
    expect(zh.refusedSessionClosed).toContain('还没有打开')
    expect(zh.refusedSubagentSession).toContain('子代理会话')
    expect(zh.refusedSubagentSession).toContain('主会话')
    expect(zh.refusedRouterNotReady).toContain('路由器')
    expect(zh.refusedRecordFailed).toContain('写入失败')
    expect(zh.refusedRebuildFailed).toContain('新引擎没能建起来')
    expect(en.refusedTurnRunning).toContain('after this turn ends')
    expect(en.refusedTurnRunning).toContain('not interrupted')
    expect(en.refusedSessionClosed).toContain('not open yet')
    expect(en.refusedSubagentSession).toContain('subagent session')
    expect(en.refusedRouterNotReady).toContain('router is not ready')
    expect(en.refusedRecordFailed).toContain('could not be written')
    expect(en.refusedRebuildFailed).toContain('new engine could not be started')
  })

  it('says what a reloading switch costs BEFORE it is sent', () => {
    // The confirmation's whole job: the reload is this page's scroll position and
    // its unsent draft, and the user decides with that in front of them.
    expect(zh.switchReloadConfirmTitle).toContain('重新载入页面')
    expect(zh.switchReloadConfirmBody).toContain('滚动位置')
    expect(zh.switchReloadConfirmBody).toContain('草稿')
    expect(zh.switchReloadConfirmBody).toContain('会话记录')
    expect(en.switchReloadConfirmTitle).toMatch(/reloads the page/i)
    expect(en.switchReloadConfirmBody).toContain('scroll position')
    expect(en.switchReloadConfirmBody).toContain('unsent draft')
    expect(en.switchReloadConfirmBody).toContain('conversation record')
    // Two buttons, and not the notice's single "close": a confirmation must offer
    // a way to NOT do it, and a distinct way to do it.
    expect(zh.switchReloadConfirmAction).toBe('切换并重载')
    expect(en.switchReloadConfirmAction).toBe('Switch and reload')
    expect(zh.cancelAction).not.toBe(zh.switchReloadConfirmAction)
    expect(zh.cancelAction).not.toBe(zh.closeLabel)
  })
})

/**
 * One effect run of the hook (`./use-session-engine.ts`), without React: declare
 * this surface's session as the one on screen, read its cached engine, name the
 * engine the row draws, and reflect it. The derivation is the hook's own
 * (`hostedEngineOf` of the report's ACTUAL engine), so this cannot drift from it.
 *
 * Calling this IS that effect running. The effect is keyed on the engine it
 * derived, not on the render, so a caller calls it exactly when that value
 * changed: once the first answer landed, and once more after an invalidation
 * dropped it. The returned release is the effect's cleanup.
 * @param cache - the cache the surfaces read.
 * @param sessionId - the session whose surface is on screen.
 * @returns the release the hook installs as its cleanup.
 */
function reflectAsSurface(cache: SessionEngineCache, sessionId: string): () => void {
  focusTurnStatusSession(sessionId)
  const report = cache.read(sessionId)
  reflectTurnStatusEngine(sessionId, report === undefined ? undefined : hostedEngineOf(report.engine))
  return () => { blurTurnStatusSession(sessionId) }
}

describe('the turn-status row the session on screen paints', () => {
  afterEach(() => { delete (globalThis as { document?: unknown }).document })

  it('paints a hosted engine and clears for in-process or an unnamed engine', () => {
    const dataset = fakeDocument()
    focusTurnStatusSession('s1')

    reflectTurnStatusEngine('s1', 'pi')
    expect(dataset[ENGINE_KEY]).toBe('pi')

    // `in-process` is the harness's own row, not an engine of ours.
    reflectTurnStatusEngine('s1', 'in-process')
    expect(ENGINE_KEY in dataset).toBe(false)

    reflectTurnStatusEngine('s1', 'claude-code')
    expect(dataset[ENGINE_KEY]).toBe('claude-code')
    // No engine named at all (`legacy` / `unset` / nothing yet): the row goes
    // back to stock instead of guessing one.
    reflectTurnStatusEngine('s1', undefined)
    expect(ENGINE_KEY in dataset).toBe(false)
  })

  it('writes nothing when there is no document, so a non-browser boot cannot throw', () => {
    focusTurnStatusSession('s1')
    expect(() => { reflectTurnStatusEngine('s1', 'pi') }).not.toThrow()
  })

  it('lets no session but the one on screen paint the row', () => {
    const dataset = fakeDocument()
    // The session on screen, as its chip and its composer declare and paint it.
    focusTurnStatusSession('A')
    reflectTurnStatusEngine('A', 'pi')
    expect(dataset[ENGINE_KEY]).toBe('pi')

    // A reflection that speaks for another session is a no-op: the late answer
    // of the session the user has left, or a surface of a session that is not on
    // screen, cannot paint this row...
    reflectTurnStatusEngine('B', 'kimi')
    expect(dataset[ENGINE_KEY]).toBe('pi')

    // ...and the row is still session A's to paint and to clear.
    reflectTurnStatusEngine('A', 'codex')
    expect(dataset[ENGINE_KEY]).toBe('codex')
    reflectTurnStatusEngine('A', undefined)
    expect(ENGINE_KEY in dataset).toBe(false)
  })

  it('keeps the replacing session\'s focus when a departing surface unmounts', () => {
    const dataset = fakeDocument()
    // Session A is on screen; the user switches to B, whose surface mounts...
    focusTurnStatusSession('A')
    reflectTurnStatusEngine('A', 'pi')
    focusTurnStatusSession('B')
    reflectTurnStatusEngine('B', 'kimi')
    // ...and A's surface unmounts only then — React runs a departing component's
    // cleanup in no guaranteed order against an arriving one's, and an
    // unconditional withdrawal would un-focus the session that just took over,
    // so A's late answer would paint over it.
    blurTurnStatusSession('A')
    reflectTurnStatusEngine('A', 'claude-code')
    expect(dataset[ENGINE_KEY]).toBe('kimi')

    // That the first assertion holds IS the withdrawal's guard at work: A's
    // cleanup ran while B was the focus, so it withdrew nothing and B is still
    // the row's writer. Had it withdrawn B's focus, B's own next reflection —
    // the chip and the composer both make one whenever the answer changes —
    // would go nowhere.
    reflectTurnStatusEngine('B', 'codex')
    expect(dataset[ENGINE_KEY]).toBe('codex')
  })

  it('writes nothing for a page with no session', () => {
    const dataset = fakeDocument()
    // The new-session page has no turn-status row and no session to speak for:
    // a reflection from there writes nothing and clears nothing.
    reflectTurnStatusEngine(undefined, 'kimi')
    expect(ENGINE_KEY in dataset).toBe(false)

    // ...and it does not take the row away from the session that IS on screen.
    focusTurnStatusSession('A')
    reflectTurnStatusEngine('A', 'pi')
    reflectTurnStatusEngine(undefined, 'kimi')
    expect(dataset[ENGINE_KEY]).toBe('pi')
    // The session on screen is still the only writer.
    reflectTurnStatusEngine('A', 'codex')
    expect(dataset[ENGINE_KEY]).toBe('codex')
  })

  it('does not let a background session\'s answer take the row over', async () => {
    // The regression this guard exists for: an answer landing for a session that
    // is not on screen used to repaint the row, because the cache reflected on
    // every publish and "the write that landed last" is not "the session on
    // screen" — the chip and the composer of every rendered session write here.
    const dataset = fakeDocument()
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)

    cache.watch('A', () => {})
    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'claude-code' } } })
    await flushed()
    reflectAsSurface(cache, 'A')
    expect(dataset[ENGINE_KEY]).toBe('claude-code')

    // Another session is answered while A is on screen. Under the old rule this
    // was the last write, and the row showed Kimi's moon beside a Pi session.
    cache.watch('B', () => {})
    host.settle(1, { ok: true, value: { engine: { kind: 'engine', engine: 'kimi' } } })
    await flushed()
    expect(cache.read('B')).toEqual({ engine: { kind: 'engine', engine: 'kimi' } })
    expect(dataset[ENGINE_KEY]).toBe('claude-code')
  })

  it('follows the session on screen through a switch: repaints on the new answer, clears while it is unknown', async () => {
    const dataset = fakeDocument()
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)
    cache.watch('A', () => {})

    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'claude-code' } } })
    await flushed()
    reflectAsSurface(cache, 'A')
    expect(dataset[ENGINE_KEY]).toBe('claude-code')

    // The switch landed: the cached answer is dropped, so the surface derives no
    // engine at all and the row goes back to stock until the re-read answers.
    cache.invalidate('A')
    reflectAsSurface(cache, 'A')
    expect(ENGINE_KEY in dataset).toBe(false)

    host.settle(1, { ok: true, value: { engine: { kind: 'engine', engine: 'pi' } } })
    await flushed()
    reflectAsSurface(cache, 'A')
    expect(dataset[ENGINE_KEY]).toBe('pi')
  })

  it('paints the engine the session runs, never the one it has only recorded', async () => {
    const dataset = fakeDocument()
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)
    cache.watch('A', () => {})

    // A committed switch to codex that the harness loop cannot take over: the
    // session still runs the in-process loop, so the row stays stock even
    // though the record already names codex.
    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'in-process' }, pending: 'codex' } })
    await flushed()
    expect(cache.read('A')).toEqual({ engine: { kind: 'engine', engine: 'in-process' }, pending: 'codex' })
    reflectAsSurface(cache, 'A')
    expect(ENGINE_KEY in dataset).toBe(false)

    // And the other direction: the live engine is pi, and what is pending is
    // the move to the in-process loop — the row draws pi.
    cache.invalidate('A')
    host.settle(1, { ok: true, value: { engine: { kind: 'engine', engine: 'pi' }, pending: 'in-process' } })
    await flushed()
    reflectAsSurface(cache, 'A')
    expect(dataset[ENGINE_KEY]).toBe('pi')
  })

  it('does not let the session the user left paint back over the new one', async () => {
    const dataset = fakeDocument()
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)
    cache.watch('A', () => {})
    cache.watch('B', () => {})

    // A is on screen and answered; then the user switches to B, whose own read
    // is still in flight when it takes the row over.
    host.settle(0, { ok: true, value: { engine: { kind: 'engine', engine: 'claude-code' } } })
    await flushed()
    reflectAsSurface(cache, 'A')
    expect(dataset[ENGINE_KEY]).toBe('claude-code')
    reflectAsSurface(cache, 'B')
    expect(ENGINE_KEY in dataset).toBe(false)
    host.settle(1, { ok: true, value: { engine: { kind: 'engine', engine: 'pi' } } })
    await flushed()
    reflectAsSurface(cache, 'B')
    expect(dataset[ENGINE_KEY]).toBe('pi')

    // A's answer lands again after that (a re-read of a session nobody is
    // looking at any more): it must neither clear the row nor repaint it.
    cache.invalidate('A')
    expect(dataset[ENGINE_KEY]).toBe('pi')
    host.settle(2, { ok: true, value: { engine: { kind: 'engine', engine: 'claude-code' } } })
    await flushed()
    expect(dataset[ENGINE_KEY]).toBe('pi')
  })

  it('keeps the row stock for every answer that names no engine', async () => {
    const dataset = fakeDocument()
    const cache = new SessionEngineCache()
    const host = fakeRemote()
    cache.attach(host.remote)
    // Eight sessions, each the one on screen in turn — the user walking through
    // them. Every hosted answer has to repaint the row, and every answer that
    // names no engine has to take the paint back off: `legacy` (it ran a hosted
    // engine, the id never said which) and `unset` by their own report,
    // `in-process` because the router's own fold drops it, and an unanswered
    // session because the row never guesses an engine it does not know.
    const cases: Array<{ sessionId: string; result: SessionEngineResult; painted: string | undefined }> = [
      { sessionId: 'kimi', result: { ok: true, value: { engine: { kind: 'engine', engine: 'kimi' } } }, painted: 'kimi' },
      { sessionId: 'legacy', result: { ok: true, value: { engine: { kind: 'legacy' } } }, painted: undefined },
      { sessionId: 'codex', result: { ok: true, value: { engine: { kind: 'engine', engine: 'codex' } } }, painted: 'codex' },
      { sessionId: 'unset', result: { ok: true, value: { engine: { kind: 'unset' } } }, painted: undefined },
      { sessionId: 'pi', result: { ok: true, value: { engine: { kind: 'engine', engine: 'pi' } } }, painted: 'pi' },
      {
        sessionId: 'in-process',
        result: { ok: true, value: { engine: { kind: 'engine', engine: 'in-process' } } },
        painted: undefined,
      },
      {
        sessionId: 'claude-code',
        result: { ok: true, value: { engine: { kind: 'engine', engine: 'claude-code' } } },
        painted: 'claude-code',
      },
      { sessionId: 'refused', result: { ok: false, error: { message: 'no such session' } }, painted: undefined },
    ]
    for (const entry of cases) cache.watch(entry.sessionId, () => {})

    for (const [index, entry] of cases.entries()) {
      host.settle(index, entry.result)
      await flushed()
      reflectAsSurface(cache, entry.sessionId)
      expect(dataset[ENGINE_KEY]).toBe(entry.painted)
      // Cleared, not set to an empty value.
      expect(ENGINE_KEY in dataset).toBe(entry.painted !== undefined)
    }
    expect(host.calls).toEqual(cases.map(entry => entry.sessionId))
  })
})

describe('sessionEngineSwitcher', () => {
  it('reports a successful switch and hands the session id to the invalidation hook', async () => {
    const ctx = new Context()
    ctx.provide('remote.loopEngine', {
      engine: vi.fn(),
      select: vi.fn(async () => ({ ok: true, value: { ok: true, engine: 'pi' } })),
    })
    const switched = vi.fn()
    const switchEngine = sessionEngineSwitcher(ctx, switched)

    await expect(switchEngine('s1', 'pi')).resolves.toEqual({ ok: true })
    expect(switched).toHaveBeenCalledWith('s1')
    await ctx.fiber.dispose()
  })

  it('reports a switch the host made by releasing the session, and reloads the page for it', async () => {
    const ctx = new Context()
    ctx.provide('remote.loopEngine', {
      engine: vi.fn(),
      select: vi.fn(async () => ({
        ok: true,
        value: { ok: true, engine: 'in-process', reload: true },
      })),
    })
    const switched = vi.fn()
    const page = fakePage()
    const switchEngine = sessionEngineSwitcher(ctx, switched, page)

    // The pick was committed — the host's own read for this session changed, so
    // the cached engine is stale and gets dropped — and the session's agent was
    // RELEASED to make it land: the page reloads, and the id is stashed so the
    // page that comes back opens this session rather than the client's own
    // startup fallback.
    await expect(switchEngine('s1', 'in-process')).resolves.toEqual({ ok: true, reload: true })
    expect(switched).toHaveBeenCalledWith('s1')
    expect(page.stash?.getItem(RELOAD_RETURN_KEY)).toBe('s1')
    expect(page.reloads).toBe(1)
    await ctx.fiber.dispose()
  })

  it('reloads the page even when the tab can hold no stash for the way back', async () => {
    const ctx = new Context()
    ctx.provide('remote.loopEngine', {
      engine: vi.fn(),
      select: vi.fn(async () => ({ ok: true, value: { ok: true, engine: 'pi', reload: true } })),
    })
    // A tab whose storage refuses the write (private mode, quota): the switch
    // still lands, and the page still reloads — only the return is lost.
    const page = fakePage({ setItem: () => { throw new Error('quota exceeded') } })
    const switchEngine = sessionEngineSwitcher(ctx, undefined, page)

    await expect(switchEngine('s1', 'pi')).resolves.toEqual({ ok: true, reload: true })
    expect(page.reloads).toBe(1)
    await ctx.fiber.dispose()
  })

  it('reports a refusal with its code and the host\'s sentence, and invalidates nothing', async () => {
    const ctx = new Context()
    ctx.provide('remote.loopEngine', {
      engine: vi.fn(),
      select: vi.fn(async () => ({
        ok: true,
        value: {
          ok: false,
          code: 'turn-running',
          reason: 'session "s1" is running; switch its engine after this turn ends',
        },
      })),
    })
    const switched = vi.fn()
    const switchEngine = sessionEngineSwitcher(ctx, switched)

    // The code travels with the refusal — it is what the composer localizes —
    // and the host's sentence is kept beside it as detail.
    await expect(switchEngine('s1', 'pi'))
      .resolves.toEqual({
        ok: false,
        kind: 'refused',
        code: 'turn-running',
        reason: 'session "s1" is running; switch its engine after this turn ends',
      })
    // The session's engine did not change, so the cached answer is still right.
    expect(switched).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reports a refusal that carries no code at all, with the host\'s sentence as the message', async () => {
    const ctx = new Context()
    ctx.provide('remote.loopEngine', {
      engine: vi.fn(),
      select: vi.fn(async () => ({ ok: true, value: { ok: false, reason: 'a newer host said no' } })),
    })
    const switchEngine = sessionEngineSwitcher(ctx)

    // An older host (or a hand-written answer) is not a broken answer: the
    // refusal still reaches the surface with something readable in it.
    await expect(switchEngine('s1', 'pi'))
      .resolves.toEqual({ ok: false, kind: 'refused', reason: 'a newer host said no' })
    await ctx.fiber.dispose()
  })

  it('reports a refused CALL separately from a refused SWITCH', async () => {
    const ctx = new Context()
    ctx.provide('remote.loopEngine', {
      engine: vi.fn(),
      select: vi.fn(async () => ({
        ok: false,
        error: { message: 'engine must be one of in-process, claude-code, codex, pi, kimi' },
      })),
    })
    const switched = vi.fn()
    const switchEngine = sessionEngineSwitcher(ctx, switched)

    // A request the Gateway itself rejected never reached the plugin, so there is
    // no host sentence about the session to show — only the gateway's frame.
    await expect(switchEngine('s1', 'pi'))
      .resolves.toEqual({
        ok: false,
        kind: 'refused',
        reason: 'engine must be one of in-process, claude-code, codex, pi, kimi',
      })
    expect(switched).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reports an unreachable namespace and a rejected call as refusals', async () => {
    const bare = new Context()
    const unreachable = sessionEngineSwitcher(bare)
    await expect(unreachable('s1', 'pi')).resolves.toEqual({ ok: false, kind: 'unavailable' })
    await bare.fiber.dispose()

    const ctx = new Context()
    ctx.provide('remote.loopEngine', {
      engine: vi.fn(),
      select: vi.fn(async () => { throw new Error('method unmounted') }),
    })
    const switchEngine = sessionEngineSwitcher(ctx)
    await expect(switchEngine('s1', 'pi'))
      .resolves.toEqual({ ok: false, kind: 'refused', reason: 'method unmounted' })
    await ctx.fiber.dispose()
  })
})

describe('the reload return', () => {
  it('stashes the session for the page that replaces this one, and reads it back exactly once', () => {
    const page = fakePage()

    expect(armReloadReturn(page, 's1')).toBe(true)
    expect(page.stash!.getItem(RELOAD_RETURN_KEY)).toBe('s1')
    expect(takeReloadReturn(page)).toBe('s1')
    // Reading is destructive: a later reload this feature did not ask for must
    // not drag the user back into a session they have since moved away from.
    expect(takeReloadReturn(page)).toBeUndefined()
  })

  it('neither arms nor takes anything on a page with no tab storage', () => {
    const page: ReloadPage = { stash: undefined, reload: () => {} }

    expect(armReloadReturn(page, 's1')).toBe(false)
    expect(takeReloadReturn(page)).toBeUndefined()
  })

  it('treats an empty stash, and one that cannot be read, as no return at all', () => {
    const empty = fakePage()
    empty.stash!.setItem(RELOAD_RETURN_KEY, '')
    expect(takeReloadReturn(empty)).toBeUndefined()

    const unreadable: ReloadPage = {
      stash: {
        getItem: () => { throw new Error('storage disabled') },
        setItem: () => {},
        removeItem: () => {},
      },
      reload: () => {},
    }
    expect(takeReloadReturn(unreadable)).toBeUndefined()
  })

  it('opens the stashed session as soon as the list that carries it arrives', () => {
    const page = fakePage()
    armReloadReturn(page, 's1')
    const host = fakeSessions({ phase: 'pending', ids: [] })
    const warn = vi.fn()

    const release = restoreReloadReturn(host.sessions, page, warn)

    // Nothing is opened on a list that has not arrived: the ids are not known yet,
    // and `open` refuses an id the client cannot see.
    expect(host.opened).toEqual([])
    host.publish({ phase: 'pending', ids: ['s1'] })
    expect(host.opened).toEqual([])
    // The first settled list is the one that decides: the session is on disk, so
    // the host lists it, and opening it is what makes the host build it again.
    host.publish({ phase: 'ready', ids: ['other', 's1'] })
    expect(host.opened).toEqual(['s1'])
    expect(warn).not.toHaveBeenCalled()
    // One decision per reload: a later list (a reconnect re-pull) opens nothing.
    host.publish({ phase: 'ready', ids: ['s1'] })
    expect(host.opened).toEqual(['s1'])
    expect(page.stash!.getItem(RELOAD_RETURN_KEY)).toBeNull()
    release()
  })

  it('decides on the list that is already settled, and gives up when it never carries the session', () => {
    const page = fakePage()
    armReloadReturn(page, 'gone')
    // The list settled before this feature was installed (the plugin mounts
    // after the first pull), and it does not carry the session.
    const host = fakeSessions({ phase: 'ready', ids: ['other'] })
    const warn = vi.fn()

    const release = restoreReloadReturn(host.sessions, page, warn)

    expect(host.opened).toEqual([])
    // Reported once, in the plugin's own words: there is nothing to open, and the
    // user has to pick the session out of the list themselves.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not in the session list'))
    // And a later list cannot reopen it either: waiting would only hijack a page
    // the user has long since moved on from.
    host.publish({ phase: 'ready', ids: ['gone'] })
    expect(host.opened).toEqual([])
    release()
  })

  it('reports a session service that refuses the open instead of breaking its own publication', () => {
    const page = fakePage()
    armReloadReturn(page, 's1')
    const host = fakeSessions({ phase: 'ready', ids: ['s1'] })
    host.failOpen = new Error('unknown session s1')
    const warn = vi.fn()

    const release = restoreReloadReturn(host.sessions, page, warn)
    // The throw happens inside the list store's notification: letting it escape
    // would break the harness's publication, not just this feature.
    expect(() => { host.publish({ phase: 'ready', ids: ['s1'] }) }).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not reopen session "s1"'))
    release()
  })

  it('does nothing for a page that was not reloaded for a session', () => {
    const page = fakePage()
    const host = fakeSessions({ phase: 'ready', ids: ['s1'] })
    const warn = vi.fn()

    const release = restoreReloadReturn(host.sessions, page, warn)

    expect(host.opened).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    release()
  })

  it('installs itself on the client tree and opens the session through the real service', async () => {
    const page = fakePage()
    armReloadReturn(page, 's1')
    const host = fakeSessions({ phase: 'ready', ids: ['s1'] })
    const ctx = new Context()
    ctx.provide('sessions', host.sessions)
    const warn = vi.fn()

    installReloadReturn(ctx as unknown as Parameters<typeof installReloadReturn>[0], page, warn)
    await vi.waitFor(() => { expect(host.opened).toEqual(['s1']) })

    // The subscription belongs to the injected fiber, so unloading the client
    // tree takes it with it.
    await ctx.fiber.dispose()
    host.publish({ phase: 'ready', ids: ['s1'] })
    expect(host.opened).toEqual(['s1'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reloads the live page through location.reload and reads its storage', () => {
    // The one place the browser globals are read; a page that has neither is a
    // node boot, which this feature must survive.
    const globals = globalThis as { location?: { reload(): void }; sessionStorage?: ReloadStash }
    const reload = vi.fn()
    const held = new Map<string, string>()
    globals.location = { reload }
    globals.sessionStorage = {
      getItem: key => held.get(key) ?? null,
      setItem: (key, value) => { held.set(key, value) },
      removeItem: (key) => { held.delete(key) },
    }
    try {
      const page = browserPage()
      expect(armReloadReturn(page, 's1')).toBe(true)
      page.reload()
      expect(reload).toHaveBeenCalledTimes(1)
      expect(takeReloadReturn(page)).toBe('s1')
    } finally {
      delete globals.location
      delete globals.sessionStorage
    }
    const bare = browserPage()
    expect(bare.stash).toBeUndefined()
    expect(() => { bare.reload() }).not.toThrow()
  })
})

describe('the Remote contribution the browser half mounts', () => {
  it('declares both endpoints, the argument name, and the strict codecs the mount requires', () => {
    expect(LOOP_ENGINE_REMOTE_CONTRIBUTION.package).toBe('dsh-loop-engine')
    expect(LOOP_ENGINE_REMOTE_CONTRIBUTION.descriptors.map(descriptor => descriptor.method))
      .toEqual([LOOP_ENGINE_REMOTE_METHOD, LOOP_ENGINE_REMOTE_SELECT_METHOD])

    for (const descriptor of LOOP_ENGINE_REMOTE_CONTRIBUTION.descriptors) {
      expect(descriptor).toMatchObject({
        service: LOOP_ENGINE_REMOTE_NAMESPACE,
        namespace: LOOP_ENGINE_REMOTE_NAMESPACE,
        invocation: { kind: 'direct' },
      })
      // The wire field must be the HOST method's own parameter name for each
      // endpoint (`src/engine-remote.ts`, pinned in `tests/engine-remote.spec.ts`).
      expect(descriptor.parameters).toHaveLength(1)
      expect(descriptor.parameters[0]).toMatchObject({ name: 'request', wire: 'request', source: 'json' })
      expect(descriptor.parameters[0]!.codec.mode).toBe('strict')
      expect(descriptor.result.mode).toBe('strict')
    }
  })

  it('normalizes the reporting request and refuses one without a session id', () => {
    const schema = LOOP_ENGINE_REMOTE_CONTRIBUTION.descriptors[0]!.parameters[0]!.codec.schema
    expect(schema.parse({ sessionId: 's1', extra: true })).toEqual({ sessionId: 's1' })
    expect(() => schema.parse({ sessionId: '' })).toThrow(/sessionId must be a non-empty string/)
    expect(() => schema.parse(undefined)).toThrow(/sessionId must be a non-empty string/)
  })

  it('accepts exactly the three engine states and rejects anything else', () => {
    const schema = LOOP_ENGINE_REMOTE_CONTRIBUTION.descriptors[0]!.result.schema
    expect(schema.parse({ engine: { kind: 'engine', engine: 'kimi' } }))
      .toEqual({ engine: { kind: 'engine', engine: 'kimi' } })
    expect(schema.parse({ engine: { kind: 'legacy' } })).toEqual({ engine: { kind: 'legacy' } })
    expect(schema.parse({ engine: { kind: 'unset' } })).toEqual({ engine: { kind: 'unset' } })
    expect(() => schema.parse({ engine: { kind: 'engine', engine: 'not-an-engine' } }))
      .toThrow(/not a session engine state/)
    expect(() => schema.parse({ engine: { kind: 'unknown' } })).toThrow(/not a session engine state/)
    // A bare three-state is no longer an answer: the report wraps it.
    expect(() => schema.parse({ kind: 'engine', engine: 'kimi' })).toThrow(/not a session engine state/)
  })

  it('carries the engine a session has recorded but not adopted as pending', () => {
    const schema = LOOP_ENGINE_REMOTE_CONTRIBUTION.descriptors[0]!.result.schema
    const pending = { engine: { kind: 'engine', engine: 'pi' }, pending: 'in-process' }
    expect(schema.parse(pending)).toEqual(pending)
    // A pending field that is not an installed engine is no answer at all,
    // not a session shown as running the engine it has only recorded.
    expect(() => schema.parse({ engine: { kind: 'engine', engine: 'pi' }, pending: 'gpt' }))
      .toThrow(/is not a session engine state/)
  })

  it('refuses a switching request that names no session or no installed engine', () => {
    const schema = LOOP_ENGINE_REMOTE_CONTRIBUTION.descriptors[1]!.parameters[0]!.codec.schema
    expect(schema.parse({ sessionId: 's1', engine: 'pi' })).toEqual({ sessionId: 's1', engine: 'pi' })
    expect(schema.parse({ sessionId: 's1', engine: 'in-process', extra: true }))
      .toEqual({ sessionId: 's1', engine: 'in-process' })
    expect(() => schema.parse({ sessionId: '', engine: 'pi' })).toThrow(/sessionId must be a non-empty string/)
    expect(() => schema.parse({ sessionId: 's1' })).toThrow(/engine must be one of in-process/)
    expect(() => schema.parse({ sessionId: 's1', engine: 'gpt' })).toThrow(/engine must be one of in-process/)
  })

  it('carries both switch outcomes across the boundary', () => {
    const schema = LOOP_ENGINE_REMOTE_CONTRIBUTION.descriptors[1]!.result.schema
    expect(schema.parse({ ok: true, engine: 'codex' })).toEqual({ ok: true, engine: 'codex' })
    // A switch the host made by releasing the session's agent asks this half to
    // reload the page, so that flag must survive the boundary — as the literal
    // `true`, which is the only value that may ask for it.
    expect(schema.parse({ ok: true, engine: 'in-process', reload: true }))
      .toEqual({ ok: true, engine: 'in-process', reload: true })
    expect(() => schema.parse({ ok: true, engine: 'pi', reload: 'yes' }))
      .toThrow(/not an engine switch outcome/)
    expect(() => schema.parse({ ok: true, engine: 'pi', reload: 1 }))
      .toThrow(/not an engine switch outcome/)
    // A refusal is an ordinary answer — the branch's code for the surface to
    // localize, plus the host's own sentence kept as detail.
    expect(schema.parse({ ok: false, code: 'turn-running', reason: 'session "s1" is running; switch its engine after this turn ends' }))
      .toEqual({ ok: false, code: 'turn-running', reason: 'session "s1" is running; switch its engine after this turn ends' })
    // A refusal without a code is still a refusal (an older host): the sentence
    // stays the message, so nothing readable is lost.
    expect(schema.parse({ ok: false, reason: 'session "s1" is not open; open it first, then switch its engine' }))
      .toEqual({ ok: false, reason: 'session "s1" is not open; open it first, then switch its engine' })
    // A code this build does not know is normalized AWAY rather than rejected:
    // dropping it costs the user localization, rejecting the answer would cost
    // them the reason too.
    expect(schema.parse({ ok: false, code: 'quota-exceeded', reason: 'a newer host said no' }))
      .toEqual({ ok: false, reason: 'a newer host said no' })
    expect(() => schema.parse({ ok: true, engine: 'gpt' })).toThrow(/not an engine switch outcome/)
    expect(() => schema.parse({ ok: false })).toThrow(/not an engine switch outcome/)
    expect(() => schema.parse(null)).toThrow(/not an engine switch outcome/)
  })
})
