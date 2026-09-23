/**
 * Per-session agent loop engines, node half.
 *
 * Hosts the non-default agent-loop engines (Claude Code, Codex, Pi, Kimi Code)
 * and routes each session to the engine it runs. The engine is the PLUGIN's own
 * per-session fact (`session-engine-store.ts`), read first and over the recorded
 * agent preset; a session the plugin has no record for keeps the preset answer,
 * which is what makes every pre-existing session behave exactly as before.
 * The harness admits exactly one AgentFactory per process, so "session A on
 * Codex while session B runs Kimi" is realized by a single router factory
 * ({@link RouterLoop}, which extends the harness's own `AgentLoop`) dispatching
 * to one driver runtime per engine; `in-process` sessions keep the harness loop
 * through that same router.
 *
 * Because the router owns the slot, the plugin keeps the base bundle's
 * `agent-loop` row disabled for as long as it is composed. That managed block
 * lives in the profile's `cordis.patch.yml` (see `patch-manager.ts`) and is the
 * plugin's only footprint in the harness's configuration; the block names no
 * engine, because the engine is a per-session decision.
 *
 * The plugin authors one preset per hosted engine into the user preset root
 * (`$DSH_HOME/.agent-presets/loop-engine-<engine>`, see `preset.ts`), each a
 * copy of `standard` minus the dsh-native command and skill rows an external
 * engine replaces, and it serves every hosted engine's provider route label in
 * the llm registry (`provider-route.ts`): an engine logs its own label into
 * each session's request/header, and the web host refuses a turn whose session
 * selection names a provider no adapter serves. The preset is now only the
 * session's agent-plane composition (and the engine's own default for a session
 * with no record) — it is no longer the thing that decides a running session's
 * engine.
 *
 * The `agent-loop-engine` settings section carries the DEFAULT engine for new
 * sessions — which preset the roster's default points at — not a process-wide
 * switch: existing sessions keep the engine they run, and nothing is torn down or
 * reloaded by it. (A PER-SESSION switch is a different thing: it is made from the
 * chat composer, and when it involves the harness loop it releases that session's
 * agent and reloads the page — `router-loop.ts` `move`, `client/reload.ts`.)
 *
 * @module dsh-loop-engine
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AgentPresetsService, LlmRegistry, SettingsMutator } from './driver-core/host-servers.ts'
import { engineOfSession } from './engine-of-session.ts'
import { LoopEngineRemote } from './engine-remote.ts'
import { ClaudeCodeLoop, CLAUDE_CODE_PERMISSION_MODES, type Config as ClaudeCodeConfig } from './engine-claude/loop.ts'
import { CodexLoop, CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES, type Config as CodexConfig } from './engine-codex/loop.ts'
import { PiLoop, type Config as PiConfig } from './engine-pi/loop.ts'
import { KimiLoop, type Config as KimiConfig } from './engine-kimi/loop.ts'
import type { CodexApprovalPolicy, CodexSandboxMode } from './engine-codex/types.ts'
import {
  applyManagedBlock,
  hasLegacyManagedBlock,
  hasManagedBlock,
  legacyBlockEngineOf,
} from './patch-manager.ts'
import { enginePresetId, ensureEnginePresets } from './preset.ts'
import { HOSTED_ROUTE_LABEL } from './agent-preset-ids.ts'
import { HostedEngineRouteAdapter } from './provider-route.ts'
import { ROUTER_SERVICES, RouterLoop, type RouterEngine } from './router-loop.ts'
import {
  resolveEngineRecordPath,
  SessionEngineStore,
  writeFileAtomicSync,
} from './session-engine-store.ts'
import type { RouterSurfaceHolder } from './engine-remote.ts'
import {
  loopEngineSettingsNamespace,
  LOOP_ENGINE_SETTINGS_SCHEMA,
  type HostedEngineId,
  type LoopEngineId,
  type LoopEngineSettings,
} from './settings.ts'

export const name = 'loop-engine'

/**
 * Services the plugin's own fiber requires. The plugin declares none of its
 * own: the optional host services it reads (`commands`, `skills`, `agentPresets`,
 * `llm`) are resolved lazily via `ctx.get` and may be absent, and the router
 * declares the harness loop's own dependency set when it mounts. Empty keeps
 * the plugin from demanding a service that a minimal profile does not provide.
 */
