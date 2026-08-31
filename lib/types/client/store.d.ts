/**
 * Loop engine selection store: the durable settings scope is the transport,
 * and the store publishes a render-safe snapshot plus the write path.
 * @module dsh-loop-engine/client/store
 */
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client';
import { type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { LoopEngineId } from '../settings.ts';
/** State rendered by the loop engine section. */
export interface LoopEngineState {
    status: 'loading' | 'ready' | 'unavailable' | 'saving';
    engine: LoopEngineId;
    showInComposer: boolean;
    writable: boolean;
    error: string | null;
}
/** Narrow a wire section to the stored engine id and display toggle; an invalid one reads default. */
export declare function decodeLoopEngine(section: unknown): {
    engine: LoopEngineId;
    showInComposer: boolean;
} | undefined;
/** Coordinates the settings-backed loop engine selection. */
export declare class LoopEngineStore {
    private readonly scope;
    /** uSES-safe state source shared by the registered settings section. */
    readonly store: SnapshotStore<LoopEngineState>;
    private following;
    private saving;
    /**
     * @param scope - the loop engine settings namespace scope.
     */
    constructor(scope: SettingsScope<{
        engine: LoopEngineId;
        showInComposer: boolean;
    }>);
    /** Begin following the bound scope and publish its current answer. */
    load(): void;
    /**
     * Persist the selected engine. Success is judged against the snapshot the
     * write left behind, so a refused write reports error after its recovery.
     * @param engine - the engine to select for future Agent turns.
     * @returns whether the write landed.
     */
    setEngine(engine: LoopEngineId): Promise<boolean>;
    /**
     * Persist whether the composer shows the engine picker. Success is judged
     * against the snapshot the write left behind, so a refused write reports
     * error after its recovery. Unlike {@link setEngine}, landing does not reload
     * the page — the toggle only changes composer visibility.
     * @param show - whether the chat page composer reveals the engine picker.
     * @returns whether the write landed.
     */
    setShowInComposer(show: boolean): Promise<boolean>;
    /** Stop following the scope. */
    dispose(): void;
    private derive;
}
//# sourceMappingURL=store.d.ts.map