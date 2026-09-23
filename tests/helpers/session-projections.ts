/**
 * Shared session-projection stand-in for the router suites.
 *
 * `@deepseek-ai/dsh-session-projection` is not a dependency of this package (a
 * minimal profile may compose none), so a suite that needs the registry supplies
 * this structural stand-in instead. Unlike a fold-free stub, this one actually
 * FOLDS: the harness loop's inbox reads its own cell back mid-turn
 * (`ReactLoopInbox.current`), so a registry that only ever returned `init()`
 * would stall every turn before its first model call.
 *
 * @module tests/helpers/session-projections
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** One projection unit as the loop registers it, accepted structurally. */
interface RegisteredUnit {
  readonly key: string
  init(...args: never[]): unknown
  apply(state: never, event: SessionEvent): unknown
}

/** One registered unit after erasure, foldable without knowing its state type. */
interface ErasedUnit {
  readonly init: () => unknown
  readonly apply: (state: unknown, event: SessionEvent) => unknown
}

/**
 * The registry's slice this package reads, with the same fold semantics as the
 * host: cells are per session and key, eager over `session/event`, and
 * materialized lazily from the session's own log on a read.
 *
 * The lazy half is not decoration. A session is only attached to the session
 * store at PUBLICATION, so no `session/event` is emitted for anything appended
 * before that — which is exactly when a pre-publication composition appends
 * (the loop's own setup, and this plugin's model-selection guard). The real
 * registry catches up on read, so a stand-in that only ever folded emitted
 * events would answer "nothing recorded" for the one write the plugin makes
 * before the session exists to anyone else.
 * @param ctx - context the drive's `session/event` subscription belongs to.
 * @returns a `sessionProjections`-shaped service.
 */
export function fakeSessionProjections(ctx: Context) {
  const units = new Map<string, ErasedUnit>()
  const cells = new WeakMap<Session, Map<string, unknown>>()
  /** Highest event seq already folded into a session's cells. */
  const folded = new WeakMap<Session, number>()

  const cellFor = (session: Session): Map<string, unknown> => {
    let cell = cells.get(session)
    if (cell === undefined) {
      cell = new Map()
      cells.set(session, cell)
    }
    return cell
  }

  const stateFor = (session: Session, key: string): unknown => {
    const cell = cellFor(session)
    if (!cell.has(key)) {
      const unit = units.get(key)
      if (unit === undefined) return undefined
      cell.set(key, unit.init())
    }
    return cell.get(key)
  }

  const fold = (session: Session, event: SessionEvent): void => {
    const cell = cellFor(session)
    for (const [key, unit] of units) cell.set(key, unit.apply(stateFor(session, key), event))
    folded.set(session, event.seq)
  }

  /** Apply every event this session's cells have not seen yet, in order. */
  const catchUp = (session: Session): void => {
    const applied = folded.get(session) ?? -1
    for (const event of session.snapshotEvents()) {
      if (event.seq > applied) fold(session, event)
    }
  }

  ctx.on('session/event', (session, event) => {
    fold(session, event)
  })

  return {
    register: (definition: RegisteredUnit): (() => void) => {
      units.set(definition.key, {
        init: () => definition.init(),
        // The real registry erases the per-key state type the same way.
        apply: (state, event) => definition.apply(state as never, event),
      })
      return () => { units.delete(definition.key) }
    },
    stateOf: (session: Session, key: string): unknown => {
      catchUp(session)
      return stateFor(session, key)
    },
  }
}
