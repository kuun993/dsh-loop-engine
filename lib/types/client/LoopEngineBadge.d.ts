/**
 * Session header engine badge: a read-only chip naming the loop engine that
 * drives this session. The engine is a deployment-level choice, so the chip
 * reports the same value for every session — naming what sessions run is the
 * honest affordance; the switch itself lives in the settings section.
 *
 * Styling is token-driven inline styles like the settings section (the
 * client-module bundle is esbuild-built without a CSS loader).
 * @module dsh-loop-engine/client/badge
 */
import type { JSX } from 'react';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import type { LoopEngineState } from './store.ts';
import type { en } from './locales.ts';
/** Registration-side business face for the header badge. */
export interface LoopEngineBadgeInjected {
    hooks: {
        /** Engine snapshot bound by the renderer as useSnapshot. */
        snapshot: SnapshotStore<LoopEngineState>;
    };
    /** Section copy bound to the engine dictionaries. */
    t: (key: keyof typeof en) => string;
}
/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineBadgeProps = Partial<InjectFace<LoopEngineBadgeInjected>>;
/**
 * Render the session header's loop-engine chip. Hides until the settings
 * scope settles, so the header never flashes a provisional engine.
 * @param props - composed slot props.
 * @returns the chip, or null while the engine is unknown.
 */
export declare function LoopEngineBadge(props: LoopEngineBadgeProps): JSX.Element | null;
//# sourceMappingURL=LoopEngineBadge.d.ts.map