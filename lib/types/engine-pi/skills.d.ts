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
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl } from '../skills.ts';
/**
 * Resolve the pi config directory, honoring the `PI_CODING_AGENT_DIR`
 * environment override and falling back to `~/.pi/agent`.
 * @returns the absolute pi config directory.
 */
export declare function piAgentDir(): string;
/**
 * Skill provider that discovers context files and skills from pi's standard
 * locations:
 *   - project context files between the cwd and the git root (plus
 *     `~/.pi/agent/AGENTS.md`) — surfaced as one `agents-md` skill;
 *   - project `.pi/skills/` and user `~/.pi/agent/skills/` — each `SKILL.md`
 *     entry surfaced under its own name.
 */
export declare class PiSkillProvider implements SkillProvider {
    private readonly control;
    readonly name = "pi";
    constructor(control: SkillProviderControl);
    list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]>;
    get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined>;
    /** One merged `agents-md` candidate for a ranked file set. */
    private agentsCandidate;
    /** Collect every skill in one skills directory, both pi layouts. */
    private collectSkillsDir;
    /** One parsed skill as a ranked candidate. */
    private skillCandidate;
    /** Parse one SKILL.md file, or `undefined` when it is unreadable or invalid. */
    private tryParse;
}
export default PiSkillProvider;
//# sourceMappingURL=skills.d.ts.map