export const inject = []

/** Composition entry for the loop engine selection and the hosted engine drivers. */
export interface Config extends ClaudeCodeConfig {
  /** Profile whose `cordis.patch.yml` carries the managed block; defaults to `web`. */
  profile?: string
  /** Patch file name inside the profile; defaults to `cordis.patch.yml`. */
  patchFilename?: string
  /** Explicit absolute path to the patch file, overriding profile + filename. */
  patchPath?: string
  /** Pinned Codex sandbox mode; falls back to the session's dsh permission knobs. */
  sandboxMode?: CodexSandboxMode
  /** Pinned Codex approval policy; falls back to the session's dsh permission knobs. */
  approvalPolicy?: CodexApprovalPolicy
  /** LLM provider for the Pi RPC child (`--provider`). */
  piProvider?: string
  /** Thinking/reasoning level for the Pi RPC child, appended to its `--model`. */
  piThinking?: string
  /** Kimi CLI executable; `'kimi'` resolves through PATH when not pinned to an absolute path. */
  kimiBin?: string
}

/**
 * Schema of the loop engine composition entry.
 *
 * A schemastery object validates each field only when it is present and lets
 * an absent key fall through as `undefined`, so omitted knobs are accepted —
 * matching the permissive interface and read path (`resolvePatchPath` defaults
 * the patch path; each engine driver resolves only the knobs it owns and
 * omitted deployment tunables fall back to the session). The composition entry
 * is an engine-agnostic superset: every hosted engine's knobs live here at
 * once, because any session may select any engine.
 */
export const Config: z<Config> = z.object({
  profile: z.string(),
  patchFilename: z.string(),
  patchPath: z.string(),
  permissionMode: z.union(CLAUDE_CODE_PERMISSION_MODES.map(mode => z.const(mode))),
  env: z.dict(z.string()),
  model: z.string(),
  disposeGraceMs: z.number(),
  maxTurns: z.number(),
  sandboxMode: z.union(CODEX_SANDBOX_MODES.map(mode => z.const(mode))),
  approvalPolicy: z.union(CODEX_APPROVAL_POLICIES.map(policy => z.const(policy))),
  piProvider: z.string(),
  piThinking: z.string(),
  kimiBin: z.string(),
})

/** Resolve the managed patch file from configuration, defaulting to the web profile. */
export function resolvePatchPath(config: Config): string {
  if (config.patchPath !== undefined && config.patchPath !== '') return config.patchPath
  return join(
    resolveDshHome(),
    'profiles',
    config.profile ?? 'web',
    config.patchFilename ?? 'cordis.patch.yml',
  )
}

/** Whether a promise rejection was an ENOENT (file not found). */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Read the patch file, or `undefined` when it does not exist yet. */
async function readPatchOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Atomically replace the patch file (same-directory temp + rename). */
export async function writePatchFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * Synchronously atomically replace the patch file. The settings onChange that
 * commits a default-engine change is a synchronous hook with no await, and the
 * write MUST land before the caller is told the change committed — otherwise a
 * user who restarts `dsh web` immediately reads the stale file.
 * @param path - the profile's patch file.
 * @param text - the next file content.
 */
export function writePatchFileSync(path: string, text: string): void {
  writeFileAtomicSync(path, text)
}

/**
 * Ensure the profile's patch file carries the plugin's managed block, which
 * disables the base bundle's `agent-loop` row so this plugin's router owns the
 * single AgentFactory slot. Idempotent: a file already carrying a block and no
 * legacy block is left untouched.
 * @param path - the profile's patch file.
 * @returns whether a write occurred.
 */
