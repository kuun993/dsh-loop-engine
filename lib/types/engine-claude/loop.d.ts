/**
 * Claude Code loop engine module: hosts the AgentFactory that drives every
 * session through the official Claude Agent SDK, one stateless query per dsh
 * step, with the durable session log as the sole source of model context.
 * dsh-loop-engine constructs this factory when the Claude Code engine is
 * selected; this module is a library, not a Cordis plugin entry.
 *
 * @module dsh-loop-engine/engine-claude
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import type { ClaudeCodePermissionMode, ResolvedConfig } from './types.ts';
/** Deployment-selectable non-interactive Claude Code permission modes. */
export declare const CLAUDE_CODE_PERMISSION_MODES: readonly ClaudeCodePermissionMode[];
/** Deployment-owned configuration for the Claude Code loop plugin. */
export interface Config {
    /**
     * Native non-interactive permission handling for every query. When omitted,
     * each query follows the session's dsh permission knobs (`sandbox/mode` and
     * `approval/policy`): full access bypasses native checks, an `ask` policy
     * forwards requests to the dsh approval seam, and anything else auto-denies.
     * A pinned mode overrides the session for every query: `dontAsk` auto-denies,
     * `acceptEdits` accepts edits, `auto` uses the native classifier, `plan`
     * returns a plan without approving execution, and `bypassPermissions`
     * explicitly skips permission checks.
     */
    permissionMode?: ClaudeCodePermissionMode;
    /** Explicit environment entries layered over the credential-scrubbed parent environment. */
    env?: Record<string, string>;
    /** Model label for the logged request header; Claude Code native settings own the actual model. */
    model?: string;
    /** Grace in milliseconds for Claude Code process-tree termination. */
    disposeGraceMs?: number;
    /** Cap on the number of conversation turns before each query stops. */
    maxTurns?: number;
}
/** Schema of the Claude Code loop plugin configuration. */
export declare const Config: z<Config>;
/** Host-face ctx key for the Claude Code loop service. */
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentLoopClaudeCode: ClaudeCodeLoop;
    }
}
/**
 * Concrete AgentFactory and driver service of the Claude Code loop. Creation
 * and resume follow the registry factory contract and the shared publication
 * transaction: prepare, run setup, then publish through both registries,
 * announce, and emit `agent/session-start`.
 */
export declare class ClaudeCodeLoop extends Service implements AgentFactory {
    /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
    static inject: string[];
    /** Validated configuration owned by the loop plugin. */
    readonly config: ResolvedConfig;
    private readonly ownership;
    /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
    private readonly runtime;
    constructor(ctx: Context, config: Config);
    /**
     * Construct the driver, scope, and one memoized reverse teardown for a new
     * agent. The teardown is registered with the factory and the owner fiber
     * BEFORE publication, so a mid-setup unload rolls everything back; `signal`
     * fuses caller cancellation with lifecycle teardown for setup awaits.
     */
    private prepare;
    /** Prepare one Agent around an acquired Session, run setup, and publish it. */
    private setupAndPublish;
    /**
     * Create an agent and session under one caller-supplied identity, owned by
     * the accessing fiber.
     * @param ownerCtx - caller context that structurally owns the lifecycle.
     * @param options - identities, session seed/metadata, loop options, setup, and cancellation.
     * @returns the published handle.
     */
    createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
    /**
     * Resume an owned agent from the configured persistence service.
     * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
     * @param options - persisted identity, loop options, setup, and cancellation.
     * @returns the published handle.
     */
    resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
    /** Resume through an explicit persistence handle. */
    private resumeWith;
}
//# sourceMappingURL=loop.d.ts.map