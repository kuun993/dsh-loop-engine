/**
 * Unit tests for Kimi's dsh-endpoint dialect: the `KIMI_MODEL_*` environment
 * entries and the dsh-protocol → Kimi provider-type translation.
 *
 * @module tests/engine-kimi/model-handover
 */

import { describe, expect, it } from 'vitest'
import { kimiModelEnv } from '../../src/engine-kimi/model-handover.ts'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'

function handover(overrides: Partial<DshModelHandover> = {}): DshModelHandover {
  return {
    provider: 'meicloud',
    model: 'deepseek-flash',
    baseURL: 'https://ai.example.com/litellm',
    api: 'anthropic-messages',
    apiKey: 'sk-secret',
    ...overrides,
  }
}

describe('kimiModelEnv', () => {
  it('names the model, base URL, and credential, and maps Anthropic Messages to kimi\'s `anthropic`', () => {
    expect(kimiModelEnv(handover())).toEqual({
      KIMI_MODEL_NAME: 'deepseek-flash',
      KIMI_MODEL_API_KEY: 'sk-secret',
      KIMI_MODEL_BASE_URL: 'https://ai.example.com/litellm',
      KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
    })
  })

  it('maps both OpenAI-shaped protocols to kimi\'s `openai`', () => {
    expect(kimiModelEnv(handover({ api: 'openai-completions' })).KIMI_MODEL_PROVIDER_TYPE).toBe('openai')
    expect(kimiModelEnv(handover({ api: 'openai-responses' })).KIMI_MODEL_PROVIDER_TYPE).toBe('openai')
  })

  it('omits the provider type for a protocol kimi cannot express, leaving kimi its own default', () => {
    const env = kimiModelEnv(handover({ api: 'bespoke-wire' }))
    expect(env).toEqual({
      KIMI_MODEL_NAME: 'deepseek-flash',
      KIMI_MODEL_API_KEY: 'sk-secret',
      KIMI_MODEL_BASE_URL: 'https://ai.example.com/litellm',
    })
    expect('KIMI_MODEL_PROVIDER_TYPE' in env).toBe(false)
  })

  it('still hands the endpoint over when dsh named no protocol, omitting only the provider type', () => {
    const env = kimiModelEnv(handover({ api: undefined }))
    expect(env).toEqual({
      KIMI_MODEL_NAME: 'deepseek-flash',
      KIMI_MODEL_API_KEY: 'sk-secret',
      KIMI_MODEL_BASE_URL: 'https://ai.example.com/litellm',
    })
    expect('KIMI_MODEL_PROVIDER_TYPE' in env).toBe(false)
  })
})
