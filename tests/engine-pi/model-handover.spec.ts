/**
 * Unit tests for Pi's dsh-endpoint dialect: the plugin-owned agent directory and
 * the `models.json` it materializes, which is what lets `PI_CODING_AGENT_DIR`
 * point a `pi --mode rpc` child at a dsh endpoint without touching `~/.pi`.
 *
 * @module tests/engine-pi/model-handover
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { piAgentDir } from '../../src/engine-pi/model-handover.ts'
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

describe('piAgentDir', () => {
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
