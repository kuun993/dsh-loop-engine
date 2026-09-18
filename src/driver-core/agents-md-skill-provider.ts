/**
 * Data-driven skill provider for the hosted engines whose discovery surface is
 * "per-directory instruction files plus a skills catalog".
 *
 * Codex, Pi, and Kimi Code each expose the same two things through the dsh
 * skill-injection seam: an `agents-md` candidate merging the per-directory
 * instruction files found between the session cwd and the git root, and one
 * candidate per `SKILL.md` catalog entry. Only the *locations*, *names*, and
 * *precedence ranks* differ — never the algorithm — so those are the entire
 * configuration surface here, and each engine module supplies one
 * {@link AgentsMdProviderSpec} and a thin subclass.
 *
 * `.agents/skills` roots are deliberately absent from every engine's spec:
 * dsh's own `skill-filesystem` provider already serves them through the same
 * registry in the web profile.
 *
 * @module dsh-loop-engine/driver-core/agents-md-skill-provider
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  anySourceNonEmpty,
  collectProjectContextFiles,
  fileNonEmpty,
  projectAncestors,
  readSources,
  type ContextFilePolicy,
} from './context-files.ts'
import { parseSkillFile, type ParsedSkill } from '../skills.ts'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl } from '../skills.ts'

/** Name of the merged per-directory instruction candidate. */
const AGENTS_MD = 'agents-md'

/** Locator for the merged `agents-md` candidate. */
interface AgentsMdLocator {
  readonly kind: 'agents-md'
  /** Existing context files, nearest directory first. */
  readonly paths: readonly string[]
}

/** Locator for one parsed `SKILL.md` entry. */
interface SkillFileLocator {
  readonly kind: 'skill-file'
  readonly path: string
}

/** A skills catalog: a per-ancestor project directory plus one user-level directory. */
export interface SkillCatalogSpec {
  /** Directory path, relative to each ancestor of the session cwd. */
  readonly project: readonly string[]
  /** Rank of project catalog entries — project instructions beat project skills. */
  readonly projectRank: number
  /** Directory name under the user install root. */
  readonly userDir: string
  /** Rank of user catalog entries — project files win duplicate names. */
  readonly userRank: number
}

/** Everything that varies between the codex, pi, and kimi discovery surfaces. */
export interface AgentsMdProviderSpec {
  /** Provider identity registered against the host skills service. */
  readonly name: string
  /** Description of the merged `agents-md` candidate. */
  readonly agentsMdDescription: string
  /** Per-directory instruction files this engine reads, and its override. */
  readonly contextPolicy: ContextFilePolicy
  /** The engine's user-level install root. */
  readonly userDir: () => string
  /** Rank of the project `agents-md` candidate. */
  readonly projectRank: number
  /** User-level instruction file inside {@link userDir}, when the engine reads one. */
  readonly userContext?: { readonly file: string; readonly rank: number }
  /** Skill catalogs, when the engine has any. */
  readonly skills?: SkillCatalogSpec
}

/**
 * Skill provider that discovers an engine's per-directory instruction files and
 * `SKILL.md` catalogs from the locations its spec names.
 */
export class AgentsMdSkillProvider implements SkillProvider {
  readonly name: string

  constructor(
    private readonly spec: AgentsMdProviderSpec,
    private readonly control: SkillProviderControl,
  ) {
    this.name = spec.name
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    const cwd = options.cwd
    if (cwd !== undefined) {
      const contextPaths = await collectProjectContextFiles(cwd, this.spec.contextPolicy)
      if (await anySourceNonEmpty(contextPaths)) candidates.push(this.agentsCandidate(contextPaths, this.spec.projectRank))
      if (this.spec.skills !== undefined) {
        const catalog = this.spec.skills
        for (const dir of await projectAncestors(cwd)) {
          await this.collectSkillsDir(join(dir, ...catalog.project), catalog.projectRank, candidates)
        }
      }
    }
    const userDir = this.spec.userDir()
    const userContext = this.spec.userContext
    if (userContext !== undefined) {
      const userFile = join(userDir, userContext.file)
      if (await fileNonEmpty(userFile)) candidates.push(this.agentsCandidate([userFile], userContext.rank))
    }
    if (this.spec.skills !== undefined) {
      await this.collectSkillsDir(join(userDir, this.spec.skills.userDir), this.spec.skills.userRank, candidates)
    }
    if (this.control.signal.aborted) return []
    return candidates
  }

  async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as AgentsMdLocator | SkillFileLocator
    if (locator.kind === 'skill-file') {
      const parsed = await this.tryParse(locator.path)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
        invocation: parsed.invocation,
        source: candidate.source,
        provider: this.name,
        content: parsed.content,
        path: locator.path,
        resourceBase: { kind: 'directory', path: dirname(locator.path) },
      }
    }
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
      name: AGENTS_MD,
      description: this.spec.agentsMdDescription,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom',
      provider: this.name,
      rank,
      locator: { kind: 'agents-md', paths } satisfies AgentsMdLocator,
      path: first,
      resourceBase: { kind: 'file', path: first },
    }
  }

  /** Collect every skill in one skills directory, both nesting layouts. */
  private async collectSkillsDir(skillsDir: string, rank: number, candidates: SkillCandidate[]): Promise<void> {
    let entries
    try {
      entries = await readdir(skillsDir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return // missing or unreadable — no skills from this root
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = join(skillsDir, entry.name)
      // stat follows links: Windows skill installers use junctions, whose
      // Dirent reports neither isFile() nor isDirectory().
      /* v8 ignore start -- stat only loses a mid-listing delete race */
      /* v8 ignore next -- see above */
      const info = await stat(entryPath).catch(() => undefined)
      if (info === undefined) continue
      /* v8 ignore stop */
      if (info.isDirectory()) {
        const path = join(entryPath, 'SKILL.md')
        const parsed = await this.tryParse(path)
        if (parsed === undefined) continue
        candidates.push(this.skillCandidate(parsed, path, rank, entryPath))
        continue
      }
      // Flat root `<name>.md` files are discovered as individual skills.
      if (!entry.name.endsWith('.md')) continue
      const parsed = await this.tryParse(entryPath)
      if (parsed === undefined) continue
      candidates.push(this.skillCandidate(parsed, entryPath, rank, skillsDir))
    }
  }

  /** One parsed skill as a ranked candidate. */
  private skillCandidate(skill: ParsedSkill, path: string, rank: number, resourceDir: string): SkillCandidate {
    return {
      name: skill.name,
      description: skill.description,
      ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
      invocation: skill.invocation,
      source: 'custom',
      provider: this.name,
      rank,
      locator: { kind: 'skill-file', path } satisfies SkillFileLocator,
      path,
      resourceBase: { kind: 'directory', path: resourceDir },
    }
  }

  /** Parse one SKILL.md file, or `undefined` when it is unreadable or invalid. */
  private async tryParse(path: string): Promise<ParsedSkill | undefined> {
    try {
      const raw = await readFile(path, { encoding: 'utf8' })
      return parseSkillFile(raw)
    } catch {
      return undefined
    }
  }
}
