/**
 * The `Agent.model` handle a hosted agent owes the 0.2.2 harness.
 *
 * The 0.2.2 `Agent` contract gained a model handle beside `session` and `inbox`:
 * the harness reads `agent.model.current()` where it used to read
 * `agent.options`, and hands a new choice back through `agent.model.select()`.
 * A hosted engine answers its own model calls, so neither direction decides what
 * the engine runs on — but the handle is part of the contract, and the readers
 * that matter are harness code: tool resolution and the system-prompt assembly
 * both reach for the agent's recorded selection rather than its static options.
 *
 * This module mirrors the harness's own `AgentModel`
 * (`packages/core/agent/src/model-selection.ts`) on top of the read the plugin
 * already shares: {@link currentSelection} — a pending `model/selection`, else
 * the logged `request/header` — outranks the agent's live options, exactly as
 * the host resolves it. `select()` appends the log-only `model/selection` event,
 * which is already the host's own way of recording a choice.
 *
 * Nothing here branches on the harness generation: an older harness never reads
 * the property, and both operations are plain session reads and appends that
 * every covered line has.
 *
 * @module dsh-loop-engine/driver-core/agent-model
 */

import type { AgentOptions, Model, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { HOSTED_DEFAULT_MODEL, HOSTED_ROUTE_LABEL } from '../agent-preset-ids.ts'
import { currentSelection } from './session-model.ts'
import type { SessionModelSelection, SessionProjectionsService } from './host-servers.ts'

/**
 * One hosted agent's `model` handle: the recorded selection, then its options.
 *
 * Constructed once per agent, like the harness's own handle, so a reader calling
 * `current()` on every step sees a choice appended mid-conversation.
 */
export class HostedAgentModel implements Model {
  /**
   * @param loopCtx - the engine's context, carrying the session-projection registry.
   * @param session - the live session whose log and projections hold the choice.
   * @param options - the agent's live options, the fallback when the log names none.
   */
  constructor(
    private readonly loopCtx: Context,
    private readonly session: Session,
    private readonly options: AgentOptions,
  ) {}

  /**
   * The choice the next step begins preparation with: the recorded selection,
   * else the agent's live options.
   * @returns a detached selection, or undefined when neither names a route.
   */
  current(): Readonly<ModelSelection> | undefined {
    const resolved = this.resolved()
    return resolved === undefined ? undefined : asModelSelection(resolved)
  }

  /**
   * Replace the next step's selection by appending the log-only event.
   *
   * A selection equal to the one the session already records is a no-op: it
   * says the same thing the session already says, and re-appending would only
   * grow the log. An options-only fallback is not recorded, so a selection equal
   * to it is written once — which is what makes it real.
   * @param selection - complete provider, model, and optional explicit effort.
   */
  select(selection: Readonly<ModelSelection>): void {
    const recorded = currentSelection(this.session, this.projections())
    if (recorded !== undefined && sameSelection(recorded, selection)) return
    this.session.append('model/selection', {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    })
  }

  /**
   * The selection a step announcement must carry, which the harness declares
   * non-optional.
   *
   * A hosted session always has one: the router seats the engine's own route
   * before the agent is built (`ModelSelectionReset.guardFor`), so the recorded
   * read answers. The fallback covers a composition that skipped that seat — a
   * hosted engine places no real model call, so naming the placeholder route
   * loses no request.
   * @returns the recorded selection, the agent's options, or the hosted placeholder.
   */
  forStep(): Readonly<ModelSelection> {
    return this.current() ?? asModelSelection({ provider: HOSTED_ROUTE_LABEL, model: HOSTED_DEFAULT_MODEL })
  }

  /** The recorded selection, else the agent's own options. */
  private resolved(): SessionModelSelection | undefined {
    const recorded = currentSelection(this.session, this.projections())
    if (recorded !== undefined) return recorded
    const { provider, model, reasoningEffort } = this.options
    if (provider === undefined) return undefined
    if (model === undefined) return undefined
    return { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort: String(reasoningEffort) } }
  }

  /** The host's session-projection registry, when this deployment composes one. */
  private projections(): SessionProjectionsService | undefined {
    return this.loopCtx.get('sessionProjections') as SessionProjectionsService | undefined
  }
}

/**
 * Present the plugin's local selection shape as the harness's brand-carrying
 * one.
 *
 * The two differ only in the reasoning-effort brand: this plugin reads and writes
 * plain strings, which is what the branded type erases to at runtime. The cast
 * stays in this module so no driver carries it.
 * @param selection - the plugin's selection shape.
 * @returns the same value under the harness's type.
 */
function asModelSelection(selection: SessionModelSelection): Readonly<ModelSelection> {
  return selection as unknown as Readonly<ModelSelection>
}

/**
 * Whether two selections name the same route and effort.
 * @param left - the recorded selection.
 * @param right - the selection being written.
 * @returns whether appending would be a no-op.
 */
function sameSelection(left: SessionModelSelection, right: Readonly<ModelSelection>): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}
