/**
 * Unit tests for Codex's dsh-endpoint dialect: the `-c` configuration overrides,
 * TOML quoting, the wire-protocol translation, and the credential environment.
 *
 * @module tests/engine-codex/model-handover
 */

import { describe, expect, it } from 'vitest'
import {
  CODEX_DSH_API_KEY_ENV,
  codexModelConfig,
} from '../../src/engine-codex/model-handover.ts'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'

function handover(overrides: Partial<DshModelHandover> = {}): DshModelHandover {
  return {
    provider: 'meicloud',
    model: 'deepseek-flash',
    baseURL: 'https://ai.example.com/litellm',
    api: 'openai-responses',
    apiKey: 'sk-secret',
    ...overrides,
  }
}

describe('codexModelConfig', () => {
  it('points codex at a plugin-owned provider with the endpoint and an env_key', () => {
    expect(codexModelConfig(handover())).toEqual({
      argv: [
        '-c', 'model_provider="dsh"',
        '-c', 'model_providers.dsh={base_url="https://ai.example.com/litellm",wire_api="responses",env_key="DSH_LOOP_ENGINE_API_KEY"}',
      ],
      env: { DSH_LOOP_ENGINE_API_KEY: 'sk-secret' },
    })
  })

  it('maps OpenAI Chat Completions to codex\'s `chat` wire', () => {
    const { argv } = codexModelConfig(handover({ api: 'openai-completions' }))
    expect(argv[3]).toContain('wire_api="chat"')
  })

  it('omits wire_api for a protocol codex does not speak, leaving codex its own default wire', () => {
    const { argv } = codexModelConfig(handover({ api: 'anthropic-messages' }))
    expect(argv[3]).not.toContain('wire_api')
    expect(argv[3]).toContain('base_url="https://ai.example.com/litellm"')
    expect(argv[3]).toContain('env_key="DSH_LOOP_ENGINE_API_KEY"')
  })

  it('escapes quotes and backslashes so the inline TOML table stays parseable', () => {
    const { argv } = codexModelConfig(handover({ baseURL: 'https://host/"odd"\\path' }))
    expect(argv[3]).toContain('base_url="https://host/\\"odd\\"\\\\path"')
  })

  it('exposes the env var name the override names', () => {
    expect(CODEX_DSH_API_KEY_ENV).toBe('DSH_LOOP_ENGINE_API_KEY')
  })
})
