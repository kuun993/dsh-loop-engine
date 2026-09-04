/**
 * Pi loop engine module: hosts the AgentFactory that drives every session
 * through the Pi CLI (`@earendil-works/pi-coding-agent`) over its JSONL RPC
 * mode, one stateless session per dsh step, with the durable session log as the
 * sole source of model context. dsh-loop-engine constructs this factory when
 * the Pi engine is selected; this module is a library, not a Cordis plugin
 * entry. Pi has no permission system, so the entire `pi --mode rpc` child is
 * spawned through the dsh subprocess seam — the only available privilege
 * boundary — and its `--tools` are pruned to the resolved sandbox stance.
 *
 * @module dsh-loop-engine/engine-pi
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { interruptedTurnClosers, SessionId, SessionLogOffset, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { PiAgent } from './agent.ts'
import type { PiProcess, PiSpawnSpec } from './rpc/client.ts'
import type { PiSandboxMode, ResolvedConfig } from './types.ts'
import { FactoryOwnership, raceAbort, raceAbortCall } from '../driver-core/ownership.ts'

/** Pi CLI sandbox modes a deployment may pin. */
export const PI_SANDBOX_MODES: readonly PiSandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

/** Grace in milliseconds for Pi process-tree termination. */
export const PI_DISPOSE_GRACE_MS = 3000

/** Deployment-owned configuration for the Pi loop plugin. */
export interface Config {
  /**
   * Pinned sandbox stance for every RPC child. When omitted, each query follows
   * the session's dsh permission knobs (`sandbox/mode` and `approval/policy`):
   * full access runs native, `workspace-write` wraps the child in the dsh
   * sandbox with a write-capable tool set, an `ask` policy degrades to a
   * read-only denial, and anything else fails closed with `read-only`.
   */
  sandboxMode?: PiSandboxMode
  /** LLM provider for the `pi` child (`--provider`), when the deployment pins one. */
  provider?: string
  /** Model pattern for the `pi` child (`--model`); Pi native settings own the model when omitted. */
  model?: string
  /** Thinking/reasoning level, appended to the `--model` pattern when pinned. */
  thinkingLevel?: string
  /** Explicit environment entries passed to the `pi` child. */
  env?: Record<string, string>
}

/** Schema of the Pi loop plugin configuration. */
export const Config: z<Config> = z.object({
  sandboxMode: z.union([...PI_SANDBOX_MODES]),
  provider: z.string(),
  model: z.string(),
  thinkingLevel: z.string(),
  env: z.dict(z.string()).default({}),
})

/** Prepared-but-unpublished agent resources sharing one memoized teardown. */
interface PreparedAgent {
  agent: PiAgent
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
  return {
    sandboxMode: config.sandboxMode,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    env: config.env ?? {},
  }
}

/** Resolve the Pi CLI entrypoint from the package's pinned `bin` field. */
function piCliEntrypoint(): string {
  // The package is ESM-only (its `exports` exposes no `require` condition), so
  // resolve the import entry and walk back to the package root to read `bin`.
  const mainUrl = (import.meta as ImportMeta & { resolve: (specifier: string) => string })
    .resolve('@earendil-works/pi-coding-agent')
  const root = dirname(dirname(fileURLToPath(mainUrl)))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }
  const bin = pkg.bin
  /* v8 ignore start -- the pinned dependency's bin is an object map; the string-arm and fallbacks are a defensive unreachable layout */
  /* v8 ignore next -- see above */
  const rel = typeof bin === 'string'
    ? bin
    : bin?.['pi'] ?? Object.values(bin ?? {})[0] ?? 'bin/pi.js'      /* v8 ignore stop */
  return join(root, rel)
}

/** Project the driver's spawn request onto the dsh subprocess seam. */
function piSubprocessSpec(spec: PiSpawnSpec, graceMs: number): SubprocessSpawnSpec {
  return {
    // `spec.argv[0]` is the Pi CLI entrypoint; run it under the current node.
    argv: [process.execPath, ...spec.argv],
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs,
    env: spec.env,
  }
}

/** Project a dsh subprocess handle onto the Pi protocol transport. */
function fromSubprocess(handle: SubprocessHandle): PiProcess {
  const { stdin, stdout, stderr } = handle
  /* v8 ignore start -- the Pi spawn spec always requests piped stdio, so a missing stream is a wiring hole */
  /* v8 ignore next -- see above */
  if (stdin === undefined || stdout === undefined || stderr === undefined) {
    throw new Error('agent-loop-pi: spawned child must pipe stdin/stdout/stderr')
  }
  /* v8 ignore stop */
  return {
    stdin,
    stdout,
    stderr,
    onExit: (handler) => { void handle.done.then(handler, handler) },
    terminate: () => handle.terminate(),
  }
}

/** Host-face ctx key for the Pi loop service. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopPi: PiLoop
  }
}

/**
 * Concrete AgentFactory and driver service of the Pi loop. Creation and resume
 * follow the registry factory contract and the shared publication transaction:
 * prepare, run setup, then publish through both registries, announce, and emit
 * `agent/session-start`.
 */
export class PiLoop extends Service implements AgentFactory {
  /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
  static inject = ['agents', 'sessions', 'systemPrompt', 'subprocess']

  /** Validated configuration owned by the loop plugin. */
  readonly config: ResolvedConfig
  private readonly ownership: FactoryOwnership
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context }
  /** Process-tree spawn capability handed to every agent, sandboxed by the subprocess seam. */
  readonly spawn: (spec: PiSpawnSpec) => PiProcess
  /** Resolved Pi CLI entrypoint; `argv[0]` of every Pi RPC child. */
  readonly bin: string

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, 'agentLoopPi')
    this.config = resolveConfig(config)
    this.ownership = new FactoryOwnership(ctx.fiber)
    this.runtime = { ctx }
    this.bin = piCliEntrypoint()
    this.spawn = (spec) => fromSubprocess(this.runtime.ctx.subprocess.spawn(piSubprocessSpec(spec, PI_DISPOSE_GRACE_MS)))
    ctx.effect(() => () => this.ownership.dispose(), 'agentLoopPi.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoopPi.setFactory()')
    // Pi owns its prompt natively, so these variables feed only downstream
    // consumers of the dsh system prompt assembly, mirroring the default loop's
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

    let machine: PiAgent | undefined
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
      }, `agentLoopPi.lifecycle(${id})`)
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
      const agent = machine = new PiAgent(loopCtx, id, options, session, this.config, this.spawn, this.bin)
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
      }, `agentLoopPi.resume-load(${id})`)
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
