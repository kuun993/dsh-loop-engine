/**
 * Codex skill provider: exposes the codex CLI's instruction files as DSH
 * skills.
 *
 * Codex has no per-skill catalog like the agents-skill standard; its
 * instructions are `AGENTS.md` files read from the session cwd up to the git
 * root, plus the global `~/.codex/AGENTS.md`. Each file set is surfaced as one
 * user-invocable `agents-md` skill whose body is the concatenated file
 * contents, so the dsh skill-injection seam (`/name` gestures) can carry it
 * into the prompt.
 *
 * @module dsh-loop-engine/engine-codex/skills
 */
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl } from '../skills.ts';
/**
 * Skill provider that discovers `AGENTS.md` from every directory between the
 * project cwd and the git root, plus the user home `~/.codex/AGENTS.md`.
 */
export declare class CodexSkillProvider implements SkillProvider {
    private readonly control;
    readonly name = "codex";
    constructor(control: SkillProviderControl);
    list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]>;
    get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined>;
    /** One merged `agents-md` candidate for a ranked file set. */
    private agentsCandidate;
}
export default CodexSkillProvider;
//# sourceMappingURL=skills.d.ts.map