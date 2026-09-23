/**
 * Shared mounting harness for the per-engine agent lifecycle specs.
 *
 * Each engine module is a library, not a Cordis plugin: a spec mounts it
 * through a wrapper plugin whose constructor registers the loop's agent
 * factory. The four engines differ only in that constructor, the services they
 * declare, and how they obtain a subprocess runtime — everything else about
 * booting a context is identical, so that is all this module parameterises.
 *
 * Engine-specific material (event factories, client mocks, transcript
 * assertions) deliberately stays in each spec; a helper general enough to hold
 * it would be harder to read than the duplication it removed.
 *
 * @module tests/helpers/agent-harness
 */

import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentFactory } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/** A loop class as the specs construct it: `new Loop(ctx, config)`. */
type LoopCtor = new (ctx: Context, config: never) => AgentFactory

/** How the booted context obtains a subprocess runtime, when its engine needs one. */
export type SubprocessStrategy =
  /** Mount the real local runtime (Claude Code, Pi). */
  | 'runtime'
  /** Provide a bare stub, for an engine that only needs the service to exist (Kimi). */
  | 'stub'
  /** Provide nothing: the engine never touches subprocess (Codex). */
  | 'none'

/**
 * Wrap one engine's driver as the Cordis plugin a spec mounts.
 *
 * An engine runtime is not itself a plugin: in production the router owns the
 * single AgentFactory slot and delegates to it ({@link RouterLoop}). A
 * per-engine spec wants the engine driven directly, so the wrapper does what
 * the router does for one engine — construct it, hand it the slot, and publish
 * the three prompt variables the harness loop normally contributes. The engine
 * registers its own ctx key, so `ctx.agentLoopKimi` and friends still resolve
 * exactly as they did when each engine was a service.
 */
export function loopPluginFor(ctor: LoopCtor, inject: readonly string[]) {
  return {
    inject: [...inject],
    apply: (ctx: Context, config: Record<string, unknown>): void => {
      const engine = new (ctor as new (ctx: Context, config: unknown) => AgentFactory)(ctx, config)
      // Nested under this wrapper's fiber on purpose: unloading the wrapper must
      // release the single factory slot, which is the behavior the per-engine
      // lifecycle specs assert.
      ctx.effect(() => ctx.agents.setFactory(engine), 'test-loop.setFactory()')
      ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
      ctx.systemPrompt.variable('model', context => context.agent?.options.model)
      ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
    },
  }
}

/** A plugin as {@link loopPluginFor} builds it. */
export type LoopPlugin = ReturnType<typeof loopPluginFor>

/** Boot the services every engine loop needs plus the loop plugin under test. */
export async function mountHarness(
  plugin: LoopPlugin,
  config: Record<string, unknown> = {},
  subprocess: SubprocessStrategy = 'runtime',
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  if (subprocess === 'runtime') await ctx.plugin(LocalSubprocessRuntime)
  if (subprocess === 'stub') ctx.provide('subprocess', { spawn: vi.fn() })
  await ctx.plugin(plugin, config)
  return ctx
}

/** One user text message, shaped as the drivers receive it. */
export function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
