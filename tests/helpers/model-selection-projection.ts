/**
 * The host's `modelSelection` session projection, reproduced for suites that
 * need the pending/header read.
 *
 * `@deepseek-ai/dsh-api-session-controller` owns this fold and is not a
 * dependency of this package, so it is reproduced from the host's source
 * (`packages/api/session-controller/src/model-selection-projection.ts`) on top
 * of the generic {@link fakeSessionProjections} registry. A session's selection
 * is `pending` until a matching `request/header` retires it, and the header is
 * the fallback — which is exactly the read `driver-core/session-model.ts` makes.
 *
 * @module tests/helpers/model-selection-projection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { fakeSessionProjections } from './session-projections.ts'

/** One complete selection as the projection holds it. */
interface FoldedSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The `modelSelection` fold's state. */
interface FoldedState {
  readonly lastUsed: FoldedSelection | null
  readonly pending: FoldedSelection | null
}

/** Whether two selections name the same provider/model/effort. */
function sameSelection(left: FoldedSelection | null, right: FoldedSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort)
}

/**
 * Mount a `sessionProjections`-shaped registry carrying the host's
 * `modelSelection` fold.
 * @param ctx - context the fold's `session/event` subscription belongs to.
 * @returns the registry to provide as `sessionProjections`.
 */
export function modelSelectionProjections(ctx: Context) {
  const projections = fakeSessionProjections(ctx)
  projections.register({
    key: 'modelSelection',
    init: (): FoldedState => ({ lastUsed: null, pending: null }),
    apply: (state: FoldedState, event: SessionEvent): FoldedState => {
      if (event.type === 'model/selection') {
        return sameSelection(state.pending, event.data)
          ? state
          : { lastUsed: state.lastUsed, pending: event.data }
      }
      if (event.type !== 'request/header') return state
      const lastUsed: FoldedSelection = {
        provider: event.data.header.config.provider,
        model: event.data.header.config.model,
        ...event.data.header.config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: String(event.data.header.config.reasoningEffort) },
      }
      const pending = sameSelection(state.pending, lastUsed) ? null : state.pending
      return sameSelection(state.lastUsed, lastUsed) && pending === state.pending
        ? state
        : { lastUsed, pending }
    },
  })
  return projections
}
