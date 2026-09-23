/**
 * Shared loop-engine identity, namespace, and schema.
 *
 * Both the namespace literal and the engine/preset-id mapping live in
 * zero-import modules (`./namespace.ts`, `./agent-preset-ids.ts`) so both halves
 * agree on them: the node half brands the literal as a `SettingsNamespace` and
 * builds this schema, while the browser half imports the same literals without
 * pulling host-side packages (`dsh-settings`, `schemastery`, `node:fs`) into the
 * client bundle (cross-plugin value imports go through cordis services, and
 * `settings-scope.ts` follows the same discipline). This module re-exports them
 * so node-side importers keep their paths.
 *
 * @module dsh-loop-engine/settings
 */

import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from './namespace.ts'
import { LOOP_ENGINE_IDS } from './agent-preset-ids.ts'
import type { LoopEngineId } from './agent-preset-ids.ts'

export { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from './namespace.ts'
export {
  HOSTED_ENGINE_IDS, HOSTED_PRESET_PREFIX, LOOP_ENGINE_IDS, SOURCE_PRESET_ID,
  engineOfPreset, enginePresetId,
} from './agent-preset-ids.ts'
export type { HostedEngineId, LoopEngineId } from './agent-preset-ids.ts'

/** Stored and composed loop engine selection. */
export interface LoopEngineSettings {
  /** The engine NEW sessions are created on; the engine a given session runs is the plugin's own per-session record. */
  engine: LoopEngineId
  /** Whether the composer's loop engine picker is shown on the chat page. */
  showInComposer: boolean
}

/**
 * Schema of the loop engine settings section. The engine union derives from
 * {@link LOOP_ENGINE_IDS}, so adding an engine there also admits it here.
 */
export const LOOP_ENGINE_SETTINGS_SCHEMA: z<LoopEngineSettings> = z.object({
  engine: z.union(LOOP_ENGINE_IDS.map(id => z.const(id))).default('in-process'),
  showInComposer: z.boolean().default(true),
})

/** The shared literal branded as a settings namespace on the node side. */
export function loopEngineSettingsNamespace(): SettingsNamespace {
  return LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL as SettingsNamespace
}