/**
 * Context-file collection and body loading shared by the hosted engine
 * drivers.
 *
 * Codex and Pi read per-directory instruction files (`AGENTS.md`; pi also
 * accepts `CLAUDE.md` and prefers `AGENTS.override.md` inside any directory
 * that has one) while walking from the session cwd up to the git root. The
 * skill providers surface each collected set as one merged skill candidate so
 * the dsh skill-injection seam (`/name` gestures) can carry it into the
 * prompt; the body-loading helpers below feed both providers' list/get paths.
 *
 * @module dsh-loop-engine/driver-core/context-files
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { findProjectRoot } from '../skills.ts'

/** Per-directory context-file resolution policy for one engine. */
export interface ContextFilePolicy {
  /** Per-directory override file that replaces the primary files when present. */
  readonly override?: string
  /** Per-directory primary files, tried in order until one exists. */
  readonly primary: readonly string[]
}

/**
 * The directory chain from `cwd` up to the git root, nearest first. Without a
 * repository the chain is just the resolved `cwd` itself, matching
 * {@link findProjectRoot}'s fallback so the walk stays bounded.
 * @param cwd - the session working directory.
 * @returns the chain of directories to inspect.
 */
export async function projectAncestors(cwd: string): Promise<string[]> {
  const root = await findProjectRoot(resolve(cwd))
  const dirs: string[] = []
  let current = resolve(cwd)
  while (true) {
    dirs.push(current)
    if (current === root) return dirs
    current = resolve(current, '..')
  }
}

/**
 * Collect every directory's context file per the policy, from the session cwd
 * up to the git root.
 * @param cwd - the session working directory.
 * @param policy - per-directory resolution policy.
 * @returns existing context files, nearest directory first.
 */
export async function collectProjectContextFiles(cwd: string, policy: ContextFilePolicy): Promise<string[]> {
  const files: string[] = []
  for (const dir of await projectAncestors(cwd)) {
    const chosen = await dirContextFile(dir, policy)
    if (chosen !== undefined) files.push(chosen)
  }
  return files
}

/** Resolve the context file one directory contributes, or `undefined` for none. */
async function dirContextFile(dir: string, policy: ContextFilePolicy): Promise<string | undefined> {
  if (policy.override !== undefined) {
    const override = join(dir, policy.override)
    if (await pathExists(override)) return override
  }
  for (const name of policy.primary) {
    const candidate = join(dir, name)
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

/** Whether a path exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read one file, or `undefined` when it is unreadable.
 * @param path - the file to read.
 * @returns the file body, or `undefined` on any failure.
 */
export async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, { encoding: 'utf8' })
  } catch {
    return undefined
  }
}

/**
 * Whether any of the given sources carries non-whitespace content.
 * @param paths - candidate file paths.
 * @returns whether at least one readable source is non-empty.
 */
export async function anySourceNonEmpty(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    const raw = await readOptionalFile(path)
    if (raw !== undefined && raw.trim().length > 0) return true
  }
  return false
}

/**
 * Whether one file exists and carries non-whitespace content.
 * @param path - the file to inspect.
 * @returns whether the file is readable and non-empty.
 */
export async function fileNonEmpty(path: string): Promise<boolean> {
  const raw = await readOptionalFile(path)
  return raw !== undefined && raw.trim().length > 0
}

/**
 * Concatenate every non-empty readable source body in order, or `undefined`
 * when none are readable.
 * @param paths - candidate file paths, nearest directory first.
 * @returns the joined bodies, or `undefined` when nothing could be read.
 */
export async function readSources(paths: readonly string[]): Promise<string | undefined> {
  const parts: string[] = []
  for (const path of paths) {
    const raw = await readOptionalFile(path)
    if (raw !== undefined && raw.trim().length > 0) parts.push(raw)
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}