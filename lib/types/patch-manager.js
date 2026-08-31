/**
 * Managed-block editing for a profile's `cordis.patch.yml`.
 *
 * The plugin owns one contiguous block inside the user's patch file, delimited
 * by a begin/end marker pair, and rewrites only that span on engine switches
 * — everything else the user wrote (other patches, their comments) survives
 * byte for byte. The block's content is the loader patch that takes the loop
 * engine over: it disables the base bundle's `agent-loop` row so this plugin's
 * factory (hosted by dsh-loop-engine) can register without colliding, because
 * the harness admits exactly one AgentFactory:
 *
 *   # -- dsh-loop-engine managed block: claude-code --
 *   - id: agent-loop
 *     disabled: true
 *   # -- /dsh-loop-engine managed block --
 *
 * `in-process` renders an absent block (the base bundle's `agent-loop` row
 * stays active and supplies the factory), so switching back removes the span
 * entirely. Any other engine renders the same disable block, and the begin
 * marker carries the specific engine id (`# -- dsh-loop-engine managed block:
 * claude-code --`) so `currentEngineOf` can read which non-default engine owns
 * the slot from the file alone. All functions here are pure string transforms —
 * file I/O and durability live in the plugin's apply.
 *
 * @module dsh-loop-engine/patch-manager
 */
import { LOOP_ENGINE_IDS } from "./settings.js";
/** Begin marker of the plugin-managed span inside a profile patch file. */
export const MANAGED_BLOCK_BEGIN = '# -- dsh-loop-engine managed block: ';
/** End marker of the plugin-managed span inside a profile patch file. */
export const MANAGED_BLOCK_END = '# -- /dsh-loop-engine managed block --';
/** The block's trailing newline convention (one blank line before the end marker). */
const END_MARKER_LINE = `${MANAGED_BLOCK_END}\n`;
/** Render the managed block for one engine; `in-process` returns the empty span. */
export function renderManagedBlock(engine) {
    if (engine === 'in-process')
        return '';
    return [
        `${MANAGED_BLOCK_BEGIN}${engine} --`,
        '- id: agent-loop',
        '  disabled: true',
        END_MARKER_LINE,
    ].join('\n');
}
/** Whether a patch-file text contains the managed block span. */
export function hasManagedBlock(text) {
    return text.includes(MANAGED_BLOCK_BEGIN);
}
/** Begin-marker line pattern carrying the engine name (`<name>` is the engine id). */
const BEGIN_MARKER_RE = /^# -- dsh-loop-engine managed block: (\S+) --$/m;
/** Derive the current engine from a patch-file text by the managed block's begin marker. */
export function currentEngineOf(text) {
    const engine = BEGIN_MARKER_RE.exec(text)?.[1];
    return LOOP_ENGINE_IDS.includes(engine ?? '')
        ? engine
        : 'in-process';
}
/** Split a patch-file text at the managed span; absent span means it appends. */
function managedSpan(text) {
    const begin = text.indexOf(MANAGED_BLOCK_BEGIN);
    if (begin === -1)
        return { head: text, tail: '', present: false, blankBefore: false };
    const afterBegin = begin + MANAGED_BLOCK_BEGIN.length;
    const endAt = text.indexOf(MANAGED_BLOCK_END, afterBegin);
    const spanEnd = endAt === -1 ? text.length : endAt + END_MARKER_LINE.length;
    // The plugin writes one blank line before its begin marker; preserve it when
    // removing the span so the file does not accumulate blank lines.
    const before = text.slice(0, begin);
    const blankBefore = before.endsWith('\n\n');
    return {
        head: blankBefore ? before.slice(0, -1) : before,
        tail: text.slice(spanEnd),
        present: true,
        blankBefore,
    };
}
/** Normalize a file so the managed span sits on its own lines with a blank separator. */
function ensureTrailingNewline(text) {
    return text.endsWith('\n') ? text : `${text}\n`;
}
/**
 * A line holding only an empty flow sequence — the body dsh writes into a fresh
 * profile's `cordis.patch.yml`.
 */
const EMPTY_FLOW_SEQ_RE = /^[ \t]*\[\][ \t]*$/;
/**
 * Whether the text's only YAML content is an empty flow sequence (`[]`).
 * Comments and blank lines do not count as content.
 */
function isEmptyFlowSeqDocument(text) {
    let sawEmptySeq = false;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#'))
            continue;
        if (!sawEmptySeq && EMPTY_FLOW_SEQ_RE.test(line)) {
            sawEmptySeq = true;
            continue;
        }
        return false;
    }
    return sawEmptySeq;
}
/**
 * Drop the sole `[]` body, keeping every comment and blank line.
 *
 * `[]` is a complete flow-style document: appending block sequence items after
 * it is a YAML syntax error, so it has to go before a block can be written. An
 * empty list carries no information, so removing it loses nothing.
 */
function stripEmptyFlowSeq(text) {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => EMPTY_FLOW_SEQ_RE.test(line));
    if (at === -1)
        return text;
    lines.splice(at, 1);
    return lines.join('\n');
}
/**
 * Produce the next patch-file text for a target engine, preserving every byte
 * outside the managed span. Appends the span when absent; replaces or removes
 * it when present.
 *
 * The file must always parse as a top-level YAML *array*: app-boot's
 * `parsePatchList` throws `must be a top-level YAML array of loader patch
 * entries` on anything else, which fails the whole plugin tree — including this
 * plugin's own `insert` row, so no agent factory registers at all.
 *
 * That constrains both directions:
 *   - A fresh profile's file is `[]`, a complete flow-style document. Block
 *     sequence items cannot follow it, so the `[]` is dropped when a block goes
 *     in.
 *   - Removing the last block must not leave a comments-only file: that parses
 *     as `null`, not `[]`. The `[]` is restored so the list stays a list.
 *
 * @param text - current patch-file text.
 * @param engine - target engine.
 * @returns the rewritten patch-file text.
 */
export function applyManagedBlock(text, engine) {
    const block = renderManagedBlock(engine);
    const span = managedSpan(text);
    if (!span.present) {
        if (block === '')
            return text;
        const base = ensureTrailingNewline(isEmptyFlowSeqDocument(text) ? stripEmptyFlowSeq(text).trimEnd() : text);
        return `${base}\n${block}`;
    }
    if (block === '') {
        // Collapse the blank separator that preceded the removed span so repeated
        // switches do not accumulate blank lines; the head already shed one blank
        // in managedSpan, and the tail's leading blank is the span's own newline.
        const removed = span.tail.startsWith('\n')
            ? `${span.head}${span.tail.slice(1)}`
            : `${span.head}${span.tail}`;
        return hasYamlContent(removed) ? removed : withEmptyFlowSeq(removed);
    }
    return `${span.head}${span.blankBefore ? '\n' : ''}${block}${span.tail}`;
}
/** Whether a patch-file text carries YAML content (not just comments and blanks). */
function hasYamlContent(text) {
    return text.split('\n').some((line) => {
        const trimmed = line.trim();
        return trimmed !== '' && !trimmed.startsWith('#');
    });
}
/** Re-add the `[]` body so a comments-only file still parses as a patch list. */
function withEmptyFlowSeq(text) {
    if (text.trim() === '')
        return '[]\n';
    return `${ensureTrailingNewline(text.trimEnd())}[]\n`;
}
//# sourceMappingURL=patch-manager.js.map