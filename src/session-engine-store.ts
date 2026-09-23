/**
 * The plugin's own per-session engine record: one sidecar file beside the
 * harness home, deliberately NOT an event in the session log.
 *
 * The engine a session runs is a per-session host-plane fact, and the session
 * log is where this project records such facts — so the obvious home for it is
 * a plugin-authored session event. It cannot be done:
 *
 *  - `Session.append` builds the event envelope itself and offers no way to set
 *    the envelope's `ignorable?: true` marker (the only options it takes are
 *    surface metadata);
 *  - the persistence read path refuses a stored event whose type is outside the
 *    harness's generated `KNOWN_SESSION_EVENT_TYPES` unless the envelope carries
 *    that marker;
 *  - so the append succeeds in memory, the write succeeds on disk, and the NEXT
 *    cold read of that session refuses the whole log:
 *    `SessionFormatUnsupportedError: … contains event type "…" unknown to this
 *    harness and not marked ignorable; refusing to interpret the log`.
 *
 * That is a destroyed session per engine switch, so this plugin keeps the fact
 * out of the log instead. `docs/proposals/append-ignorable-events.md` asks the
 * harness for the missing seam; if it lands, this record can move into the log
 * with the file kept as the fallback for sessions recorded before the change.
 *
 * Storage semantics (all of them deliberate):
 *
 *  - one small JSON document, `{ version, engines: { <sessionId>: <engine> } }`,
 *    written whole through a same-directory temp file + rename, so a crash
 *    mid-write can never leave a truncated record behind;
 *  - the in-memory view advances only after the write committed, so a failed
 *    write leaves both the file and the view exactly as they were;
 *  - a missing file is the normal first-run state (no diagnostic); an
 *    unreadable or unrecognizable file degrades to "no record" with ONE warn
 *    (the document is read at most once per process, so no lookup repeats a
 *    failure), because a broken record must cost a session its remembered
 *    engine, never its ability to open: the routing read falls back to the
 *    preset mapping;
 *  - entries are added, never removed: one line per session ever switched, which
 *    a deployment cannot notice, and a stale entry for a deleted session is
 *    simply never asked about.
 *
 * @module dsh-loop-engine/session-engine-store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isLoopEngineId, type LoopEngineId } from './agent-preset-ids.ts'

/** Harness-home-relative directory holding the plugin's own records. */
export const ENGINE_RECORD_DIR = '.loop-engine'

/** File name of the per-session engine record document. */
export const ENGINE_RECORD_FILE = 'engines.json'

/** Format version of the record document; a mismatch is treated as no record. */
export const ENGINE_RECORD_VERSION = 1

/**
 * The record file's path under the harness home (`$DSH_HOME/.loop-engine/engines.json`).
 * @returns the absolute path of the engine record document.
 */
export function resolveEngineRecordPath(): string {
  return join(resolveDshHome(), ENGINE_RECORD_DIR, ENGINE_RECORD_FILE)
}

/**
 * Read one session's engine off the plugin's own record.
 *
 * The narrow face the routing read depends on, so a test can hand the router an
 * exact set of records instead of a file.
 */
export interface EngineRecordSource {
  /**
   * The engine this plugin's record names for one session.
   * @param sessionId - the session to look up.
   * @returns the recorded engine, or undefined when this session has no record.
   */
  engineOf(sessionId: SessionId): LoopEngineId | undefined
}

/**
 * The record as the ROUTER uses it: the read every routing decision makes, plus
 * the write an engine switch commits.
 */
export interface EngineRecordStore extends EngineRecordSource {
  /**
   * Record one session's engine, replacing any earlier record for it.
   * @param sessionId - the session whose engine is recorded.
   * @param engine - the engine that session now runs.
   */
  record(sessionId: SessionId, engine: LoopEngineId): void
}

/** Whether a filesystem failure means "the path is not there". */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Replace one file atomically: same-directory temp file, then rename over the
 * target, so a reader never sees a partial document. The temp name is unique
 * per write, so two writers cannot collide on it.
 * @param path - the file to replace (its directory is created as needed).
 * @param text - the next file content.
 */
export function writeFileAtomicSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** Parse one record document, or undefined when this build cannot use it. */
function parseEngineRecord(text: string): Map<string, LoopEngineId> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as { readonly version?: unknown; readonly engines?: unknown }
  const engines = document.engines
  if (document.version !== ENGINE_RECORD_VERSION
    || typeof engines !== 'object' || engines === null || Array.isArray(engines)) {
    return undefined
  }
  const entries = new Map<string, LoopEngineId>()
  for (const [sessionId, engine] of Object.entries(engines)) {
    // An entry this build cannot name is dropped, not fatal: the session falls
    // back to its preset, exactly as a session with no record does.
    if (isLoopEngineId(engine)) entries.set(sessionId, engine)
  }
  return entries
}

/**
 * The plugin's per-session engine record, held in memory and mirrored to one
 * atomically written JSON file.
 *
 * The file is read once, lazily, on the first lookup; every later lookup is a
 * map read, so routing never pays for filesystem I/O.
 */
export class SessionEngineStore implements EngineRecordSource {
  private entries: Map<string, LoopEngineId> | undefined

  /**
   * @param path - the record document's absolute path.
   * @param warn - diagnostic sink for a record this build cannot read.
   */
  constructor(
    private readonly path: string,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * The engine this plugin's record names for one session.
   * @param sessionId - the session to look up.
   * @returns the recorded engine, or undefined when there is no usable record.
   */
  engineOf(sessionId: SessionId): LoopEngineId | undefined {
    return this.load().get(String(sessionId))
  }

  /**
   * Record one session's engine, replacing any earlier record for it.
   *
   * The write commits before the in-memory view moves, so a caller that sees a
   * rejection knows the store still answers what it answered before.
   * @param sessionId - the session whose engine is recorded.
   * @param engine - the engine that session now runs.
   * @throws when the document could not be written; the previous file is intact.
   */
  record(sessionId: SessionId, engine: LoopEngineId): void {
    const next = new Map(this.load())
    next.set(String(sessionId), engine)
    writeFileAtomicSync(this.path, formatEngineRecord(next))
    this.entries = next
  }

  /** The in-memory record, read from disk on first use. */
  private load(): Map<string, LoopEngineId> {
    this.entries ??= this.read()
    return this.entries
  }

  /** Read the document once, degrading to an empty record. */
  private read(): Map<string, LoopEngineId> {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error: unknown) {
      // Absence is the first-run state, not trouble: report nothing.
      if (isMissing(error)) return new Map()
      return this.degrade(`could not read "${this.path}": ${String(error)}`)
    }
    return parseEngineRecord(text)
      ?? this.degrade(`"${this.path}" is not a version ${ENGINE_RECORD_VERSION} engine record`)
  }

  /**
   * Report one unusable record and answer "no record".
   *
   * The load is memoized, so this runs at most once per store — once per process
   * for a path — rather than once per lookup: a broken record costs one line, and
   * the degraded view serves every later read.
   * @param problem - what is wrong with the record, with the path.
   * @returns the empty record.
   */
  private degrade(problem: string): Map<string, LoopEngineId> {
    this.warn(`loop-engine: ${problem}; sessions without a record fall back to their agent preset`)
    return new Map()
  }
}

/**
 * Serialize one record document.
 * @param entries - the session-to-engine entries.
 * @returns the document text, newline-terminated like every file this repo writes.
 */
function formatEngineRecord(entries: Map<string, LoopEngineId>): string {
  return `${JSON.stringify({ version: ENGINE_RECORD_VERSION, engines: Object.fromEntries(entries) }, undefined, 2)}\n`
}
