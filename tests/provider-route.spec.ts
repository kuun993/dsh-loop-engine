/**
 * Provider-route placeholder suite: the engine-id → route-label map and the
 * model-less adapter that serves a hosted engine's request/header label.
 * @module tests/provider-route
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { HOSTED_PROVIDER_ROUTES, HostedEngineRouteAdapter } from '../src/provider-route.ts'
import type { PiModelEntry } from '../src/engine-pi/probe.ts'
import { LOOP_ENGINE_IDS } from '../src/settings.ts'

describe('HOSTED_PROVIDER_ROUTES', () => {
  it('covers every hosted engine id exactly once', () => {
    expect(Object.keys(HOSTED_PROVIDER_ROUTES).sort())
      .toEqual(LOOP_ENGINE_IDS.filter(id => id !== 'in-process').sort())
  })

  it('matches the provider label each driver logs into the request header', () => {
    expect(HOSTED_PROVIDER_ROUTES).toEqual({
      'claude-code': 'claude-code',
      codex: 'codex',
      pi: 'pi',
      kimi: 'kimi',
    })
  })
})

describe('HostedEngineRouteAdapter', () => {
  it('serves its label with default metadata and an empty catalog', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const llm = ctx.get('llm') as LlmRuntime
    const release = llm.registerAdapter(['kimi'], new HostedEngineRouteAdapter('kimi'))

    expect(llm.listProviders()).toEqual([{ id: 'kimi', name: 'kimi' }])
    await expect(llm.listModels('kimi')).resolves.toEqual([])

    release()
    expect(llm.listProviders()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('fails loud when a model query reaches the placeholder', () => {
    const adapter = new HostedEngineRouteAdapter('kimi')
    const options = undefined as unknown as GenerateOptions
    expect(() => adapter.stream(options)).toThrow(LlmError)
    expect(() => adapter.stream(options)).toThrow('provider "kimi" is a hosted loop engine route, not a model endpoint')
    try {
      adapter.stream(options)
      expect.unreachable()
    } catch (error: unknown) {
      expect((error as LlmError).failure.code).toBe('HOSTED_ENGINE_ROUTE')
    }
  })
})

describe('HostedEngineRouteAdapter with a model catalog source', () => {
  it('advertises the injected Pi models under the pi provider group', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const llm = ctx.get('llm') as LlmRuntime
    const catalog = (): readonly PiModelEntry[] => [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
    ]
    const release = llm.registerAdapter(
      ['pi'],
      new HostedEngineRouteAdapter('pi', { listModels: catalog }),
    )

    const models = await llm.listModels('pi')
    expect(models.map(m => m.provider)).toEqual(['pi', 'pi'])
    expect(models.map(m => m.id)).toEqual([
      'anthropic/claude-sonnet-4-6',
      'deepseek/deepseek-v4-pro',
    ])
    expect(models.map(m => m.name)).toEqual([
      'anthropic/claude-sonnet-4-6',
      'deepseek/deepseek-v4-pro',
    ])
    // A provider-group with non-empty models appears in the catalog.
    expect(llm.listProviders()).toContainEqual({ id: 'pi', name: 'pi' })

    release()
    await ctx.fiber.dispose()
  })

  it('returns an empty catalog when no source is injected', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const llm = ctx.get('llm') as LlmRuntime
    const release = llm.registerAdapter(['pi'], new HostedEngineRouteAdapter('pi'))
    await expect(llm.listModels('pi')).resolves.toEqual([])
    release()
    await ctx.fiber.dispose()
  })

  it('still fails loud when a model query reaches the placeholder', () => {
    const adapter = new HostedEngineRouteAdapter('pi', {
      listModels: () => [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
    })
    const options = undefined as unknown as GenerateOptions
    expect(() => adapter.stream(options)).toThrow('provider "pi" is a hosted loop engine route, not a model endpoint')
  })
})
