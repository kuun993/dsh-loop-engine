/**
 * Claude Code skill provider: discovers skills from the project's `.claude/`
 * directory, the user-level `~/.claude/skills/` directory, and the project's
 * `CLAUDE.md` file, using the same YAML-frontmatter + markdown format as DSH
 * skills.
 *
 * @module dsh-loop-engine/skills
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
// ── Constants ──
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVIDER_NAME = 'claude-code';
/** Rank between project-dsh (100) and custom (300) — beats project-provided skills. */
const CLAUDE_CODE_RANK = 150;
/** User-level (`~/.claude/skills`) rank — project skills win duplicate names. */
const CLAUDE_CODE_USER_RANK = 160;
function parseFrontmatter(raw) {
    const firstLineEnd = raw.indexOf('\n');
    if (firstLineEnd < 0)
        return undefined;
    const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '');
    if (firstLine !== '---')
        return undefined;
    const start = firstLineEnd + 1;
    const closing = findClosingFrontmatter(raw, start);
    if (closing === undefined)
        return undefined;
    const yaml = raw.slice(start, closing.start);
    // Simple YAML subset parser: plain scalars plus `>`/`|` block scalars (the
    // Claude Code SKILL.md frontmatter uses folded `description: >` heavily).
    const data = {};
    const lines = yaml.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        /* v8 ignore start -- index is bounded by the loop condition */
        /* v8 ignore next -- index is bounded by the loop condition */
        const line = lines[index] ?? ''; /* v8 ignore stop */
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#'))
            continue;
        const colon = trimmed.indexOf(':');
        if (colon < 0)
            continue;
        const key = trimmed.slice(0, colon).trim();
        const value = trimmed.slice(colon + 1).trim();
        if (key.length === 0)
            continue;
        if (value === '>' || value === '>-' || value === '|' || value === '|-') {
            const block = [];
            while (index + 1 < lines.length) {
                /* v8 ignore start -- index is bounded by the loop condition */
                /* v8 ignore next -- index is bounded by the loop condition */
                const next = lines[index + 1] ?? ''; /* v8 ignore stop */
                if (next.trim().length > 0 && !/^[\s]/.test(next))
                    break;
                index += 1;
                if (next.trim().length > 0)
                    block.push(next.trim());
            }
            data[key] = value.startsWith('|') ? block.join('\n') : block.join(' ');
            continue;
        }
        data[key] = unquote(value);
    }
    return { data, body: raw.slice(closing.bodyStart) };
}
/** Strip one pair of matching surrounding quotes from a YAML plain value. */
function unquote(value) {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return value.slice(1, -1);
        }
    }
    return value;
}
function findClosingFrontmatter(raw, start) {
    let lineStart = start;
    while (lineStart <= raw.length) {
        const nextNewline = raw.indexOf('\n', lineStart);
        const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
        const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '');
        if (line === '---') {
            return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
        }
        if (nextNewline < 0)
            return undefined;
        lineStart = nextNewline + 1;
    }
    /* v8 ignore start -- every loop exit above returns; this is unreachable */
    /* v8 ignore next -- every loop exit above returns; this is unreachable */
    return undefined;
    /* v8 ignore stop */
}
/**
 * Parse one agents-skill standard file: YAML frontmatter (`name`,
 * `description`, optional `whenToUse`/`disable-model-invocation`/
 * `user-invocable`) plus the markdown body.
 * @param raw - the raw file content.
 * @returns the parsed skill, or `undefined` when the file is not a skill.
 */
