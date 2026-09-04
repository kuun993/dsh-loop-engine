/**
 * Claude Code loop engine module: hosts the AgentFactory that drives every
 * session through the official Claude Agent SDK, one stateless query per dsh
 * step, with the durable session log as the sole source of model context.
 * dsh-loop-engine constructs this factory when the Claude Code engine is
 * selected; this module is a library, not a Cordis plugin entry.
 *
 * @module dsh-loop-engine/engine-claude
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type {
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { interruptedTurnClosers, SessionId, SessionLogOffset, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ClaudeCodeAgent } from './agent.ts'
import { DEFAULT_DISPOSE_GRACE_MS } from './sdk.ts'
import type { ClaudeCodePermissionMode, ResolvedConfig } from './types.ts'
import { FactoryOwnership, raceAbort, raceAbortCall } from '../driver-core/ownership.ts'

/** Deployment-selectable non-interactive Claude Code permission modes. */
export const CLAUDE_CODE_PERMISSION_MODES: readonly ClaudeCodePermissionMode[] = [
  'dontAsk',
  'acceptEdits',
  'auto',
  'plan',
  'bypassPermissions',
]

/** Deployment-owned configuration for the Claude Code loop plugin. */
export interface Config {
  /**
   * Native non-interactive permission handling for every query. When omitted,
   * each query follows the session's dsh permission knobs (`sandbox/mode` and
   * `approval/policy`): full access bypasses native checks, an `ask` policy
   * forwards requests to the dsh approval seam, and anything else auto-denies.
   * A pinned mode overrides the session for every query: `dontAsk` auto-denies,
   * `acceptEdits` accepts edits, `auto` uses the native classifier, `plan`
   * returns a plan without approving execution, and `bypassPermissions`
   * explicitly skips permission checks.
   */
  permissionMode?: ClaudeCodePermissionMode
  /** Explicit environment entries layered over the credential-scrubbed parent environment. */
  env?: Record<string, string>
  /** Model label for the logged request header; Claude Code native settings own the actual model. */
  model?: string
  /** Grace in milliseconds for Claude Code process-tree termination. */
  disposeGraceMs?: number
  /** Cap on the number of conversation turns before each query stops. */
  maxTurns?: number
}

/** Schema of the Claude Code loop plugin configuration. */
export const Config: z<Config> = z.object({
  permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES]),
  env: z.dict(z.string()).default({}),
  model: z.string(),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  maxTurns: z.number().step(1).min(1),
})

/** Prepared-but-unpublished agent resources sharing one memoized teardown. */
interface PreparedAgent {
  agent: ClaudeCodeAgent
  /** Aborts when the factory unloads, the caller cancels, or teardown begins — ends any setup await. */
  signal: AbortSignal
  /** Enter registries, announce, notify session-start, and start the machine. */
  publish(source: SessionStartSource): AgentHandle
  /** Reverse teardown: stop the machine, unregister, unwind the scope. Memoized. */
  dispose(): Promise<void>
}

/** One session's owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config: Config): ResolvedConfig {
  const disposeGraceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0) {
    throw new Error('agent-loop-claude-code: disposeGraceMs must be a positive finite number')
  }
  if (disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `agent-loop-claude-code: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    permissionMode: config.permissionMode,
    env: config.env ?? {},
    model: config.model,
    disposeGraceMs,
    maxTurns: config.maxTurns,
  }
}

/** Host-face ctx key for the Claude Code loop service. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopClaudeCode: ClaudeCodeLoop
  }
}

/**
 * Concrete AgentFactory and driver service of the Claude Code loop. Creation
 * and resume follow the registry factory contract and the shared publication
 * transaction: prepare, run setup, then publish through both registries,
 * announce, and emit `agent/session-start`.
 */
export class ClaudeCodeLoop extends Service implements AgentFactory {
  /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
  static inject = ['agents', 'sessions', 'systemPrompt', 'subprocess']

