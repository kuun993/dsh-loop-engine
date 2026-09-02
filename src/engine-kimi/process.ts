/**
 * Kimi CLI process projection. The driver locates the `kimi` executable, builds
 * the `-p --output-format stream-json` argv for one step, and projects the dsh
 * subprocess seam handle onto a minimal transport the agent can read to
 * completion. Kimi has no host permission callback and no `--tools` pruning
 * flag in `-p` mode, so the whole child is spawned through the seam — the only
 * available privilege boundary (the seam's OS sandbox, default read-only) — and
 * every step is a fresh one-shot child because `-p` is inherently stateless.
 *
 * @module dsh-loop-engine/engine-kimi/process
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** The exact argv/cwd/env the driver requests for one `kimi -p` child. */
export interface KimiSpawnSpec {
  /** The program plus its flags; `argv[0]` is the Kimi CLI executable. */
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  /** Cancellation: the seam escalates process-tree termination when it fires. */
  readonly signal?: AbortSignal
}

/** A spawned Kimi process as the agent's transport needs it. */
export interface KimiProcess {
  /** Child stdin (JSON-RPC request frames). */
  readonly stdin: Writable
  /** Child stdout (the `session/update` notification frames). */
  readonly stdout: Readable
  /** Child stderr (diagnostics; drained and dropped). */
  readonly stderr: Readable
  /** Resolves when the child closes. */
  readonly done: Promise<unknown>
  /** Request process-tree termination. */
  terminate(): void
}

/** Spawns one Kimi child over the given spec (the driver's spawn capability). */
export type KimiSpawnCapability = (spec: KimiSpawnSpec) => KimiProcess

/** Resolve the Kimi home directory from `KIMI_CODE_HOME` or the current user's home. */
export function kimiHomeDir(): string {
  const envHome = process.env.KIMI_CODE_HOME
  return envHome !== undefined && envHome !== '' ? envHome : join(homedir(), '.kimi-code')
}

/**
 * Resolve the Kimi CLI executable. An explicit config path wins; otherwise this
 * probes the standard `<kimi home>/bin/kimi[.exe]` location and falls back to
 * `'kimi'` (resolved through PATH by the spawner).
 * @param configBin - an operator-pinned absolute path (or `'kimi'`), if any.
 * @returns the executable to spawn as `argv[0]`.
 */
export function kimiBinResolver(configBin?: string): string {
  if (configBin !== undefined && configBin !== '') return configBin
  const executable = process.platform === 'win32' ? 'kimi.exe' : 'kimi'
  const candidate = join(kimiHomeDir(), 'bin', executable)
  return existsSync(candidate) ? candidate : 'kimi'
}

/**
 * Build the persistent `kimi acp` argv. The ACP child stays alive across steps
 * and is spoken to over JSON-RPC on stdio — the prompt is a request body, not an
 * argv positional — so there is no command-line length ceiling and no model flag
 * (Kimi owns model selection natively via its own config).
 * @param bin - the Kimi executable.
 * @returns the argv, `argv[0]` being the executable.
 */
export function kimiAcpArgv(bin: string): string[] {
  return [bin, 'acp']
}

/** Project the driver's spawn request onto the dsh subprocess seam. */
export function kimiSubprocessSpec(spec: KimiSpawnSpec, graceMs: number): SubprocessSpawnSpec {
  return {
    argv: [...spec.argv],
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs,
    env: spec.env,
    ...spec.signal === undefined ? {} : { signal: spec.signal },
  }
}

/** Project a dsh subprocess handle onto the Kimi process transport. */
export function fromSubprocess(handle: SubprocessHandle): KimiProcess {
  const { stdin, stdout, stderr } = handle
  /* v8 ignore start -- the Kimi spawn spec always requests piped stdio, so a missing stream is a wiring hole */
  /* v8 ignore next -- see above */
  if (stdin === undefined || stdout === undefined || stderr === undefined) {
    throw new Error('agent-loop-kimi: spawned child must pipe stdin/stdout/stderr')
  }
  /* v8 ignore stop */
  return {
    stdin,
    stdout,
    stderr,
    done: handle.done,
    terminate: () => handle.terminate(),
  }
}
