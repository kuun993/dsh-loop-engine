/**
 * Loop engine settings plugin, browser half. Registers the "Loop engine"
 * page under the settings section slot once the settings shell declares it,
 * binding one store to the duplicated `agent-loop-engine` settings scope.
 * Export discipline: packages/client/AGENTS.md.
 * @module dsh-loop-engine/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type LoopEngineKey } from './locales.ts';
export type { LoopEngineSectionInjected, LoopEngineSectionProps } from './LoopEngineSection.tsx';
export type { LoopEngineBadgeInjected, LoopEngineBadgeProps } from './LoopEngineBadge.tsx';
export type { LoopEngineComposerSelectInjected, LoopEngineComposerSelectProps } from './LoopEngineComposerSelect.tsx';
export type { LoopEngineState } from './store.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The Loop engine settings page copy. */
        'settings.loop-engine': LoopEngineKey;
    }
}
/** Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply; registration depends on it through `slots.inject()`. */
export declare const inject: string[];
/**
 * Register the Loop engine section once the `settings.section` declaration is
 * on the ledger and bind its store to the duplicated settings scope.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map