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
/** Per-directory context-file resolution policy for one engine. */
export interface ContextFilePolicy {
    /** Per-directory override file that replaces the primary files when present. */
    readonly override?: string;
    /** Per-directory primary files, tried in order until one exists. */
    readonly primary: readonly string[];
}
/**
 * The directory chain from `cwd` up to the git root, nearest first. Without a
 * repository the chain is just the resolved `cwd` itself, matching
 * {@link findProjectRoot}'s fallback so the walk stays bounded.
 * @param cwd - the session working directory.
 * @returns the chain of directories to inspect.
 */
export declare function projectAncestors(cwd: string): Promise<string[]>;
/**
 * Collect every directory's context file per the policy, from the session cwd
 * up to the git root.
 * @param cwd - the session working directory.
 * @param policy - per-directory resolution policy.
 * @returns existing context files, nearest directory first.
 */
export declare function collectProjectContextFiles(cwd: string, policy: ContextFilePolicy): Promise<string[]>;
/**
 * Read one file, or `undefined` when it is unreadable.
 * @param path - the file to read.
 * @returns the file body, or `undefined` on any failure.
 */
export declare function readOptionalFile(path: string): Promise<string | undefined>;
/**
 * Whether any of the given sources carries non-whitespace content.
 * @param paths - candidate file paths.
 * @returns whether at least one readable source is non-empty.
 */
export declare function anySourceNonEmpty(paths: readonly string[]): Promise<boolean>;
/**
 * Whether one file exists and carries non-whitespace content.
 * @param path - the file to inspect.
 * @returns whether the file is readable and non-empty.
 */
export declare function fileNonEmpty(path: string): Promise<boolean>;
/**
 * Concatenate every non-empty readable source body in order, or `undefined`
 * when none are readable.
 * @param paths - candidate file paths, nearest directory first.
 * @returns the joined bodies, or `undefined` when nothing could be read.
 */
export declare function readSources(paths: readonly string[]): Promise<string | undefined>;
//# sourceMappingURL=context-files.d.ts.map