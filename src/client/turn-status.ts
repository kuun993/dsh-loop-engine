/**
 * Per-engine styling for the chat turn-status line (the "深度求索中..." row).
 *
 * That row is rendered from inside the harness's ChatView and its words belong
 * to ui-chat: the row is not a slot, and ui-chat owns the `chat` locale
 * namespace (a second `locale.register` for the same namespace throws), so a
 * plugin cannot change the text. What it CAN do is restyle the element, and
 * that is all this module does — it paints an engine-specific glyph and color
 * onto the row while the session on screen runs a hosted engine, and leaves the
 * stock look alone otherwise.
 *
 * WHICH engine it paints is the SESSION ON SCREEN's, not the settings default.
 * {@link reflectTurnStatusEngine} is driven from the per-session engine cache
 * (`./session-engine.ts`) — the same authoritative answer the header chip and
 * the composer render from, the plugin's own Remote read off the session's
 * durable log — and it is driven by the ONE hook those two surfaces share
 * (`./use-session-engine.ts`). So this row cannot disagree with the two surfaces
 * beside it; while it was keyed off the settings store it did, and painted
 * Claude Code's glyph onto every session's row whenever claude-code was the
 * default, a session running pi included.
 *
 * The reflection's SUBJECT is still a document-level attribute rather than the
 * row's own element: the sheet has to reach a class the harness hashes (see
 * {@link ROW_SELECTORS}), which takes an attribute selector on an ancestor,
 * and the row offers no session-scoped hook for a plugin to hang it on — the one
 * attribute this module does put on a row ({@link LIVE_ATTR}) claims no session,
 * it says "the turn in flight is this one" and is re-derived every time the rows
 * change. A document-level attribute has exactly ONE owner at a time, though —
 * and on this page the WRITERS outnumber the reader: the chip and the composer of every
 * session that has been rendered carry an answer, the session the user has just
 * left included, and the cache publishes a session's answer regardless of what is
 * on screen. So "whoever reflected last" is not "the session on screen", and an
 * implementation that read it as one shipped the bug this guard ends: a
 * background session's answer — or the late answer of the session the user just
 * left — painted ITS engine onto the row of the session on screen, and a session
 * running pi showed Kimi's moon.
 *
 * The owner is therefore DECLARED, not inferred: a reflection names the session
 * it speaks for and writes only while that session is the row's focus
 * ({@link focusTurnStatusSession}); a reflection whose subject is not the focused
 * session is a NO-OP, so only the session on screen can paint and only it can
 * un-paint. The chip and the composer of one session reflect the same value (the
 * write is idempotent); the focus is withdrawn by
 * {@link blurTurnStatusSession}, which acts only while the focus is still the
 * departing session's (React runs a departing component's cleanup in no
 * guaranteed order against an arriving one's, so an unconditional withdrawal
 * would un-focus the session that just took over); and the attribute itself is
 * never withdrawn on unmount: the sibling surface of the same session still
 * paints by it, and a leftover attribute is inert on a page whose turn-status row
 * is not rendered.
 *
 * The paint is gated TWICE, and both gates are needed on the 0.1.7 line — the
 * 0.2.0 line needs neither of them, for the reason given below.
 *
 * First, on the session being MID-TURN, through a second document-level
 * attribute ({@link RUNNING_ATTR}, written from the same reflection). On the
 * 0.1.5 line the row only exists while a turn is in flight, so the engine
 * attribute alone was enough; on the 0.1.7 line that same button stays on screen
 * after the turn ends, as the collapsed summary that reads "用时 4秒" — an
 * engine-only gate leaves the glyph and the sweep animating on a finished turn,
 * which is not what the live line means. The gate is a surface's own answer
 * (`session.running`, which every session-scoped seat receives), so a surface
 * that cannot answer passes nothing and leaves it alone rather than guessing.
 *
 * Second, and this is the one a session-level gate cannot express: on the
 * 0.1.7 line EVERY turn's row stays on screen, so while turn N runs, turns
 * 1..N-1 are still there. A session-wide gate turns the whole sheet on for all
 * of them — the finished rows would wear the glyph again for as long as any
 * later turn ran. So the live row is MARKED, and the row selector is gated on
 * the mark (see {@link LIVE_ATTR}, {@link markLiveRow} and
 * {@link ROW_SELECTORS}): "the last row in the document" is the turn in flight,
 * because the rows are rendered in turn order and only the newest one can still
 * be running. The two gates answer different questions — "is a turn in flight
 * for this session" and "is this row the one it belongs to" — and neither alone
 * is enough.
 *
 * The 0.2.0 line needs NEITHER gate, because it moved the live row out of the
 * turn-process button. There the running indicator is the harness's own node —
 * `RunningStatus`, a `[data-chat-running]` div mounted only while the session
 * runs — and `TurnProcessNodeView` renders nothing at all until its turn closes,
 * so a turn-process button is now always a settled summary. The third sheet
 * ({@link sheetForRunning}) is therefore gated on the engine attribute alone,
 * and the per-row mark is not merely unnecessary there but WRONG:
 * {@link markLiveRow} stamps nothing while such a node is on screen, because the
 * last turn-process button on that page is a finished turn's summary — exactly
 * the row the mark exists to leave alone.
 *
 * Three facts about the harness markup make that safe and specific:
 *   - the row has one stable handle per harness generation — an
 *     `[hash]_turnStatus` class suffix on the 0.1.5 line, the
 *     `data-turn-process` button on the 0.1.7 line (whose text is a `<span>`
 *     whose hashed class ends `_label`), and the harness's own
 *     `data-chat-running` attribute on the 0.2.0 line — so each generation gets
 *     its own copy of the sheet ({@link ROW_SELECTORS}, {@link RUNNING_ROW}) and
 *     the one the running app renders matches while the others stay inert;
 *   - its colours paint through custom properties — the 0.1.x rows through the
 *     `--dsw-static-deepseek-*` gradient pair, 0.2.0's through the
 *     `--dsw-alias-label-deep-diving*` pair it resolves its own text colour and
 *     shimmer tint from — so recoloring is a variable override rather than a
 *     fight over `background` and `background-clip` or over the harness's own
 *     animation;
 *   - the glyph rides a `::before` pseudo-element, so the row's real text node
 *     — and the status it announces — is untouched.
 *
 * This sheet deliberately keeps the 0.1.x rows animating even when the OS
 * reports `prefers-reduced-motion: reduce` (see the re-asserted sweep below):
 * the deployment's Windows images ship with client-area animation off, which
 * otherwise freezes every indicator here — the sweep and the glyph alike. On the
 * 0.2.0 line the harness runs its own shimmer and honours that preference
 * itself, so the plugin neither re-declares it nor overrides it there; only the
 * glyph keeps animating. In-process sessions keep the stock reduced-motion
 * behaviour on every line.
 *
 * @module dsh-loop-engine/client/turn-status
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { LoopEngineId, HostedEngineId } from '../agent-preset-ids.ts'

/** Attribute on `<html>` naming the engine the session on screen runs; absent means stock. */
const ENGINE_ATTR = 'data-loop-engine'