export async function syncManagedBlock(path: string): Promise<boolean> {
  const current = await readPatchOrUndefined(path)
  // A file already carrying the CURRENT block and no legacy span is left
  // untouched. A legacy span is rewritten even when its begin marker names an
  // engine this build does not recognize: the routing model does not read an
  // engine out of the file at all, so an unrecognized name is simply a legacy
  // span to migrate.
  if (current !== undefined && hasManagedBlock(current) && !hasLegacyManagedBlock(current)) {
    return false
  }
  await writePatchFile(path, applyManagedBlock(current ?? ''))
  return true
}

/** Synchronous patch-file read for plugin startup only. */
function readPatchFileSync(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if (isMissing(error)) return ''
    throw error
  }
}

/** Forward the engine-driver fields of the composition entry to the Claude Code engine. */
function claudeCodeConfig(config: Config): ClaudeCodeConfig {
  return {
    ...config.permissionMode === undefined ? {} : { permissionMode: config.permissionMode },
    ...config.env === undefined ? {} : { env: config.env },
    ...config.model === undefined ? {} : { model: config.model },
    ...config.disposeGraceMs === undefined ? {} : { disposeGraceMs: config.disposeGraceMs },
    ...config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns },
  }
}

/** Forward the engine-driver fields of the composition entry to the Codex engine. */
function codexConfig(config: Config): CodexConfig {
  return {
    ...config.sandboxMode === undefined ? {} : { sandboxMode: config.sandboxMode },
    ...config.approvalPolicy === undefined ? {} : { approvalPolicy: config.approvalPolicy },
    ...config.env === undefined ? {} : { env: config.env },
    ...config.model === undefined ? {} : { model: config.model },
  }
}

/** Forward the engine-driver fields of the composition entry to the Pi engine. */
function piConfig(config: Config): PiConfig {
  return {
    ...config.piProvider === undefined ? {} : { provider: config.piProvider },
    ...config.model === undefined ? {} : { model: config.model },
    ...config.piThinking === undefined ? {} : { thinkingLevel: config.piThinking },
    ...config.env === undefined ? {} : { env: config.env },
    ...config.sandboxMode === undefined ? {} : { sandboxMode: config.sandboxMode },
  }
}

/** Forward the engine-driver fields of the composition entry to the Kimi engine. */
function kimiConfig(config: Config): KimiConfig {
  return {
    ...config.model === undefined ? {} : { model: config.model },
    ...config.env === undefined ? {} : { env: config.env },
    ...config.kimiBin === undefined ? {} : { bin: config.kimiBin },
  }
}

/**
 * Apply the plugin: own the profile's managed block, mount the routing factory,
 * author the per-engine presets, and serve every hosted engine's provider
 * route. The settings section carries the deployment's default engine.
 * @param ctx - the composing context.
 * @param config - composition entry for the managed patch file and engine knobs.
 */
