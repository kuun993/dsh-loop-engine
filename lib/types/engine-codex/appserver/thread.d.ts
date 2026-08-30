/**
 * Thread lifecycle management for the codex app-server. Wraps a codex thread
 * and its turn-level streaming, producing dsh-native events from the
 * app-server's JSON-RPC notifications.
 *
 * @module dsh-loop-engine/engine-codex/appserver/thread
 */
import type { AppServerClient } from './client.ts';
import type { ErrorNotification, ItemCompletedNotification, ThreadStartParams, ThreadTokenUsageUpdatedNotification, TurnCompletedNotification, TurnInput } from './types.ts';
/** An event yielded during a turn's streaming. */
export type AppServerEvent = {
    readonly kind: 'turn-started';
    readonly turnId: string;
} | {
    readonly kind: 'item-started';
    readonly itemType: string;
    readonly itemId: string;
} | {
    readonly kind: 'agent-delta';
    readonly itemId: string;
    readonly delta: string;
} | {
    readonly kind: 'reasoning-summary-delta';
    readonly itemId: string;
    readonly delta: string;
    readonly summaryIndex: number;
} | {
    readonly kind: 'reasoning-text-delta';
    readonly itemId: string;
    readonly delta: string;
    readonly contentIndex: number;
} | {
    readonly kind: 'plan-delta';
    readonly itemId: string;
    readonly delta: string;
} | {
    readonly kind: 'item-completed';
    readonly item: ItemCompletedNotification['item'];
} | {
    readonly kind: 'turn-completed';
    readonly turn: TurnCompletedNotification['turn'];
} | {
    readonly kind: 'token-usage';
    readonly usage: ThreadTokenUsageUpdatedNotification['tokenUsage'];
} | {
    readonly kind: 'error';
    readonly error: ErrorNotification['error'];
    readonly willRetry: boolean;
};
/** Wraps one codex thread and its streaming turns. */
export declare class AppServerThread {
    private readonly client;
    readonly threadId: string;
    constructor(client: AppServerClient, threadId: string);
    /** Create a new thread on the app-server. */
    static create(client: AppServerClient, params: ThreadStartParams): Promise<AppServerThread>;
    /**
     * Start a turn and stream its events as an async generator.
     * The generator ends when the turn completes or an error occurs.
     */
    turn(input: readonly TurnInput[], options: {
        signal?: AbortSignal;
        params?: Partial<Omit<import('./types.ts').TurnStartParams, 'threadId' | 'input'>>;
    }): AsyncGenerator<AppServerEvent, void, void>;
}
//# sourceMappingURL=thread.d.ts.map