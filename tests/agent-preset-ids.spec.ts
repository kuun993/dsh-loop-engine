/**
 * The zero-import contract of the shared engine ↔ preset-id mapping.
 *
 * `src/agent-preset-ids.ts` is imported by the browser half, so a runtime import
 * added there would follow the mapping into the client bundle — and any host
 * package it named (`dsh-settings`, `schemastery`, `node:fs`) with it. The
 * mapping's behaviour is pinned by `tests/preset.spec.ts`; what is pinned here is
 * the module's shape: no imports at all, and the node-side modules re-exporting
 * the very same bindings rather than restating them.
 * @module tests/agent-preset-ids
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  HOSTED_ENGINE_IDS, HOSTED_PRESET_PREFIX, LEGACY_HOSTED_PRESET_ID, LOOP_ENGINE_IDS,
  LOOP_ENGINE_REFUSAL_CODES, SOURCE_PRESET_ID, engineOfPreset, enginePresetId, hostedEngineOf,
  isHostedEngine, isLoopEngineRefusalCode, sessionEngineOf,
} from '../src/agent-preset-ids.ts'
import * as preset from '../src/preset.ts'
import * as settings from '../src/settings.ts'

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

describe('agent-preset-ids is zero-import', () => {
  it('imports nothing, so the browser half can carry the mapping', async () => {
    const text = await source('../src/agent-preset-ids.ts')
    expect(text).not.toMatch(/^\s*import\b/m)
    expect(text).not.toMatch(/\brequire\s*\(/)
  })

  it('keeps the id roster in one place', () => {
    expect(HOSTED_ENGINE_IDS).toEqual(LOOP_ENGINE_IDS.filter(id => id !== 'in-process'))
    expect(SOURCE_PRESET_ID).toBe('standard')
    expect(HOSTED_PRESET_PREFIX).toBe('loop-engine-')
    expect(enginePresetId('in-process')).toBe(SOURCE_PRESET_ID)
  })

  it('keeps the pre-routing preset id out of both sides of the mapping', () => {
    // A hosted session whose engine was never recorded: not one of this plugin's
    // engine presets (so the router keeps reading it as the harness loop), and
    // not repeatable by the forward mapping — the id is only ever a session's
    // recorded history, and the client half is the only reader that tells it
    // apart from an unowned preset.
    expect(LEGACY_HOSTED_PRESET_ID).toBe('loop-engine')
    expect(LEGACY_HOSTED_PRESET_ID).toBe(HOSTED_PRESET_PREFIX.slice(0, -1))
    expect(LOOP_ENGINE_IDS.map(enginePresetId)).not.toContain(LEGACY_HOSTED_PRESET_ID)
    expect(engineOfPreset(LEGACY_HOSTED_PRESET_ID)).toBeUndefined()
  })

  it('classifies an engine as hosted without naming one of them', () => {
    // The judgement the two surfaces that say "the model is the engine's own
    // business" share (`src/client/LoopEngineSection.tsx`,
    // `src/client/LoopEngineComposerSelect.tsx`): every hosted engine answers the
    // same way, and an engine nobody has answered for yet is not hosted — a
    // surface that does not know says nothing rather than claiming the wrong
    // half.
    for (const id of HOSTED_ENGINE_IDS) expect(isHostedEngine(id)).toBe(true)
    expect(isHostedEngine('in-process')).toBe(false)
    expect(isHostedEngine(undefined)).toBe(false)
  })

  it('classifies a refusal code, so the browser half can normalize an unknown one away', () => {
    // Every code the host can send is a code this build knows; anything else —
    // a code a newer host added, a hand-written answer — is NOT one, and the
    // boundary keeps that distinction so the host's own sentence stays readable
    // instead of the answer failing (`src/client/session-engine.ts`
    // `parseSelectResult`).
    for (const code of LOOP_ENGINE_REFUSAL_CODES) expect(isLoopEngineRefusalCode(code)).toBe(true)
    expect(isLoopEngineRefusalCode('session-running')).toBe(false)
    expect(isLoopEngineRefusalCode('')).toBe(false)
    expect(isLoopEngineRefusalCode(undefined)).toBe(false)
    expect(isLoopEngineRefusalCode(7)).toBe(false)
  })
})

describe('the node-side modules re-export that one mapping', () => {
  it('re-exports the same bindings from preset.ts', () => {
    expect(preset.enginePresetId).toBe(enginePresetId)
    expect(preset.engineOfPreset).toBe(engineOfPreset)
    expect(preset.sessionEngineOf).toBe(sessionEngineOf)
    expect(preset.hostedEngineOf).toBe(hostedEngineOf)
    expect(preset.HOSTED_PRESET_PREFIX).toBe(HOSTED_PRESET_PREFIX)
    expect(preset.SOURCE_PRESET_ID).toBe(SOURCE_PRESET_ID)
  })

  it('re-exports the same bindings from settings.ts', () => {
    expect(settings.enginePresetId).toBe(enginePresetId)
    expect(settings.engineOfPreset).toBe(engineOfPreset)
    expect(settings.LOOP_ENGINE_IDS).toBe(LOOP_ENGINE_IDS)
    expect(settings.HOSTED_ENGINE_IDS).toBe(HOSTED_ENGINE_IDS)
  })
})
