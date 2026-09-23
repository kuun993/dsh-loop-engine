/**
 * The engine a session runs: the pure preset → engine judgement, and the one
 * read that combines the plugin's own per-session record with the durable log.
 *
 * This suite pins the two halves of the authority the whole plugin now shares.
 * `sessionEngineOf` is the fallback judgement the router routes on and the
 * plugin's Remote reports; `engineOfSession` is the read that feeds it, and it
 * must answer the plugin's own record first and the durable `agentPreset`
 * projection otherwise — not the session header (a creation fact) and not a
 * client-side listing hint (a partial cache). `engineReportOfSession` is the one
 * refinement on top of that read: with a LIVE agent the router's bookkeeping is
 * the better answer, and a record it has not adopted yet travels beside it as
 * `pending` instead of being reported as the engine the session runs. The
 * Remote's end-to-end behaviour on a real session, the router's agreement with
 * it, and a live engine switch are pinned in `tests/engine-remote.spec.ts`.
 * @module tests/engine-of-session
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  HOSTED_PRESET_PREFIX, LEGACY_HOSTED_PRESET_ID, LOOP_ENGINE_IDS, SOURCE_PRESET_ID,
  enginePresetId, hostedEngineOf, sessionEngineOf, type LoopEngineId,
} from '../src/agent-preset-ids.ts'
import { engineOfSession, engineReportOfSession } from '../src/engine-of-session.ts'
import type { EngineRecordSource } from '../src/session-engine-store.ts'

/** One session's projection snapshot, as the observation lease carries it. */
interface LeaseProjections {
  readonly values: { readonly agentPreset?: string | null }
}

/** The record of a deployment that has never switched an engine. */
const NO_RECORDS: EngineRecordSource = { engineOf: () => undefined }

/** A record naming one engine per session id, as the plugin's file would. */
function recordsFrom(entries: Readonly<Record<string, LoopEngineId>>): EngineRecordSource {
  return { engineOf: (sessionId: SessionId) => entries[String(sessionId)] }
}

/** Install a `sessionQuery` stand-in serving one fixed snapshot per session id. */
function provideQuery(
  ctx: Context,
  snapshots: Readonly<Record<string, LeaseProjections | undefined>>,
): { observeSession: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn()
  const observeSession = vi.fn(async (sessionId: SessionId) => ({
    projections: snapshots[String(sessionId)],
    [Symbol.dispose]: dispose,
  }))
  ctx.provide('sessionQuery', { observeSession })
  return { observeSession, dispose }
}

describe('sessionEngineOf', () => {
  it('names the engine of every preset this plugin authors', () => {
    for (const engine of LOOP_ENGINE_IDS) {
      expect(sessionEngineOf(enginePresetId(engine))).toEqual({ kind: 'engine', engine })
    }
  })

  it('keeps a preset the plugin does not own on the harness loop', () => {
    for (const presetId of [SOURCE_PRESET_ID, 'minimal', 'ptc', 'deployment-authored']) {
      expect(sessionEngineOf(presetId)).toEqual({ kind: 'engine', engine: 'in-process' })
    }
  })

  it('reads the pre-routing single preset id as a hosted engine, not the harness loop', () => {
    expect(LEGACY_HOSTED_PRESET_ID).toBe('loop-engine')
    expect(sessionEngineOf(LEGACY_HOSTED_PRESET_ID)).toEqual({ kind: 'legacy' })
    // The whole point of the state: it is a hosted session, but the id never
    // recorded which engine, so no surface may name one.
    expect(sessionEngineOf(LEGACY_HOSTED_PRESET_ID).kind).not.toBe('engine')
  })

  it('reads a session that records no preset as unset', () => {
    expect(sessionEngineOf(undefined)).toEqual({ kind: 'unset' })
  })

  it('reads an untyped projection value as unset, like no preset at all', () => {
    // The value crosses an untyped boundary (`SessionProjectionValues` is
    // `Record<string, unknown>`), so anything that is not a string reads as no
    // preset rather than being trusted into the mapping.
    for (const value of [42, null, false, {}, [], NaN]) {
      expect(sessionEngineOf(value)).toEqual({ kind: 'unset' })
    }
  })

  it('does not read a plugin-prefixed id that is not a hosted engine as legacy', () => {
    // `loop-engine-in-process` and `loop-engine-unknown` carry the prefix but no
    // hosted engine name; the pre-routing id is the exact `loop-engine` literal,
    // and everything else the router resolves to the harness loop.
    for (const presetId of [`${HOSTED_PRESET_PREFIX}in-process`, `${HOSTED_PRESET_PREFIX}unknown`, HOSTED_PRESET_PREFIX]) {
      expect(sessionEngineOf(presetId)).toEqual({ kind: 'engine', engine: 'in-process' })
    }
  })

  it('treats an empty string as a preset this plugin does not own, not as "unset"', () => {
    // It is a string, so it reaches the mapping: it names no hosted engine and is
    // not the legacy literal, so it is somebody's own preset as far as this
    // plugin is concerned — the harness loop, never a hosted one.
    expect(sessionEngineOf('')).toEqual({ kind: 'engine', engine: 'in-process' })
  })
})