export function apply(ctx: Context, config: Config): void {
  const patchPath = resolvePatchPath(config)
  const patchText = readPatchFileSync(patchPath)
  // A block written by an older build names the ONE engine the profile used to
  // be pinned to. Carry that choice into the settings seed so the deployment's
  // default engine survives the upgrade, then rewrite the block to the
  // engine-agnostic form the router needs.
  const legacyEngine = legacyBlockEngineOf(patchText)
  const needsWrite = hasLegacyManagedBlock(patchText) || !hasManagedBlock(patchText)
  if (needsWrite) {
    try {
      writePatchFileSync(patchPath, applyManagedBlock(patchText))
    } catch (error: unknown) {
      // Without the block the base `agent-loop` row keeps the factory slot and
      // the router's registration is refused; every session would then fail
      // loud, so this is reported at error level rather than swallowed.
      ctx.logger.error(
        `loop-engine: could not write the managed block to "${patchPath}": ${String(error)}. `
        + 'The base agent loop still owns the factory slot; restart `dsh web` after fixing the path.',
      )
    }
  }

  /** Settings namespace of the preset roster (owned by dsh-agent-presets). */
  const AGENT_PRESETS_NS = 'agent-presets' as SettingsNamespace
  /** Bounded retry window for the roster's settings namespace attach race. */
  const PRESET_DEFAULT_ATTEMPTS = 30
  const PRESET_DEFAULT_RETRY_MS = 100
  /** Bounded retry window for the llm service attach race on route registration. */
  const ROUTE_ATTEMPTS = 30
  const ROUTE_RETRY_MS = 100
  /**
   * Bounded retry window for the base loop's slot: it holds the `agentLoop`
   * name until the harness's live patch reload applies this plugin's block.
   */
  const ROUTER_ATTEMPTS = 40
  const ROUTER_RETRY_MS = 50
  /** Attempts already spent waiting for the base loop to release the slot. */
  let routerAttempts = 0
  /** Pending router-remount timer (base loop still holding the slot). */
  let routerRetry: ReturnType<typeof setTimeout> | undefined

  const CLEAR_ROUTER_RETRY = (): void => {
    if (routerRetry !== undefined) {
      clearTimeout(routerRetry)
      routerRetry = undefined
    }
  }

  /**
   * Set by the plugin's cleanup effect. Every scheduled retry checks it before
   * acting: a retry armed from an async continuation can otherwise outlive the
   * context and re-enter the settings path after disposal.
   */
  let disposed = false

  /**
   * Arm a retry timer that must not act after the plugin is disposed. Retries
   * armed from async continuations (a settings mutation rejecting, an unsettled
   * fiber) can be scheduled *after* the cleanup effect already ran, so clearing
   * pending handles is not enough on its own.
   */
  const retryLater = (run: () => void, ms: number): ReturnType<typeof setTimeout> =>
    setTimeout(() => { if (!disposed) run() }, ms)

  let routeDisposers: (() => void)[] | undefined
  let routeRetry: ReturnType<typeof setTimeout> | undefined

  const CLEAR_ROUTE_RETRY = (): void => {
    if (routeRetry !== undefined) {
      clearTimeout(routeRetry)
      routeRetry = undefined
    }
  }

  /**
   * Serve the single hosted provider route label from the llm registry.
   *
   * Every hosted engine logs the SAME label into its sessions' request/header
   * (`HOSTED_ROUTE_LABEL`), and the web host refuses a turn whose session
   * selection names a provider no adapter serves — without this placeholder the
   * second prompt of every hosted session fails with `model-unavailable`. One
   * label for all four engines means one adapter: the browser model catalog is
   * per Host generation rather than per session, so a route per engine would put
   * four identical `default` groups in every session's menu at once
   * (`provider-route.ts`). The placeholder advertises exactly one model entry —
   * the engine's own `default` — so the model menu can name a hosted session's
   * selection instead of rendering the raw `provider/model` string.
   *
   * Best-effort: a composition without the llm service cannot enforce the route
   * check either, so an absent registry only schedules a bounded retry against
   * the fiber start-order race.
   */
  const mountProviderRoutes = (attempt = 0): void => {
    CLEAR_ROUTE_RETRY()
    const llm = ctx.get('llm') as LlmRegistry | undefined
    if (llm === undefined) {
      if (attempt < ROUTE_ATTEMPTS) {
        routeRetry = retryLater(() => mountProviderRoutes(attempt + 1), ROUTE_RETRY_MS)
      }
      return
    }
    const registered: (() => void)[] = []
    try {
      registered.push(llm.registerAdapter([HOSTED_ROUTE_LABEL], new HostedEngineRouteAdapter()))
    } catch (error: unknown) {
      // A deployment whose own adapter already serves the label needs no
      // placeholder. The llm registry signals that structurally with an error
      // code; the message arm stays for a registry that throws an uncoded one.
      const duplicateAdapter = (error as { code?: unknown } | null)?.code === 'DUPLICATE_ADAPTER'
      if (error instanceof Error && (duplicateAdapter || error.message.includes('already registered'))) {
        ctx.logger.warn(`loop-engine: provider route "${HOSTED_ROUTE_LABEL}" is already served by another adapter`)
      } else {
        ctx.logger.error(`loop-engine: provider route "${HOSTED_ROUTE_LABEL}" registration failed: ${String(error)}`)
      }
    }
    routeDisposers = registered
  }

  /** Release every placeholder route registered by the plugin. */
  const releaseRoutes = (): void => {
    CLEAR_ROUTE_RETRY()
    const disposers = routeDisposers
    routeDisposers = undefined
    for (const dispose of disposers ?? []) dispose()
  }

  /** Pending preset-default retry timer (attach race or stale-value re-check). */
  let presetRetry: ReturnType<typeof setTimeout> | undefined
  /** Pending engine-preset authoring retry timer (roster attach race). */
  let authorRetry: ReturnType<typeof setTimeout> | undefined

  const CLEAR_PRESET_RETRY = (): void => {
    if (presetRetry !== undefined) {
      clearTimeout(presetRetry)
      presetRetry = undefined
    }
  }

  const CLEAR_AUTHOR_RETRY = (): void => {
    if (authorRetry !== undefined) {
      clearTimeout(authorRetry)
      authorRetry = undefined
    }
  }

  /**
   * Author every hosted engine's preset into the user preset root, once.
   *
   * Done up front rather than on the first engine selection: the plugin owns
   * the factory slot for its whole lifetime, so a session may ask for any
   * engine at any moment, and the roster reads presets from disk. The roster
   * service attaches from its own settings inject callback, which may land
   * after this plugin's apply, hence the bounded retry.
   *
   * The in-flight promise is memoized because two paths want the presets — the
   * boot-time authoring and the default-engine steering — and letting both walk
   * the same eight files races their writes: the loser's `rename` fails on
   * Windows, and the deployment's default then never gets steered.
   * @param attempt - retry counter for the roster attach race.
   * @returns the roster and its settled authoring, or undefined when no roster
   *   is composed (the retry keeps looking for a bounded window either way).
   */
  const authorEnginePresets = (
    attempt = 0,
  ): { presets: AgentPresetsService; settled: Promise<boolean> } | undefined => {
    CLEAR_AUTHOR_RETRY()
    const presets = ctx.get('agentPresets') as AgentPresetsService | undefined
    if (presets === undefined) {
      if (attempt < PRESET_DEFAULT_ATTEMPTS) {
        authorRetry = retryLater(() => authorEnginePresets(attempt + 1), PRESET_DEFAULT_RETRY_MS)
      }
      return undefined
    }
    const settled = authoring ??= ensureEnginePresets(resolveDshHome(), presets).catch((error: unknown) => {
      // Failures are advisory: the presets stay absent and the roster default
      // keeps pointing at the deployment's own preset, so sessions still run.
      ctx.logger.error(`loop-engine: engine preset authoring failed: ${String(error)}`)
      authoring = undefined
      return false
    })
    return { presets, settled }
  }

  /** The in-flight or settled preset authoring, shared by every caller. */
  let authoring: Promise<boolean> | undefined

  /**
   * Apply one roster-default op, retrying while the `agent-presets` settings
   * namespace is unregistered: the roster registers it from its own settings
   * inject callback, which may land after this plugin's apply. Any other
   * failure is deployment trouble and fails loud once.
   */
  const mutatePresetDefault = (op: SettingsPathOp, attempt = 0): void => {
    const settings = ctx.get('settings') as SettingsMutator | undefined
    if (settings === undefined) return
    // A provider that can enumerate its namespaces says structurally whether
    // the roster's section has attached yet, so the roster's attach race needs
    // no failed write (let alone a message match) to detect. Providers without
    // `describe` fall through to the write and the message arm below.
    if (settings.describe !== undefined && !settings.describe().some(entry => entry.ns === AGENT_PRESETS_NS)) {
      if (attempt < PRESET_DEFAULT_ATTEMPTS) {
        presetRetry = retryLater(() => mutatePresetDefault(op, attempt + 1), PRESET_DEFAULT_RETRY_MS)
      } else {
        ctx.logger.error(`loop-engine: preset default switch failed: the "${AGENT_PRESETS_NS}" settings namespace never registered`)
      }
      return
    }
    settings.mutate(AGENT_PRESETS_NS, [op]).then(() => undefined, (error: unknown) => {
      if (
        error instanceof Error
        && error.message.includes('not registered')
        && attempt < PRESET_DEFAULT_ATTEMPTS
      ) {
        presetRetry = retryLater(() => mutatePresetDefault(op, attempt + 1), PRESET_DEFAULT_RETRY_MS)
        return
      }
      ctx.logger.error(`loop-engine: preset default switch failed: ${String(error)}`)
    })
  }

  /** The roster default the plugin replaced, restored when the default returns to in-process. */
  let savedPresetDefault: string | undefined
  /** The engine the roster default currently points at. */
  let steeredEngine: LoopEngineId | undefined

  /**
   * Point the roster's default at the preset selecting `engine`, so new
   * sessions open on the deployment's default engine. Live sessions keep the
   * preset they were composed from — the roster reads its default per call.
   * `in-process` restores whatever default the plugin replaced.
   */
  const steerPresetDefault = (engine: LoopEngineId): void => {
    steeredEngine = engine
    if (engine === 'in-process') {
      const saved = savedPresetDefault
      savedPresetDefault = undefined
      if (saved === undefined) return
      mutatePresetDefault({ op: 'set', path: ['default'], value: saved })
      return
    }
    const started = authorEnginePresets()
    // A profile without the preset roster has nothing to steer.
    if (started === undefined) return
    void started.settled.then((authored) => {
      // No presets on disk: pointing the roster at a missing preset would fail
      // every new session loud, so the default stays where it was.
      if (!authored) return
      const current = started.presets.defaultId
      const target = enginePresetId(engine)
      if (current === target) return
      // Remember the deployment's own default only when it is not one of ours,
      // so switching between hosted engines never overwrites it with a managed id.
      if (!current.startsWith('loop-engine-')) savedPresetDefault = current
      mutatePresetDefault({ op: 'set', path: ['default'], value: target })
    })
  }

  /** The engine the settings section names, or the legacy block's, for the initial seed. */
  const seedEngine: LoopEngineId = legacyEngine ?? 'in-process'

  /**
   * The plugin's one diagnostic sink: the routing decision, the Remote, and the
   * engine record all report through it, so a deployment sees plugin diagnostics
   * in the host's own log with a single voice.
   */
  const pluginWarn = (message: string): void => { ctx.logger.warn(message) }

  /**
   * The plugin's own per-session engine record, read by the routing decision and
   * written by an engine switch (`selectEngine`). Created up front and read
   * lazily, so a deployment that never switches an engine never touches the
   * file.
   */
  const engineRecords = new SessionEngineStore(resolveEngineRecordPath(), pluginWarn)

  /**
   * Where the Remote's two endpoints find the router. Empty until the router is
   * mounted, and emptied again if a mount attempt fails: a holder still pointing
   * at a disposed router would report a live agent nobody drives and release an
   * agent nobody rebuilds.
   */
  const routerHolder: RouterSurfaceHolder = { current: undefined }

  /** Build one hosted engine's driver runtime on the router's context. */
  const buildEngine = (engineCtx: Context, engine: HostedEngineId): RouterEngine => {
    switch (engine) {
      case 'claude-code':
        return new ClaudeCodeLoop(engineCtx, claudeCodeConfig(config))
      case 'codex':
        return new CodexLoop(engineCtx, codexConfig(config))
      case 'pi':
        return new PiLoop(engineCtx, piConfig(config))
      case 'kimi':
        return new KimiLoop(engineCtx, kimiConfig(config))
    }
  }

  /**
   * Mount the routing factory, retrying while the base bundle's `agent-loop`
   * row still owns the slot.
   *
   * The managed block this plugin writes is read at the NEXT composition, so on
   * a fresh install's first boot that row is still active and the router's
   * registration is refused — the router registers as `agentLoop`, the base
   * loop's own service name, so the collision shows up as a duplicate service
   * rather than a factory error. Retry on exactly that collision, bounded, so
   * the router comes up as soon as the harness's live patch reload drops the
   * base row; any other failure is deployment trouble and fails loud once.
   *
   * The inject gate exists because the router's constructor touches these
   * services synchronously (`ctx.agents.setFactory`, `ctx.systemPrompt.variable`,
   * `ctx.sessionProjections.register`), which a plugin's apply cannot assume
   * are up yet. Each attempt gets a FRESH fiber: a failed construction has
   * already claimed the `agentLoop` name and registered effects on its own.
   */
  const mountRouter = (): void => {
    const fiber = ctx.inject(ROUTER_SERVICES, (routerCtx) => {
      try {
        const router = new RouterLoop(
          routerCtx,
          (engine): RouterEngine => buildEngine(routerCtx, engine),
          engineRecords,
          pluginWarn,
        )
        routerHolder.current = router
      } catch (error: unknown) {
        // A router that failed to construct owns nothing: the holder must not
        // keep pointing at the fiber this attempt is about to dispose.
        routerHolder.current = undefined
        // A live base loop under the same service name is the structural
        // "the slot is still taken" signal; it survives any rewording of the
        // harness's duplicate-service message.
        if (ctx.get('agentLoop') !== undefined && routerAttempts < ROUTER_ATTEMPTS) {
          routerAttempts += 1
          routerRetry = retryLater(() => {
            void Promise.resolve(fiber.dispose()).then(mountRouter, mountRouter)
          }, ROUTER_RETRY_MS)
          return
        }
        ctx.logger.error(`loop-engine: could not start the loop router: ${String(error)}`)
      }
    })
  }
  mountRouter()

  /**
   * Publish "which engine does this session run?" and "move it to another" to
   * the browser half as the plugin's own Remote (`remote.loopEngine.engine`,
   * `remote.loopEngine.select`, see `engine-remote.ts`).
   *
   * Registered unconditionally, on this plugin's fiber: `TypertRemoteService`
   * binds a visible `typertRemote` and registers a Cordis service, and the
   * Gateway reflects over live services at INVOKE time — so a profile that
   * mounts no Gateway pays nothing, and unmounting the plugin withdraws the
   * binding with the fiber.
   *
   * The read it publishes is the mounted router's own bookkeeping
   * ({@link RouterLoop.reportEngine}: the engine driving this session NOW, plus
   * the one a committed switch has recorded for its next build), falling back to
   * {@link engineOfSession} — the plugin's own record first, then the same
   * durable-log fold the router routes on — while no router is mounted. Either
   * way the engine a session is shown as running and the engine it is actually
   * driven by are one answer, and the one case where a session has two facts
   * travels as two fields rather than as a claim that the switch already landed.
   */
  const mountEngineRemote = (): void => {
    new LoopEngineRemote(
      ctx,
      (sessionId) => engineOfSession(ctx, sessionId, engineRecords),
      routerHolder,
      pluginWarn,
    )
  }
  mountEngineRemote()

  mountProviderRoutes()
  authorEnginePresets()
  ctx.effect(() => () => {
    disposed = true
    CLEAR_ROUTE_RETRY()
    CLEAR_PRESET_RETRY()
    CLEAR_AUTHOR_RETRY()
    CLEAR_ROUTER_RETRY()
    releaseRoutes()
  }, 'loop-engine: cleanup')

  // installSection always calls setSource before the first onChange, so
  // `source` is guaranteed set here; the assertion is a contract guard.
  let source: (() => LoopEngineSettings) | undefined
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(
      ctx,
      loopEngineSettingsNamespace(),
      LOOP_ENGINE_SETTINGS_SCHEMA,
      { engine: seedEngine, showInComposer: true },
      {
        setSource: (current) => { source = current },
        onChange: () => {
          const next = source!().engine
          if (next === steeredEngine) return
          steerPresetDefault(next)
        },
      },
    )
  })
}