export function parseSkillFile(raw) {
    const parsed = parseFrontmatter(raw);
    if (parsed === undefined)
        return undefined;
    const name = stringField(parsed.data, 'name');
    const description = stringField(parsed.data, 'description');
    if (name === undefined || description === undefined || !SKILL_NAME.test(name))
        return undefined;
    const disableModelInvocation = booleanField(parsed.data, 'disable-model-invocation');
    const userInvocable = booleanField(parsed.data, 'user-invocable');
    const whenToUse = optionalString(parsed.data, 'whenToUse');
    return {
        name,
        description,
        ...(whenToUse !== undefined ? { whenToUse } : {}),
        invocation: {
            modelInvocable: disableModelInvocation !== true,
            userInvocable: userInvocable !== false,
        },
        content: parsed.body.trim(),
    };
}
function stringField(data, key) {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function optionalString(data, key) {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function booleanField(data, key) {
    const value = data[key];
    if (typeof value !== 'string')
        return undefined;
    if (value === 'true' || value === 'yes')
        return true;
    if (value === 'false' || value === 'no')
        return false;
    return undefined;
}
/**
 * Skill provider that discovers skills from Claude Code's standard locations:
 *   - `<project>/.claude/skills/` — project skills
 *   - `~/.claude/skills/` — personal skills
 * Each location accepts both Claude Code layouts: a `<name>/SKILL.md`
 * directory (its directory becomes the resource base) and a flat `<name>.md`
 * file. `CLAUDE.md` in the project root is also read when it carries skill
 * frontmatter.
 */
export class ClaudeCodeSkillProvider {
    control;
    name = PROVIDER_NAME;
    constructor(control) {
        this.control = control;
    }
    async list(options) {
        const candidates = [];
        // 1. Project skills, anchored at the git root when one exists.
        const cwd = options.cwd;
        if (cwd !== undefined) {
            const projectRoot = await findProjectRoot(resolve(cwd));
            await collectSkillsDir(join(projectRoot, '.claude', 'skills'), CLAUDE_CODE_RANK, candidates);
            await collectClaudeMd(projectRoot, candidates);
        }
        // 2. Personal skills from the user home — project skills outrank them.
        await collectSkillsDir(join(homedir(), '.claude', 'skills'), CLAUDE_CODE_USER_RANK, candidates);
        // Check abort signal
        if (this.control.signal.aborted)
            return [];
        return candidates;
    }
    async get(candidate, _options) {
        const locator = candidate.locator;
        try {
            const raw = await readFile(locator.path, { encoding: 'utf8' });
            const parsed = parseSkillFile(raw);
            if (parsed === undefined)
                return undefined;
            return {
                name: parsed.name,
                description: parsed.description,
                ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
                invocation: parsed.invocation,
                source: 'custom',
                provider: this.name,
                content: parsed.content,
                path: locator.path,
                ...candidate.resourceBase !== undefined ? { resourceBase: candidate.resourceBase } : {},
            };
        }
        catch {
            return undefined;
        }
    }
}
/** Collect every skill in one `.claude/skills/` directory, both layouts. */
async function collectSkillsDir(skillsDir, rank, candidates) {
    let entries;
    try {
        entries = await readdir(skillsDir, { withFileTypes: true, encoding: 'utf8' });
    }
    catch {
        return; // Directory doesn't exist or can't be read — that's fine
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const entryPath = join(skillsDir, entry.name);
        // stat follows links: Windows skill installers use junctions, whose Dirent
        // reports neither isFile() nor isDirectory().
        /* v8 ignore start -- stat only loses a mid-listing delete race */
        /* v8 ignore next -- stat only loses a mid-listing delete race */
        const info = await stat(entryPath).catch(() => undefined);
        if (info === undefined)
            continue;
        /* v8 ignore stop */
        // Claude Code's canonical layout: <name>/SKILL.md — the directory is the
        // skill's resource base (scripts/, references/ resolve against it).
        if (info.isDirectory()) {
            const path = join(entryPath, 'SKILL.md');
            const skill = await tryParseSkill(path);
            if (skill === undefined)
                continue;
            candidates.push(toCandidate(skill, path, rank, entryPath));
            continue;
        }
        // Flat layout: <name>.md directly under .claude/skills/.
        if (!entry.name.endsWith('.md'))
            continue;
        const skill = await tryParseSkill(entryPath);
        if (skill === undefined)
            continue;
        candidates.push(toCandidate(skill, entryPath, rank, skillsDir));
    }
}
/** Collect the project-root CLAUDE.md when it carries skill frontmatter. */
async function collectClaudeMd(projectRoot, candidates) {
    const claudeMd = join(projectRoot, 'CLAUDE.md');
    try {
        const info = await stat(claudeMd);
        if (!info.isFile())
            return;
        const skill = await tryParseSkill(claudeMd);
        if (skill !== undefined) {
            candidates.push(toCandidate(skill, claudeMd, CLAUDE_CODE_RANK, projectRoot));
        }
    }
    catch {
        // File doesn't exist — that's fine
    }
}
function toCandidate(skill, path, rank, resourceBaseDir) {
    return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
        invocation: skill.invocation,
        source: 'custom',
        provider: PROVIDER_NAME,
        rank,
        locator: { kind: 'file', path },
        path,
        resourceBase: { kind: 'directory', path: resourceBaseDir },
    };
}
async function tryParseSkill(path) {
    try {
        const raw = await readFile(path, { encoding: 'utf8' });
        return parseSkillFile(raw);
    }
    catch {
        return undefined;
    }
}
export async function findProjectRoot(cwd) {
    let current = cwd;
    while (true) {
        try {
            await stat(join(current, '.git'));
            return current;
        }
        catch {
            // continue walking up
        }
        const parent = resolve(current, '..');
        if (parent === current)
            return cwd; // reached filesystem root
        current = parent;
    }
}
export default ClaudeCodeSkillProvider;
//# sourceMappingURL=skills.js.map