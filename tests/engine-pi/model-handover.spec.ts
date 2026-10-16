/**
 * Unit tests for Pi's dsh-endpoint dialect: the protocol vocabulary the driver
 * judges a handover against (`resolvePiApi`), and the plugin-owned agent
 * directory with the `models.json` it materializes, which is what lets
 * `PI_CODING_AGENT_DIR` point a `pi --mode rpc` child at a dsh endpoint without
 * touching `~/.pi`.
 *
 * The judgement is its own subject because pi names wires in its OWN vocabulary
 * and refuses a provider whose `api` it has no implementation for: dsh's (or a
 * third-party plugin's) spelling of a wire it does speak has to be translated
 * before the document is written (GitHub issue #2).
 *
 * @module tests/engine-pi/model-handover
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { piAgentDir, resolvePiApi, type PiSupportedHandover } from '../../src/engine-pi/model-handover.ts'

function handover(overrides: Partial<PiSupportedHandover> = {}): PiSupportedHandover {
  return {
    provider: 'meicloud',
    model: 'deepseek-flash',
    baseURL: 'https://ai.example.com/litellm',
    api: 'anthropic-messages',
    apiKey: 'sk-secret',
    ...overrides,
  }
}

describe('resolvePiApi', () => {
  it('answers "absent" when the provider profile declared no protocol', () => {
    expect(resolvePiApi(undefined)).toEqual({ kind: 'absent' })
  })

  it('supports a protocol pi spells the same way, unchanged', () => {
    expect(resolvePiApi('openai-completions')).toEqual({ kind: 'supported', api: 'openai-completions' })
  })

  it("translates a spelling outside dsh's vocabulary into the wire pi names", () => {
    // `anthropic` is not in llm-pi-ai's vocabulary at all, so a provider plugin
    // writing it means the wire pi calls `anthropic-messages` — pi refuses the
    // raw value outright ("No API provider registered for api: anthropic").
    expect(resolvePiApi('anthropic')).toEqual({ kind: 'supported', api: 'anthropic-messages' })
  })

  it('refuses a protocol outside pi vocabulary, which pi would fail every turn on', () => {
    expect(resolvePiApi('totally-bogus-api')).toEqual({ kind: 'unsupported' })
  })
})

describe('piAgentDir', () => {
  /** The `models.json` one directory holds, as pi's provider schema reads it. */
  function modelsOf(dir: string): { providers: Record<string, { api: string }> } {
    return JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')) as { providers: Record<string, { api: string }> }
  }

  it('materializes a models.json declaring the dsh provider, protocol, and credential', () => {
    const dir = piAgentDir(handover())
    const document = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')) as {
      providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: { id: string; name: string }[] }>
    }
    expect(document).toEqual({
      providers: {
        meicloud: {
          baseUrl: 'https://ai.example.com/litellm',
          api: 'anthropic-messages',
          apiKey: 'sk-secret',
          models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }],
        },
      },
    })
  })

  it("writes the protocol under pi's own name, not the spelling the profile used", () => {
    // The regression this pins: writing dsh's raw string made pi answer
    // "No API provider registered for api: anthropic" on every turn of a
    // session that had selected a real dsh model (GitHub issue #2).
    const dir = piAgentDir(handover({ api: 'anthropic', model: 'aliased-model' }))
    expect(modelsOf(dir).providers.meicloud?.api).toBe('anthropic-messages')
  })

  it('hands back the same directory for the same endpoint, writing nothing twice', () => {
    const first = piAgentDir(handover())
    const second = piAgentDir(handover())
    expect(second).toBe(first)
    expect(existsSync(join(second, 'models.json'))).toBe(true)
  })

  it('gives a different endpoint its own directory', () => {
    const first = piAgentDir(handover())
    const second = piAgentDir(handover({ model: 'another-model' }))
    expect(second).not.toBe(first)
    expect(existsSync(join(second, 'models.json'))).toBe(true)
  })

  it('creates the directory private to the user, since it holds a credential', () => {
    const dir = piAgentDir(handover({ model: 'permissions-probe' }))
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, 'models.json')).mode & 0o777).toBe(0o600)
    } else {
      // Windows reports no POSIX mode; the assertion is the file's existence.
      expect(existsSync(join(dir, 'models.json'))).toBe(true)
    }
  })
})
