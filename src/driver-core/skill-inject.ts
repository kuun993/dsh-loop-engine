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

import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Kebab-case skill name regex. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whitespace-bounded `/name` gesture in user text. */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

export function isSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name)
}

/** Minimal shape of a loaded skill definition. */
export interface SkillDefinition {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly content: string
  readonly path?: string
  readonly resourceBase?: { readonly kind: string; readonly path: string }
}

/** Durable source for an injected user-explicit skill invocation (mirrors dsh-skill's). */
export interface SkillInvocationSource {
  readonly kind: 'skill-invocation'
  readonly name: string
  readonly form: 'instructions'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A user-explicit skill invocation injected by this driver. */
    'skill-invocation': SkillInvocationSource
  }
}

/** Minimal shape of the SkillRegistry service. */
export interface SkillsService {
  get(name: string, options: { cwd?: string; signal?: AbortSignal; scope?: unknown }): Promise<SkillDefinition | undefined>
}

/** Escape text for inclusion in XML-like skill markup. */
export function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Escape an XML-like attribute value. */
export function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** Render the `<skill_content>` block for a loaded skill. */
export function renderSkillContent(skill: SkillDefinition): string {
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    skill.resourceBase !== undefined && skill.resourceBase.kind === 'directory'
      ? `Base directory for this skill: ${escapeText(skill.resourceBase.path)}. Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.`
      : `Resources for this skill are managed by provider "${escapeText(skill.provider)}". Load referenced resources only as needed.`,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** Collect `/name` gesture tokens from direct user messages, in first-seen order. */
export function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}
