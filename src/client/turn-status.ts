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
 * and the row offers no session-scoped hook for a plugin to hang it on. A
 * document-level attribute has exactly ONE owner at a time, though — and on this
 * page the WRITERS outnumber the reader: the chip and the composer of every
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
 * The paint is gated TWICE, and both gates are needed on the 0.1.7 line.
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
 * later turn ran. The row selector therefore carries `:disabled` (see
 * {@link ROW_SELECTORS}), which is how ui-chat marks the live row. The two
 * gates answer different questions — "is a turn in flight for this session" and
 * "is this row the one it belongs to" — and neither alone is enough.
 *
 * Three facts about the harness markup make that safe and specific:
 *   - the row has one stable handle per harness generation — an
 *     `[hash]_turnStatus` class suffix on the 0.1.5 line, and, on the 0.1.7
 *     line, the `data-turn-process` button whose text is a `<span>` whose hashed
 *     class ends `_label` — so each generation gets its own copy of the sheet
 *     ({@link ROW_SELECTORS}) and the one the running app renders matches while
 *     the other stays inert;
 *   - its gradient paints through the `--dsw-static-deepseek-*` custom
 *     properties, so recoloring is a variable override rather than a fight
 *     over `background` and `background-clip`;
 *   - the glyph rides a `::before` pseudo-element, so the row's real text node
 *     — and the status it announces — is untouched.
 *
 * This sheet deliberately keeps the row animating even when the OS reports
 * `prefers-reduced-motion: reduce` (see the re-asserted sweep below): the
 * deployment's Windows images ship with client-area animation off, which
 * otherwise freezes every indicator here — the sweep and the glyph alike.
 * In-process sessions keep the stock reduced-motion behaviour.
 *
 * @module dsh-loop-engine/client/turn-status
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { LoopEngineId } from '../agent-preset-ids.ts'

/** Attribute on `<html>` naming the engine the session on screen runs; absent means stock. */
const ENGINE_ATTR = 'data-loop-engine'

/**
 * Attribute on `<html>` marking that the session on screen is mid-turn; absent
 * means it is not. Session-level half of the gate: the 0.1.7 row outlives the
 * turn it belongs to, and the per-row half lives in {@link ROW_SELECTORS}.
 */
const RUNNING_ATTR = 'data-loop-engine-running'

/** Owning plugin id, stamped on the injected tag for identification. */
const PLUGIN_ID = 'dsh-loop-engine'

/**
 * One harness markup row the sheet restyles — the sheet is emitted once per
 * generation's selector, and whichever the running app renders matches while
 * the other stays inert. The row moved between generations, so the selector is
 * data here rather than baked into the CSS.
 *
 * The two generations need DIFFERENT precision, and that difference is the
 * whole reason this is a list of selectors rather than one:
 *
 *   - the 0.1.5 row exists only while its turn runs, so "the row" and "the live
 *     turn" are the same thing and the plain class selector is exact;
 *   - the 0.1.7 row is a `button[data-turn-process]` that STAYS on screen after
 *     its turn ends, as the collapsed "用时 …" summary — one per turn, all of
 *     them still rendered. So the session-wide mid-turn gate alone is not
 *     enough: while turn N runs, turns 1..N-1 (all normally finished, all
 *     enabled buttons) are on screen too and would be painted with it. The
 *     `:disabled` in the selector is what picks out the live one — ui-chat sets
 *     `disabled={!canCollapse}` and `canCollapse` is false exactly while the
 *     turn is open (`turnProcessAlwaysOpen`, and the chevron renders under the
 *     same condition, so the live row is the one with no chevron).
 *
 * Known edge: `turnProcessAlwaysOpen` is ALSO true for a turn that ended
 * `aborted` or `error`, so such a row stays disabled forever and keeps the
 * glyph while a later turn runs. The DOM carries the end reason nowhere a
 * selector can reach, so this stays a documented limit rather than a rule.
 */
const ROW_SELECTORS = [
  /** 0.1.5 line: the turn-status row, whose class name ends `_turnStatus`. */
  '[class$="_turnStatus"]',
  /**
   * 0.1.7 line: the LIVE turn-process button — `disabled` is ui-chat's "this
   * turn cannot be collapsed", which is true only while the turn is open — and
   * its status text is the label span.
   */
  'button[data-turn-process]:disabled [class$="_label"]',
] as const

