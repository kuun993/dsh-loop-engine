/**
 * Skill-injection helpers shared by the hosted engine drivers. Both the Claude
 * Code and Codex agents replicate the dsh `/name` skill gesture scan and the
 * XML `<skill_content>` rendering that the in-process engine's dsh-tool-skill
 * handler would otherwise provide — their agent contexts do not descend from
 * the agent-preset chain. These helpers are pure: they take user messages or a
 * loaded skill and return the injected text, with no session or loop access.
 *
 * @module dsh-loop-engine/driver-core/skill-inject
 */
import type { UserMessage } from '@deepseek-ai/dsh-session';
export declare function isSkillName(name: string): boolean;
/** Minimal shape of a loaded skill definition. */
export interface SkillDefinition {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly invocation: {
        readonly modelInvocable: boolean;
        readonly userInvocable: boolean;
    };
    readonly source: string;
    readonly provider: string;
    readonly content: string;
    readonly path?: string;
    readonly resourceBase?: {
        readonly kind: string;
        readonly path: string;
    };
}
/** Durable source for an injected user-explicit skill invocation (mirrors dsh-skill's). */
export interface SkillInvocationSource {
    readonly kind: 'skill-invocation';
    readonly name: string;
    readonly form: 'instructions';
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** A user-explicit skill invocation injected by this driver. */
        'skill-invocation': SkillInvocationSource;
    }
}
/** Minimal shape of the SkillRegistry service. */
export interface SkillsService {
    get(name: string, options: {
        cwd?: string;
        signal?: AbortSignal;
        scope?: unknown;
    }): Promise<SkillDefinition | undefined>;
}
/** Escape text for inclusion in XML-like skill markup. */
export declare function escapeText(value: string): string;
/** Escape an XML-like attribute value. */
export declare function escapeAttr(value: string): string;
/** Render the `<skill_content>` block for a loaded skill. */
export declare function renderSkillContent(skill: SkillDefinition): string;
/** Collect `/name` gesture tokens from direct user messages, in first-seen order. */
export declare function invokedSkillNames(messages: readonly UserMessage[]): string[];
//# sourceMappingURL=skill-inject.d.ts.map