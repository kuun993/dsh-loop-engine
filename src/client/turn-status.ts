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

html[${ENGINE_ATTR}="claude-code"] [class$="_turnStatus"] {
  --dsw-static-deepseek-500: #d97757;
  --dsw-static-deepseek-200: #f5bda6;
}
html[${ENGINE_ATTR}="claude-code"] [class$="_turnStatus"]::before {
  content: "✻";
  color: #d97757;
  -webkit-text-fill-color: #d97757;
  animation: le-twinkle 1.4s ease-in-out infinite;
}

html[${ENGINE_ATTR}="codex"] [class$="_turnStatus"] {
  --dsw-static-deepseek-500: #a9b1c0;
  --dsw-static-deepseek-200: #e6eaf2;
}
html[${ENGINE_ATTR}="codex"] [class$="_turnStatus"]::before {
  content: "▌";
  color: #a9b1c0;
  -webkit-text-fill-color: #a9b1c0;
  font-size: 0.85em;
  animation: le-blink 1s step-end infinite;
}

html[${ENGINE_ATTR}="pi"] [class$="_turnStatus"] {
  --dsw-static-deepseek-500: #8e4ec6;
  --dsw-static-deepseek-200: #d6bff0;
}
html[${ENGINE_ATTR}="pi"] [class$="_turnStatus"]::before {
  content: "π";
  color: #8e4ec6;
  -webkit-text-fill-color: #8e4ec6;
  animation: le-bob 1.6s ease-in-out infinite;
}

html[${ENGINE_ATTR}="kimi"] [class$="_turnStatus"] {
  --dsw-static-deepseek-500: #e5484d;
  --dsw-static-deepseek-200: #f5b2b4;
}
html[${ENGINE_ATTR}="kimi"] [class$="_turnStatus"]::before {
  content: "♂";
  color: #e5484d;
  -webkit-text-fill-color: #e5484d;
  animation: le-spin 2.4s linear infinite;
}

@keyframes le-twinkle {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.86); }
}
@keyframes le-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
@keyframes le-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}
@keyframes le-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  [class$="_turnStatus"]::before { animation: none; }
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