/**
 * Attribute on `<html>` marking that the session on screen is mid-turn; absent
 * means it is not. Session-level half of the gate: the 0.1.7 rows outlive the
 * turns they belong to, and the per-row half is {@link LIVE_ATTR}. The 0.2.0
 * sheet is not gated on it — that generation's row only exists while the turn
 * does (see {@link sheetForRunning}) — but the attribute is written either way,
 * because which generation is running is not something the plugin can know.
 */
const RUNNING_ATTR = 'data-loop-engine-running'

/**
 * The 0.1.7 turn-process button: one per turn, in turn order, every one of them
 * still on screen after its turn ends. The row's only stable handle.
 */
const ROW_BUTTON = 'button[data-turn-process]'

/**
 * The 0.2.0 running row: the harness's own indicator, the `[data-chat-running]`
 * div `RunningStatus` mounts while the session on screen runs and unmounts when
 * the turn settles. It is live by construction — which is why this line needs
 * neither of the two gates the 0.1.x lines need (see the sheets below) and why
 * {@link markLiveRow} leaves it and the turn-process buttons alone.
 */
const RUNNING_ROW = '[data-chat-running]'

/**
 * Attribute this module stamps on the row of the turn in flight; absent means
 * no row is claimed. The per-ROW half of the gate — the session-level
 * {@link RUNNING_ATTR} says a turn is in flight for the session on screen, this
 * says which of the many rows still on screen is that turn's own. Written only
 * while the gate is on, and by {@link markLiveRow} only — which also means it is
 * never written on the 0.2.0 line, whose live row is the harness's own and is
 * never a turn-process row.
 */
