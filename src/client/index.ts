/**
 * Loop engine settings plugin, browser half. Registers the "Loop engine"
 * page under the settings section slot once the settings shell declares it,
 * binding one store to the duplicated `agent-loop-engine` settings scope.
 * Export discipline: packages/client/AGENTS.md.
 * @module dsh-loop-engine/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LoopEngineSection } from './LoopEngineSection.tsx'
import type { LoopEngineSectionInjected } from './LoopEngineSection.tsx'
import { LoopEngineBadge } from './LoopEngineBadge.tsx'
import type { LoopEngineBadgeInjected } from './LoopEngineBadge.tsx'
import { LoopEngineComposerSelect } from './LoopEngineComposerSelect.tsx'
import type { LoopEngineComposerSelectInjected } from './LoopEngineComposerSelect.tsx'
import { LoopEngineStore, decodeLoopEngine } from './store.ts'
import { createSessionEngineCache, sessionEngineSwitcher } from './session-engine.ts'
import { installReloadReturn } from './reload.ts'
import { installTurnStatusStyles } from './turn-status.ts'
import { en, zh, type LoopEngineKey } from './locales.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../namespace.ts'
import type { LoopEngineSettings } from '../settings.ts'

export type { LoopEngineSectionInjected, LoopEngineSectionProps } from './LoopEngineSection.tsx'
export type { LoopEngineBadgeInjected, LoopEngineBadgeProps } from './LoopEngineBadge.tsx'
export type { LoopEngineComposerSelectInjected, LoopEngineComposerSelectProps } from './LoopEngineComposerSelect.tsx'
export type { LoopEngineState } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Loop engine settings page copy. */
    'settings.loop-engine': LoopEngineKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.loop-engine'

/** Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply; registration depends on it through `slots.inject()`. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Register the Loop engine section once the `settings.section` declaration is
 * on the ledger and bind its store to the duplicated settings scope.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'loop-engine: copy dictionaries')

  const scope = ctx.settingsScope.bind<LoopEngineSettings>({
    namespace: LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL,
    decode: decodeLoopEngine,
  })
  const controller = new LoopEngineStore(scope)
  ctx.effect(() => {
    controller.load()
    return () => { controller.dispose() }
  }, 'loop-engine: store lifecycle')

  // Paint the chat turn-status row in the colors and glyph of the engine the
  // session ON SCREEN runs. The harness owns that row's text and offers no slot
  // for it, so this is a stylesheet keyed on a document-level attribute; the
  // attribute itself is written by the session surfaces through the hook they
  // share (`./use-session-engine.ts`) — never by the cache below, which answers
  // for sessions that are not on screen — and that hook reflects the same
  // authoritative answer the header chip and the composer render from, under the
  // focus guard a document-level attribute needs.
  installTurnStatusStyles(ctx)

  // The authoritative per-session engine read: the plugin's own Remote namespace
  // (`remote.loopEngine.engine`), mounted here and cached per session. Both the
  // header chip and the composer render from it, and the composer's switch
  // invalidates it — the client session list's `agentPreset` hint is deliberately
  // NOT read anywhere any more: it is a partial cache and it lags the durable log
  // on exactly the sessions (engine switched while blank) users noticed it on.
  const sessionEngines = createSessionEngineCache(ctx)

  // Switch a session's engine onto the harness loop and the host releases that
  // session's agent, which leaves THIS page holding a session the controller
  // marked as gone. The switcher reloads the page for that reason, and this
  // installation is the other half: the page that comes back reads the session id
  // the switcher stashed and opens that session again, so the host rebuilds it on
  // the engine its record names (`./reload.ts`).
  installReloadReturn(ctx)

  const t = ctx.locale.bind(NS) as LoopEngineSectionInjected['t']
  const injected = (): LoopEngineSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    t,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'loop-engine',
    order: 30,
    label: () => t('nav'),
    inject: injected,
  }, LoopEngineSection))

  // The conversation header badge reads the session's own engine through the
  // plugin's Remote, so it needs only this plugin's copy plus that cache — not
  // the settings store: the settings engine is the default for sessions created
  // later, while the chip names what the session on screen actually runs.
  // Registered in the conversation scope so it exists only where a session header
  // is rendered.
  ctx.inject(['slots', 'conversation'], (scope: ClientContext) => {
    const badgeInjected = (): LoopEngineBadgeInjected => ({ sessionEngines, t })
    scope.effect(() => {
      return scope.slots.register({
        name: 'conversation.session.header.actions',
        id: 'loop-engine',
        // Static session context precedes interactive actions (agent-preset's
        // label sits at -10, so the engine chip leads the header).
        order: -20,
        locale: NS,
        inject: badgeInjected,
      }, LoopEngineBadge)
    }, 'loop-engine: session header engine badge')
  })

  // The composer's loop-engine picker: registered at the tool-row seat beside
  // the model select so the engine is switchable in the chat page, not only in
  // settings. A pick moves that session over this plugin's own `loopEngine/select`
  // endpoint and reads the session's engine back from the same Remote's `engine`
  // endpoint; the settings default stays this plugin's own fallback for a seat
  // without a session. The dependency on `conversation` (like the header badge)
  // ensures ui-conversation has declared the `conversation.input.right` seat
  // before this entry lands.
  //
  // A successful switch drops the session's cached answer, so the picker, the
  // header chip, and the chat turn-status row immediately report what the
  // session now runs rather than the engine it ran a moment ago: the row follows
  // the surface's own reflection, which re-runs when the re-read lands.
  //
  // A switch the host had to make by releasing the session's agent goes further:
  // the switcher reloads the page, which is what clears the client state that
  // release leaves behind, and it stashes the session for the page that comes
  // back — that is how the reload lands on the same session instead of the
  // client's own startup fallback.
  const switchEngine = sessionEngineSwitcher(ctx, (sessionId) => { sessionEngines.invalidate(sessionId) })
  ctx.inject(['slots', 'conversation'], (scope: ClientContext) => {
    const composerInjected = (): LoopEngineComposerSelectInjected => ({
      controller,
      hooks: { snapshot: controller.store },
      sessionEngines,
      switchEngine,
      t,
    })
    scope.effect(() => {
      return scope.slots.register({
        name: 'conversation.input.right',
        id: 'loop-engine',
        order: 0,
        locale: NS,
        inject: composerInjected,
      }, LoopEngineComposerSelect)
    }, 'loop-engine: composer engine select')
  })
}