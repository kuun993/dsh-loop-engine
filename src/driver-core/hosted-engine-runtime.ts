/**
 * Shared AgentFactory transaction machinery for the hosted loop engines.
 *
 * All four engines (Claude Code, Codex, Pi, Kimi Code) implement the harness's
 * AgentFactory contract the same way: prepare a driver, scope, and one memoized
 * reverse teardown for a session; run the caller's setup under a fused abort
 * signal; publish through both registries and announce; and on resume, own a
 * session's write handle across the cold read, crash repair, and
 * re-publication. None of that touches an engine protocol — the whole
 * engine-specific surface is one call, {@link HostedEngineRuntime.buildAgent}.
 *
 * One move has no counterpart in the harness's own factory contract and is what
 * makes an in-place engine swap possible: a LIVE session changes drivers without
 * being released. {@link HostedAgentHandle.retire} stops the outgoing machine
 * while leaving the session entered, and {@link HostedEngineRuntime.swap} builds
 * the incoming engine's machine onto that same Session. The session's store
 * entry and write handle travel across the handover in a
 * {@link SessionLifetime} — the one object that owns them.
 *
 * This body mirrors the default in-process `agent-loop` factory. It is a plain
 * class, not a Cordis plugin: the process-wide AgentFactory slot is owned by
 * the router (`router-loop.ts`, which subclasses the harness `AgentLoop`), and
 * every hosted engine is one runtime instance the router delegates to. That is
 * what lets several engines serve different sessions concurrently — the
 * harness admits exactly one factory, so the factory itself must dispatch.
 *
 * Subclasses supply:
 *   - the effect label prefix (`<label>.transactions()`,
 *     `<label>.lifecycle(id)`, `<label>.resume-load(id)`) — the lifecycle label
 *     is asserted by tests, so it must stay `<label>.lifecycle(...)`;
 *   - their own configuration resolution;
 *   - {@link HostedEngineRuntime.buildAgent}.
 *
 * @module dsh-loop-engine/driver-core/hosted-engine-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { interruptedTurnClosers, SessionId, SessionLogOffset, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { FactoryOwnership, raceAbort, raceAbortCall } from './ownership.ts'
import { SessionLifetime } from './session-lifetime.ts'

/**
 * What the transaction machinery needs of a driver beyond the harness `Agent`
 * contract: a teardown entry point that also unwinds the driver's own scope.
 * The concrete engines declare these; the base only spells them out so the
 * shared body can call them generically.
 */
export interface HostedAgent extends Agent {
  /** Stop the machine with the given cause, without waiting for it to settle. */
  cancel(cause: Parameters<Agent['cancel']>[0]): void
  /** Resolves when the machine has no work in flight. */
  whenIdle(): Promise<void>
  /** The driver's own resource scope, unwound after the machine settles. */
  readonly scope: Scope
}

/**
 * The plugin's own handle for one published hosted agent: the harness contract
 * plus the two facts an in-place engine swap needs.
 *
 * A swap is two moves by two different runtimes: the outgoing engine retires its
 * machine and hands the session over, and the incoming engine builds onto that
 * session. The router is the only caller and it tracks the handle already, so
 * the harness's own `AgentHandle` — which carries neither fact — is widened
 * here rather than reaching back into a transaction that has ended.
 */
export interface HostedAgentHandle extends AgentHandle {
  /** The live session's lifetime resources, owned by this agent until it is disposed. */
  readonly lifetime: SessionLifetime
  /**
   * Retire this machine for good while LEAVING the session alive: stop it,
   * unwind its scope, and leave the agent registry — the session's entry and
   * write handle pass to {@link SessionLifetime}'s next owner instead of being
   * released here. Only valid while this agent still owns the session: the
   * router calls it for the session's live, idle agent only.
   */
  retire(): Promise<void>
}