const LIVE_ATTR = 'data-loop-engine-live'

/** Owning plugin id, stamped on the injected tag for identification. */
const PLUGIN_ID = 'dsh-loop-engine'

/**
 * One harness markup row a sheet restyles. The sheet is emitted once per
 * generation's anchor — these two for the 0.1.x lines and {@link RUNNING_ROW}
 * for 0.2.0 — and whichever the running app renders matches while the others
 * stay inert. The row moved between generations, so the selector is data here
 * rather than baked into the CSS.
 *
 * The two 0.1.x generations need DIFFERENT precision, and that difference is the
 * whole reason this is a list of selectors rather than one:
 *
 *   - the 0.1.5 row exists only while its turn runs, so "the row" and "the live
 *     turn" are the same thing and the plain class selector is exact;
 *   - the 0.1.7 row is a {@link ROW_BUTTON} that STAYS on screen after its turn
 *     ends, as the collapsed "用时 …" summary — one per turn, all of them still
 *     rendered. So the session-wide mid-turn gate alone is not enough: while
 *     turn N runs, turns 1..N-1 are on screen too and would be painted with it.
 *     The live one is picked out by {@link LIVE_ATTR}, which
 *     {@link markLiveRow} puts on the LAST row in the document. Nothing the row
 *     itself carries can stand in for it: the only state a row exposes is
 *     `disabled` (ui-chat's `disabled={!canCollapse}`, which reads "this turn
 *     cannot be collapsed" rather than "this turn is running"), and a turn that
 *     ended `aborted` or `error` is left disabled forever — a rule keyed on it
 *     paints exactly the zombie rows this mark exists to avoid, which is what
 *     the previous `:disabled` selector did.
 *
 * The 0.1.7 status text is a `<span>` whose hashed class ends `_label` (the
 * literal `.label` does not exist: the harness's CSS Modules name classes
 * `[hash]_[local]`).
 */
const ROW_SELECTORS = [
  /** 0.1.5 line: the turn-status row, whose class name ends `_turnStatus`. */
  '[class$="_turnStatus"]',
  /** 0.1.7 line: the marked live turn-process button, and its label span. */
  `${ROW_BUTTON}[${LIVE_ATTR}] [class$="_label"]`,
] as const

/**
 * The two custom properties a sheet drives a row's colour through, base colour
 * first and the lighter tint its sweep travels in second. The pair is written on
 * the row itself, so overriding them recolours both the text and its sweep
 * without touching either rule that paints them.
 */
type ColourVars = readonly [string, string]

/** The 0.1.x rows paint their DeepSeek gradient through these two. */
const GRADIENT_VARS: ColourVars = ['--dsw-static-deepseek-500', '--dsw-static-deepseek-200']

/** The 0.2.0 aliases `.running` resolves its text colour and overlay tint from. */
const RUNNING_VARS: ColourVars = ['--dsw-alias-label-deep-diving', '--dsw-alias-label-deep-diving-shimmer']

/** One engine's paint: the colours, the glyph and the animation that drives it. */
interface EnginePaint {
  /** The text's own colour — and the glyph's, where the glyph is not an emoji. */
  readonly colour: string
  /** The lighter tint the sweep (0.1.x gradient, 0.2.0 overlay) travels in. */
  readonly tint: string
  /** The glyph itself, unquoted; the glyph rule adds the `content` quoting. */
  readonly glyph: string
  /** Further declarations the glyph rule carries after `color`, in order. */
  readonly extras: readonly string[]
  /** The `animation` shorthand driving the glyph; its `@keyframes` is below. */
  readonly animation: string
}

/**
 * Every hosted engine's paint, in the order the sheets emit it.
 *
 * This is the one place an engine's identity on the row lives. The pair is the
 * same on every generation — a base colour and the lighter tint its sweep
 * travels in — and only the custom properties it is written to change, so a
 * sheet is this table emitted through that generation's selectors and variables
 * rather than a second copy of the four engines.
 */
