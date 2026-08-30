/**
 * Web-switchable agent loop engine, node half.
 *
 * Hosts the non-default agent-loop engines (Claude Code, Codex) and
 * bridges them with the harness's single AgentFactory slot. The engine is
 * selected by the `agent-loop-engine` settings section; the selection is
 * realized by a managed block in the profile's `cordis.patch.yml` that
 * disables the base bundle's `agent-loop` row — exactly one AgentFactory may
 * register, so a non-default engine owns the slot by disabling the base loop
 * first, and `in-process` leaves the base row active (this plugin does NOT
 * register its own factory then).
 *
 * The managed block is the ground truth the factory decision reads at boot:
 * apply() reads the file synchronously, so a committed engine change takes
 * effect on the next recomposition (restart); the config-only HMR watcher
 * re-applies the patch file but cannot re-register an AgentFactory mid-run.
 * The settings section is seeded from the block so the UI mirrors the file,
 * and a committed settings change writes the block (only when it differs).
 *
 * @module dsh-loop-engine
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type Config as ClaudeCodeConfig } from './engine-claude/loop.ts';
import type { CodexApprovalPolicy, CodexSandboxMode } from './engine-codex/types.ts';
import { type LoopEngineId } from './settings.ts';
export declare const name = "loop-engine";
/**
 * Services the plugin's own fiber requires. The plugin declares none of its
 * own: the optional host services it reads (`commands`, `skills`) are resolved
 * lazily via `ctx.get` and may be absent, and the hosted engine factories
 * (Claude Code / Codex) declare their own `inject` when the plugin mounts them
 * as children. Empty keeps the plugin from demanding a service that a minimal
 * profile does not provide.
 */
export declare const inject: never[];
/** Composition entry for the loop engine selection and the hosted engine drivers. */
export interface Config extends ClaudeCodeConfig {
    /** Profile whose `cordis.patch.yml` carries the managed block; defaults to `web`. */
    profile?: string;
    /** Patch file name inside the profile; defaults to `cordis.patch.yml`. */
    patchFilename?: string;
    /** Explicit absolute path to the patch file, overriding profile + filename. */
    patchPath?: string;
    /** Pinned Codex sandbox mode; falls back to the session's dsh permission knobs. */
    sandboxMode?: CodexSandboxMode;
    /** Pinned Codex approval policy; falls back to the session's dsh permission knobs. */
    approvalPolicy?: CodexApprovalPolicy;
    /** LLM provider for the Pi RPC child (`--provider`). */
    piProvider?: string;
    /** Thinking/reasoning level for the Pi RPC child, appended to its `--model`. */
    piThinking?: string;
}
/**
 * Schema of the loop engine composition entry.
 *
 * A schemastery object validates each field only when it is present and lets
 * an absent key fall through as `undefined`, so omitted knobs are accepted —
 * matching the permissive interface and read path (`resolvePatchPath` defaults
 * the patch path; each engine driver resolves only the knobs it owns and
 * omitted deployment tunables fall back to the session). The composition entry
 * is an engine-agnostic superset: the selectable knobs belong to whichever
 * engine the settings pick at runtime, so both engines' knobs may coexist and
 * only the selected one is consumed.
 */
export declare const Config: z<Config>;
/** Resolve the managed patch file from configuration, defaulting to the web profile. */
export declare function resolvePatchPath(config: Config): string;
/** Atomically replace the patch file (same-directory temp + rename). */
export declare function writePatchFile(path: string, text: string): Promise<void>;
/**
 * Synchronously atomically replace the patch file. The engine-selection
 * onChange is a synchronous hook with no await, and the write MUST land before
 * the caller is told the switch committed — otherwise a user who restarts
 * `dsh web` immediately reads the stale file and the previous engine boots.
 * @param path - the profile's patch file.
 * @param text - the next file content.
 */
export declare function writePatchFileSync(path: string, text: string): void;
/**
 * Rewrite the managed block for a target engine, preserving the rest of the
 * file byte for byte. Only writes when the file actually differs.
 * @param path - the profile's patch file.
 * @param engine - the target engine.
 * @returns whether a write occurred.
 */
export declare function syncManagedBlock(path: string, engine: LoopEngineId): Promise<boolean>;
/**
 * Apply the plugin: seed the settings section from the managed block, host
 * the non-default engine factory when the block says so, and translate
 * committed engine changes into managed-block writes.
 * @param ctx - the composing context.
 * @param config - composition entry for the managed patch file.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map