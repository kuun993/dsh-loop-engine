/**
 * Loop engine settings plugin, browser half. Registers the "Loop engine"
 * page under the settings section slot once the settings shell declares it,
 * binding one store to the duplicated `agent-loop-engine` settings scope.
 * Export discipline: packages/client/AGENTS.md.
 * @module @deepseek-ai/dsh-loop-engine/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LoopEngineSection } from './LoopEngineSection.tsx'
import type { LoopEngineSectionInjected } from './LoopEngineSection.tsx'
import { LoopEngineStore, decodeLoopEngine } from './store.ts'
import { en, zh, type LoopEngineKey } from './locales.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../namespace.ts'
import type { LoopEngineSettings } from '../settings.ts'

export type { LoopEngineSectionInjected, LoopEngineSectionProps } from './LoopEngineSection.tsx'
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
}