describe('hostedEngineOf', () => {
  it('names the hosted engine of every hosted preset and no engine for in-process', () => {
    for (const engine of LOOP_ENGINE_IDS) {
      expect(hostedEngineOf(sessionEngineOf(enginePresetId(engine))))
        .toBe(engine === 'in-process' ? undefined : engine)
    }
  })

  it('answers undefined for every state the harness loop serves', () => {
    // The router's half of the judgement: a session that named no hosted engine
    // is the harness loop's, whether it said `standard`, the pre-routing id, or
    // nothing at all.
    expect(hostedEngineOf(sessionEngineOf(SOURCE_PRESET_ID))).toBeUndefined()
    expect(hostedEngineOf({ kind: 'legacy' })).toBeUndefined()
    expect(hostedEngineOf({ kind: 'unset' })).toBeUndefined()
  })
})

describe('engineOfSession', () => {
  it('reads the durable projection through the host session-query seam and releases the lease', async () => {
    const ctx = new Context()
    const query = provideQuery(ctx, { s1: { values: { agentPreset: enginePresetId('pi') } } })

    await expect(engineOfSession(ctx, SessionId('s1'), NO_RECORDS))
      .resolves.toEqual({ kind: 'engine', engine: 'pi' })
    // The same observation the host itself makes: every projection of that cut,
    // through a read-only lease released immediately.
    expect(query.observeSession).toHaveBeenCalledWith(SessionId('s1'), { projectionMode: 'all' })
    expect(query.dispose).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('reads each of the three states off the projection value', async () => {
    const ctx = new Context()
    provideQuery(ctx, {
      blank: { values: {} },
      legacy: { values: { agentPreset: LEGACY_HOSTED_PRESET_ID } },
      nul: { values: { agentPreset: null } },
      standard: { values: { agentPreset: SOURCE_PRESET_ID } },
    })

    await expect(engineOfSession(ctx, SessionId('blank'), NO_RECORDS)).resolves.toEqual({ kind: 'unset' })
    await expect(engineOfSession(ctx, SessionId('legacy'), NO_RECORDS)).resolves.toEqual({ kind: 'legacy' })
    await expect(engineOfSession(ctx, SessionId('nul'), NO_RECORDS)).resolves.toEqual({ kind: 'unset' })
    await expect(engineOfSession(ctx, SessionId('standard'), NO_RECORDS))
      .resolves.toEqual({ kind: 'engine', engine: 'in-process' })
    await ctx.fiber.dispose()
  })

  it('reads a session with no projections at all as unset and still releases the lease', async () => {
    const ctx = new Context()
    const query = provideQuery(ctx, { missing: undefined })

    await expect(engineOfSession(ctx, SessionId('missing'), NO_RECORDS)).resolves.toEqual({ kind: 'unset' })
    expect(query.dispose).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('reads a deployment that composes no session query as unset, asking nothing', async () => {
    const ctx = new Context()

    await expect(engineOfSession(ctx, SessionId('s1'), NO_RECORDS)).resolves.toEqual({ kind: 'unset' })
    await ctx.fiber.dispose()
  })

  it('lets a failing observation reject rather than reporting a state', async () => {
    // The read itself does not swallow: a broken durable read is a real failure
    // for the ROUTER, which must not silently move a session to another engine.
    // The plugin's Remote catches it for the UI's sake where it is asked
    // (`src/engine-remote.ts`, pinned in `tests/engine-remote.spec.ts`).
    const ctx = new Context()
    ctx.provide('sessionQuery', {
      observeSession: vi.fn(async () => { throw new Error('persistence is gone') }),
    })

    await expect(engineOfSession(ctx, SessionId('s1'), NO_RECORDS)).rejects.toThrow('persistence is gone')
    await ctx.fiber.dispose()
  })
})

describe("engineOfSession over the plugin's own record", () => {
  it('answers the record over every preset, asking the durable log nothing', async () => {
    const ctx = new Context()
    // The log says something else entirely: a session the plugin has moved must
    // read as the engine it was moved to, and the record is the whole answer.
    const query = provideQuery(ctx, { s1: { values: { agentPreset: SOURCE_PRESET_ID } } })

    await expect(engineOfSession(ctx, SessionId('s1'), recordsFrom({ s1: 'pi' })))
      .resolves.toEqual({ kind: 'engine', engine: 'pi' })
    // Not merely preferred — never asked: a session with a record reads
    // correctly even when its persistence is unavailable.
    expect(query.observeSession).not.toHaveBeenCalled()
    expect(query.dispose).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('answers a record for the harness loop and for the pre-routing preset id alike', async () => {
    const ctx = new Context()
    provideQuery(ctx, {
      plain: { values: { agentPreset: SOURCE_PRESET_ID } },
      legacy: { values: { agentPreset: LEGACY_HOSTED_PRESET_ID } },
    })

    await expect(engineOfSession(ctx, SessionId('plain'), recordsFrom({ plain: 'in-process' })))
      .resolves.toEqual({ kind: 'engine', engine: 'in-process' })
    // A record resolves the one state the preset could never name: the session
    // that ran an unknown hosted engine has an engine again.
    await expect(engineOfSession(ctx, SessionId('legacy'), recordsFrom({ legacy: 'kimi' })))
      .resolves.toEqual({ kind: 'engine', engine: 'kimi' })
    await ctx.fiber.dispose()
  })

  it('answers a record with no durable log to consult at all', async () => {
    const ctx = new Context()

    await expect(engineOfSession(ctx, SessionId('s1'), recordsFrom({ s1: 'codex' })))
      .resolves.toEqual({ kind: 'engine', engine: 'codex' })
    await ctx.fiber.dispose()
  })

  it('falls back to the preset for a record that does not name this session', async () => {
    const ctx = new Context()
    provideQuery(ctx, { mine: { values: { agentPreset: enginePresetId('claude-code') } } })

    await expect(engineOfSession(ctx, SessionId('mine'), recordsFrom({ other: 'pi' })))
      .resolves.toEqual({ kind: 'engine', engine: 'claude-code' })
    await ctx.fiber.dispose()
  })
})

describe('engineReportOfSession', () => {
  it('reports the live agent as the actual engine and the record as pending, reading no log', async () => {
    const ctx = new Context()
    // The durable log names a preset this plugin does not own — the answer the
    // NEXT build would take. It must not become the reported engine while the
    // session is still driven by the live pi agent.
    const query = provideQuery(ctx, { s1: { values: { agentPreset: SOURCE_PRESET_ID } } })

    await expect(engineReportOfSession(ctx, SessionId('s1'), recordsFrom({ s1: 'in-process' }), () => 'pi'))
      .resolves.toEqual({ engine: { kind: 'engine', engine: 'pi' }, pending: 'in-process' })
    // With a live agent the report is the router's bookkeeping plus the record:
    // the log cannot add a fact the record already outranks.
    expect(query.observeSession).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reports no pending engine while the record and the live agent agree', async () => {
    const ctx = new Context()
    provideQuery(ctx, {})

    const report = await engineReportOfSession(ctx, SessionId('s1'), recordsFrom({ s1: 'pi' }), () => 'pi')
    expect(report).toEqual({ engine: { kind: 'engine', engine: 'pi' } })
    // Absent, not present-and-undefined: a surface keys its "not in force yet"
    // marker off the key's existence.
    expect(Object.keys(report)).toEqual(['engine'])
    await ctx.fiber.dispose()
  })

  it('reports no pending engine for a live agent this plugin holds no record for', async () => {
    const ctx = new Context()
    provideQuery(ctx, {})

    // A session never switched has no record, so there is nothing waiting: the
    // live agent IS the answer, whichever engine built it.
    const report = await engineReportOfSession(ctx, SessionId('fresh'), NO_RECORDS, () => 'codex')
    expect(report).toEqual({ engine: { kind: 'engine', engine: 'codex' } })
    expect(Object.keys(report)).toEqual(['engine'])
    await ctx.fiber.dispose()
  })

  it('answers a session with no live agent exactly as the plain read does, and never pending', async () => {
    const ctx = new Context()
    provideQuery(ctx, { preset: { values: { agentPreset: LEGACY_HOSTED_PRESET_ID } } })

    // Nothing is running, so the record is what this session runs — the engine
    // its next build uses — and there is no second fact to report.
    const recorded = await engineReportOfSession(ctx, SessionId('cold'), recordsFrom({ cold: 'kimi' }), () => undefined)
    expect(recorded).toEqual({ engine: { kind: 'engine', engine: 'kimi' } })
    expect(Object.keys(recorded)).toEqual(['engine'])

    // The same three states the plain read answers, including the two that name
    // no engine at all.
    await expect(engineReportOfSession(ctx, SessionId('preset'), NO_RECORDS, () => undefined))
      .resolves.toEqual({ engine: { kind: 'legacy' } })
    await expect(engineReportOfSession(ctx, SessionId('unknown'), NO_RECORDS, () => undefined))
      .resolves.toEqual({ engine: { kind: 'unset' } })
    await ctx.fiber.dispose()
  })
})
