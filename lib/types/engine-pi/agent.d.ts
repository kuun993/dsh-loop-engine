/**
 * Pi loop Agent: drives one session through turn and step boundaries by
 * spawning a `pi --mode rpc` child process and speaking strict-LF JSONL over
 * stdio. The dsh session log is the sole source of truth and each step runs one
 * stateless Pi session (a fresh `new_session` + a single `prompt`), so the
 * prompt is a pure serialization of the durable history plus the assembled dsh
 * system prompt. Pi owns its tools natively but has no permission system, so
 * the whole child is sandboxed by the dsh subprocess seam and its `--tools`
 * are pruned to the resolved stance.
 *
 * @module dsh-loop-engine/engine-pi/agent
 */
import type { Agent, AgentCancelCause, AgentOptions, AgentStatus, CancelOptions, InboxTarget } from '@deepseek-ai/dsh-agent';
import { Inbox } from '@deepseek-ai/dsh-agent';
import type { Scope } from '@deepseek-ai/dsh-scope';
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './types.ts';
import { type PiSpawnCapability } from './rpc/client.ts';
/** Drives one session through turn and step boundaries on Pi. */
export declare class PiAgent implements Agent {
    private loopCtx;
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    private readonly config;
    private readonly spawn;
    private readonly bin;
    readonly inbox: Inbox;
    private phase;
    private activityDone;
    /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
    readonly scope: Scope;
    readonly ctx: Context;
    /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
    private readonly dispatch;
    /** Whether this loop instance has appended its initial/resume request anchor. */
    private requestHeaderLogged;
    /** Lazily created RPC client, reused across steps and released on scope teardown. */
    private rpc;
    /** The spawn spec the cached client was built from; a change forces a respawn. */
    private lastSpec;
    constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, config: ResolvedConfig, spawn: PiSpawnCapability, bin: string);
    /** Return the cached RPC client, respawning when the spec or process changed. */
    private rpcClient;
    get status(): AgentStatus;
    /** Commit a phase and publish its externally visible status transition. */
    private setPhase;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    /**
     * Queue a message for the next turn and wake the driver.
     * @param input - the user message to deliver.
     */
    followup(input: UserMessage): void;
    /**
     * Queue a message for the running step and wake the driver.
     * @param input - the user message to deliver.
     */
    steer(input: UserMessage): void;
    /**
     * Queue a message for the running step without waking the driver.
     * @param input - the user message to deliver.
     */
    inject(input: UserMessage): void;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    /**
     * Run a maintenance job while the agent is idle.
     * @param job - the maintenance operation, receiving the phase abort signal.
     * @returns the maintenance result.
     */
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
    /**
     * Start one driver, or latch its wake behind maintenance or an aborted
     * activity. A wake sent while idle always opens its turn boundary, even
     * when its message was cleared; only a latched replay is suppressed when
     * the queue no longer holds the wake.
     * @param wakeAfterAbort - the {@link send} classification, captured before
     *   the inbox insertion so a reentrant cancel cannot reclassify it.
     */
    private wakeDriver;
    whenIdle(): Promise<void>;
    /** Report one failure at its live boundary, then preserve it for driver containment. */
    private throwError;
    private kick;
    private preStep;
    /**
     * Scan the step's user messages for `/name` skill gestures, load each
     * matching skill, and inject the rendered skill content into the message
     * batch.  This mirrors what dsh-tool-skill does for the in-process engine.
     * @param messages - the current step's message batch.
     * @param signal - cancellation signal (aborted loads are silently dropped).
     * @returns the original batch when no skill was invoked, or an extended
     *   batch with injected skill-content messages appended.
     */
    private injectSkills;
    /**
     * Resolve the runtime permission stance for one query. Deployment-pinned
     * fields win; anything unpinned follows the session's durable dsh permission
     * knobs, re-folded per query so mid-session preset switches take effect on the
     * next step.
     * @returns the permission fields of the query spec.
     */
    private queryPermission;
    /** Open one turn before claiming its first proposed step. */
    private turn;
    /** Model label recorded in the request header for one lifecycle. */
    private modelLabel;
    /** Append the request header snapshot once per loop instance. */
    private assertRequestHeader;
    /** Build the `pi --mode rpc` argv/cwd/env for one step's child process. */
    private spawnSpec;
    /**
     * Run one Pi RPC query for the current step and map its event stream into the
     * session log. The step opens a fresh Pi session (`new_session`) and sends the
     * serialized session history as one prompt, then consumes events until the
     * agent settles. Like the Codex/Claude drivers, Pi owns its own system prompt
     * natively, so the dsh system-prompt assembly (which pulls dsh tool schemas
     * and `agent.ctx.tools`) is deliberately not run — the durable session log is
     * the sole source of model context.
     */
    private step;
    /** Append one Pi tool result to the durable log as a `tool/result` message. */
    private appendToolResult;
}
//# sourceMappingURL=agent.d.ts.map