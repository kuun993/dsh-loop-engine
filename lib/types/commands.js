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
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** dsh command-name grammar (mirrors the host registry `^[a-z][a-z0-9_-]*$`). */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
/**
 * Build the forwarding handler for one Claude Code slash command: it
 * re-delivers the full `/<name> [args]` line to the receiving agent as a
 * plain user message, where the CLI expands it. `rawInput` already carries the
 * separator whitespace and any arguments.
 * @param name - the command name without the leading slash.
 * @returns the command handler.
 */
export function forwardClaudeCodeCommand(name) {
    return (invocation) => {
        invocation.agent.followup(createUserMessage({
            content: [{ type: 'text', text: `/${name}${invocation.rawInput}` }],
            source: { kind: 'user' },
        }));
        return { kind: 'success' };
    };
}
/** One built-in Claude Code slash command, registered with a forwarding handler. */
function builtin(name, description) {
    return { name, description, handler: forwardClaudeCodeCommand(name) };
}
/** Claude Code's built-in slash commands. */
export const CLAUDE_CODE_COMMANDS = [
    builtin('help', 'Show help about Claude Code commands'),
    builtin('compact', 'Compact the conversation to reduce context usage'),
    builtin('clear', 'Clear the conversation and start fresh'),
    builtin('review', 'Review recent changes (git diff)'),
    builtin('explain', 'Explain the selected code'),
    builtin('fix', 'Fix issues in the code'),
    builtin('tests', 'Add tests for the selected code'),
];
/**
 * Discover the user-level custom slash commands from `~/.claude/commands/*.md`
 * and build forwarding definitions for them. The scan is synchronous so the
 * mount path can register the commands before the engine-selection commit
 * returns; files without a usable name or description, and names already taken
 * by the built-ins, are skipped.
 * @returns forwarding definitions, sorted by file name.
 */
export function discoverUserSlashCommands() {
    let entries;
    try {
        entries = readdirSync(userCommandsDir(), { encoding: 'utf8' });
    }
    catch {
        return []; // directory does not exist yet — no user commands
    }
    const definitions = [];
    const seen = new Set(CLAUDE_CODE_COMMANDS.map(command => command.name));
    for (const entry of entries.sort()) {
        if (!entry.endsWith('.md'))
            continue;
        const name = entry.slice(0, -'.md'.length);
        if (!COMMAND_NAME.test(name) || seen.has(name))
            continue;
        const path = join(userCommandsDir(), entry);
        let raw;
        try {
            raw = readFileSync(path, 'utf8');
        }
        catch {
            continue; // unreadable entry (e.g. a directory carrying a `.md` name)
        }
        const description = commandDescription(raw);
        if (description === undefined)
            continue;
        seen.add(name);
        definitions.push({ name, description, handler: forwardClaudeCodeCommand(name) });
    }
    return definitions;
}
/** The user-level Claude Code custom slash-command directory under the home. */
function userCommandsDir() {
    return join(homedir(), '.claude', 'commands');
}
/**
 * Derive a command's menu description from its markdown body: the frontmatter
 * `description` field when present, else the first non-empty non-heading body
 * line.
 * @param raw - the raw command file content.
 * @returns the description, or `undefined` when the body yields none.
 */
function commandDescription(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return undefined;
    let body = trimmed;
    // Closed YAML frontmatter: read `description` from the block, else describe
    // the body. A dangling opener has no body to describe.
    if (trimmed.startsWith('---\n')) {
        const closing = trimmed.indexOf('\n---');
        if (closing <= 0)
            return undefined; // dangling `---` opener — nothing to describe
        for (const line of trimmed.slice(4, closing).split('\n')) {
            const colon = line.indexOf(':');
            if (colon < 0 || line.slice(0, colon).trim() !== 'description')
                continue;
            const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
            if (value.length > 0)
                return value;
        }
        body = trimmed.slice(closing + 4);
    }
    for (const line of body.split('\n')) {
        const candidate = line.trim();
        if (candidate.length === 0 || candidate.startsWith('#'))
            continue;
        return candidate.length > 120 ? `${candidate.slice(0, 119)}…` : candidate;
    }
    return undefined;
}
//# sourceMappingURL=commands.js.map