const ENGINE_PAINT: ReadonlyArray<readonly [HostedEngineId, EnginePaint]> = [
  ['claude-code', {
    colour: '#d97757', tint: '#f5bda6', glyph: '✻', extras: [],
    animation: 'le-bloom 1.6s ease-in-out infinite',
  }],
  ['codex', {
    colour: '#a9b1c0', tint: '#e6eaf2', glyph: '•',
    extras: ['text-shadow: 0 0 6px currentColor'],
    animation: 'le-pulse 1.4s ease-in-out infinite',
  }],
  ['pi', {
    colour: '#8e4ec6', tint: '#d6bff0', glyph: '⠋', extras: ['font-size: 1.1em'],
    animation: 'le-braille 1s linear infinite',
  }],
  ['kimi', {
    colour: '#e5484d', tint: '#f5b2b4', glyph: '🌗', extras: [],
    animation: 'le-moon 2.5s linear infinite',
  }],
]

/**
 * Emit every engine's two rules for one sheet, as a block.
 *
 * Both selectors are given as a function of the engine because they are not
 * always the same element: the 0.1.x lines hang the glyph off the very element
 * they set the variables on, while 0.2.0 sets them on the running row and hangs
 * the glyph off the content row inside it (see {@link sheetForRunning}).
 * @param properties - the selector the two custom properties go on, per engine.
 * @param glyph - the selector the glyph hangs off, per engine; `::before` is appended.
 * @param vars - the two custom properties {@link ColourVars}, base first.
 * @returns the rules, one engine after another, blank-line separated.
 */
const engineRules = (
  properties: (engine: HostedEngineId) => string,
  glyph: (engine: HostedEngineId) => string,
  vars: ColourVars,
): string => ENGINE_PAINT.map(([engine, paint]) => `${properties(engine)} {
  ${vars[0]}: ${paint.colour};
  ${vars[1]}: ${paint.tint};
}
${glyph(engine)}::before {
  content: "${paint.glyph}";
  color: ${paint.colour};
  -webkit-text-fill-color: ${paint.colour};
${paint.extras.map(extra => `  ${extra};\n`).join('')}  animation: ${paint.animation};
}`).join('\n\n')

/**
 * The four glyph animations, emitted by every sheet so each generation's copy is
 * self-contained. `@keyframes` are document-global and not scoped by a selector,
 * so a duplicate name across the sheets is a duplicate of the same rule.
 */
const GLYPH_KEYFRAMES = `/* Grows from small to large each cycle — the opposite of a twinkle. The range
   is deliberately wide (3x) because a bare size change on a thin glyph reads
   weakly otherwise, and the large state is held briefly (50%-62%) so it blooms
   rather than throbs. 1.35x extends ~2.5px per side at the 14px glyph, inside
   the 6px ::before margin. */
@keyframes le-bloom {
  0%, 100% { transform: scale(0.45); opacity: 0.45; }
  50%, 62% { transform: scale(1.35); opacity: 1; }
}
/* A terminal braille spinner. The glyph is an ordinary text character, not an
   emoji, so the engine color actually paints — a colored emoji silently ignores
   color/-webkit-text-fill-color. Stepping content walks the ten dot frames. */
@keyframes le-braille {
  0% { content: "⠋"; }
  10% { content: "⠙"; }
  20% { content: "⠹"; }
  30% { content: "⠸"; }
  40% { content: "⠼"; }
  50% { content: "⠴"; }
  60% { content: "⠦"; }
  70% { content: "⠧"; }
  80% { content: "⠇"; }
  90% { content: "⠏"; }
  100% { content: "⠋"; }
}
/* A soft pulse for the codex dot: the glyph breathes between a small, dim
   point and a larger, full-brightness one — a light dot, not a spinner. */
@keyframes le-pulse {
  0%, 100% { transform: scale(0.5); opacity: 0.35; }
  50% { transform: scale(1.3); opacity: 1; }
}
/* Moon phases rather than a rigid rotation: a spinning moon bitmap can only
   squash and mirror itself, never show a full or a new moon. Stepping the
   glyph through the phase set sweeps the lit edge across the disc AND actually
   reaches 🌕 and 🌑. The order runs waning first (full → new → full), so the lit
   edge travels counter-clockwise, and the glyph under the row's first paint
   (🌗) is a mid-phase rather than a full or a new moon. */
@keyframes le-moon {
  0% { content: "🌕"; }
  12.5% { content: "🌖"; }
  25% { content: "🌗"; }
  37.5% { content: "🌘"; }
  50% { content: "🌑"; }
  62.5% { content: "🌒"; }
  75% { content: "🌓"; }
  87.5% { content: "🌔"; }
  100% { content: "🌕"; }
}`

