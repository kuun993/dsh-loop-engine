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
 * host: cells are per session and key, eager over `session/event`, and lazily
 * initialized from the unit's `init`.
 * @param ctx - context the drive's `session/event` subscription belongs to.
 * @returns a `sessionProjections`-shaped service.
 */
export function fakeSessionProjections(ctx: Context) {
  const units = new Map<string, ErasedUnit>()
  const cells = new WeakMap<Session, Map<string, unknown>>()

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

  ctx.on('session/event', (session, event) => {
    const cell = cellFor(session)
    for (const [key, unit] of units) cell.set(key, unit.apply(stateFor(session, key), event))
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
    stateOf: (session: Session, key: string): unknown => stateFor(session, key),
  }
}
