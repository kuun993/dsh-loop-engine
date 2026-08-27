/**
 * Codex loop engine module: hosts the AgentFactory that drives every session
 * through the OpenAI Codex SDK, one stateless thread per dsh step, with the
 * durable session log as the sole source of model context. dsh-loop-engine
 * constructs this factory when the Codex engine is selected; this module is a
 * library, not a Cordis plugin entry. The Codex SDK spawns its own CLI binary
 * (no spawn injection seam), so this loop deliberately does not inject the dsh
 * subprocess service.
 *
 * @module @kuun993/dsh-loop-engine/engine-codex
 */

import { FiberState, Service } from '@deepseek-ai/cordis'
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
import { SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { CodexAgent } from './agent.ts'
import { DEFAULT_DISPOSE_GRACE_MS } from './sdk.ts'
import type { CodexApprovalPolicy, CodexSandboxMode, ResolvedConfig } from './types.ts'

/** Fiber states that cannot own or serve a new lifecycle. */
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

/** Codex CLI sandbox modes a deployment may pin. */
export const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

/** Codex CLI approval policies a deployment may pin. */
export const CODEX_APPROVAL_POLICIES: readonly CodexApprovalPolicy[] = [
  'never',
  'on-request',
  'on-failure',
  'untrusted',
]

/** Deployment-owned configuration for the Codex loop plugin. */
export interface Config {
  /**
   * Pinned sandbox mode for every thread. When omitted, each query follows the
   * session's dsh permission knobs (`sandbox/mode` and `approval/policy`):
   * full access maps to `danger-full-access`, an `ask` policy maps to
   * `workspace-write`, and anything else fails closed with `read-only`.
   */
  sandboxMode?: CodexSandboxMode
  /**
   * Pinned approval policy for every thread. When omitted, each query follows
   * the session's dsh permission knobs: an `ask` policy maps to `on-request`
   * (the CLI's own interactive prompt degrades to a denial in the unattended
   * dsh runtime) and anything else maps to `never`.
   */
  approvalPolicy?: CodexApprovalPolicy
  /** Explicit environment entries layered over the credential-scrubbed parent environment. */
  env?: Record<string, string>
  /** Model override for the SDK; Codex native settings own the model when omitted. */
  model?: string
  /** API key injected as CODEX_API_KEY into the CLI environment. */
  apiKey?: string
  /** Base URL override for the Codex API endpoint. */
  baseUrl?: string
  /** Whether the sandboxed agent may reach the network. */
  networkAccessEnabled?: boolean
  /**
   * Grace in milliseconds kept for config symmetry with the Claude Code
   * driver. The Codex SDK spawns and owns its CLI process, so the value is
   * validated at the config boundary but not currently forwarded.
   */
  disposeGraceMs?: number
  /**
   * Cap on conversation turns kept for config symmetry with the Claude Code
   * driver. The Codex SDK exposes no per-thread turn cap, so the value is
   * validated at the config boundary but not currently forwarded.
   */
  maxTurns?: number
}

/** Schema of the Codex loop plugin configuration. */
export const Config: z<Config> = z.object({
  sandboxMode: z.union([...CODEX_SANDBOX_MODES]),
  approvalPolicy: z.union([...CODEX_APPROVAL_POLICIES]),
  env: z.dict(z.string()).default({}),
  model: z.string(),
  apiKey: z.string(),
  baseUrl: z.string(),
  networkAccessEnabled: z.boolean(),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  maxTurns: z.number().step(1).min(1),
})

/* jscpd:ignore-start -- the ownership/transaction machinery mirrors the
 * Claude Code loop factory; each product's lifecycle stays package-private. */
/** Factory-level ownership: live agent teardowns plus load-time tracking. */
class FactoryOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly inactive = Promise.withResolvers<void>()
  private readonly liveAgents = new Set<() => Promise<void>>()
  private startupTasks = new Set<Promise<void>>()

  constructor(private readonly fiber: Context['fiber']) {}

  /** Aborts (reason: `agent loop is not active` error) when factory teardown begins. */
  get signal(): AbortSignal {
    return this.teardown.signal
  }

  isActive(): boolean {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
  }

  /** Track one live agent's shared teardown until it has run. */
  track(dispose: () => Promise<void>): () => void {
    this.liveAgents.add(dispose)
    return () => { this.liveAgents.delete(dispose) }
  }

  /** Join config startup work that begins before an agent exists. */
  trackStartup(job: Promise<void>): void {
    this.startupTasks.add(job)
    const forget = () => { this.startupTasks.delete(job) }
    void job.then(forget, forget)
  }

  /** Join one public create/resume continuation; factory dispose awaits its settlement. */
  trackWrapper(job: Promise<unknown>): void {
    this.trackStartup(job.then(() => undefined, () => undefined))
  }

  async dispose(): Promise<void> {
    this.accepting = false
    this.teardown.abort(new Error('agent loop is not active'))
    this.inactive.resolve()
    await Promise.all([
      ...[...this.liveAgents].map(dispose => dispose()),
      ...this.startupTasks,
    ])
  }
}