/** Options for {@link HostedEngineRuntime.swap}. */
export interface SwapAgentOptions {
  /** The live session's lifetime resources, handed over by the outgoing engine. */
  readonly lifetime: SessionLifetime
  /** Loop options for the successor; the router replays the outgoing agent's own. */
  readonly agentOptions?: AgentOptions | undefined
  /** The composition callback the session was built with, replayed onto the successor. */
  readonly setup?: AgentSetup | undefined
  /** The outgoing agent's runtime owner, for a child session's inherited ownership. */
  readonly parentAgent?: Agent | undefined
}

/** Prepared-but-unpublished agent resources sharing one memoized teardown. */
interface PreparedAgent<TAgent extends HostedAgent> {
  agent: TAgent
  /** Aborts when the factory unloads, the caller cancels, or teardown begins — ends any setup await. */
  signal: AbortSignal
  /** Enter registries, announce, notify session-start, and start the machine. */
  publish(source: SessionStartSource): HostedAgentHandle
  /** Reverse teardown: stop the machine, release the session, unwind the scope. Memoized. */
  dispose(): Promise<void>
}

/** One session's owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

/**
 * Concrete creation/resume machinery for one hosted engine.
 *
 * Creation and resume follow the registry factory contract and the shared
 * publication transaction: prepare, run setup, then publish through both
 * registries, announce, and emit `agent/session-start`. {@link swap} follows the
 * same transaction onto a session another agent entered, which is the only
 * difference between taking a session over and owning it from birth.
 */
export abstract class HostedEngineRuntime<TConfig, TAgent extends HostedAgent> implements AgentFactory {
  /** Validated configuration owned by this engine instance. */
  readonly config: TConfig
  /** Effect-label prefix; also identifies the engine in diagnostics. */
  readonly label: string
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  protected readonly runtime: { ctx: Context }
  private readonly ownership: FactoryOwnership

  /**
   * @param ctx - the owning context; its fiber's unload tears every live agent down.
   * @param label - effect-label prefix, e.g. `agentLoopKimi`.
   * @param config - already-resolved engine configuration.
   */
  constructor(ctx: Context, label: string, config: TConfig) {
    this.label = label
    this.config = config
    this.ownership = new FactoryOwnership(ctx.fiber)
    this.runtime = { ctx }
    // Expose the engine under its conventional ctx key. This is not an
    // AgentFactory registration (the router owns the single slot) — it is the
    // introspection surface the per-engine specs and `--dump-config` readers
    // use to see which drivers a process actually built.
    ctx.reflect.provide(label, this)
    // Registration precedes a subclass's own field initializers (they run after
    // `super` returns). That is safe: this constructor and those initializers
    // complete in one synchronous run, and nothing inside the ownership
    // registration can reach `buildAgent` — which subclasses are free to
    // implement against fields they assign afterwards.
    ctx.effect(() => () => this.ownership.dispose(), `${label}.transactions()`)
  }

