/**
 * Loop engine settings plugin, browser half. Registers the "Loop engine"
 * page under the settings section slot once the settings shell declares it,
 * binding one store to the duplicated `agent-loop-engine` settings scope.
 * Export discipline: packages/client/AGENTS.md.
 * @module dsh-loop-engine/client
 */
import { LoopEngineSection } from "./LoopEngineSection.js";
import { LoopEngineBadge } from "./LoopEngineBadge.js";
import { LoopEngineComposerSelect } from "./LoopEngineComposerSelect.js";
import { LoopEngineStore, decodeLoopEngine } from "./store.js";
import { en, zh } from "./locales.js";
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from "../namespace.js";
/** Dictionary namespace owned by this plugin. */
const NS = 'settings.loop-engine';
/** Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply; registration depends on it through `slots.inject()`. */
export const inject = ['slots', 'locale', 'settingsScope'];
/**
 * Register the Loop engine section once the `settings.section` declaration is
 * on the ledger and bind its store to the duplicated settings scope.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'loop-engine: copy dictionaries');
    const scope = ctx.settingsScope.bind({
        namespace: LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL,
        decode: decodeLoopEngine,
    });
    const controller = new LoopEngineStore(scope);
    ctx.effect(() => {
        controller.load();
        return () => { controller.dispose(); };
    }, 'loop-engine: store lifecycle');
    const t = ctx.locale.bind(NS);
    const injected = () => ({
        controller,
        hooks: { snapshot: controller.store },
        t,
    });
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'loop-engine',
        order: 30,
        label: () => t('nav'),
        inject: injected,
    }, LoopEngineSection));
    // The conversation header badge shares the same controller: the engine is a
    // deployment choice, so one snapshot feeds the settings picker and the
    // per-session chip. Registered in the conversation scope so it exists only
    // where a session header is rendered.
    ctx.inject(['slots', 'conversation'], (scope) => {
        const badgeInjected = () => ({
            hooks: { snapshot: controller.store },
            t,
        });
        scope.effect(() => {
            return scope.slots.register({
                name: 'conversation.session.header.actions',
                id: 'loop-engine',
                // Static session context precedes interactive actions (agent-preset's
                // label sits at -10, so the engine chip leads the header).
                order: -20,
                locale: NS,
                inject: badgeInjected,
            }, LoopEngineBadge);
        }, 'loop-engine: session header engine badge');
    });
    // The composer's loop-engine picker: registered at the tool-row seat beside
    // the model select so the engine is switchable in the chat page, not only in
    // settings. Same controller/store, so all three surfaces stay in sync. The
    // dependency on `conversation` (like the header badge) ensures ui-conversation
    // has declared the `conversation.input.right` seat before this entry lands.
    ctx.inject(['slots', 'conversation'], (scope) => {
        const composerInjected = () => ({
            controller,
            hooks: { snapshot: controller.store },
            t,
        });
        scope.effect(() => {
            return scope.slots.register({
                name: 'conversation.input.right',
                id: 'loop-engine',
                order: 0,
                locale: NS,
                inject: composerInjected,
            }, LoopEngineComposerSelect);
        }, 'loop-engine: composer engine select');
    });
}
//# sourceMappingURL=index.js.map