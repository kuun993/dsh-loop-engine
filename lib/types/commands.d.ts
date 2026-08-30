/**
 * Claude Code slash-command bridge.
 *
 * The dsh `commands` runtime executes a registered command locally — the line
 * is consumed and never reaches the model — so a command whose real processing
 * lives inside the Claude Code CLI must forward the raw line back to the
 * engine. The definitions here do exactly that: the handler delivers
 * `/<name> [args]` to the receiving agent as a plain user message, and the CLI
 * then expands it natively (built-ins and custom `.claude/commands/*.md`).
 * Registering the built-ins keeps them visible in the dsh web slash menu;
 * unregistered `/lines` pass through as user text, but the menu would hide the
 * engine's command surface.
 *
 * User-level custom slash commands (`~/.claude/commands/*.md`) are discovered
 * and registered the same way, so they appear in the menu AND reach the CLI.
 * Project-level `.claude/commands/` files are left to the CLI entirely: they
 * are cwd-dependent, and a global dsh registration would collide across
 * projects.
 *
 * @module dsh-loop-engine/commands
 */
import type { UserMessage } from '@deepseek-ai/dsh-session';
/** Minimal shape of a DSH command definition (avoiding a direct peer dep on @deepseek-ai/dsh-commands). */
export interface CommandDefinition {
    readonly name: string;
    readonly description: string;
    readonly input?: {
        readonly hint: string;
        readonly images?: boolean;
    };
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}
/** Invocation delivered to one registered command handler. */
export interface CommandInvocation {
    readonly commandId: string;
    /** The receiving agent; forwarding handlers deliver the raw line back to it. */
    readonly agent: {
        readonly followup: (input: UserMessage) => void;
    };
    /** Exact text following the command name, including separator whitespace. */
    readonly rawInput: string;
    readonly signal: AbortSignal;
}
/** Settled result of one command handler. */
export interface CommandResult {
    readonly kind: 'success' | 'error';
    readonly text?: string;
}
/**
 * Build the forwarding handler for one Claude Code slash command: it
 * re-delivers the full `/<name> [args]` line to the receiving agent as a
 * plain user message, where the CLI expands it. `rawInput` already carries the
 * separator whitespace and any arguments.
 * @param name - the command name without the leading slash.
 * @returns the command handler.
 */
export declare function forwardClaudeCodeCommand(name: string): (invocation: CommandInvocation) => CommandResult;
/** Claude Code's built-in slash commands. */
export declare const CLAUDE_CODE_COMMANDS: readonly CommandDefinition[];
/**
 * Discover the user-level custom slash commands from `~/.claude/commands/*.md`
 * and build forwarding definitions for them. The scan is synchronous so the
 * mount path can register the commands before the engine-selection commit
 * returns; files without a usable name or description, and names already taken
 * by the built-ins, are skipped.
 * @returns forwarding definitions, sorted by file name.
 */
export declare function discoverUserSlashCommands(): CommandDefinition[];
//# sourceMappingURL=commands.d.ts.map