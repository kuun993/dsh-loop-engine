/**
 * Composer loop-engine picker: a compact dropdown registered at the
 * `conversation.input.right` seat, so it sits immediately left of the model
 * select in the composer's tool row. The engine is a deployment-level choice,
 * so this surface shares the same settings-backed {@link LoopEngineStore} as
 * the settings section and the header badge — a change in any one is what the
 * others show next. Switching still asks for confirmation first (it interrupts
 * sessions still running on the previous engine) and reloads the page once the
 * commit lands, matching the settings section's semantics.
 *
 * Styling is token-driven inline styles like the badge and section (the
 * client-module bundle is esbuild-built without a CSS loader).
 * @module dsh-loop-engine/client/composer
 */
import { type JSX } from 'react';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import type { LoopEngineStore, LoopEngineState } from './store.ts';
import type { en } from './locales.ts';
/** Injected dependencies of {@link LoopEngineComposerSelect} (slot `inject`). */
export interface LoopEngineComposerSelectInjected {
    /** The selection store (loaded on mount, refreshed by scope pushes). */
    controller: LoopEngineStore;
    hooks: {
        /** Engine snapshot bound by the UI renderer as useSnapshot. */
        snapshot: SnapshotStore<LoopEngineState>;
    };
    /** Composer copy bound to the loop engine dictionaries. */
    t: (key: keyof typeof en) => string;
}
/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineComposerSelectProps = Partial<InjectFace<LoopEngineComposerSelectInjected>>;
/**
 * Render the composer's loop-engine dropdown. Hides until the settings scope
 * settles, so the composer never flashes a provisional engine.
 * @param props - composed slot props.
 * @returns the picker, or null while the engine is unknown.
 */
export declare function LoopEngineComposerSelect(props: LoopEngineComposerSelectProps): JSX.Element | null;
//# sourceMappingURL=LoopEngineComposerSelect.d.ts.map