/**
 * Per-engine styling for the chat turn-status line (the "深度求索中..." row).
 *
 * That row is rendered from inside the harness's ChatView and its words belong
 * to ui-chat: the row is not a slot, and ui-chat owns the `chat` locale
 * namespace (a second `locale.register` for the same namespace throws), so a
 * plugin cannot change the text. What it CAN do is restyle the element, and
 * that is all this module does — it paints an engine-specific glyph and color
 * onto the row while a hosted engine is selected, and leaves the stock look
 * alone otherwise.
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
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LoopEngineId } from '../settings.ts'
import type { LoopEngineState } from './store.ts'

/** Attribute on `<html>` naming the running engine; absent means stock. */
const ENGINE_ATTR = 'data-loop-engine'

/** Owning plugin id, stamped on the injected tag for identification. */
const PLUGIN_ID = 'dsh-loop-engine'

/**
 * The engine-keyed stylesheet.
 *
 * Every selector is gated on the root attribute, so the sheet is inert until
 * {@link reflect} names a hosted engine — with no attribute, no rule sets
 * `content` and no pseudo-element box is ever generated.
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
   reaches 🌕 and 🌑. The order runs waning (full → new), so the lit edge
   retreats right-to-left — the direction the user picked. */
@keyframes le-moon {
  0% { content: "🌕"; }
  12.5% { content: "🌔"; }
  25% { content: "🌓"; }
  37.5% { content: "🌒"; }
  50% { content: "🌑"; }
  62.5% { content: "🌘"; }
  75% { content: "🌗"; }
  87.5% { content: "🌖"; }
  100% { content: "🌕"; }
}

`

/**
 * Reflect the active engine onto the document root so the stylesheet above
 * selects it.
 *
 * Only a settled, hosted engine paints: `in-process` is the stock row, and a
 * not-yet-resolved or refused selection must not guess, so both clear the
 * attribute and restore what the harness shipped.
 * @param engine - the engine recorded by the settings scope.
 * @param settled - whether the settings scope has produced a final answer.
 */
function reflect(engine: LoopEngineId, settled: boolean): void {
  const root = document.documentElement
  if (!settled || engine === 'in-process') {
    delete root.dataset.loopEngine
    return
  }
  root.dataset.loopEngine = engine
}

/**
 * Install the per-engine turn-status styling for the lifetime of `ctx`.
 *
 * Keyed off the shared controller store, so it follows a live engine switch
 * exactly as the settings section and header chip do; the store is read rather
 * than the settings scope so all three surfaces cannot disagree.
 * @param ctx - the client root context.
 * @param store - the loop-engine controller's snapshot source.
 */
export function installTurnStatusStyles(ctx: ClientContext, store: SnapshotStore<LoopEngineState>): void {
  // Non-browser boots of the client tree have no document to paint.
  if (typeof document === 'undefined') return

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/turn-status.css`
    tag.textContent = STYLESHEET
    document.head.appendChild(tag)
    return () => {
      tag.remove()
      delete document.documentElement.dataset.loopEngine
    }
  }, 'loop-engine: per-engine turn status styles')

  const sync = (): void => {
    const { status, engine } = store.getSnapshot()
    reflect(engine, status === 'ready')
  }
  ctx.effect(() => store.subscribe(sync), 'loop-engine: turn status engine reflection')
  // The store may already hold a settled engine from an earlier mount.
  sync()
}
