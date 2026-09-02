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
 * @module dsh-loop-engine/engine-kimi/skills
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  anySourceNonEmpty,
  collectProjectContextFiles,
  projectAncestors,
  readSources,
  type ContextFilePolicy,
} from '../driver-core/context-files.ts'
import { parseSkillFile, type ParsedSkill } from '../skills.ts'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl } from '../skills.ts'

/** Provider identity registered against the host skills service. */
const PROVIDER_NAME = 'kimi'
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

/**
 * Skill provider that discovers context files and skills from Kimi's standard
 * locations:
 *   - project `AGENTS.md` files between the cwd and the git root — surfaced as
 *     one `agents-md` skill;
 *   - project `.kimi-code/skills/` and user `~/.kimi-code/skills/` — each
 *     `SKILL.md` entry surfaced under its own name.
 */
export class KimiSkillProvider implements SkillProvider {
  readonly name = PROVIDER_NAME

  constructor(private readonly control: SkillProviderControl) {}

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    const cwd = options.cwd
    if (cwd !== undefined) {
      const projectDirs = await projectAncestors(cwd)
      const contextPaths = await collectProjectContextFiles(cwd, KIMI_CONTEXT_POLICY)
      if (await anySourceNonEmpty(contextPaths)) candidates.push(this.agentsCandidate(contextPaths, KIMI_AGENTS_PROJECT_RANK))
      for (const dir of projectDirs) {
        await this.collectSkillsDir(join(dir, '.kimi-code', 'skills'), KIMI_SKILL_PROJECT_RANK, candidates)
      }
    }
    await this.collectSkillsDir(join(kimiAgentDir(), 'skills'), KIMI_SKILL_USER_RANK, candidates)
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
      name: 'agents-md',
      description: 'Kimi project instructions (AGENTS.md)',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom',
      provider: this.name,
      rank,
      locator: { kind: 'agents-md', paths } satisfies AgentsMdLocator,
      path: first,
      resourceBase: { kind: 'file', path: first },
    }
  }

  /** Collect every skill in one skills directory, both kimi layouts. */
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

export default KimiSkillProvider
