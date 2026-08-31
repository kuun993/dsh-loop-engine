/**
 * Managed-block editing for a profile's `cordis.patch.yml`.
 *
 * The plugin owns one contiguous block inside the user's patch file, delimited
 * by a begin/end marker pair, and rewrites only that span on engine switches
 * — everything else the user wrote (other patches, their comments) survives
 * byte for byte. The block's content is the loader patch that takes the loop
 * engine over: it disables the base bundle's `agent-loop` row so this plugin's
 * factory (hosted by dsh-loop-engine) can register without colliding, because
 * the harness admits exactly one AgentFactory:
 *
 *   # -- dsh-loop-engine managed block: claude-code --
 *   - id: agent-loop
 *     disabled: true
 *   # -- /dsh-loop-engine managed block --
 *
 * `in-process` renders an absent block (the base bundle's `agent-loop` row
 * stays active and supplies the factory), so switching back removes the span
 * entirely. Any other engine renders the same disable block, and the begin
 * marker carries the specific engine id (`# -- dsh-loop-engine managed block:
 * claude-code --`) so `currentEngineOf` can read which non-default engine owns
 * the slot from the file alone. All functions here are pure string transforms —
 * file I/O and durability live in the plugin's apply.
 *
 * @module dsh-loop-engine/patch-manager
 */
import type { LoopEngineId } from './settings.ts';
/** Begin marker of the plugin-managed span inside a profile patch file. */
export declare const MANAGED_BLOCK_BEGIN = "# -- dsh-loop-engine managed block: ";
/** End marker of the plugin-managed span inside a profile patch file. */
export declare const MANAGED_BLOCK_END = "# -- /dsh-loop-engine managed block --";
/** Render the managed block for one engine; `in-process` returns the empty span. */
export declare function renderManagedBlock(engine: LoopEngineId): string;
/** Whether a patch-file text contains the managed block span. */
export declare function hasManagedBlock(text: string): boolean;
/** Derive the current engine from a patch-file text by the managed block's begin marker. */
export declare function currentEngineOf(text: string): LoopEngineId;
/**
 * Produce the next patch-file text for a target engine, preserving every byte
 * outside the managed span. Appends the span when absent; replaces or removes
 * it when present.
 *
 * The file must always parse as a top-level YAML *array*: app-boot's
 * `parsePatchList` throws `must be a top-level YAML array of loader patch
 * entries` on anything else, which fails the whole plugin tree — including this
 * plugin's own `insert` row, so no agent factory registers at all.
 *
 * That constrains both directions:
 *   - A fresh profile's file is `[]`, a complete flow-style document. Block
 *     sequence items cannot follow it, so the `[]` is dropped when a block goes
 *     in.
 *   - Removing the last block must not leave a comments-only file: that parses
 *     as `null`, not `[]`. The `[]` is restored so the list stays a list.
 *
 * @param text - current patch-file text.
 * @param engine - target engine.
 * @returns the rewritten patch-file text.
 */
export declare function applyManagedBlock(text: string, engine: LoopEngineId): string;
//# sourceMappingURL=patch-manager.d.ts.map