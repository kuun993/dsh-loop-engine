/**
 * Loop engine settings section component: one dropdown choosing the agent
 * loop engine, backed by the duplicated settings scope through the inject face.
 * Changing the engine asks for confirmation first, because the switch
 * interrupts sessions still running on the previous engine.
 *
 * Styling is token-driven like the rest of the settings shell (`--dsw-*`
 * aliases), with the picker rendered through the shared `Menu` primitive and
 * the confirmation through `Modal`. The client-module bundle is esbuild-built
 * without a CSS loader, so the section shell uses token-based inline styles
 * instead of a CSS module.
 * @module dsh-loop-engine/client
 */
import { type JSX } from 'react';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import type { LoopEngineStore, LoopEngineState } from './store.ts';
import type { en } from './locales.ts';
/** Injected dependencies of {@link LoopEngineSection} (slot `inject`). */
export interface LoopEngineSectionInjected {
    /** The selection store (loaded on mount, refreshed by scope pushes). */
    controller: LoopEngineStore;
    hooks: {
        /** Section snapshot bound by the UI renderer as useSnapshot. */
        snapshot: SnapshotStore<LoopEngineState>;
    };
    /** Section copy. */
    t: (key: keyof typeof en) => string;
}
/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineSectionProps = Partial<InjectFace<LoopEngineSectionInjected>>;
/** Render the engine dropdown plus the interrupt notice and the switch confirmation. */
export declare function LoopEngineSection(props: LoopEngineSectionProps): JSX.Element;
//# sourceMappingURL=LoopEngineSection.d.ts.map