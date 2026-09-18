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
 * The discovery algorithm itself lives in {@link AgentsMdSkillProvider}; this
 * module supplies only Codex's locations and ranks — and, having no skills
 * catalog, no `skills` entry.
 *
 * @module dsh-loop-engine/engine-codex/skills
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ContextFilePolicy } from '../driver-core/context-files.ts'
import { AgentsMdSkillProvider, type AgentsMdProviderSpec } from '../driver-core/agents-md-skill-provider.ts'
import type { SkillProviderControl } from '../skills.ts'

/** Rank between project-dsh (100) and custom (300) — project AGENTS.md beats project skills. */
const CODEX_PROJECT_RANK = 140
/** User-level (`~/.codex/AGENTS.md`) rank — project files win duplicate names. */
const CODEX_USER_RANK = 160
/** Project context-file policy: `AGENTS.md` only, no per-directory override. */
const CODEX_CONTEXT_POLICY = { primary: ['AGENTS.md'] } satisfies ContextFilePolicy

/** Codex's discovery surface: `AGENTS.md` files only, with no skills catalog. */
const CODEX_SPEC: AgentsMdProviderSpec = {
  name: 'codex',
  agentsMdDescription: 'Codex project/user instructions (AGENTS.md)',
  contextPolicy: CODEX_CONTEXT_POLICY,
  userDir: () => join(homedir(), '.codex'),
  projectRank: CODEX_PROJECT_RANK,
  userContext: { file: 'AGENTS.md', rank: CODEX_USER_RANK },
}

/**
 * Skill provider that discovers `AGENTS.md` from every directory between the
 * project cwd and the git root, plus the user home `~/.codex/AGENTS.md`.
 */
export class CodexSkillProvider extends AgentsMdSkillProvider {
  constructor(control: SkillProviderControl) {
    super(CODEX_SPEC, control)
  }
}

export default CodexSkillProvider