/** Await `operation`, or throw the signal's reason as soon as it aborts. */
async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  const toAbortError = (): Error => {
    /* v8 ignore start -- every fused abort source carries an Error reason; onCallerAbort and onFactoryTeardown wrap foreign values */
    /* v8 ignore next -- every fused abort source carries an Error reason; onCallerAbort and onFactoryTeardown wrap foreign values */
    return signal.reason instanceof Error ? signal.reason : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  }
  /* v8 ignore next -- both call sites guard pre-aborted signals, so a pre-aborted entry is unreachable */
  if (signal.aborted) throw toAbortError()    /* v8 ignore stop */
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => { aborted.reject(toAbortError()) }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}
/** Start an abortable operation and release a value that arrives after cancellation. */
async function raceAbortCall<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
  releaseAbandoned?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  }
  const pending = Promise.resolve().then(operation)
  try {
    return await raceAbort(pending, signal, id)
  } catch (error: unknown) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while the operation is awaited.
    if (signal.aborted && releaseAbandoned !== undefined) {
      void pending.then(releaseAbandoned, () => undefined)
    }
    throw error
  }
}
/* jscpd:ignore-end */

/** Prepared-but-unpublished agent resources sharing one memoized teardown. */
interface PreparedAgent {
  agent: CodexAgent
  /** Aborts when the factory unloads, the caller cancels, or teardown begins — ends any setup await. */
  signal: AbortSignal
  /** Enter registries, announce, notify session-start, and start the machine. */
  publish(source: SessionStartSource): AgentHandle
  /** Reverse teardown: stop the machine, unregister, unwind the scope. Memoized. */
  dispose(): Promise<void>
}

/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config: Config): ResolvedConfig {
  const disposeGraceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0) {
    throw new Error('agent-loop-codex: disposeGraceMs must be a positive finite number')
  }
  if (disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `agent-loop-codex: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    sandboxMode: config.sandboxMode,
    approvalPolicy: config.approvalPolicy,
    env: config.env ?? {},
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    networkAccessEnabled: config.networkAccessEnabled,
    disposeGraceMs,
    maxTurns: config.maxTurns,
  }
}

/** Host-face ctx key for the Codex loop service. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopCodex: CodexLoop
  }
}

/**
 * Concrete AgentFactory and driver service of the Codex loop. Creation and
 * resume follow the registry factory contract and the shared publication
 * transaction: prepare, run setup, then publish through both registries,
 * announce, and emit `agent/session-start`.
 */
export class CodexLoop extends Service implements AgentFactory {
  /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
  static inject = ['agents', 'sessions', 'systemPrompt']

  /** Validated configuration owned by the loop plugin. */
  readonly config: ResolvedConfig
  private readonly ownership: FactoryOwnership
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context }

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, 'agentLoopCodex')
    this.config = resolveConfig(config)
    this.ownership = new FactoryOwnership(ctx.fiber)
    this.runtime = { ctx }
    ctx.effect(() => () => this.ownership.dispose(), 'agentLoopCodex.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoopCodex.setFactory()')
    // Codex owns its prompt, so these variables feed only downstream consumers
    // of the (unused) dsh system prompt assembly, mirroring the default loop's
    // registrations.
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
  /* jscpd:ignore-start -- ownership/transaction machinery mirrors the Claude Code loop factory. */
  private prepare(ownerCtx: Context, id: SessionId, options: AgentOptions, session: Session, callerSignal?: AbortSignal): PreparedAgent {
    ownerCtx.fiber.assertActive()
    /* v8 ignore start -- unreachable backstop, see above */
    /* v8 ignore next -- unreachable backstop, see above */
    if (!this.ownership.isActive()) throw new Error('agent loop is not active')    /* v8 ignore stop */
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason })
    }
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

    let machine: CodexAgent | undefined
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
        try {
          detachAgent?.()
          detachSession?.()
        } finally {
          untrack()
          if (!ownerTriggered) await unfollowOwner()
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
      }, `agentLoopCodex.lifecycle(${id})`)
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
      const agent = machine = new CodexAgent(loopCtx, id, options, session, this.config)
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
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    const session = ownedPreparation.session
    const prepared = this.prepare(ownerCtx, id, agentOptions, session, signal)
    try {
      const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id)
      setupCommit?.commit()
      return prepared.publish(source)
    } catch (error: unknown) {
      await prepared.dispose()
      throw error
    }
  }

  /**
   * Create an agent and session under one caller-supplied identity, owned by
   * the accessing fiber.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
    }))
    const published = this.setupAndPublish(
      ownerCtx,
      options.sessionId,
      preparation,
      options.agentOptions ?? {},
      options.setup,
      options.signal,
      'startup',
    )
    this.ownership.trackWrapper(published)
    return published
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

  /** Resume through an explicit persistence handle. */
  private async resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const id = options.resumeSessionId
    let preparation: SessionPreparation | undefined
    try {
      const ownerAbort = new AbortController()
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      }, `agentLoopCodex.resume-load(${id})`)
      const fused = AbortSignal.any([
        ...options.signal === undefined ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal,
      ])
      try {
        preparation = await raceAbortCall(
          () => persistence.prepare(id, fused),
          fused,
          id,
          (abandoned) => { abandoned[Symbol.dispose]() },
        )
      } finally {
        await unfollowOwner()
      }
      ownerCtx.fiber.assertActive()
      if (!this.ownership.isActive()) throw new Error('agent loop is not active')
      return await this.setupAndPublish(
        ownerCtx,
        id,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        'resume',
      )
    } finally {
      preparation?.[Symbol.dispose]()
    }
  }
}
/* jscpd:ignore-end */
