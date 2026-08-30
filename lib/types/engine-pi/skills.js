/**
 * Pi skill provider: exposes the Pi CLI's instruction files and skills as DSH
 * skills.
 *
 * Pi reads per-directory context files (`AGENTS.md`, or `CLAUDE.md`,
 * preferring `AGENTS.override.md` where one exists) from the session cwd up to
 * the git root, plus a global `AGENTS.md` under the pi config directory
 * (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), and installs skills from
 * `skills/` directories (`~/.pi/agent/skills/` and project `.pi/skills/`
 * walking up). Each context-file set is surfaced as one user-invocable
 * `agents-md` skill whose body is the concatenated file contents; every found
 * `SKILL.md` catalog entry is surfaced under its own name, so the dsh
 * skill-injection seam (`/name` gestures) can carry them into the prompt.
 *
 * `.agents/skills` roots are deliberately not scanned here: dsh's own
 * `skill-filesystem` provider already exposes them through the same registry
 * in the web profile. Pi settings/CLI/package skills are only discoverable
 * through a running `pi --mode rpc` probe, which the engine does not perform
 * at composition time — the filesystem subset above is authoritative for the
 * web menu.
 *
 * @module dsh-loop-engine/engine-pi/skills
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { anySourceNonEmpty, collectProjectContextFiles, fileNonEmpty, projectAncestors, readSources, } from "../driver-core/context-files.js";
import { parseSkillFile } from "../skills.js";
/** Provider identity registered against the host skills service. */
const PROVIDER_NAME = 'pi';
/** Project `agents-md` rank — between project-dsh (100) and custom (300). */
const PI_AGENTS_PROJECT_RANK = 140;
/** Project `.pi/skills/` rank — project AGENTS.md beats project skills. */
const PI_SKILL_PROJECT_RANK = 150;
/** User `agents-md` rank — project files win duplicate names. */
const PI_AGENTS_USER_RANK = 160;
/** User `~/.pi/agent/skills/` rank. */
const PI_SKILL_USER_RANK = 170;
/** Pi context-file policy: `AGENTS.md`/`CLAUDE.md`, `AGENTS.override.md` wins. */
const PI_CONTEXT_POLICY = {
    override: 'AGENTS.override.md',
    primary: ['AGENTS.md', 'CLAUDE.md'],
};
/**
 * Resolve the pi config directory, honoring the `PI_CODING_AGENT_DIR`
 * environment override and falling back to `~/.pi/agent`.
 * @returns the absolute pi config directory.
 */
export function piAgentDir() {
    const override = process.env.PI_CODING_AGENT_DIR;
    if (override !== undefined && override.length > 0)
        return resolve(override);
    return join(homedir(), '.pi', 'agent');
}
/**
 * Skill provider that discovers context files and skills from pi's standard
 * locations:
 *   - project context files between the cwd and the git root (plus
 *     `~/.pi/agent/AGENTS.md`) — surfaced as one `agents-md` skill;
 *   - project `.pi/skills/` and user `~/.pi/agent/skills/` — each `SKILL.md`
 *     entry surfaced under its own name.
 */
