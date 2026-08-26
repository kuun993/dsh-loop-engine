/**
 * Regression probe for runtime engine-switch symmetry:
 * a committed settings change must mount/unmount the Claude Code factory in
 * the SAME process, not only rewrite the patch file.
 * @module tests/direction-bug
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { apply } from '../src/index.ts'
import { currentEngineOf } from '../src/patch-manager.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../src/namespace.ts'

const NS = LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, doc?: Record<string, unknown>) {
    super(ctx)
    this.doc = structuredClone(doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function boot(doc?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = ctx.plugin(MemorySettings, doc)
  await fiber
  return { ctx, provider: ctx.get('settings') as MemorySettings, fiber }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-direction-'))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/** Actively wait until a scope-settled condition holds or the budget runs out. */
async function waitFor(condition: () => boolean, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(condition()).toBe(true)
}

describe('runtime switch direction symmetry', () => {
  it('in-process -> claude-code mounts the Claude Code loop and its factory', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '# seed\n') // file = in-process
    const { ctx, fiber } = await boot({})
    apply(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 30))

    // No claude factory before the switch.
    expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()

    // UI switch: in-process -> claude-code.
    await ctx.settings.update(NS, { engine: 'claude-code' })

    // The plugin fiber mounts asynchronously after the synchronous onChange.
    await waitFor(() => ctx.get('agentLoopClaudeCode') !== undefined)
    const text = await readFile(path, 'utf8')
    expect(currentEngineOf(text)).toBe('claude-code')
    console.log('SWITCH A: claude loop mounted =', ctx.get('agentLoopClaudeCode') !== undefined)

    await fiber.dispose()
  })

  it('claude-code -> in-process unmounts the Claude Code loop so the base factory regains the slot', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    // file = claude-code
    await writeFile(path, ['# seed\n', '', '# -- dsh-loop-engine managed block: claude-code --', '- id: agent-loop', '  disabled: true', '# -- /dsh-loop-engine managed block --', ''].join('\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    apply(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 30))
    console.log('SWITCH B: initial claude loop =', ctx.get('agentLoopClaudeCode') !== undefined)

    // UI switch: claude-code -> in-process.
    await ctx.settings.update(NS, { engine: 'in-process' })
    await waitFor(() => ctx.get('agentLoopClaudeCode') === undefined)

    const text = await readFile(path, 'utf8')
    expect(currentEngineOf(text)).toBe('in-process')
    expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()
    console.log('SWITCH B: claude loop after switch =', ctx.get('agentLoopClaudeCode') !== undefined)

    await fiber.dispose()
  })

  it('in-process -> codex mounts the Codex loop and codex -> in-process unmounts it', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '# seed\n') // file = in-process
    const { ctx, fiber } = await boot({})
    apply(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 30))

    // No codex factory before the switch.
    expect(ctx.get('agentLoopCodex')).toBeUndefined()

    // UI switch: in-process -> codex.
    await ctx.settings.update(NS, { engine: 'codex' })
    await waitFor(() => ctx.get('agentLoopCodex') !== undefined)
    expect(currentEngineOf(await readFile(path, 'utf8'))).toBe('codex')

    // UI switch: codex -> in-process.
    await ctx.settings.update(NS, { engine: 'in-process' })
    await waitFor(() => ctx.get('agentLoopCodex') === undefined)
    expect(currentEngineOf(await readFile(path, 'utf8'))).toBe('in-process')

    await fiber.dispose()
  })
})