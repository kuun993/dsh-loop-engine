/**
 * Thread lifecycle management for the codex app-server. Wraps a codex thread
 * and its turn-level streaming, producing dsh-native events from the
 * app-server's JSON-RPC notifications.
 *
 * @module dsh-loop-engine/engine-codex/appserver/thread
 */
/** Wraps one codex thread and its streaming turns. */
export class AppServerThread {
    client;
    threadId;
    constructor(client, threadId) {
        this.client = client;
        this.threadId = threadId;
    }
    /** Create a new thread on the app-server. */
    static async create(client, params) {
        const result = await client.threadStart(params);
        return new AppServerThread(client, result.thread.id);
    }
    /**
     * Start a turn and stream its events as an async generator.
     * The generator ends when the turn completes or an error occurs.
     */
    async *turn(input, options) {
        const { signal, params } = options;
        const queue = [];
        const earlyNotifications = [];
        let resolve;
        let done = false;
        let turnError;
        let turnId;
        const notificationHandler = (method, rawParams) => {
            /* v8 ignore start -- defensive guards: done flag and threadId filter */
            if (done)
                return;
            const params = rawParams;
            if (params.threadId !== this.threadId)
                return;
            /* v8 ignore stop */
            if (turnId === undefined) {
                earlyNotifications.push([method, rawParams]);
                return;
            }
            let event;
            switch (method) {
                case 'item/started': {
                    const p = params;
                    if (p.turnId !== turnId)
                        return;
                    event = { kind: 'item-started', itemType: p.item.type, itemId: p.item.id };
                    break;
                }
                case 'item/agentMessage/delta': {
                    const p = params;
                    if (p.turnId !== turnId)
                        return;
                    event = { kind: 'agent-delta', itemId: p.itemId, delta: p.delta };
                    break;
                }
                case 'item/reasoning/summaryTextDelta': {
                    const p = params;
                    if (p.turnId !== turnId)
                        return;
                    event = { kind: 'reasoning-summary-delta', itemId: p.itemId, delta: p.delta, summaryIndex: p.summaryIndex };
                    break;
                }
                case 'item/reasoning/textDelta': {
                    const p = params;
                    if (p.turnId !== turnId)
                        return;
                    event = { kind: 'reasoning-text-delta', itemId: p.itemId, delta: p.delta, contentIndex: p.contentIndex };
                    break;
                }
                case 'item/plan/delta': {
                    const p = params;
                    if (p.turnId !== turnId)
                        return;
                    event = { kind: 'plan-delta', itemId: p.itemId, delta: p.delta };
                    break;
                }
                case 'item/completed': {
                    const p = params;
                    if (p.turnId !== turnId)
                        return;
                    event = { kind: 'item-completed', item: p.item };
                    break;
                }
                case 'turn/completed': {
                    const p = params;
                    /* v8 ignore start -- defensive filter for turn/completed from other threads */
                    if (p.threadId !== this.threadId)
                        return;
                    /* v8 ignore stop */
                    event = { kind: 'turn-completed', turn: p.turn };
                    done = true;
                    break;
                }
                case 'thread/tokenUsage/updated': {
                    const p = params;
                    if (p.turnId !== turnId)
                        return;
                    event = { kind: 'token-usage', usage: p.tokenUsage };
                    break;
                }
                case 'error': {
                    const p = params;
                    if (p.turnId !== turnId)
                        return;
                    event = { kind: 'error', error: p.error, willRetry: p.willRetry };
                    done = true;
                    turnError = new Error(p.error.message);
                    break;
                }
            }
            /* v8 ignore start -- resolve wakes the generator; only fires when the generator is awaiting */
            if (event) {
                queue.push(event);
                resolve?.();
            }
            /* v8 ignore stop */
        };
        // Subscribe before turn/start: the server may emit the first deltas before
        // its JSON-RPC response reaches this client.
        this.client.onNotification(notificationHandler);
        let turnResult;
        try {
            turnResult = await this.client.turnStart({
                threadId: this.threadId,
                input,
                ...params,
            });
        }
        catch (error) {
            this.client.onNotification(noopNotificationHandler);
            throw error;
        }
        turnId = turnResult.turn.id;
        for (const [method, rawParams] of earlyNotifications)
            notificationHandler(method, rawParams);
        earlyNotifications.length = 0;
        yield { kind: 'turn-started', turnId };
        // Handle abort signal — propagate the abort reason so the caller sees the
        // AgentCancelCause rather than a generic error.
        const abortHandler = () => {
            /* v8 ignore start -- abort handler only fires when the turn is not already done */
            if (!done) {
                done = true;
                turnError = signal?.reason instanceof Error ? signal.reason : new Error('turn aborted');
                // Try to interrupt the turn
                void this.client.turnInterrupt({ threadId: this.threadId, turnId }).catch(() => { });
            }
            /* v8 ignore stop */
            resolve?.();
        };
        signal?.addEventListener('abort', abortHandler, { once: true });
        try {
            while (true) {
                if (done && queue.length === 0)
                    break;
                if (queue.length > 0) {
                    yield queue.shift();
                }
                else {
                    /* v8 ignore start -- the resolve callback is a fire-and-forget promise constructor */
                    await new Promise((r) => { resolve = r; });
                    /* v8 ignore stop */
                    resolve = undefined;
                }
            }
            if (turnError)
                throw turnError;
        }
        finally {
            signal?.removeEventListener('abort', abortHandler);
            // Restore the previous notification handler (or clear it)
            this.client.onNotification(noopNotificationHandler);
        }
    }
}
/** No-op notification handler used to clear the per-turn handler. */
/* v8 ignore start -- the no-op handler body is never meaningfully executed */
function noopNotificationHandler() {
    // Intentionally empty — clears the per-turn streaming handler.
}
/* v8 ignore stop */
//# sourceMappingURL=thread.js.map