export class PiSkillProvider {
    control;
    name = PROVIDER_NAME;
    constructor(control) {
        this.control = control;
    }
    async list(options) {
        const candidates = [];
        const cwd = options.cwd;
        if (cwd !== undefined) {
            const projectDirs = await projectAncestors(cwd);
            const contextPaths = await collectProjectContextFiles(cwd, PI_CONTEXT_POLICY);
            if (await anySourceNonEmpty(contextPaths))
                candidates.push(this.agentsCandidate(contextPaths, PI_AGENTS_PROJECT_RANK));
            for (const dir of projectDirs) {
                await this.collectSkillsDir(join(dir, '.pi', 'skills'), PI_SKILL_PROJECT_RANK, candidates);
            }
        }
        const userAgentDir = piAgentDir();
        const userContext = join(userAgentDir, 'AGENTS.md');
        if (await fileNonEmpty(userContext))
            candidates.push(this.agentsCandidate([userContext], PI_AGENTS_USER_RANK));
        await this.collectSkillsDir(join(userAgentDir, 'skills'), PI_SKILL_USER_RANK, candidates);
        if (this.control.signal.aborted)
            return [];
        return candidates;
    }
    async get(candidate, _options) {
        const locator = candidate.locator;
        if (locator.kind === 'skill-file') {
            const parsed = await this.tryParse(locator.path);
            if (parsed === undefined)
                return undefined;
            return {
                name: parsed.name,
                description: parsed.description,
                ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
                invocation: parsed.invocation,
                source: candidate.source,
                provider: this.name,
                content: parsed.content,
                path: locator.path,
                resourceBase: { kind: 'directory', path: dirname(locator.path) },
            };
        }
        const content = await readSources(locator.paths);
        if (content === undefined)
            return undefined;
        // Every candidate is constructed from a non-empty file set.
        const first = locator.paths[0];
        return {
            name: candidate.name,
            description: candidate.description,
            invocation: candidate.invocation,
            source: candidate.source,
            provider: this.name,
            content,
            path: first,
            resourceBase: { kind: 'file', path: first },
        };
    }
    /** One merged `agents-md` candidate for a ranked file set. */
    agentsCandidate(paths, rank) {
        // Every caller only constructs candidates from a non-empty file set.
        const first = paths[0];
        return {
            name: 'agents-md',
            description: 'Pi project/user instructions (AGENTS.md / CLAUDE.md)',
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'custom',
            provider: this.name,
            rank,
            locator: { kind: 'agents-md', paths },
            path: first,
            resourceBase: { kind: 'file', path: first },
        };
    }
    /** Collect every skill in one skills directory, both pi layouts. */
    async collectSkillsDir(skillsDir, rank, candidates) {
        let entries;
        try {
            entries = await readdir(skillsDir, { withFileTypes: true, encoding: 'utf8' });
        }
        catch {
            return; // missing or unreadable — no skills from this root
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const entryPath = join(skillsDir, entry.name);
            // stat follows links: Windows skill installers use junctions, whose
            // Dirent reports neither isFile() nor isDirectory().
            /* v8 ignore start -- stat only loses a mid-listing delete race */
            /* v8 ignore next -- see above */
            const info = await stat(entryPath).catch(() => undefined);
            if (info === undefined)
                continue;
            /* v8 ignore stop */
            if (info.isDirectory()) {
                const path = join(entryPath, 'SKILL.md');
                const parsed = await this.tryParse(path);
                if (parsed === undefined)
                    continue;
                candidates.push(this.skillCandidate(parsed, path, rank, entryPath));
                continue;
            }
            // Flat root `<name>.md` files are discovered as individual skills.
            if (!entry.name.endsWith('.md'))
                continue;
            const parsed = await this.tryParse(entryPath);
            if (parsed === undefined)
                continue;
            candidates.push(this.skillCandidate(parsed, entryPath, rank, skillsDir));
        }
    }
    /** One parsed skill as a ranked candidate. */
    skillCandidate(skill, path, rank, resourceDir) {
        return {
            name: skill.name,
            description: skill.description,
            ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
            invocation: skill.invocation,
            source: 'custom',
            provider: this.name,
            rank,
            locator: { kind: 'skill-file', path },
            path,
            resourceBase: { kind: 'directory', path: resourceDir },
        };
    }
    /** Parse one SKILL.md file, or `undefined` when it is unreadable or invalid. */
    async tryParse(path) {
        try {
            const raw = await readFile(path, { encoding: 'utf8' });
            return parseSkillFile(raw);
        }
        catch {
            return undefined;
        }
    }
}
export default PiSkillProvider;
//# sourceMappingURL=skills.js.map