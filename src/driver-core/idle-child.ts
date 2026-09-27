/**
 * Idle shutdown for a driver's persistent child process.
 *
 * Two engines keep one child alive per session so a step never pays a spawn:
 * Kimi's `kimi acp` and Codex's app-server. Nothing in the harness releases an
 * agent when a turn ends — an agent lives as long as its session's scope — so
 * that child outlives the work that needed it and an idle session keeps
 * costing what its child costs (tens to hundreds of MB for a Node CLI). The
 * closer arms a countdown whenever its owner goes idle and runs the owner's
 * close when the countdown expires, so the next step's own lazy accessor
 * spawns a fresh child.
 *
 * The closer is inert unless `idleMs` is positive: a deployment that does not
 * configure idle shutdown keeps every child for the process's lifetime, which
 * is the behaviour that predates this reasoner.
 *
 * This is deliberately NOT an agent release: disposing the agent emits
 * `session/disposed`, which the browser half reads as "this session is gone"
 * with no way back in that page's lifetime (`router-loop.ts` `move`). Closing
 * the child leaves the agent, the session, and the page exactly where they are.
 *
 * @module dsh-loop-engine/driver-core/idle-child
 */

/** An armed-on-idle countdown that closes one child process. */
export interface IdleChildCloser {
  /**
   * (Re)start the countdown. Called when the owner settles into an idle phase;
   * a no-op while idle shutdown is disabled.
   */
  arm(): void
  /**
   * Cancel a pending countdown, for the moment the child is needed again.
   * Cancelling a countdown that never armed is a no-op.
   */
  cancel(): void
  /**
   * Cancel the countdown and drop the timer. Called from the owner's teardown,
   * so a disposed agent never closes a child through a stale callback.
   */
  dispose(): void
}

/** Input of {@link createIdleChildCloser}. */
export interface IdleChildCloserOptions {
  /** Idle window in milliseconds; zero or less leaves the child alone forever. */
  readonly idleMs: number
  /** Close the child; the owner's next accessor call spawns a fresh one. */
  readonly close: () => void
  /** Report a failing close without letting it escape the countdown. */
  readonly warn: (message: string) => void
}

/**
 * Build one owner's idle countdown.
 * @param options - the idle window, the close to run, and a diagnostic sink.
 * @returns the closer, inert while the idle window is not positive.
 */
export function createIdleChildCloser(options: IdleChildCloserOptions): IdleChildCloser {
  const { idleMs, close, warn } = options
  let timer: NodeJS.Timeout | undefined
  const cancel = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  return {
    arm: () => {
      if (!(idleMs > 0)) return
      cancel()
      timer = setTimeout(() => {
        timer = undefined
        try {
          close()
        } catch (error: unknown) {
          warn(`loop-engine: idle shutdown failed to close a child process: ${String(error)}`)
        }
      }, idleMs)
      // The countdown must never be the reason the process stays alive. Node's
      // timer always carries `unref`; the guard covers a fake-timer handle.
      /* v8 ignore next -- Node timers always carry unref */
      timer.unref?.()
    },
    cancel,
    dispose: cancel,
  }
}
