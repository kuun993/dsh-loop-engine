/**
 * Pi loop engine module: drives every session it is handed through the Pi CLI
 * (`@earendil-works/pi-coding-agent`) over its JSONL RPC mode, one stateless
 * session per dsh step, with the durable session log as the sole source of
 * model context. The router routes a session here on the plugin's own engine
 * record, else its agent preset; this module is a library, not a Cordis plugin entry. Pi has no permission system, so the entire `pi --mode rpc` child is
 * spawned through the dsh subprocess seam — the only available privilege
 * boundary — and its `--tools` are pruned to the resolved sandbox stance.
 *
 * @module dsh-loop-engine/engine-pi
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { PiAgent } from './agent.ts'
import type { PiProcess, PiSpawnSpec } from './rpc/client.ts'
import type { PiSandboxMode, ResolvedConfig } from './types.ts'
import { HostedEngineRuntime } from '../driver-core/hosted-engine-runtime.ts'

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
  /** Fallback model for the `pi` child (`--model`), used when the session selects none; Pi native settings own the model when omitted. */
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
    onExit: (handler) => {
      // `PiProcess.onExit` is a zero-arg notification, while the seam reports a
      // child exit as an outcome: reconcile the outcome into that notification,
      // on a clean exit and on a failed wait alike.
      void handle.done.then(handler, handler)
    },
    terminate: () => handle.terminate(),
  }
}

/** Host-face ctx key this engine's runtime is registered under. */
export const PI_ENGINE_LABEL = 'agentLoopPi'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopPi: PiLoop
  }
}

/**
 * Creation/resume machinery for the Pi engine. The process-wide AgentFactory
 * slot belongs to the router, which delegates each session to the engine its
 * preset names; this class is that engine's driver, not a plugin.
 */
export class PiLoop extends HostedEngineRuntime<ResolvedConfig, PiAgent> {
  /** Process-tree spawn capability handed to every agent, sandboxed by the subprocess seam. */
  readonly spawn: (spec: PiSpawnSpec) => PiProcess
  /** Resolved Pi CLI entrypoint; `argv[0]` of every Pi RPC child. */
  readonly bin: string

  constructor(
    ctx: Context,
    config: Config,
  ) {
    super(ctx, PI_ENGINE_LABEL, resolveConfig(config))
    // Resolved lazily rather than injected: this engine is built only when a
    // session actually selects it, so a profile without the subprocess service
    // fails that session loud instead of stalling the whole plugin.
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error('loop-engine: the pi engine needs the dsh subprocess service on this context')
    }
    this.bin = piCliEntrypoint()
    this.spawn = (spec) => fromSubprocess(subprocess.spawn(piSubprocessSpec(spec, PI_DISPOSE_GRACE_MS)))
  }

  /** Construct the Pi RPC driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): PiAgent {
    return new PiAgent(
      loopCtx, id, options, session, this.config, this.spawn, this.bin,
    )
  }
}
