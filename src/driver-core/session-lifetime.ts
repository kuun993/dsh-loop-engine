/**
 * The session-scoped half of one published hosted transaction: the session's
 * entry in the store, and the write handle that stores its events.
 *
 * Ownership is ONE object rather than two closure variables because an engine
 * swap MOVES it. A hot swap replaces a session's agent while the session itself
 * stays live: the retiring machine hands its lifetime to the successor instead
 * of releasing it, and the successor releases it later exactly as the agent that
 * entered the session would have. Releasing it at the handover point would emit
 * `session/disposed`, which the browser half reads as the session being gone —
 * its session list drops the row, its composer renders "session unavailable",
 * and the conversation view falls back to the workspace picker — so a live
 * session would be torn out from under the page attached to it.
 *
 * The two release steps are separate operations because their ORDER around the
 * agent registry's own release is load-bearing: `agent/disposed` is published
 * after driver quiescence and BEFORE the session is detached (the event's
 * contract in `@deepseek-ai/dsh-agent`), and the write handle closes before the
 * store attachment is released so its buffered closing events are drained
 * durably. Users of this type therefore close the handle, detach the agent, then
 * leave the store.
 *
 * Neither step needs a memo of its own: `SessionHandle.close()` is idempotent by
 * contract, and the detacher `SessionsService.enter` returns is single-shot.
 *
 * @module dsh-loop-engine/driver-core/session-lifetime
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'

/**
 * One live session's lifetime resources, owned by whichever agent drives it.
 */
export class SessionLifetime {
  /** The live session these resources belong to. */
  readonly session: Session
  /** The write handle this lifetime owns, or `undefined` when no persistence backend is mounted. */
  private readonly handle: SessionHandle | undefined
  /** The store's detacher; `undefined` until the entry is bound by the transaction that entered the session. */
  private detach: (() => void) | undefined

  /**
   * @param session - the live session whose entry and write handle these are.
   * @param handle - the write handle the transaction acquired, if a backend is mounted.
   */
  constructor(session: Session, handle: SessionHandle | undefined) {
    this.session = session
    this.handle = handle
  }

  /**
   * Whether the session's store entry is already held: true for a lifetime a
   * retiring machine handed over, false for one whose transaction still has to
   * enter the session it prepared.
   */
  get entered(): boolean {
    return this.detach !== undefined
  }

  /**
   * Bind the store entry this lifetime owns. Called once, by the transaction
   * that enters the session; a joined session's entry is already bound.
   * @param detach - the detacher the session's own `enter` returned.
   */
  bind(detach: () => void): void {
    this.detach = detach
  }

  /** Drain and close the write handle — the durability barrier that precedes leaving the store. */
  async closeHandle(): Promise<void> {
    await this.handle?.close()
  }

  /** Remove the session from the store, publishing its paired disposal exactly once. */
  leaveStore(): void {
    this.detach?.()
  }
}
