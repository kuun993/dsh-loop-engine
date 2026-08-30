/**
 * Package-owned invariant companion for the loop engine selection.
 *
 * The plugin's owned relationship is the patch-manager round trip: rendering
 * a managed block for an engine and reading it back must produce the same
 * engine, and the `in-process` engine must render an absent block (so the base
 * bundle's `agent-loop` row stays mounted). The companion asserts both against
 * the pure transform, binding the writer's inverse to the reader directly.
 *
 * @module dsh-loop-engine/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "loop-engine-invariant";
/** Services required before the companion can register. */
export declare const inject: string[];
/**
 * Register the loop-engine invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map