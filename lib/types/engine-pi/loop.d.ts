/**
 * Pi loop engine module: hosts the AgentFactory that drives every session
 * through the Pi CLI (`@earendil-works/pi-coding-agent`) over its JSONL RPC
 * mode, one stateless session per dsh step, with the durable session log as the
 * sole source of model context. dsh-loop-engine constructs this factory when
 * the Pi engine is selected; this module is a library, not a Cordis plugin
 * entry. Pi has no permission system, so the entire `pi --mode rpc` child is
 * spawned through the dsh subprocess seam — the only available privilege
 * boundary — and its `--tools` are pruned to the resolved sandbox stance.
 *
 * @module dsh-loop-engine/engine-pi
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import type { PiProcess, PiSpawnSpec } from './rpc/client.ts';
import type { PiSandboxMode, ResolvedConfig } from './types.ts';
/** Pi CLI sandbox modes a deployment may pin. */
export declare const PI_SANDBOX_MODES: readonly PiSandboxMode[];
/** Grace in milliseconds for Pi process-tree termination. */
export declare const PI_DISPOSE_GRACE_MS = 3000;
/** Deployment-owned configuration for the Pi loop plugin. */
export interface Config {
    /**
     * Pinned sandbox stance for every RPC child. When omitted, each query follows
     * the session's dsh permission knobs (`sandbox/mode` and `approval/policy`):
     * full access runs native, `workspace-write` wraps the child in the dsh
     * sandbox with a write-capable tool set, an `ask` policy degrades to a
     * read-only denial, and anything else fails closed with `read-only`.
     */
    sandboxMode?: PiSandboxMode;
    /** LLM provider for the `pi` child (`--provider`), when the deployment pins one. */
    provider?: string;
    /** Model pattern for the `pi` child (`--model`); Pi native settings own the model when omitted. */
    model?: string;
    /** Thinking/reasoning level, appended to the `--model` pattern when pinned. */
    thinkingLevel?: string;
    /** Explicit environment entries passed to the `pi` child. */
    env?: Record<string, string>;
}
/** Schema of the Pi loop plugin configuration. */
export declare const Config: z<Config>;
/** Host-face ctx key for the Pi loop service. */
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentLoopPi: PiLoop;
    }
}
/**
 * Concrete AgentFactory and driver service of the Pi loop. Creation and resume
 * follow the registry factory contract and the shared publication transaction:
 * prepare, run setup, then publish through both registries, announce, and emit
 * `agent/session-start`.
 */
export declare class PiLoop extends Service implements AgentFactory {
    /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
    static inject: string[];
    /** Validated configuration owned by the loop plugin. */
    readonly config: ResolvedConfig;
    private readonly ownership;
    /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
    private readonly runtime;
    /** Process-tree spawn capability handed to every agent, sandboxed by the subprocess seam. */
    readonly spawn: (spec: PiSpawnSpec) => PiProcess;
    /** Resolved Pi CLI entrypoint; `argv[0]` of every Pi RPC child. */
    readonly bin: string;
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