  /**
   * Construct this engine's driver for one prepared session. Called once per
   * create, resume, or swap, after the session exists and before setup runs; the
   * hook is the engine's entire protocol surface.
   */
  protected abstract buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): TAgent

  /**
   * Construct the driver, scope, and one memoized reverse teardown for a new
   * agent. The teardown is registered with the factory and the owner fiber
   * BEFORE publication, so a mid-setup unload rolls everything back; `signal`
   * fuses caller cancellation with lifecycle teardown for setup awaits.
   *
   * `lifetime` carries the session's store entry and write handle rather than
   * this body owning them: a fresh transaction binds them when it publishes,
   * while a swap publishes a session whose entry another machine already bound
   * and whose write handle another machine already opened.
   */
  /* jscpd:ignore-start -- ownership/transaction machinery mirrors the default agent-loop factory: the harness exports the loop as a plugin, not as reusable transaction helpers, so the body is replicated rather than delegated to. */
  private prepare(ownerCtx: Context, id: SessionId, options: AgentOptions, session: Session, callerSignal: AbortSignal | undefined, lifetime: SessionLifetime, parentAgent?: Agent): PreparedAgent<TAgent> {
    ownerCtx.fiber.assertActive()
    /* v8 ignore start -- unreachable backstop, see above */
    /* v8 ignore next -- unreachable backstop, see above */
    if (!this.ownership.isActive()) throw new Error('agent loop is not active')    /* v8 ignore stop */
    /* v8 ignore start -- both call sites gate the caller signal through raceAbortCall (create) or the fused load signal (resume) before prepare runs, so entering prepare with an aborted signal is unreachable */
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason })
    }
    /* v8 ignore stop */
    const loopCtx = this.runtime.ctx

    // Deactivation fuses three owners, each with its own reason: the caller's
    // cancellation signal, the owner fiber's unload, and factory teardown.
    const abort = new AbortController()
    const onCallerAbort = (): void => {
      abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }))
    }
    const onFactoryTeardown = (): void => { abort.abort(this.ownership.signal.reason) }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true })

    let machine: TAgent | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    /** Set by {@link PreparedAgent.retire}: the successor owns the session's lifetime from then on. */
    let handedOver = false
    const machineReady = Promise.withResolvers<void>()
    const dispose = (ownerTriggered = false): Promise<void> => (disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`))
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      try {
        /* v8 ignore start -- disposal runs only after the constructor publishes the machine, so it is never undefined here */
        /* v8 ignore next -- disposal runs only after the constructor publishes the machine, so it is never undefined here */
        if (machine === undefined) await machineReady.promise
        /* v8 ignore next -- the undefined-machine arm is reachable only through the unreachable catch below */
        if (machine !== undefined) {
          machine.cancel({ kind: 'disposed' })
          await machine.whenIdle()
          await machine.scope.dispose()
        }        /* v8 ignore stop */
      } finally {
        // The machine committed its closing events synchronously into the
        // session; closing the write handle drains them durably before the
        // store attachment (the live-event write path) is released. A RETIRED
        // machine holds neither: both moved to the session's successor, which
        // releases them in this machine's place.
        try {
          if (!handedOver) await lifetime.closeHandle()
        } finally {
          try {
            detachAgent?.()
          } finally {
            try {
              if (!handedOver) lifetime.leaveStore()
            } finally {
              untrack()
              if (!ownerTriggered) await unfollowOwner()
            }
          }
        }
      }
    })())
    const untrack = this.ownership.track(dispose)
    let unfollowOwner: () => Promise<void> | void
    try {
      unfollowOwner = ownerCtx.effect(() => () => {
        if (disposing !== undefined) return
        abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
        return dispose(true)
      }, `${this.label}.lifecycle(${id})`)
      /* v8 ignore start -- ctx.effect throws only on an inactive fiber, which assertActive() above already rejected */
    } catch (error: unknown) {
      untrack()
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      throw error
    }
    /* v8 ignore stop */

    const assertLive = (): void => {
      if (!abort.signal.aborted) return
      /* v8 ignore start -- unreachable String() arm, see above */
      /* v8 ignore next -- see above */
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))      /* v8 ignore stop */
    }
    const retire = async (): Promise<void> => {
      // Hand the session over BEFORE the teardown runs: releasing it is the
      // teardown's own last step, and the successor owns it from here.
      handedOver = true
      await dispose()
    }
    try {
      const agent = machine = this.buildAgent(loopCtx, id, options, session)
      machineReady.resolve()
      assertLive()

      return {
        agent,
        signal: abort.signal,
        publish: (source) => {
          assertLive()
          // A swap JOINS a session another machine already entered and
          // announced, so it owes only the agent half of the publication:
          // `sessions.enter` refuses a live id and `sessions.announce` refuses a
          // second announcement, and the entry travels in the lifetime instead.
          const joining = lifetime.entered
          if (!joining) lifetime.bind(agent.ctx.sessions.enter(session))
          detachAgent = loopCtx.agents.enter(agent, parentAgent)
          if (!joining) agent.ctx.sessions.announce(session)
          assertLive()
          loopCtx.agents.announce(agent)
          assertLive()
          emitAgentEvent(loopCtx, agent, 'agent/session-start', { source })
          assertLive()
          return { agent, dispose, retire, lifetime }
        },
        dispose,
      }
    /* v8 ignore start -- assertLive() runs synchronously where the fused signal cannot abort mid-window, so this catch never fires */
    } catch (error: unknown) {
      machineReady.resolve()
      void dispose()
      throw error
    }
    /* v8 ignore stop */
  }

  /** Prepare one Agent around an acquired Session, run setup, and publish it. */
  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    session: Session,
    agentOptions: AgentOptions,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: SessionStartSource,
    lifetime: SessionLifetime,
    parentAgent?: Agent,
    stored?: StoredSession,
  ): Promise<HostedAgentHandle> {
    let prepared: PreparedAgent<TAgent>
    try {
      prepared = this.prepare(ownerCtx, id, agentOptions, session, signal, lifetime, parentAgent)
    } catch (error: unknown) {
      // A rejected prepare never took the handle: close it so write ownership
      // is released instead of leaking with the process.
      await stored?.handle.close().catch(() => {})
      throw error
    }
    try {
      const setupCommit = await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id)
      setupCommit?.commit()
      await this.appendUnstoredSuffix(stored, session)
      return prepared.publish(source)
    } catch (error: unknown) {
      // Rollback swallows a disposal rejection (a failing final handle close):
      // the setup failure is the primary error the caller must see.
      await prepared.dispose().catch(() => {})
      throw error
    }
  }

  /**
   * Create an agent and session under one caller-supplied identity, owned by
   * the accessing fiber. When a persistence backend is mounted, the session's
   * durable identity is stored before publication.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, optional live parent, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<HostedAgentHandle> {
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    const published = (async () => {
      let stored: StoredSession | undefined
      try {
        // raceAbortCall normalizes a pre-aborted or mid-create abort and
        // closes a handle that finishes creating after abandonment.
        stored = options.signal === undefined
          ? await this.createStoredSession(preparation.session)
          : await raceAbortCall(
            () => this.createStoredSession(preparation.session, options.signal),
            options.signal,
            options.sessionId,
            (abandoned) => { void abandoned?.handle.close().catch(() => {}) },
          )
        return await this.setupAndPublish(
          ownerCtx,
          options.sessionId,
          preparation.session,
          options.agentOptions ?? {},
          options.setup,
          options.signal,
          'startup',
          new SessionLifetime(preparation.session, stored?.handle),
          options.parentAgent,
          stored,
        )
      } finally {
        // The preparation's provider state is needed until the session is
        // entered, and released on every outcome after that — including the
        // create-stored-session failure above, which never reaches publication.
        preparation[Symbol.dispose]()
      }
    })()
    this.ownership.trackWrapper(published)
    return published
  }

  /**
   * Take a fresh session's write ownership when persistence is mounted.
   * Nothing is appended here: the constructor seed (which never re-emits
   * through `session/event`) is stored by {@link appendUnstoredSuffix} at the
   * publication commit point, so a failed or cancelled setup closes an
   * unmaterialized handle and leaves no stored residue — the same id can be
   * created again.
   * @param session - the unpublished session to store.
   * @param signal - optional cancellation forwarded to the backend create.
   * @returns the owned handle and stored cursor, or `undefined` without a backend.
   */
  private async createStoredSession(session: Session, signal?: AbortSignal): Promise<StoredSession | undefined> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    return { handle, storedCount: 0 }
  }

  /**
   * Durably store the session events appended since the last stored cursor.
   * Pre-publication appends (constructor seed markers, setup-window events)
   * never re-emit through `session/event`, so publication must flush them
   * through the handle before live events start routing into it.
   * @param stored - the session's owned handle and stored cursor, if any.
   * @param session - the unpublished session whose suffix is stored.
   */
  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session): Promise<void> {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    // Advance by what was stored, not to `session.seq`: an event appended
    // during the await must stay unstored for the next flush.
    stored.storedCount += suffix.length
  }

  /**
   * Resume an owned agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, optional live parent, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<HostedAgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    return this.resumeWith(ownerCtx, persistence, options)
  }

  /**
   * Build this engine's agent onto a LIVE session another engine's agent left,
   * taking the session's lifetime over.
   *
   * The counterpart of {@link HostedAgentHandle.retire}: together they are an
   * in-place engine swap, and the harness's own factory contract has neither.
   * Nothing is read from persistence and nothing is created in the store — the
   * successor drives the Session object that is already live and already
   * entered, so a browser half attached to that session sees no lifecycle edge
   * at all. The lifetime carries the still-open write handle, so the session
   * keeps being stored through the same channel it was already using.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - the live session's lifetime, loop options, setup, and parent.
   * @returns the published handle, which owns the session from here on.
   */
  async swap(ownerCtx: Context, options: SwapAgentOptions): Promise<HostedAgentHandle> {
    const session = options.lifetime.session
    const published = (async () => await this.setupAndPublish(
      ownerCtx,
      session.id,
      session,
      options.agentOptions ?? {},
      options.setup,
      undefined,
      'resume',
      options.lifetime,
      options.parentAgent,
    ))()
    this.ownership.trackWrapper(published)
    return published
  }

  /** Resume through an explicit persistence service. */
  private resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<HostedAgentHandle> {
    const id = options.resumeSessionId
    const published = (async () => {
      // The open and read may outlive their owner: race them against caller
      // cancellation, owner-fiber unload, and factory teardown so a
      // never-settling backend cannot pin the identity.
      const ownerAbort = new AbortController()
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      }, `${this.label}.resume-load(${id})`)
      const fused = AbortSignal.any([
        ...options.signal === undefined ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal,
      ])
      let handle: SessionHandle | undefined
      let stored: StoredSession | undefined
      let preparation: SessionPreparation | undefined
      try {
        try {
          handle = await raceAbortCall(
            () => persistence.open(id, 'write', { signal: fused }),
            fused,
            id,
            (abandoned) => { void abandoned.close() },
          )
          // Semantic crash repair is the agent layer's job: persistence hands
          // back the physically valid log; an interrupted final turn receives
          // synthetic closers (missing tool errors, step/end, turn/end) that
          // are appended through the same handle as an ordinary batch.
          const coldRead = await handle.read(0, undefined, { signal: fused })
          fused.throwIfAborted()
          const persisted = coldRead.events
          const closers = interruptedTurnClosers(persisted)
          if (closers.length > 0) await handle.append(closers)
          preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
            seed: [...persisted, ...closers],
            meta: structuredClone(handle.header),
            inheritedEventCount: handle.inheritedEventCount,
            eventState: coldRead.eventState,
          }))
          stored = { handle, storedCount: persisted.length + closers.length }
          await this.appendUnstoredSuffix(stored, preparation.session)
        } finally {
          await unfollowOwner()
        }
        ownerCtx.fiber.assertActive()
        if (!this.ownership.isActive()) throw new Error('agent loop is not active')
        const owned = stored
        handle = undefined // ownership passes to setupAndPublish/prepare
        return await this.setupAndPublish(
          ownerCtx,
          id,
          preparation.session,
          options.agentOptions ?? {},
          options.setup,
          options.signal,
          'resume',
          new SessionLifetime(preparation.session, owned?.handle),
          options.parentAgent,
          owned,
        )
      } finally {
        preparation?.[Symbol.dispose]()
        await handle?.close().catch(() => {})
      }
    })()
    this.ownership.trackWrapper(published)
    return published
  }
}
/* jscpd:ignore-end */
