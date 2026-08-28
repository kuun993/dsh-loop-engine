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

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  anySourceNonEmpty,
  collectProjectContextFiles,
  fileNonEmpty,
  readSources,
  type ContextFilePolicy,
} from '../driver-core/context-files.ts'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl } from '../skills.ts'

/** Provider identity registered against the host skills service. */
const PROVIDER_NAME = 'codex'
/** Rank between project-dsh (100) and custom (300) — project AGENTS.md beats project skills. */
const CODEX_PROJECT_RANK = 140
/** User-level (`~/.codex/AGENTS.md`) rank — project files win duplicate names. */
const CODEX_USER_RANK = 160
/** Project context-file policy: `AGENTS.md` only, no per-directory override. */
const CODEX_CONTEXT_POLICY = { primary: ['AGENTS.md'] } satisfies ContextFilePolicy

/** Locator for the merged `agents-md` candidate. */
interface AgentsMdLocator {
  readonly kind: 'agents-md'
  /** Existing context files, nearest directory first. */
  readonly paths: readonly string[]
}

/**
 * Skill provider that discovers `AGENTS.md` from every directory between the
 * project cwd and the git root, plus the user home `~/.codex/AGENTS.md`.
 */
export class CodexSkillProvider implements SkillProvider {
  readonly name = PROVIDER_NAME

  constructor(private readonly control: SkillProviderControl) {}

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    const cwd = options.cwd
    if (cwd !== undefined) {
      const paths = await collectProjectContextFiles(cwd, CODEX_CONTEXT_POLICY)
      if (await anySourceNonEmpty(paths)) candidates.push(this.agentsCandidate(paths, CODEX_PROJECT_RANK))
    }
    const userPath = join(homedir(), '.codex', 'AGENTS.md')
    if (await fileNonEmpty(userPath)) candidates.push(this.agentsCandidate([userPath], CODEX_USER_RANK))
    if (this.control.signal.aborted) return []
    return candidates
  }

  async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as AgentsMdLocator
    const content = await readSources(locator.paths)
    if (content === undefined) return undefined
    // Every candidate is constructed from a non-empty file set.
    const first = locator.paths[0]!
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: this.name,
      content,
      path: first,
      resourceBase: { kind: 'file', path: first },
    }
  }

  /** One merged `agents-md` candidate for a ranked file set. */
  private agentsCandidate(paths: readonly string[], rank: number): SkillCandidate {
    // Every caller only constructs candidates from a non-empty file set.
    const first = paths[0]!
    return {
      name: 'agents-md',
      description: 'Codex project/user instructions (AGENTS.md)',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom',
      provider: this.name,
      rank,
      locator: { kind: 'agents-md', paths } satisfies AgentsMdLocator,
      path: first,
      resourceBase: { kind: 'file', path: first },
    }
  }
}

export default CodexSkillProvider