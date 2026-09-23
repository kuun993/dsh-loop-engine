/**
 * Reloading the page, and coming back to the session the switch rebuilt.
 *
 * Switching a session onto — or off — the harness loop cannot move its agent in
 * place, so the host RELEASES that agent and answers `reload: true`
 * (`src/router-loop.ts` `move`): the session's record already names the engine it
 * must run, and the host builds it again on its next resolve. Two things have to
 * happen on this side for the user to experience that as a switch rather than as
 * a session that broke:
 *
 *  1. THE PAGE MUST RELOAD. Releasing the agent publishes `session/disposed`, and
 *     the session controller's client half reads it as this session being GONE:
 *     the row leaves its list, the current selection is masked away, and the
 *     session object is marked `removed` — a flag NOTHING in that page's
 *     lifetime clears (`packages/api/session-controller/src/client/sessions/session.ts`
 *     `handleRemoved`), which is what locks the composer
 *     (`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`). A
 *     page that stayed put would show the session as unusable; a reload is the
 *     smallest action that replaces that page state with a fresh list and a
 *     fresh, unmarked session object.
 *  2. THAT SESSION HAS TO BE OPENED AGAIN, or the user lands wherever the client
 *     falls back to. Nothing does it for us: the reload clears the session
 *     controller's own persisted selection cell once the current selection was
 *     masked away (`.../client/sessions/service.ts` `projectList`), and the
 *     workspace's startup navigation only reuses a BLANK session of the most
 *     recent workspace, creating a fresh session otherwise
 *     (`.../client/ui-workspace/src/client/navigation.ts` `watchNavigation`). So
 *     the id is stashed in TAB storage — which survives a reload and dies with
 *     the tab — and {@link restoreReloadReturn} opens it as soon as the client's
 *     session list knows it.
 *
 * That last step is what makes the whole flow worth having: the session is still
 * on DISK, so the list the page re-pulls from the host contains it (the host's
 * list unions persisted headers with live sessions), and opening it is what makes
 * the host resolve the session at all — no live agent → `ctx.agents.resume(...)`
 * → the router reads the plugin's own record → the harness loop builds it. The
 * process never restarts.
 *
 * The page is poked only through `window.location.reload()` — nothing else: a
 * reload is the action a user would take themselves, and it is the one this
 * plugin can justify.
 *
 * @module dsh-loop-engine/client/reload
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Tab-scoped web storage, as this feature reads and writes it. */
export interface ReloadStash {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The browser this plugin's client half is running in, as this feature needs it. */
export interface ReloadPage {
  /** The tab's storage, or undefined off a browser (and in node, where the specs run). */
  readonly stash: ReloadStash | undefined
  /** Reload the current page. */
  reload(): void
}

/**
 * The stash key holding the session a reload has to come back to.
 *
 * Namespaced by package: tab storage is shared with everything else the page
 * runs, and one key per concern is all this feature needs.
 */
export const RELOAD_RETURN_KEY = 'dsh-loop-engine:reload-session'

/** The live page, read off the globals. Missing ones simply mean "no page". */
export function browserPage(): ReloadPage {
  const globals = globalThis as {
    readonly sessionStorage?: ReloadStash
    readonly location?: { reload(): void }
  }
  return {
    stash: globals.sessionStorage,
    // Off a browser there is no page to reload; the stash is missing there too,
    // so nothing is ever armed for one.
    reload: () => { globals.location?.reload() },
  }
}

/**
 * Remember the session a reload must reopen.
 *
 * Best-effort by design: a page whose storage refuses the write (private mode,
 * quota) still reloads, it just cannot promise the way back — the caller reports
 * what it could do rather than refusing the switch the host already performed.
 * @param page - the page to stash into.
 * @param sessionId - the session to come back to.
 * @returns whether the id was stashed.
 */
export function armReloadReturn(page: ReloadPage, sessionId: string): boolean {
  const stash = page.stash
  if (stash === undefined) return false
  try {
    stash.setItem(RELOAD_RETURN_KEY, sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Take the session this page was reloaded for, clearing it as it is read.
 *
 * Reading is destructive so the return happens exactly once per reload: the id
 * must not survive a second reload the user starts for their own reasons, and a
 * later visit to this tab has no session to come back to.
 * @param page - the page to read.
 * @returns the stashed session id, or undefined when this page is not one.
 */
export function takeReloadReturn(page: ReloadPage): string | undefined {
  const stash = page.stash
  if (stash === undefined) return undefined
  let stashed: string | null = null
  try {
    stashed = stash.getItem(RELOAD_RETURN_KEY)
  } catch {
    return undefined
  }
  if (stashed === null || stashed.length === 0) return undefined
  try {
    stash.removeItem(RELOAD_RETURN_KEY)
  } catch {
    // The id is already in hand: a storage that refuses the clear can only cost
    // one redundant open of a session that is already on screen.
  }
  return stashed
}

/**
 * The slice of the session controller's client service this module drives:
 * the list it publishes, and the verb that opens one of its sessions.
 *
 * Declared structurally rather than imported: this is a third-party client
 * plugin (no build-time dependency on the harness's client packages), and the
 * only two members it needs are these.
 */
export interface SessionListFace {
  readonly list: {
    getSnapshot(): { readonly phase: 'pending' | 'ready'; readonly ids: readonly string[] }
    subscribe(listener: () => void): () => void
  }
  open(id: string): void
}

/**
 * Open the session this page was reloaded for, once the client knows it.
 *
 * The wait is real and cannot be skipped: the list arrives with the host's list
 * RPC, asynchronously, and `open` refuses an id it does not know yet
 * (`sessions.select: unknown session ...`). One decision is made, on the FIRST
 * settled list — the id is either in it (open it) or the session is not listed
 * at all, in which case opening it is impossible and waiting longer would only
 * mean hijacking the page minutes later, after the user had moved on.
 * @param sessions - the session controller's client service.
 * @param page - the page whose stash is read.
 * @param warn - diagnostic sink for the two ways this can end without opening.
 * @returns the release, in case the plugin unloads before the list settles.
 */
export function restoreReloadReturn(
  sessions: SessionListFace,
  page: ReloadPage,
  warn: (message: string) => void,
): () => void {
  const sessionId = takeReloadReturn(page)
  if (sessionId === undefined) return () => {}
  let unsubscribe: (() => void) | undefined
  const settle = (): void => {
    const snapshot = sessions.list.getSnapshot()
    if (snapshot.phase !== 'ready') return
    unsubscribe?.()
    unsubscribe = undefined
    if (!snapshot.ids.includes(sessionId)) {
      warn(`loop-engine: the session this page was reloaded for ("${sessionId}") is not in the session list; open it from the list`)
      return
    }
    try {
      sessions.open(sessionId)
    } catch (error: unknown) {
      // This runs inside the list store's own notification, so a throw here
      // would break the harness's publication rather than just this feature.
      warn(`loop-engine: could not reopen session "${sessionId}" after the reload: ${String(error)}`)
    }
  }
  unsubscribe = sessions.list.subscribe(settle)
  // The list may have settled before this ran (a reload lands on a page whose
  // first pull already happened): the current snapshot answers that case.
  settle()
  return () => { unsubscribe?.() }
}

/**
 * Wire the return-to-session half into the client tree.
 *
 * Takes the `sessions` service through a nested injection rather than declaring
 * it in this plugin's own `inject`: a profile that composes no session
 * controller (the settings page's own tests, a minimal client) must keep
 * working, and this feature degrades to "reload without the way back" there —
 * the id is simply not stashed, because nothing could open it.
 * @param ctx - the client root context.
 * @param page - the page to read the stash from; the real browser by default.
 * @param warn - diagnostic sink; the client logger by default.
 */
export function installReloadReturn(
  ctx: ClientContext,
  page: ReloadPage = browserPage(),
  warn?: (message: string) => void,
): void {
  ctx.inject(['sessions'], (scope: ClientContext) => {
    const sessions = scope.get('sessions') as SessionListFace | undefined
    if (sessions === undefined) return
    const report = warn ?? ((message: string) => { scope.logger.warn(message) })
    scope.effect(
      () => restoreReloadReturn(sessions, page, report),
      'loop-engine: reopen the session this page was reloaded for',
    )
  })
}