/** Emit the sheet once for one generation's row selector. */
const sheetFor = (ROW: string): string => {
  // Every rule is gated on the engine AND on the turn being live, so the sheet
  // is inert both for a stock row and for a finished one.
  const GATE = `html[${ENGINE_ATTR}][${RUNNING_ATTR}]`
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

html[${ENGINE_ATTR}="claude-code"][${RUNNING_ATTR}] ${ROW} {
  --dsw-static-deepseek-500: #d97757;
  --dsw-static-deepseek-200: #f5bda6;
}
html[${ENGINE_ATTR}="claude-code"][${RUNNING_ATTR}] ${ROW}::before {
  content: "✻";
  color: #d97757;
  -webkit-text-fill-color: #d97757;
  animation: le-bloom 1.6s ease-in-out infinite;
}

html[${ENGINE_ATTR}="codex"][${RUNNING_ATTR}] ${ROW} {
  --dsw-static-deepseek-500: #a9b1c0;
  --dsw-static-deepseek-200: #e6eaf2;
}
html[${ENGINE_ATTR}="codex"][${RUNNING_ATTR}] ${ROW}::before {
  content: "•";
  color: #a9b1c0;
  -webkit-text-fill-color: #a9b1c0;
  text-shadow: 0 0 6px currentColor;
  animation: le-pulse 1.4s ease-in-out infinite;
}

html[${ENGINE_ATTR}="pi"][${RUNNING_ATTR}] ${ROW} {
  --dsw-static-deepseek-500: #8e4ec6;
  --dsw-static-deepseek-200: #d6bff0;
}
html[${ENGINE_ATTR}="pi"][${RUNNING_ATTR}] ${ROW}::before {
  content: "⠋";
  color: #8e4ec6;
  -webkit-text-fill-color: #8e4ec6;
  font-size: 1.1em;
  animation: le-braille 1s linear infinite;
}

html[${ENGINE_ATTR}="kimi"][${RUNNING_ATTR}] ${ROW} {
  --dsw-static-deepseek-500: #e5484d;
  --dsw-static-deepseek-200: #f5b2b4;
}
html[${ENGINE_ATTR}="kimi"][${RUNNING_ATTR}] ${ROW}::before {
  content: "🌗";
  color: #e5484d;
  -webkit-text-fill-color: #e5484d;
  animation: le-moon 2.5s linear infinite;
}

/* Grows from small to large each cycle — the opposite of a twinkle. The range
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
}

`
}

/**
 * The engine-keyed stylesheet.
 *
 * Every selector is gated on the root attribute, so the sheet is inert until
 * {@link reflectTurnStatusEngine} names a hosted engine — with no attribute, no
 * rule sets `content` and no pseudo-element box is ever generated.
 *
 * The glyph must re-declare `color` and `-webkit-text-fill-color`: the row
 * clips its own background to text and sets the fill transparent, and that
 * fill is inherited into the pseudo-element (which has no background of its
 * own to clip), so without the override the glyph would paint nothing.
 *
 * One copy per generation's row selector ({@link ROW_SELECTORS}).
 */
const STYLESHEET = ROW_SELECTORS.map(sheetFor).join('\n')

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
 * Write — or clear — the document-level mid-turn gate {@link RUNNING_ATTR}.
 *
 * The state is a boolean, and the gate is a PRESENCE attribute: the sheet selects
 * `[data-loop-engine-running]`, so `true` puts the attribute on (empty is enough)
 * and `false` takes it off.
 * @param running - whether the focused session is mid-turn.
 */
function writeTurnStatusRunning(running: boolean): void {
  // Non-browser boots of the client tree have no document to paint.
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (running) root.dataset.loopEngineRunning = ''
  else delete root.dataset.loopEngineRunning
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
      // named any more and no turn is live.
      tag.remove()
      delete document.documentElement.dataset.loopEngine
      delete document.documentElement.dataset.loopEngineRunning
    }
  }, 'loop-engine: per-engine turn status styles')
}
