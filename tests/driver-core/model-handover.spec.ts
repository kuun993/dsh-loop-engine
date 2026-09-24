/**
 * Unit tests for the shared dsh-endpoint resolver: the provider → settings
 * address mapping read from the llm registry's directory, the defensive profile
 * read, the credential resolution (seam first, ambient environment as the
 * fallback), and the warn-once refusal path. These tests drive the seams a real
 * composition provides — the fake `llm`/`settings`/`credentials` objects stand
 * in for `ctx.llm`, `ctx.settings`, and `ctx.credentials`.
 *
 * @module tests/driver-core/model-handover
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolveModelHandover } from '../../src/driver-core/model-handover.ts'
import type { SessionModelOverride } from '../../src/driver-core/session-model.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** One registry entry mapping a provider route to a settings address. */
function address(provider: string, settingsNs: string, settingsPath: readonly string[] = ['providers', provider]) {
  return { provider, settingsNs, settingsPath }
}

/** A provider profile as `llm-pi-ai` stores it. */
function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiKeyEnv: 'MEICLOUD_API_KEY',
    api: 'anthropic-messages',
    baseURL: 'https://ai.example.com/litellm',
    ...overrides,
  }
}

/** Mount the seams a full composition provides. */
function mount(options: {
  providers?: readonly ReturnType<typeof address>[]
  section?: unknown
  /** `null` composes no settings service at all. */
  settings?: unknown
  credentials?: unknown
  directory?: unknown
} = {}): Context {
  const ctx = new Context()
  ctx.provide('llm', options.directory ?? { listConfigurableProviders: () => options.providers ?? [] })
  if (options.settings !== null) ctx.provide('settings', options.settings ?? { get: () => options.section })
  if (options.credentials !== undefined) ctx.provide('credentials', options.credentials)
  vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  return ctx
}

const OVERRIDE: SessionModelOverride = { provider: 'meicloud', model: 'deepseek-flash' }

describe('resolveModelHandover', () => {
  it('injects nothing when the session selected no real dsh model', async () => {
    const ctx = mount()
    await expect(resolveModelHandover(ctx, undefined)).resolves.toBeUndefined()
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('resolves endpoint, protocol, and credential through the host seams', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile() } },
      credentials: { resolve: (ref: string) => Promise.resolve(ref === 'MEICLOUD_API_KEY' ? { value: 'sk-secret' } : undefined) },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toEqual({
      provider: 'meicloud',
      model: 'deepseek-flash',
      baseURL: 'https://ai.example.com/litellm',
      api: 'anthropic-messages',
      apiKey: 'sk-secret',
    })
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('reads a section that IS the profile when the registry path is empty', async () => {
    const ctx = mount({
      providers: [address('deepseek-official', 'llm-deepseek', [])],
      section: profile({ provider: 'deepseek-official' }),
      credentials: { resolve: () => Promise.resolve({ value: 'sk-official' }) },
    })
    await expect(resolveModelHandover(ctx, { provider: 'deepseek-official', model: 'deepseek-chat' }))
      .resolves.toMatchObject({ apiKey: 'sk-official' })
  })

  it('falls back to the ambient environment when the credentials seam is not composed', async () => {
    process.env.DSH_LOOP_ENGINE_TEST_KEY = 'from-env'
    try {
      const ctx = mount({
        providers: [address('meicloud', 'llm-pi-ai')],
        section: { providers: { meicloud: profile({ apiKeyEnv: 'DSH_LOOP_ENGINE_TEST_KEY' }) } },
      })
      await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toMatchObject({ apiKey: 'from-env' })
    } finally {
      delete process.env.DSH_LOOP_ENGINE_TEST_KEY
    }
  })

  it('falls back to the ambient environment when the seam answers an empty value', async () => {
    process.env.DSH_LOOP_ENGINE_TEST_KEY = 'from-env'
    try {
      const ctx = mount({
        providers: [address('meicloud', 'llm-pi-ai')],
        section: { providers: { meicloud: profile({ apiKeyEnv: 'DSH_LOOP_ENGINE_TEST_KEY' }) } },
        credentials: { resolve: () => Promise.resolve({ value: '' }) },
      })
      await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toMatchObject({ apiKey: 'from-env' })
    } finally {
      delete process.env.DSH_LOOP_ENGINE_TEST_KEY
    }
  })

  it('injects nothing, and warns once, when no registry route maps the provider', async () => {
    const ctx = mount({ providers: [address('meicloud', 'llm-pi-ai')] })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(String((ctx.logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]))
      .toContain('meicloud/deepseek-flash')
  })

  it('injects nothing when the llm registry is absent', async () => {
    const ctx = new Context()
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the registry exposes no configurable-provider directory', async () => {
    const ctx = mount({ directory: {} })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the settings service is absent', async () => {
    const ctx = mount({ providers: [address('meicloud', 'llm-pi-ai')], settings: null })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the settings service exposes no read', async () => {
    const ctx = mount({ providers: [address('meicloud', 'llm-pi-ai')], settings: {} })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the registry path does not reach an object', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: {} },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the profile names no base URL', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ baseURL: undefined }) } },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the profile names no wire protocol', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ api: undefined }) } },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the profile names no credential reference', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ apiKeyEnv: undefined }) } },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when no credential resolves and the ambient environment has none', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ apiKeyEnv: 'DSH_LOOP_ENGINE_ABSENT_KEY' }) } },
      credentials: { resolve: () => Promise.resolve(undefined) },
    })
    delete process.env.DSH_LOOP_ENGINE_ABSENT_KEY
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('warns once per unresolved selection even when re-resolved every step', async () => {
    const ctx = mount({ providers: [] })
    await resolveModelHandover(ctx, OVERRIDE)
    await resolveModelHandover(ctx, OVERRIDE)
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)

    // A different model is a different reason, so it warns on its own.
    await resolveModelHandover(ctx, { provider: 'meicloud', model: 'other-model' })
    expect(ctx.logger.warn).toHaveBeenCalledTimes(2)
  })

  it('never puts the credential, or the raw profile value, in the warning text', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ apiKeyEnv: 'MEICLOUD_API_KEY' }) } },
      credentials: { resolve: () => Promise.resolve(undefined) },
    })
    delete process.env.MEICLOUD_API_KEY
    await resolveModelHandover(ctx, OVERRIDE)
    const message = String((ctx.logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0])
    expect(message).not.toContain('sk-')
    expect(message).toContain('no credential resolves')
  })
})
