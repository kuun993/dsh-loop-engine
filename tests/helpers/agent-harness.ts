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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/** A loop class as the specs construct it: `new Loop(ctx, config)`. */
type LoopCtor = new (ctx: Context, config: never) => unknown

/** How the booted context obtains a subprocess runtime, when its engine needs one. */
export type SubprocessStrategy =
  /** Mount the real local runtime (Claude Code, Pi). */
  | 'runtime'
  /** Provide a bare stub, for an engine that only needs the service to exist (Kimi). */
  | 'stub'
  /** Provide nothing: the engine never touches subprocess (Codex). */
  | 'none'

/** Wrap one engine's loop class as the Cordis plugin a spec mounts. */
export function loopPluginFor(ctor: LoopCtor, inject: readonly string[]) {
  return {
    inject: [...inject],
    apply: (ctx: Context, config: Record<string, unknown>): void => {
      void new (ctor as new (ctx: Context, config: unknown) => unknown)(ctx, config)
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
