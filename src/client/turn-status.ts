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
 * row's own element: the sheet has to reach a class the harness hashes
 * (`[class$="_turnStatus"]`), which takes an attribute selector on an ancestor,
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
 * Three facts about the harness markup make that safe and specific:
 *   - the row carries exactly one class whose `[hash]_turnStatus` suffix is
 *     stable across rebuilds (the hash in front is not), so
 *     `[class$="_turnStatus"]` matches it and not the sibling clock;
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

/** Owning plugin id, stamped on the injected tag for identification. */
const PLUGIN_ID = 'dsh-loop-engine'

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
 */
const STYLESHEET = `
[class$="_turnStatus"]::before {
  margin-right: 6px;
  background: none;
  -webkit-background-clip: border-box;
  background-clip: border-box;
}

/*
 * The row's own sweep, re-asserted for hosted engines.
 *
 * ui-chat disables that animation under \`prefers-reduced-motion: reduce\`
 * (ChatView.module.css), and a media query carries no specificity — so this
 * attribute-gated rule outranks it. That is deliberate here: deployment images
 * ship with Windows' client-area animation off (SPI_GETCLIENTAREAANIMATION
 * false), and with the guard in force EVERY indicator on this row is frozen —
 * the sweep and the glyph alike. Scoped to hosted engines, so in-process
 * sessions keep the stock reduced-motion behaviour; delete this rule and
 * restore the guard at the foot of the sheet to hand the decision back to the OS.
 */
html[${ENGINE_ATTR}] [class$="_turnStatus"] {
  background-position: 100% 0;
  background-size: 250% 100%;
  animation: le-shimmer 1.8s linear infinite;
}

@keyframes le-shimmer {
  to { background-position: 0 0; }
}

html[${ENGINE_ATTR}="claude-code"] [class$="_turnStatus"] {
  --dsw-static-deepseek-500: #d97757;
  --dsw-static-deepseek-200: #f5bda6;
}
html[${ENGINE_ATTR}="claude-code"] [class$="_turnStatus"]::before {
  content: "✻";
  color: #d97757;
  -webkit-text-fill-color: #d97757;
  animation: le-bloom 1.6s ease-in-out infinite;
}

html[${ENGINE_ATTR}="codex"] [class$="_turnStatus"] {
  --dsw-static-deepseek-500: #a9b1c0;
  --dsw-static-deepseek-200: #e6eaf2;
}
html[${ENGINE_ATTR}="codex"] [class$="_turnStatus"]::before {
  content: "•";
  color: #a9b1c0;
  -webkit-text-fill-color: #a9b1c0;
  text-shadow: 0 0 6px currentColor;
  animation: le-pulse 1.4s ease-in-out infinite;
}

html[${ENGINE_ATTR}="pi"] [class$="_turnStatus"] {
  --dsw-static-deepseek-500: #8e4ec6;
  --dsw-static-deepseek-200: #d6bff0;
}
html[${ENGINE_ATTR}="pi"] [class$="_turnStatus"]::before {
  content: "⠋";
  color: #8e4ec6;
  -webkit-text-fill-color: #8e4ec6;
  font-size: 1.1em;
  animation: le-braille 1s linear infinite;
}

html[${ENGINE_ATTR}="kimi"] [class$="_turnStatus"] {
  --dsw-static-deepseek-500: #e5484d;
  --dsw-static-deepseek-200: #f5b2b4;
}
html[${ENGINE_ATTR}="kimi"] [class$="_turnStatus"]::before {
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
 * The NO-OP covers the late reflection as well — the one from the session the
 * user has just left, whose own answer landing after the switch used to paint
 * over the session that replaced it.
 * @param sessionId - the session this reflection speaks for, or undefined for a
 *   page with no session at all (the new-session page, which has no turn-status
 *   row): such a page has nothing to say about the row, so nothing is written and
 *   nothing is withdrawn — it leaves the row it found alone.
 * @param engine - the engine that session runs, when it is known.
 */
export function reflectTurnStatusEngine(
  sessionId: string | undefined,
  engine: LoopEngineId | undefined,
): void {
  if (sessionId === undefined || sessionId !== focusedSessionId) return
  writeTurnStatusEngine(engine)
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
      // The sheet that selected the attribute goes with it, so no engine is
      // named any more.
      tag.remove()
      delete document.documentElement.dataset.loopEngine
    }
  }, 'loop-engine: per-engine turn status styles')
}
