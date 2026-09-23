/**
 * The dsh model selection a hosted engine is handed, and the ONE judgement that
 * decides it.
 *
 * A session's model seat is the harness's own per-session fact: the host writes
 * a `model/selection` event when the user picks a model, and derives the
 * session's selection from the newest pending selection, else the logged
 * `request/header` (`packages/api/session-controller/src/agent.ts`,
 * `selectionFor`). A hosted engine owns its model natively, but it can still be
 * handed a real dsh model when the session selected one — that is what this
 * module answers.
 *
 * Three cases, decided once here and consumed by all four drivers:
 *
 *  - NO selection, or one whose provider is a hosted engine route label
 *    ({@link isHostedProviderRoute}: today's shared `external`, or a label an
 *    earlier build logged) → `undefined`. The engine keeps its own native
 *    default or the model the deployment pinned in its composition; nothing is
 *    sent, so the engine is not asked a question it never had an opinion on.
 *  - a REAL dsh model (any other provider) → `{ provider, model }`. Each engine
 *    renders that into its own interface: Pi's `--model <provider>/<model>`,
 *    Claude Code's `Options.model`, Codex's `thread/start` `model`, and Kimi's
 *    ACP `session/set_model`. Whether the engine can actually serve the model is
 *    the engine's own business: a refusal is reported, never swallowed.
 *
 * The read is the host's own ({@link currentSelection}), so the value an engine
 * gets is the value the host would install for the session — and it is taken
 * fresh on every step, because a session's model can change mid-conversation.
 *
 * @module dsh-loop-engine/driver-core/session-model
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { isHostedProviderRoute } from '../provider-route.ts'
import type { SessionModelSelection, SessionProjectionsService } from './host-servers.ts'

/** The model a session's own selection asks a hosted engine to run. */
export interface SessionModelOverride {
  /** Provider route the selection names, in the engine's own provider vocabulary. */
  readonly provider: string
  /** Provider-owned model id the selection names. */
  readonly model: string
}

/**
 * The selection the host will use for this session, by the host's own read
 * (`ApiSessionAgentController.selectionFor`): a pending selection — one
 * appended, not yet consumed by a matching recorded request — outranks the
 * logged header, and the header answers when nothing is pending.
 *
 * A deployment with no session-projection registry is not an error: the read
 * simply skips the pending half and answers from the logged header, exactly as
 * a session whose log carries only a header would.
 * @param session - the session whose selection is being read.
 * @param projections - the host session-projection registry, when composed.
 * @returns the current selection, or undefined when the log records none.
 */
export function currentSelection(
  session: Session,
  projections: SessionProjectionsService | undefined,
): SessionModelSelection | undefined {
  const pending = projections?.stateOf(session, 'modelSelection')?.pending ?? null
  if (pending !== null) return pending
  const header = session.requestHeader()?.config
  return header === undefined ? undefined : { provider: header.provider, model: header.model }
}

/**
 * The model one hosted engine should be handed for this selection, or
 * `undefined` to leave the engine to its own default (or the deployment's pin).
 *
 * The provider is the whole test: a hosted engine route label — the shared
 * `external` this plugin serves as a placeholder, or a per-engine label an
 * earlier build logged — means "the engine decides", not a model to send. Any
 * other provider is a real dsh model, and the plugin passes it through rather
 * than second-guessing whether the engine can serve it: a rejection is the
 * engine's to report, and this plugin surfaces it.
 * @param selection - the session's current selection, or undefined when none.
 * @returns the model to hand over, or undefined to send nothing.
 */
export function sessionModelOverride(
  selection: SessionModelSelection | undefined,
): SessionModelOverride | undefined {
  if (selection === undefined) return undefined
  if (isHostedProviderRoute(selection.provider)) return undefined
  return { provider: selection.provider, model: selection.model }
}

/**
 * The model override for one session, read live from its log and judged by
 * {@link sessionModelOverride}.
 *
 * The four drivers' single entry: each calls this at the top of every step, so a
 * model picked mid-conversation lands on the engine's next request rather than
 * being frozen when the agent was built.
 * @param ctx - the driver's context, carrying the session-projection registry.
 * @param session - the session whose selection is being resolved.
 * @returns the model to hand the engine, or undefined to send nothing.
 */
export function sessionModelOverrideOf(
  ctx: Context,
  session: Session,
): SessionModelOverride | undefined {
  return sessionModelOverride(
    currentSelection(session, ctx.get('sessionProjections') as SessionProjectionsService | undefined),
  )
}
