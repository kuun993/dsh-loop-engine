/**
 * Shared loop-engine identity, namespace, and schema.
 *
 * The namespace literal lives in the zero-import `./namespace.ts` so both
 * halves agree on the section name: the node half brands it through
 * `settingsNamespace()` (a runtime value), while the browser half imports the
 * same literal without pulling the host-side `dsh-settings` service into the
 * client bundle (cross-plugin value imports go through cordis services, and
 * `settings-scope.ts` follows the same discipline).
 *
 * @module dsh-loop-engine/settings
 */
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from "./namespace.js";
export { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from "./namespace.js";
/** The installed engine driving new Agent turns. */
export const LOOP_ENGINE_IDS = ['in-process', 'claude-code', 'codex', 'pi'];
/** Schema of the loop engine settings section. */
export const LOOP_ENGINE_SETTINGS_SCHEMA = z.object({
    engine: z.union([z.const('in-process'), z.const('claude-code'), z.const('codex'), z.const('pi')]).default('in-process'),
    showInComposer: z.boolean().default(true),
});
/** Brand the shared literal through the settings API on the node side. */
export function loopEngineSettingsNamespace() {
    return settingsNamespace(LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL);
}
//# sourceMappingURL=settings.js.map