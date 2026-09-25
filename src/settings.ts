/**
 * Shared loop-engine identity, namespaces, and schemas.
 *
 * Both the namespace literals and the engine/preset-id mapping live in
 * zero-import modules (`./namespace.ts`, `./agent-preset-ids.ts`) so both halves
 * agree on them: the node half brands the literal as a `SettingsNamespace` and
 * builds these schemas, while the browser half imports the same literals
 * without pulling host-side packages (`dsh-settings`, `schemastery`, `node:fs`)
 * into the client bundle (cross-plugin value imports go through cordis
 * services). This module re-exports them so node-side importers keep their
 * paths.
 *
 * The two live schema families exist because one build serves two harness
 * generations: the 0.1.5 line addresses a settings SECTION registered by a
 * provider under a namespace string ({@link LOOP_ENGINE_SETTINGS_SCHEMA} via
 * {@link loopEngineSettingsNamespace}), while the 0.1.7 line makes the plugin's
 * two live fields profile-backed Config entries
 * ({@link LOOP_ENGINE_ENGINE_SCHEMA} / {@link LOOP_ENGINE_SHOW_IN_COMPOSER_SCHEMA}).
 * Which family a running plugin builds is decided by `./compat.ts`
 * (`LEGACY_HARNESS`) in `./index.ts`.
 *
 * @module dsh-loop-engine/settings
 */

import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from './namespace.ts'
import { LOOP_ENGINE_IDS } from './agent-preset-ids.ts'
import type { LoopEngineId } from './agent-preset-ids.ts'

export { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL, LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from './namespace.ts'
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
 * Schema of the loop engine settings section, as the 0.1.5 line's settings host
 * consumes it. The engine union derives from {@link LOOP_ENGINE_IDS}, so adding
 * an engine there also admits it here.
 */
export const LOOP_ENGINE_SETTINGS_SCHEMA: z<LoopEngineSettings> = z.object({
  engine: z.union(LOOP_ENGINE_IDS.map(id => z.const(id))).default('in-process'),
  showInComposer: z.boolean().default(true),
})

/** The 0.1.5-line namespace branded as a settings namespace on the node side. */
/* v8 ignore start -- only the 0.1.5 branch of apply() calls this; exercised by vitest.config.compat015.ts */
export function loopEngineSettingsNamespace(): SettingsNamespace {
  return LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL as SettingsNamespace
}
/* v8 ignore stop */

/**
 * Declare a schema profile-backed by applying `.volatile()` when the running
 * schemastery provides it. Only the 0.1.7 line's schemastery (3.18.4) has
 * `.volatile()`; the 0.1.5 line ships 3.18.1 without it. The 0.1.5 line never
 * composes these live fields (its plugin uses {@link LOOP_ENGINE_SETTINGS_SCHEMA}
 * instead), but the module still evaluates this declaration at load on both
 * generations — so a missing `.volatile()` degrades to the plain schema rather
 * than throwing.
 * @param schema - the field schema to mark volatile.
 * @returns the volatile schema when the running schemastery supports it, else `schema`.
 */
/* v8 ignore start -- the fallback arm runs only on the 0.1.5 schemastery, exercised by vitest.config.compat015.ts */
function withVolatile<S extends { volatile: () => unknown }>(schema: S): ReturnType<S['volatile']> {
  const volatile = (schema as { volatile?: () => ReturnType<S['volatile']> }).volatile
  return volatile === undefined
    ? schema as unknown as ReturnType<S['volatile']>
    : volatile.call(schema)
}
/* v8 ignore stop */

/**
 * Live Config field schema for the default engine (0.1.7 line). `.volatile()`
 * declares it profile-backed: the settings shell projects it as a form field,
 * and a committed edit reaches the running plugin through the live Config
 * reference. The engine union derives from {@link LOOP_ENGINE_IDS}, so adding
 * an engine there admits it here too.
 */
export const LOOP_ENGINE_ENGINE_SCHEMA = withVolatile(
  z.union(LOOP_ENGINE_IDS.map(id => z.const(id))).default('in-process'),
)

/** Live Config field schema for the composer picker toggle (0.1.7 line). */
export const LOOP_ENGINE_SHOW_IN_COMPOSER_SCHEMA = withVolatile(z.boolean().default(true))
