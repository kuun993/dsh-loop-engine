/**
 * Claude Code loop Agent: drives one session through turn and step boundaries
 * with one Claude Agent SDK query per step. Claude Code owns its prompt,
 * tools, and permissions; the durable session log remains the source of truth
 * and the query prompt is a pure serialization of it.
 *
 * @module dsh-loop-engine/engine-claude/agent
 */
import type { Agent, AgentCancelCause, AgentOptions, AgentStatus, CancelOptions, InboxTarget } from '@deepseek-ai/dsh-agent';
import { Inbox } from '@deepseek-ai/dsh-agent';
import type { Scope } from '@deepseek-ai/dsh-scope';
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './types.ts';
/** Drives one session through turn and step boundaries on Claude Code. */
export declare class ClaudeCodeAgent implements Agent {
    private loopCtx;
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    private readonly config;
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
    constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, config: ResolvedConfig);
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
     * Resolve the native permission handling for one query. A deployment-pinned
     * mode wins outright; otherwise the session's durable dsh permission knobs
     * decide per query (mid-session preset switches included): full access
     * bypasses native checks, an `ask` policy forwards each native permission
     * request to the dsh approval seam, and anything else fails closed with the
     * unattended deny-all stance.
     * @returns the permission fields of the query spec.
     */
    private queryPermission;
    /** Open one turn before claiming its first proposed step. */
    private turn;
    /** Model label recorded in the request header for one lifecycle. */
    private modelLabel;
    /** Append the request header snapshot once per loop instance. */
    private assertRequestHeader;
    /** Run one Claude Code query for the current step and map its transcript into the session log. */
    private step;
}
//# sourceMappingURL=agent.d.ts.map