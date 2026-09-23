/**
 * Provider-route placeholder suite: the one shared route label, the single model
 * entry it advertises, the display name its provider group carries, the legacy
 * labels it still recognizes, and the loud failure a real model call reaching it
 * gets.
 *
 * The entry's id is the whole point of advertising one at all: the web model
 * menu resolves a session's `(provider, model)` against the catalog by
 * `model.id` (`packages/client/ui-model-selection/src/client/ModelSelect.tsx`
 * `choices`/`selectedIndex`), and a hosted engine logs its own model label into
 * the session's `request/header` — so the id has to be the label every engine
 * logs, or the seat renders the raw `provider/model` string instead.
 * @module tests/provider-route
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  HOSTED_DEFAULT_MODEL,
  HOSTED_ENGINE_IDS,
  HOSTED_ROUTE_LABEL,
  HOSTED_ROUTE_NAME,
} from '../src/agent-preset-ids.ts'
import { HostedEngineRouteAdapter, hostedRouteLabelOf, isHostedProviderRoute } from '../src/provider-route.ts'

describe('HOSTED_ROUTE_LABEL', () => {
  it('is the ASCII wire label every hosted engine logs', () => {
    // ASCII, non-empty, and different from every engine id: it is written into
    // each session's `request/header` and compared by the host, so it may not
    // collide with a provider a deployment composes.
    expect(HOSTED_ROUTE_LABEL).toBe('external')
    expect(HOSTED_ROUTE_NAME).toBe('external')
    expect(HOSTED_ENGINE_IDS).not.toContain(HOSTED_ROUTE_LABEL)
  })

  it('is the label every hosted engine resolves to, whatever the engine', () => {
    for (const engine of HOSTED_ENGINE_IDS) {
      expect(hostedRouteLabelOf(engine)).toBe(HOSTED_ROUTE_LABEL)
    }
  })
})

describe('isHostedProviderRoute', () => {
  it('recognizes the one registered label', () => {
    expect(isHostedProviderRoute(HOSTED_ROUTE_LABEL)).toBe(true)
  })

  it('still recognizes the per-engine labels earlier builds logged', () => {
    // A pre-existing session's header names one of these; no adapter serves
    // them any more, so recognizing them is what lets the reset guard rewrite
    // the seat before the host refuses the session's turn.
    for (const legacy of ['claude-code', 'codex', 'pi', 'kimi']) {
      expect(isHostedProviderRoute(legacy)).toBe(true)
    }
  })

  it('rejects every other provider, including a real one and the harness loop', () => {
    expect(isHostedProviderRoute('deepseek-official')).toBe(false)
    expect(isHostedProviderRoute('in-process')).toBe(false)
    expect(isHostedProviderRoute('')).toBe(false)
  })
})

describe('HostedEngineRouteAdapter', () => {
  it('serves the one route with its display name and its single default entry', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const llm = ctx.get('llm') as LlmRuntime
    const release = llm.registerAdapter([HOSTED_ROUTE_LABEL], new HostedEngineRouteAdapter())

    // Exactly one provider: four engines sharing a route means one group in the
    // model menu, named `external`, not four groups named after the engines.
    expect(llm.listProviders()).toEqual([{ id: HOSTED_ROUTE_LABEL, name: HOSTED_ROUTE_NAME }])
    // Exactly one entry: the group is what makes the route appear in the menu,
    // and the id is what a hosted session's logged label resolves to.
    await expect(llm.listModels(HOSTED_ROUTE_LABEL)).resolves.toEqual([
      { provider: HOSTED_ROUTE_LABEL, id: HOSTED_DEFAULT_MODEL, name: HOSTED_DEFAULT_MODEL },
    ])

    release()
    expect(llm.listProviders()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('fails loud when a model query reaches the placeholder', () => {
    const adapter = new HostedEngineRouteAdapter()
    const options = undefined as unknown as GenerateOptions
    expect(() => adapter.stream(options)).toThrow(LlmError)
    expect(() => adapter.stream(options)).toThrow('provider "external" is a hosted loop engine route, not a model endpoint')
    try {
      adapter.stream(options)
      expect.unreachable()
    } catch (error: unknown) {
      expect((error as LlmError).failure.code).toBe('HOSTED_ENGINE_ROUTE')
    }
  })
})
