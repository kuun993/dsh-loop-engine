/**
 * Codex skill provider: exposes the codex CLI's instruction files as DSH
 * skills. Codex has no per-skill catalog like Claude Code's `.claude/skills/`;
 * it reads project and user instruction files named `AGENTS.md`. Each found
 * `AGENTS.md` is surfaced as a single user-invocable skill whose content is
 * the file body, so the dsh skill-injection seam (`/name` gestures) can carry
 * it into the prompt.
 *
 * @module @kuun993/dsh-loop-engine/engine-codex/skills
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  findProjectRoot,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
} from '../skills.ts'

/** Provider identity registered against the host skills service. */
const PROVIDER_NAME = 'codex'
/** Rank between project-dsh (100) and custom (300) — project AGENTS.md beats project skills. */
const CODEX_PROJECT_RANK = 140
/** User-level (`~/.codex/AGENTS.md`) rank — project files win duplicate names. */
const CODEX_USER_RANK = 160

/** Locator for an AGENTS.md candidate. */
interface AgentsMdLocator {
  readonly kind: 'agents-md'
  readonly path: string
}

/**
 * Skill provider that discovers `AGENTS.md` from the project root (git root
 * when one exists) and the user home `~/.codex/AGENTS.md`.
 */
export class CodexSkillProvider implements SkillProvider {
  readonly name = PROVIDER_NAME

  constructor(private readonly control: SkillProviderControl) {}

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    const cwd = options.cwd
    if (cwd !== undefined) {
      const projectRoot = await findProjectRoot(resolve(cwd))
      await this.collectAgentsMd(join(projectRoot, 'AGENTS.md'), CODEX_PROJECT_RANK, candidates)
    }
    await this.collectAgentsMd(join(homedir(), '.codex', 'AGENTS.md'), CODEX_USER_RANK, candidates)
    if (this.control.signal.aborted) return []
    return candidates
  }

  async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as AgentsMdLocator
    try {
      const content = await readFile(locator.path, { encoding: 'utf8' })
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        source: candidate.source,
        provider: this.name,
        content,
        path: locator.path,
        /* v8 ignore next -- every candidate from collectAgentsMd carries a resourceBase */
        ...candidate.resourceBase !== undefined ? { resourceBase: candidate.resourceBase } : {},
      }
    } catch {
      return undefined
    }
  }

  /** Read one AGENTS.md file and push a candidate when it exists. */
  private async collectAgentsMd(path: string, rank: number, candidates: SkillCandidate[]): Promise<void> {
    try {
      const content = await readFile(path, { encoding: 'utf8' })
      if (content.trim().length === 0) return
      candidates.push({
        name: 'agents-md',
        description: 'Codex project/user instructions (AGENTS.md)',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'custom',
        provider: this.name,
        rank,
        locator: { kind: 'agents-md', path } satisfies AgentsMdLocator,
        path,
        resourceBase: { kind: 'file', path },
      })
    } catch {
      // Missing file — no candidate.
    }
  }
}

export default CodexSkillProvider
