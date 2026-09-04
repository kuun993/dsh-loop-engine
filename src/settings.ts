/**
 * Shared loop-engine identity, namespace, and schema.
 *
 * The namespace literal lives in the zero-import `./namespace.ts` so both
 * halves agree on the section name: the node half brands it as a
 * `SettingsNamespace`, while the browser half imports the same literal
 * without pulling the host-side `dsh-settings` service into the client
 * bundle (cross-plugin value imports go through cordis services, and
 * `settings-scope.ts` follows the same discipline).
 *
 * @module dsh-loop-engine/settings
 */

import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from './namespace.ts'

export { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from './namespace.ts'

/** The installed engine driving new Agent turns. */
export const LOOP_ENGINE_IDS = ['in-process', 'claude-code', 'codex', 'pi', 'kimi'] as const

/** Installed agent loop engine id. */
export type LoopEngineId = (typeof LOOP_ENGINE_IDS)[number]

/** Stored and composed loop engine selection. */
export interface LoopEngineSettings {
  /** The engine future Agents are created on. */
  engine: LoopEngineId
  /** Whether the composer's loop engine picker is shown on the chat page. */
  showInComposer: boolean
}

/** Schema of the loop engine settings section. */
export const LOOP_ENGINE_SETTINGS_SCHEMA: z<LoopEngineSettings> = z.object({
  engine: z.union([z.const('in-process'), z.const('claude-code'), z.const('codex'), z.const('pi'), z.const('kimi')]).default('in-process'),
  showInComposer: z.boolean().default(true),
})

/** The shared literal branded as a settings namespace on the node side. */
export function loopEngineSettingsNamespace(): SettingsNamespace {
  return LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL as SettingsNamespace
}