/**
 * Emit the sheet once for one 0.1.x generation's row selector.
 * @param ROW - the generation's row anchor, from {@link ROW_SELECTORS}.
 */
const sheetFor = (ROW: string): string => {
  // Every rule is gated on the engine AND on the session being mid-turn, and on
  // the 0.1.7 line the row selector carries the live-row mark as well, so the
  // sheet is inert both for a stock row and for one that has finished.
  const GATE = `html[${ENGINE_ATTR}][${RUNNING_ATTR}]`
  // The 0.1.x rows set the variables and hang the glyph off the same element.
  const PER_ENGINE = (engine: HostedEngineId): string => `html[${ENGINE_ATTR}="${engine}"][${RUNNING_ATTR}] ${ROW}`
  return `
${GATE} ${ROW}::before {
  margin-right: 6px;
  background: none;
  -webkit-background-clip: border-box;
  background-clip: border-box;
}

/*
 * The engine-colored sweep — and, on the 0.1.7 line, the sweep itself.
 *
 * The 0.1.5 row paints its own gradient (a \`linear-gradient\` over
 * --dsw-static-deepseek-*, clipped to the text) and only needs its animation
 * re-asserted; this rule declares that same gradient so the 0.1.7 row, whose
 * turn-process button is plain tertiary text, gets the sweep back. Either way
 * the per-engine override below recolors it by swapping the two custom
 * properties. ui-chat disables the animation under
 * \`prefers-reduced-motion: reduce\`, and a media query carries no specificity —
 * so this attribute-gated rule outranks it. That is deliberate here:
 * deployment images ship with Windows' client-area animation off
 * (SPI_GETCLIENTAREAANIMATION false), and with the guard in force EVERY
 * indicator on this row is frozen — the sweep and the glyph alike. Scoped to
 * hosted engines, so in-process sessions keep the stock reduced-motion
 * behaviour; delete this rule and restore the guard at the foot of the sheet to
 * hand the decision back to the OS.
 */
${GATE} ${ROW} {
  background: linear-gradient(90deg,
    var(--dsw-static-deepseek-500) 0%,
    var(--dsw-static-deepseek-500) 40%,
    var(--dsw-static-deepseek-200) 50%,
    var(--dsw-static-deepseek-500) 60%,
    var(--dsw-static-deepseek-500) 100%);
  color: #0000;
  -webkit-text-fill-color: transparent;
  -webkit-background-clip: text;
  background-clip: text;
  background-position: 100% 0;
  background-size: 250% 100%;
  animation: le-shimmer 1.8s linear infinite;
}

@keyframes le-shimmer {
  to { background-position: 0 0; }
}

${engineRules(PER_ENGINE, PER_ENGINE, GRADIENT_VARS)}

${GLYPH_KEYFRAMES}

`
}

/**
 * Emit the 0.2.0 sheet: the harness's own running row, recoloured and given the
 * engine's glyph.
 *
 * 0.2.0 MOVED the live row. `TurnProcessNodeView` now returns nothing until its
 * turn closes — a turn-process button is a settled summary and nothing else — and
 * the running indicator is `RunningStatus`, which mounts a `[data-chat-running]`
 * div only while the session on screen runs. So that node is live by
 * construction, and this sheet is gated on the engine attribute alone: the
 * session-level mid-turn gate would be redundant, and the per-row mark would be
 * wrong ({@link markLiveRow} deliberately stamps nothing on this line).
 *
 * What is left to paint is correspondingly small. The row already carries its
 * own shimmer — 0.2.0's `TextShimmer` runs a decorative overlay it tints from
 * `--dsw-alias-label-shimmer`, which `.running` points at
 * `--dsw-alias-label-deep-diving-shimmer` — so rather than re-declaring a
 * gradient (which would fight the harness's own) the sheet only swaps the two
 * aliases the row resolves its colours from, and leaves the animation, and the
 * `prefers-reduced-motion` decision that comes with it, to the harness.
 *
 * The glyph then rides a `::before` on the CONTENT row rather than on the row
 * itself: that span is `display: inline-flex`, so the pseudo-element becomes its
 * first flex item — one `gap` to the left of the whale — with nothing to reset
 * and no margin to add. The variable block stays on the outer row, which is the
 * element `.running` declares the colour on.
 */
