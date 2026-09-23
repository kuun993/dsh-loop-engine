/**
 * The React binding over the plugin's per-session engine cache.
 *
 * Separated from `./session-engine.ts` on purpose: the cache, the contribution,
 * and the switcher are plain logic with no React import, so they are exercised
 * in node (`tests/session-engine-cache.spec.ts`) — this file is the only part of
 * the read path that needs a component to render.
 *
 * It is also the ONE driver of the chat turn-status row
 * (`./turn-status.ts`): the row is painted through a document-level attribute,
 * and a component is the only place that knows whether the session it renders is
 * the one on screen. The cache cannot know that — it answers for every session a
 * surface has watched — so a reflection made from there could be (and was) taken
 * over by a background session. Here the chip and the composer of the session on
 * screen declare that session as the row's subject while they are mounted, with
 * the focus guard inside `reflectTurnStatusEngine`, and the reflection follows
 * the cache's answer so a switch repaints the row.
 *
 * @module dsh-loop-engine/client/use-session-engine
 */

import { useEffect, useState } from 'react'
import { hostedEngineOf, type SessionEngineReport } from '../agent-preset-ids.ts'
import {
  blurTurnStatusSession, focusTurnStatusSession, reflectTurnStatusEngine,
} from './turn-status.ts'
import type { SessionEngineCache } from './session-engine.ts'

/**
 * Follow one session's engine report in a component, and — because a component
 * is what knows whether this session is the one on screen — drive the chat
 * turn-status row from it.
 *
 * The value is read from the cache DURING render, so a session switch can never
 * paint the previous session's engine: only the re-render is deferred, and only
 * until the host answers. The reflection runs in an effect rather than during
 * render (it writes to the document), and re-runs when the ANSWER changes — not
 * just when the session id does — so the row follows a switch: the picker's
 * `invalidate` drops the cached answer, the cache re-asks, the hook's watcher
 * bumps, the engine changes, and the attribute lands on the engine the session
 * now runs.
 *
 * Only the ACTUAL engine reaches the row. A recorded engine that differs from it
 * is one whose switch never took over (its release did not complete), so the row
 * keeps painting what is really running — the same rule the chip and the composer
 * follow when they name an engine; they merely also carry the marker
 * ({@link SessionEngineReport}).
 *
 * The value is read from the cache DURING render, so a session switch can never
 * paint the previous session's engine: only the re-render is deferred, and only
 * until the host answers. This effect is also the trigger that re-reads the
 * session: it runs when the session on screen CHANGES (a mount, a switch, or the
 * same session opened again), and the subscription it installs re-reads the
 * session on its first watch (`SessionEngineCache.watch` → `refresh`), so a
 * session the user comes back to cannot keep rendering a report this page took
 * before — coming back is not what moves the session (a switch is performed on
 * the host, and the one that has to release the session reloads this page), but
 * it is long enough for the answer to be old.
 * Re-renders of the same session do not re-run this effect, so nothing here asks
 * again while the session stays on screen.
 *
 * One effect does the whole thing, so the three steps cannot come apart: declare
 * this session as the row's subject (`focusTurnStatusSession`), reflect its
 * engine by that declaration (`reflectTurnStatusEngine`), and release the
 * declaration when this surface goes away (`blurTurnStatusSession`, which
 * withdraws it only while it is still this session's).
 * @param cache - the cache the plugin mounted.
 * @param sessionId - the session to follow, or undefined off a session scope.
 * @returns the engine report, or undefined while it is unknown.
 */
export function useEngineOfSession(
  cache: SessionEngineCache,
  sessionId: string | undefined,
): SessionEngineReport | undefined {
  const [, bump] = useState(0)
  const report = sessionId === undefined ? undefined : cache.read(sessionId)
  // This effect runs once per session on screen — a first mount, a switch to
  // another session, or this session opened again — and the watch it installs
  // re-reads that session on its first watcher, so the surfaces never keep
  // rendering the report this page cached before. A re-render of the same
  // session does not re-run this effect, so it asks nothing more.
  useEffect(() => {
    if (sessionId === undefined) return
    return cache.watch(sessionId, () => { bump(count => count + 1) })
  }, [cache, sessionId])
  // The engine, as the row names it: a hosted id, or undefined for the harness's
  // own loop and for every answer that names no engine at all. The pending engine
  // is deliberately not reflected: it is not what this session is running.
  const engine = report === undefined ? undefined : hostedEngineOf(report.engine)
  useEffect(() => {
    // No session to speak for — the new-session page, which has no turn-status
    // row — so the row is left exactly as it is.
    if (sessionId === undefined) return
    focusTurnStatusSession(sessionId)
    reflectTurnStatusEngine(sessionId, engine)
    // React runs a departing component's cleanup in no guaranteed order against
    // an arriving one's, so the withdrawal is guarded: a session that is no
    // longer the row's subject must not un-focus the one that replaced it.
    return () => { blurTurnStatusSession(sessionId) }
  }, [sessionId, engine])
  return report
}
