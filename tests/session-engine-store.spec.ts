/**
 * The plugin's own per-session engine record: what it reads, what it writes, and
 * what a broken file costs.
 *
 * The record is the authority the router and the Remote share, and it lives in a
 * file the plugin owns, so this suite pins the storage contract directly: one
 * atomically replaced document, a write that either commits or leaves both the
 * file and the in-memory view exactly as they were, and a degraded read that
 * answers "no record" (with ONE diagnostic) instead of failing a session.
 *
 * `node:fs` is partially mocked so the atomic write's temp path is observable
 * and a single rename can be made to fail, which is how the "a failed write
 * never damages the previous document" promise is pinned on every host.
 *
 * @module tests/session-engine-store
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  ENGINE_RECORD_DIR,
  ENGINE_RECORD_FILE,
  ENGINE_RECORD_VERSION,
  resolveEngineRecordPath,
  SessionEngineStore,
} from '../src/session-engine-store.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => actual.readFileSync(...args)),
    renameSync: vi.fn((...args: Parameters<typeof actual.renameSync>) => actual.renameSync(...args)),
    writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => actual.writeFileSync(...args)),
  }
})

const mockedReadFileSync = vi.mocked(readFileSync)
const mockedRenameSync = vi.mocked(renameSync)
const mockedWriteFileSync = vi.mocked(writeFileSync)

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-record-'))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/** One record file path inside a fresh, existing temp directory. */
async function recordPath(): Promise<string> {
  const dir = join(await tempDir(), 'records')
  await mkdir(dir, { recursive: true })
  return join(dir, ENGINE_RECORD_FILE)
}

/** Leftover atomic-write temp files beside one record document. */
async function tempLeftovers(path: string): Promise<string[]> {
  return (await readdir(dirname(path))).filter(name => name.includes('.tmp-'))
}

describe('resolveEngineRecordPath', () => {
  it('names engines.json in .loop-engine under the harness home', () => {
    vi.stubEnv('DSH_HOME', 'D:\\elsewhere\\dsh')
    expect(resolveEngineRecordPath()).toBe(join(resolveDshHome(), ENGINE_RECORD_DIR, ENGINE_RECORD_FILE))
  })
})

describe('SessionEngineStore', () => {
  it('answers nothing, and reports nothing, when there is no record file yet', async () => {
    const path = await recordPath()
    const warn = vi.fn()
    const store = new SessionEngineStore(path, warn)

    expect(store.engineOf(SessionId('s1'))).toBeUndefined()
    // Absence is the first-run state: a session the plugin has never switched
    // must cost the log one silent read, not a diagnostic.
    expect(warn).not.toHaveBeenCalled()
  })

  it('records a session and answers it again in a later process', async () => {
    const path = await recordPath()
    const store = new SessionEngineStore(path, vi.fn())

    store.record(SessionId('s1'), 'pi')
    store.record(SessionId('s2'), 'kimi')
    expect(store.engineOf(SessionId('s1'))).toBe('pi')
    // Re-recording a session replaces its engine rather than adding a second.
    store.record(SessionId('s1'), 'codex')
    expect(store.engineOf(SessionId('s1'))).toBe('codex')

    // A fresh instance is what a restarted host sees: the record must outlive
    // the process, which is the whole point of not keeping it in memory.
    const restarted = new SessionEngineStore(path, vi.fn())
    expect(restarted.engineOf(SessionId('s1'))).toBe('codex')
    expect(restarted.engineOf(SessionId('s2'))).toBe('kimi')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: ENGINE_RECORD_VERSION,
      engines: { s1: 'codex', s2: 'kimi' },
    })
  })

  it('replaces the document atomically, through a sibling temp file', async () => {
    const path = await recordPath()
    new SessionEngineStore(path, vi.fn()).record(SessionId('s1'), 'pi')

    const written = String(mockedWriteFileSync.mock.calls.at(-1)?.[0])
    expect(written).toContain('.tmp-')
    expect(join(written, '..')).toBe(join(path, '..'))
    // The rename is what makes the replacement visible, and it happens only
    // after the temp file holds the complete document.
    expect(mockedRenameSync.mock.calls.at(-1)).toEqual([written, path])
    expect(await tempLeftovers(path)).toEqual([])
  })

  it('leaves the previous document and view intact when the write fails', async () => {
    const path = await recordPath()
    const warn = vi.fn()
    const store = new SessionEngineStore(path, warn)
    store.record(SessionId('s1'), 'pi')

    mockedRenameSync.mockImplementationOnce(() => { throw new Error('read-only home') })
    expect(() => { store.record(SessionId('s1'), 'kimi') }).toThrow(/read-only home/)

    // The session keeps the engine the file still names, in this process and in
    // the next one: a failed switch must not half-apply.
    expect(store.engineOf(SessionId('s1'))).toBe('pi')
    expect(new SessionEngineStore(path, vi.fn()).engineOf(SessionId('s1'))).toBe('pi')
  })

  it('degrades to no record, once, for a document it cannot parse', async () => {
    const path = await recordPath()
    const warn = vi.fn()
    const store = new SessionEngineStore(path, warn)
    await writeFile(path, '{ this is not json', 'utf8')

    expect(store.engineOf(SessionId('s1'))).toBeUndefined()
    expect(store.engineOf(SessionId('s2'))).toBeUndefined()
    // One line per store lifetime: the document is read once, so a broken file
    // cannot flood the log of a deployment whose sessions are asked about
    // constantly.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessions without a record fall back to their agent preset'))
  })

  it('degrades for every document shape this build does not own', async () => {
    const shapes = [
      '[]',
      'null',
      '7',
      '"a string"',
      '{}',
      '{"version":2,"engines":{}}',
      '{"version":1}',
      '{"version":1,"engines":null}',
      '{"version":1,"engines":[]}',
    ]
    for (const shape of shapes) {
      const path = await recordPath()
      const warn = vi.fn()
      await writeFile(path, shape, 'utf8')
      expect(new SessionEngineStore(path, warn).engineOf(SessionId('s1'))).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps every entry this build can name and drops the ones it cannot', async () => {
    const path = await recordPath()
    const warn = vi.fn()
    await writeFile(path, JSON.stringify({
      version: ENGINE_RECORD_VERSION,
      engines: { good: 'pi', unknown: 'gpt', numeric: 7 },
    }), 'utf8')

    const store = new SessionEngineStore(path, warn)
    expect(store.engineOf(SessionId('good'))).toBe('pi')
    expect(store.engineOf(SessionId('unknown'))).toBeUndefined()
    expect(store.engineOf(SessionId('numeric'))).toBeUndefined()
    // An entry naming an engine this build does not have is a record this build
    // cannot use — not a corrupt document, so nothing is degraded or reported.
    expect(warn).not.toHaveBeenCalled()
  })

  it('degrades for a file it cannot read for any reason other than absence', async () => {
    const path = await recordPath()
    const warn = vi.fn()
    mockedReadFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })

    expect(new SessionEngineStore(path, warn).engineOf(SessionId('s1'))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`could not read "${path}"`))
  })

  it('repairs a degraded record on the next write', async () => {
    const path = await recordPath()
    await writeFile(path, 'not a document', 'utf8')
    const store = new SessionEngineStore(path, vi.fn())
    expect(store.engineOf(SessionId('s1'))).toBeUndefined()

    store.record(SessionId('s1'), 'kimi')

    expect(store.engineOf(SessionId('s1'))).toBe('kimi')
    expect(new SessionEngineStore(path, vi.fn()).engineOf(SessionId('s1'))).toBe('kimi')
  })
})