const sheetForRunning = (): string => {
  const PER_ENGINE = (engine: HostedEngineId): string => `html[${ENGINE_ATTR}="${engine}"] ${RUNNING_ROW}`
  const GLYPH = (engine: HostedEngineId): string => `${PER_ENGINE(engine)} [class$="_runningContent"]`
  return `
${engineRules(PER_ENGINE, GLYPH, RUNNING_VARS)}

${GLYPH_KEYFRAMES}

`
}

/**
 * The engine-keyed stylesheet: one copy per generation's row anchor
 * ({@link ROW_SELECTORS} for the 0.1.x lines, {@link RUNNING_ROW} for 0.2.0).
 *
 * Every selector is gated on the root attribute, so the sheet is inert until
 * {@link reflectTurnStatusEngine} names a hosted engine — with no attribute, no
 * rule sets `content` and no pseudo-element box is ever generated.
 *
 * The glyph must re-declare `color` and `-webkit-text-fill-color` on the 0.1.x
 * lines: those rows clip their own background to text and set the fill
 * transparent, and that fill is inherited into the pseudo-element (which has no
 * background of its own to clip), so without the override the glyph would paint
 * nothing. 0.2.0's row does not clip, and the declaration is merely harmless
 * there — the two sheets share one glyph rule (see {@link engineRules}).
 */
const STYLESHEET = [...ROW_SELECTORS.map(sheetFor), sheetForRunning()].join('\n')

/**
 * The session whose surfaces are on screen: the row's one declared subject.
 *
 * The row is driven by two components per session (the header chip and the
 * composer picker), and by every session that has ever been rendered — a
 * session's answer can land after the user has left it — so the attribute cannot
 * be "whoever reflected last". This is the owner a reflection is measured
 * against: {@link focusTurnStatusSession} sets it, {@link blurTurnStatusSession}
 * withdraws it (with the guard the React unmount order needs), and
 * {@link reflectTurnStatusEngine} writes only for it. `undefined` until a
 * session's surfaces declare themselves.
 */
let focusedSessionId: string | undefined

/**
 * Reflect the engine of the session ON SCREEN; `undefined` restores the stock
 * row.
 *
 * The caller names the session it speaks for, and that is the row's SUBJECT: a
 * reflection paints its session's engine only while that session is the focused
 * one ({@link focusTurnStatusSession}), and is a NO-OP otherwise — the whole
 * guard, and the reason the attribute can no longer be taken over by a session
 * the user is not looking at. The subject is an explicit argument rather than
 * ambient state, so a caller cannot reflect without saying whose engine it is,
 * and cannot say "whoever, I don't know".
 *
 * `in-process` is the harness's own row, and `undefined` is every answer that
 * names no engine at all: a session the host reports as `legacy` (it ran a
 * hosted engine, the id never said which) or `unset`, a session whose first
 * answer has not landed yet, and an answer dropped in preparation for a re-read.
 * None of them paints — naming an engine for an unknown one is the misreport
 * this module was fixed for — so each clears the attribute. The clear is as
 * authoritative as the paint: a session that takes the focus with no answer yet
 * takes the previous session's paint off with it.
 *
 * The write is idempotent and never a withdrawal: the chip and the composer of
 * one session both come through here with the same value, and unmounting never
 * clears the attribute, because the sibling surface of the same session is still
 * on screen painting through it.
 *
 * The MID-TURN gate is written from here as well, but only by a surface that can
 * answer it (`running` given): the sheet is gated on both, because the 0.1.7 row
 * outlives its turn, and a surface with no answer must leave the gate as the
 * surface that has one left it rather than guess.
 *
 * The NO-OP covers the late reflection as well — the one from the session the
 * user has just left, whose own answer landing after the switch used to paint
 * over the session that replaced it.
 * @param sessionId - the session this reflection speaks for, or undefined for a
 *   page with no session at all (the new-session page, which has no turn-status
 *   row): such a page has nothing to say about the row, so nothing is written and
 *   nothing is withdrawn — it leaves the row it found alone.
 * @param engine - the engine that session runs, when it is known.
 * @param running - whether that session is mid-turn, when the surface knows;
 *   omitted by a surface with no answer, which leaves the gate alone.
 */
