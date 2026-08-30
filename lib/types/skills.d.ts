/**
 * Claude Code skill provider: discovers skills from the project's `.claude/`
 * directory, the user-level `~/.claude/skills/` directory, and the project's
 * `CLAUDE.md` file, using the same YAML-frontmatter + markdown format as DSH
 * skills.
 *
 * @module dsh-loop-engine/skills
 */
export interface SkillInvocationPolicy {
    readonly modelInvocable: boolean;
    readonly userInvocable: boolean;
}
export type SkillSource = string;
export interface SkillCandidate {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly invocation: SkillInvocationPolicy;
    readonly source: SkillSource;
    readonly provider: string;
    readonly rank: number;
    readonly locator: unknown;
    readonly path?: string;
    readonly resourceBase?: {
        readonly kind: string;
        readonly path: string;
    };
}
export interface SkillDefinition {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly invocation: SkillInvocationPolicy;
    readonly source: SkillSource;
    readonly provider: string;
    readonly content: string;
    readonly path?: string;
    readonly resourceBase?: {
        readonly kind: string;
        readonly path: string;
    };
}
export interface SkillLookupOptions {
    readonly cwd?: string;
    readonly signal?: AbortSignal;
}
export interface SkillProvider {
    readonly name: string;
    list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | {
        candidates: readonly SkillCandidate[];
        complete: boolean;
    }>;
    get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>;
}
export interface SkillProviderControl {
    readonly signal: AbortSignal;
    invalidate(): void;
}
/** One parsed agents-skill standard skill: frontmatter metadata plus the body. */
export interface ParsedSkill {
    name: string;
    description: string;
    whenToUse?: string;
    invocation: SkillInvocationPolicy;
    content: string;
}
/**
 * Parse one agents-skill standard file: YAML frontmatter (`name`,
 * `description`, optional `whenToUse`/`disable-model-invocation`/
 * `user-invocable`) plus the markdown body.
 * @param raw - the raw file content.
 * @returns the parsed skill, or `undefined` when the file is not a skill.
 */
export declare function parseSkillFile(raw: string): ParsedSkill | undefined;
/**
 * Skill provider that discovers skills from Claude Code's standard locations:
 *   - `<project>/.claude/skills/` — project skills
 *   - `~/.claude/skills/` — personal skills
 * Each location accepts both Claude Code layouts: a `<name>/SKILL.md`
 * directory (its directory becomes the resource base) and a flat `<name>.md`
 * file. `CLAUDE.md` in the project root is also read when it carries skill
 * frontmatter.
 */
export declare class ClaudeCodeSkillProvider implements SkillProvider {
    private readonly control;
    readonly name = "claude-code";
    constructor(control: SkillProviderControl);
    list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]>;
    get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined>;
}
export declare function findProjectRoot(cwd: string): Promise<string>;
export default ClaudeCodeSkillProvider;
//# sourceMappingURL=skills.d.ts.map