  /** Validated configuration owned by the loop plugin. */
  readonly config: ResolvedConfig
  private readonly ownership: FactoryOwnership
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context }

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, 'agentLoopClaudeCode')
    this.config = resolveConfig(config)
    this.ownership = new FactoryOwnership(ctx.fiber)
    this.runtime = { ctx }
    ctx.effect(() => () => this.ownership.dispose(), 'agentLoopClaudeCode.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoopClaudeCode.setFactory()')
    // Claude Code owns its prompt, so these variables feed only downstream
    // consumers of the (unused) dsh system prompt assembly, mirroring the
    // default loop's registrations.
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
  }

  /**
   * Construct the driver, scope, and one memoized reverse teardown for a new
   * agent. The teardown is registered with the factory and the owner fiber
   * BEFORE publication, so a mid-setup unload rolls everything back; `signal`
   * fuses caller cancellation with lifecycle teardown for setup awaits.
   */
  /* jscpd:ignore-start -- ownership/transaction machinery mirrors the default agent-loop factory; depending on agent-loop is forbidden. */
  private prepare(ownerCtx: Context, id: SessionId, options: AgentOptions, session: Session, callerSignal?: AbortSignal, handle?: SessionHandle): PreparedAgent {
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

    let machine: ClaudeCodeAgent | undefined
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
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
        // store attachment (the live-event write path) is released.
        try {
          await handle?.close()
        } finally {
          try {
            detachAgent?.()
            detachSession?.()
          } finally {
            untrack()
            if (!ownerTriggered) await unfollowOwner()
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
      }, `agentLoopClaudeCode.lifecycle(${id})`)
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
      /* v8 ignore next -- unreachable String() arm, see above */
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))      /* v8 ignore stop */
    }
    try {
      const agent = machine = new ClaudeCodeAgent(loopCtx, id, options, session, this.config)
      machineReady.resolve()
      assertLive()

      return {
        agent,
        signal: abort.signal,
        publish: (source) => {
          assertLive()
          detachSession = agent.ctx.sessions.enter(session)
          detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent)
          agent.ctx.sessions.announce(session)
          assertLive()
          loopCtx.agents.announce(agent)
          assertLive()
          emitAgentEvent(loopCtx, agent, 'agent/session-start', { source })
          assertLive()
          return { agent, dispose }
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
    preparation: SessionPreparation,
    agentOptions: AgentOptions,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: SessionStartSource,
    stored?: StoredSession,
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    const session = ownedPreparation.session
    let prepared: PreparedAgent
    try {
      prepared = this.prepare(ownerCtx, id, agentOptions, session, signal, stored?.handle)
    } catch (error: unknown) {
      // A rejected prepare never took the handle: close it so write ownership
      // is released instead of leaking with the process.
      await stored?.handle.close().catch(() => {})
      throw error
    }
    try {
      const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id)
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
   * @param options - identities, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
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
      } catch (error: unknown) {
        preparation[Symbol.dispose]()
        throw error
      }
      return this.setupAndPublish(
        ownerCtx,
        options.sessionId,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        'startup',
        stored,
      )
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
   * @param options - persisted identity, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    return this.resumeWith(ownerCtx, persistence, options)
  }

  /** Resume through an explicit persistence service. */
  private resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const id = options.resumeSessionId
    const published = (async () => {
      // The open and read may outlive their owner: race them against caller
      // cancellation, owner-fiber unload, and factory teardown so a
      // never-settling backend cannot pin the identity.
      const ownerAbort = new AbortController()
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      }, `agentLoopClaudeCode.resume-load(${id})`)
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
          // Taking write ownership FIRST excludes a concurrent resume of the
          // same id (in this process, a live agent's handle holds the claim).
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
          const persisted = await handle.read(0, undefined, { signal: fused })
          fused.throwIfAborted()
          const closers = interruptedTurnClosers(persisted)
          if (closers.length > 0) await handle.append(closers)
          preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
            seed: [...persisted, ...closers],
            meta: structuredClone(handle.header),
            inheritedEventCount: handle.inheritedEventCount,
            seedSource: 'persistence',
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
          preparation,
          options.agentOptions ?? {},
          options.setup,
          options.signal,
          'resume',
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