export function reflectTurnStatusEngine(
  sessionId: string | undefined,
  engine: LoopEngineId | undefined,
  running?: boolean,
): void {
  if (sessionId === undefined || sessionId !== focusedSessionId) return
  writeTurnStatusEngine(engine)
  if (running !== undefined) writeTurnStatusRunning(running)
}

/**
 * Declare which session's surfaces are on screen — the row's one subject.
 *
 * Only the focused session may paint ({@link reflectTurnStatusEngine}), which is
 * what keeps the row on the session the user is looking at: the alternative,
 * "whoever writes last owns the row", was the bug this guard ends, because the
 * chip and the composer of EVERY session that has been rendered write here, and
 * a session's answer can land after the user has left it.
 *
 * The caller is the component that renders that session: only a component knows
 * which session is the one on screen, and the hook both of that session's
 * surfaces share (`./use-session-engine.ts`) is the only place that declares it.
 * @param sessionId - the session whose surfaces are now on screen.
 */
export function focusTurnStatusSession(sessionId: string): void {
  focusedSessionId = sessionId
}

/**
 * Withdraw the focus — but only while it is still this session's.
 *
 * The guard is the point: React offers no ordering guarantee between a departing
 * component's cleanup and an arriving one's, so an unconditional withdrawal would
 * let the session the user has just left un-focus the session that replaced it
 * and silence the row. A session that is no longer the focus has nothing to
 * withdraw; unmounting also never clears the attribute itself, which the sibling
 * surface of the same session (and, for a session that is still on screen, the
 * next focus) still paints by.
 * @param sessionId - the session whose surface is going away.
 */
export function blurTurnStatusSession(sessionId: string): void {
  if (focusedSessionId === sessionId) focusedSessionId = undefined
}

/**
 * Write — or clear — the document-level attribute {@link ENGINE_ATTR}.
 *
 * The caller has already established that its subject is the focused session,
 * so this is the write itself and nothing else.
 * @param engine - the focused session's engine, when it is known.
 */
function writeTurnStatusEngine(engine: LoopEngineId | undefined): void {
  // Non-browser boots of the client tree have no document to paint.
  if (typeof document === 'undefined') return
  const root = document.documentElement
  // `dataset` is keyed by the CAMELCASED attribute name: `data-loop-engine` is
  // `dataset.loopEngine`. The literal attribute name is NOT an alternative — the
  // map's named setter refuses any key containing a dash before a lowercase
  // letter (`dataset['data-loop-engine'] = …` throws a `SyntaxError` DOMException),
  // which would take the whole reflect path down with it.
  if (engine === undefined || engine === 'in-process') {
    delete root.dataset.loopEngine
    return
  }
  root.dataset.loopEngine = engine
}

/**
 * Write — or clear — the mid-turn gate, both halves of it.
 *
 * The state is a boolean, and the session-level half is a PRESENCE attribute:
 * the sheet selects `[data-loop-engine-running]`, so `true` puts the attribute
 * on (empty is enough) and `false` takes it off. The per-row half is the
 * {@link LIVE_ATTR} mark, and its lifetime is this gate's exactly: turning it on
 * marks the live row and starts following the rows, turning it off takes the
 * mark away and stops (see {@link startLiveRowWatch}).
 * @param running - whether the focused session is mid-turn.
 */
function writeTurnStatusRunning(running: boolean): void {
  // Non-browser boots of the client tree have no document to paint.
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (!running) {
    delete root.dataset.loopEngineRunning
    stopLiveRowWatch()
    return
  }
  root.dataset.loopEngineRunning = ''
  startLiveRowWatch()
}

/** The element carrying {@link LIVE_ATTR}, so the mark can be moved off it. */
let liveRow: Element | undefined

/** The row follower while the gate is on; undefined means nothing is watched. */
let liveRowObserver: MutationObserver | undefined

/**
 * Stamp {@link LIVE_ATTR} on the LAST {@link ROW_BUTTON} in the document, and
 * take it off any other row — at most one row is claimed.
 *
 * "Last" is the live one: the rows are rendered in turn order, one per turn, and
 * the turn in flight is always the newest. The mark is moved rather than merely
 * added, and a row that is already marked is left untouched — this module's own
 * writes must not re-enter the observer that called it
 * ({@link startLiveRowWatch}).
 *
 * On the 0.2.0 line NOTHING is stamped, and that is the mark's point scaled to
 * that generation: a {@link RUNNING_ROW} node on screen means the live row is the
 * harness's own, so every turn-process button on the page is a settled turn's
 * summary — marking the last one would claim exactly the finished row this mark
 * exists to leave alone. The follower still has to run there, because the
 * running row appearing or going away is what re-derives the mark.
 */
