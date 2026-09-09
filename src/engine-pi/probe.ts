import type { PiProcess, PiSpawnSpec } from './rpc/client.ts'

/** One discoverable Pi model: the raw two-part identity `pi` exposes. */
export interface PiModelEntry {
  readonly provider: string
  readonly model: string
}

/** Wait for a Pi child to exit, resolving with its exit code. */
function waitForExit(child: PiProcess): Promise<number> {
  return new Promise<number>((resolve) => {
    // `PiProcess.onExit` is typed as a zero-arg handler, but the child's exit
    // code is delivered at runtime; reach it through a structural cast.
    ;(child.onExit as unknown as (handler: (code: number | null) => void) => void)(
      (code) => resolve(code ?? 0),
    )
  })
}

/** Collect the child's full stdout AND stderr, resolving once both close. */
function collectOutput(child: PiProcess): Promise<string> {
  return new Promise<string>((resolve) => {
    /* v8 ignore start -- real child streams always expose `.on`; this backstop is unreachable in tests */
    /* v8 ignore next -- see above */
    if ((child.stdout.on === undefined) || (child.stderr.on === undefined)) {
      resolve('')
      return
    } /* v8 ignore stop */
    let text = ''
    let pending = 2
    const finish = (): void => {
      pending -= 1
      if (pending === 0) resolve(text)
    }
    // pi --mode rpc --list-models emits the model table on STDERR (stdout is
    // reserved for the JSONL RPC protocol), so read both and merge.
    const out = child.stdout as unknown as {
      on(event: string, cb: (arg?: unknown) => void): void
      setEncoding(enc: string): void
    }
    const err = child.stderr as unknown as {
      on(event: string, cb: (arg?: unknown) => void): void
      setEncoding(enc: string): void
    }
    out.setEncoding('utf8')
    out.on('data', (data) => { text += String(data) })
    out.on('close', finish)
    err.setEncoding('utf8')
    err.on('data', (data) => { text += String(data) })
    err.on('close', finish)
  })
}

/**
 * Parse the output of `pi --list-models`: a column-aligned table whose first
 * two columns are `provider` and `model`. The header row and blank lines are
 * skipped; long model ids simply occupy more columns. Splitting on 2+ spaces
 * yields provider and model in the first two fields regardless of alignment.
 */
export function parsePiModelList(output: string): PiModelEntry[] {
  const entries: PiModelEntry[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    // The header row ("provider  model  ...") has no two-space-separated
    // provider/model pair — skip any line whose first field is a column title.
    const match = /^(\S+)\s{2,}(\S+)/.exec(trimmed)
    if (match === null) continue
    const provider = match[1]!
    if (provider === 'provider') continue // header
    entries.push({ provider, model: match[2]! })
  }
  return entries
}

/**
 * Spawn `pi --list-models` and return the parsed model entries. Failures
 * (non-zero exit, no stdout, spawn throw) resolve to an empty array so the
 * catalog stays advisory and a probe glitch never breaks the engine mount.
 * @param bin - the Pi CLI entrypoint (from `piCliEntrypoint()`); becomes spec.argv[0].
 * @param spawn - the process-spawn adapter; `piSubprocessSpec` prepends the node
 *   prefix, so spec.argv must NOT carry it.
 */
export async function probePiModels(
  bin: string,
  spawn: (spec: PiSpawnSpec) => PiProcess,
): Promise<readonly PiModelEntry[]> {
  const spec: PiSpawnSpec = {
    argv: [bin, '--mode', 'rpc', '--list-models'],
    cwd: process.cwd(),
    env: {},
  }
  let child: PiProcess
  try {
    child = spawn(spec)
  } catch {
    return []
  }
  const outputPromise = collectOutput(child)
  const exitCode = await waitForExit(child)
  if (exitCode !== 0) return []
  const output = await outputPromise
  return parsePiModelList(output)
}
