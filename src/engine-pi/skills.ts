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
 * The discovery algorithm itself lives in {@link AgentsMdSkillProvider}; this
 * module supplies only Pi's locations and ranks.
 *
 * @module dsh-loop-engine/engine-pi/skills
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ContextFilePolicy } from '../driver-core/context-files.ts'
import { AgentsMdSkillProvider, type AgentsMdProviderSpec } from '../driver-core/agents-md-skill-provider.ts'
import type { SkillProviderControl } from '../skills.ts'

/** Project `agents-md` rank — between project-dsh (100) and custom (300). */
const PI_AGENTS_PROJECT_RANK = 140
/** Project `.pi/skills/` rank — project AGENTS.md beats project skills. */
const PI_SKILL_PROJECT_RANK = 150
/** User `agents-md` rank — project files win duplicate names. */
const PI_AGENTS_USER_RANK = 160
/** User `~/.pi/agent/skills/` rank. */
const PI_SKILL_USER_RANK = 170
/** Pi context-file policy: `AGENTS.md`/`CLAUDE.md`, `AGENTS.override.md` wins. */
const PI_CONTEXT_POLICY = {
  override: 'AGENTS.override.md',
  primary: ['AGENTS.md', 'CLAUDE.md'],
} satisfies ContextFilePolicy

/**
 * Resolve the pi config directory, honoring the `PI_CODING_AGENT_DIR`
 * environment override and falling back to `~/.pi/agent`.
 * @returns the absolute pi config directory.
 */
export function piAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR
  if (override !== undefined && override.length > 0) return resolve(override)
  return join(homedir(), '.pi', 'agent')
}

/** Pi's discovery surface: `AGENTS.md`/`CLAUDE.md` context files and `.pi/skills/`. */
const PI_SPEC: AgentsMdProviderSpec = {
  name: 'pi',
  agentsMdDescription: 'Pi project/user instructions (AGENTS.md / CLAUDE.md)',
  contextPolicy: PI_CONTEXT_POLICY,
  userDir: piAgentDir,
  projectRank: PI_AGENTS_PROJECT_RANK,
  userContext: { file: 'AGENTS.md', rank: PI_AGENTS_USER_RANK },
  skills: {
    project: ['.pi', 'skills'],
    projectRank: PI_SKILL_PROJECT_RANK,
    userDir: 'skills',
    userRank: PI_SKILL_USER_RANK,
  },
}

/**
 * Skill provider that discovers context files and skills from pi's standard
 * locations:
 *   - project context files between the cwd and the git root (plus
 *     `~/.pi/agent/AGENTS.md`) — surfaced as one `agents-md` skill;
 *   - project `.pi/skills/` and user `~/.pi/agent/skills/` — each `SKILL.md`
 *     entry surfaced under its own name.
 */
export class PiSkillProvider extends AgentsMdSkillProvider {
  constructor(control: SkillProviderControl) {
    super(PI_SPEC, control)
  }
}

export default PiSkillProvider