function markLiveRow(): void {
  const live = document.querySelector(RUNNING_ROW) !== null
    ? undefined
    : Array.from(document.querySelectorAll(ROW_BUTTON)).at(-1)
  if (live === liveRow) return
  liveRow?.removeAttribute(LIVE_ATTR)
  liveRow = live
  live?.setAttribute(LIVE_ATTR, '')
}

/**
 * Whether a mutated node is a row the mark is derived from, or contains one.
 *
 * Both anchors qualify on both sides of the 0.2.0 split. A turn-process row can
 * be inserted or removed, which changes which row is the last one; a
 * {@link RUNNING_ROW} node can be, which changes whether the mark belongs on any
 * turn-process row at all — {@link markLiveRow} is re-derived on either, so the
 * mark is dropped the moment the 0.2.0 running row appears and comes back when it
 * goes.
 *
 * The observer filters on this so the chat's own streaming churn — text and
 * markup arriving inside messages — costs nothing: only an inserted or removed
 * row can change the mark.
 * @param node - one node of an observer record.
 */
function bringsRow(node: Node): boolean {
  if (node.nodeType !== 1) return false
  const element = node as Element
  return [ROW_BUTTON, RUNNING_ROW].some(selector =>
    element.matches(selector) || element.querySelector(selector) !== null)
}

/**
 * Mark the live row and follow the rows from then on.
 *
 * The observer is what keeps the mark on the turn in flight once it is set: the
 * turn advances (a newer row appears last, the marked one becomes the previous
 * turn's summary) and it ends (the last row is unmounted with the session, or
 * the next turn's row replaces it). Both are DOM insertions and removals, and
 * both are all the observer listens for — no polling, and no work at all while
 * the gate is off, because the observer is disconnected with it. It keeps
 * running on the 0.2.0 line too, where there is no mark to keep: the running
 * node's own arrival and departure come through the same records, and
 * {@link markLiveRow} is what turns them into a mark or its absence
 * ({@link bringsRow}).
 *
 * Idempotent, because a running turn is reflected by every surface of the
 * session on screen (the chip and the composer both make one).
 */
function startLiveRowWatch(): void {
  markLiveRow()
  if (liveRowObserver !== undefined) return
  liveRowObserver = new MutationObserver((records) => {
    const rowTouched = records.some(record =>
      Array.from(record.addedNodes).some(bringsRow) || Array.from(record.removedNodes).some(bringsRow))
    if (rowTouched) markLiveRow()
  })
  liveRowObserver.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
}

/**
 * Stop following the rows and give the mark up — the gate is off, so no row is
 * claimed and nothing is watched.
 */
function stopLiveRowWatch(): void {
  liveRowObserver?.disconnect()
  liveRowObserver = undefined
  liveRow?.removeAttribute(LIVE_ATTR)
  liveRow = undefined
}

/**
 * Install the per-engine turn-status stylesheet for the lifetime of `ctx`.
 *
 * This is the sheet and nothing else: which engine it selects is written by
 * {@link reflectTurnStatusEngine}, driven from the session on screen's own
 * authoritative answer (`./session-engine.ts`), through the hook the chip and
 * the composer share (`./use-session-engine.ts`) — not from the settings
 * default.
 * @param ctx - the client root context.
 */
export function installTurnStatusStyles(ctx: ClientContext): void {
  // Non-browser boots of the client tree have no document to paint.
  if (typeof document === 'undefined') return

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/turn-status.css`
    tag.textContent = STYLESHEET
    document.head.appendChild(tag)
    return () => {
      // The sheet that selected the attributes goes with it, so no engine is
      // named any more and no turn is live — which also takes the live row's
      // mark and its follower away.
      tag.remove()
      delete document.documentElement.dataset.loopEngine
      delete document.documentElement.dataset.loopEngineRunning
      stopLiveRowWatch()
    }
  }, 'loop-engine: per-engine turn status styles')
}
