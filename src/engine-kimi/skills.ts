/**
 * Kimi Code skill provider: exposes the Kimi CLI's instruction files and skills
 * as DSH skills.
 *
 * Kimi reads per-directory `AGENTS.md` files from the session cwd up to the git
 * root, and installs skills from `skills/` directories — the user-level
 * `$KIMI_CODE_HOME/skills/` (default `~/.kimi-code/skills/`) and the
 * project-level `.kimi-code/skills/` (walking up to the git root). Each
 * context-file set is surfaced as one user-invocable `agents-md` skill whose
 * body is the concatenated file contents; every found `SKILL.md` catalog entry
 * is surfaced under its own name, so the dsh skill-injection seam (`/name`
 * gestures) can carry them into the prompt.
 *
 * Unlike pi and Codex, Kimi has no user-level instruction file: its user
 * install root holds only the skills catalog.
 *
 * The generic `~/.agents/skills/` and `.agents/skills/` roots are deliberately
 * not scanned here: dsh's own `skill-filesystem` provider already exposes them
 * through the same registry in the web profile. Kimi built-in Skills are
 * shipped inside the CLI and cannot be read from a stable on-disk location, so
 * the filesystem subset above is authoritative for the web menu. Note the
 * shared {@link parseSkillFile} mirrors the agents-skill frontmatter
 * (`name`/`description`/`whenToUse`/`disable-model-invocation`); Kimi's own
 * `disableModelInvocation`/`type` fields are not translated, so a `type: flow`
 * skill is surfaced as model-invocable.
 *
 * The discovery algorithm itself lives in {@link AgentsMdSkillProvider}; this
 * module supplies only Kimi's locations and ranks.
 *
 * @module dsh-loop-engine/engine-kimi/skills
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ContextFilePolicy } from '../driver-core/context-files.ts'
import { AgentsMdSkillProvider, type AgentsMdProviderSpec } from '../driver-core/agents-md-skill-provider.ts'
import type { SkillProviderControl } from '../skills.ts'

/** Project `agents-md` rank — between project-dsh (100) and custom (300). */
const KIMI_AGENTS_PROJECT_RANK = 140
/** Project `.kimi-code/skills/` rank — project AGENTS.md beats project skills. */
const KIMI_SKILL_PROJECT_RANK = 150
/** User `~/.kimi-code/skills/` rank — project files win duplicate names. */
const KIMI_SKILL_USER_RANK = 160
/** Kimi context-file policy: `AGENTS.md` only (what the CLI reads per directory). */
const KIMI_CONTEXT_POLICY = {
  primary: ['AGENTS.md'],
} satisfies ContextFilePolicy

/**
 * Resolve the Kimi config directory, honoring the `KIMI_CODE_HOME` environment
 * override and falling back to `~/.kimi-code`.
 * @returns the absolute Kimi config directory.
 */
export function kimiAgentDir(): string {
  const override = process.env.KIMI_CODE_HOME
  if (override !== undefined && override.length > 0) return resolve(override)
  return join(homedir(), '.kimi-code')
}

/** Kimi's discovery surface: `AGENTS.md` context files and `.kimi-code/skills/`. */
const KIMI_SPEC: AgentsMdProviderSpec = {
  name: 'kimi',
  agentsMdDescription: 'Kimi project instructions (AGENTS.md)',
  contextPolicy: KIMI_CONTEXT_POLICY,
  userDir: kimiAgentDir,
  projectRank: KIMI_AGENTS_PROJECT_RANK,
  skills: {
    project: ['.kimi-code', 'skills'],
    projectRank: KIMI_SKILL_PROJECT_RANK,
    userDir: 'skills',
    userRank: KIMI_SKILL_USER_RANK,
  },
}

/**
 * Skill provider that discovers context files and skills from Kimi's standard
 * locations:
 *   - project `AGENTS.md` files between the cwd and the git root — surfaced as
 *     one `agents-md` skill;
 *   - project `.kimi-code/skills/` and user `~/.kimi-code/skills/` — each
 *     `SKILL.md` entry surfaced under its own name.
 */
export class KimiSkillProvider extends AgentsMdSkillProvider {
  constructor(control: SkillProviderControl) {
    super(KIMI_SPEC, control)
  }
}

export default KimiSkillProvider
