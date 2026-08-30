import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Composer loop-engine picker: a compact dropdown registered at the
 * `conversation.input.right` seat, so it sits immediately left of the model
 * select in the composer's tool row. The engine is a deployment-level choice,
 * so this surface shares the same settings-backed {@link LoopEngineStore} as
 * the settings section and the header badge — a change in any one is what the
 * others show next. Switching still asks for confirmation first (it interrupts
 * sessions still running on the previous engine) and reloads the page once the
 * commit lands, matching the settings section's semantics.
 *
 * Styling is token-driven inline styles like the badge and section (the
 * client-module bundle is esbuild-built without a CSS loader).
 * @module dsh-loop-engine/client/composer
 */
import { useRef, useState } from 'react';
import { Button, IconChevronDownOutline14, Menu, Modal, } from '@deepseek-ai/dsh-client-ui-primitives';
const ENGINE_OPTIONS = [
    { value: 'in-process', key: 'engineInProcess' },
    { value: 'claude-code', key: 'engineClaudeCode' },
    { value: 'codex', key: 'engineCodex' },
    { value: 'pi', key: 'enginePi' },
];
/** Locale key of one engine's option label. */
function engineLabelKey(engine) {
    switch (engine) {
        case 'claude-code': return 'engineClaudeCode';
        case 'codex': return 'engineCodex';
        case 'pi': return 'enginePi';
        default: return 'engineInProcess';
    }
}
/** Compact quiet trigger, one row tall like the model pill. */
const trigger = {
    appearance: 'none',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: 12,
    lineHeight: '20px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
};
const triggerDisabled = { ...trigger, opacity: 0.5, cursor: 'default' };
const confirmBody = {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.55,
    color: 'var(--dsw-alias-label-secondary)',
};
/**
 * Render the composer's loop-engine dropdown. Hides until the settings scope
 * settles, so the composer never flashes a provisional engine.
 * @param props - composed slot props.
 * @returns the picker, or null while the engine is unknown.
 */
export function LoopEngineComposerSelect(props) {
    const { controller, useSnapshot, t } = props;
    const { status, engine, showInComposer, writable } = useSnapshot((snapshot) => snapshot);
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(null);
    const triggerRef = useRef(null);
    // Hidden until the settings scope settles (no provisional engine), and
    // again when the settings toggle clears the composer picker.
    if (status !== 'ready' || !showInComposer)
        return null;
    const disabled = !writable;
    const label = t(engineLabelKey(engine));
    // The hint a user needs at a glance: what this control does (and, for the
    // Claude Code engine, that the model seat in this session is inert).
    const title = engine === 'claude-code' ? t('claudeModelNotice') : t('description');
    // Pick only stages the choice; the switch itself waits for confirmation.
    const onSelect = (next) => {
        setOpen(false);
        const value = next;
        if (value === engine)
            return;
        setPending(value);
    };
    const confirmSwitch = () => {
        const value = pending;
        setPending(null);
        if (value !== null) {
            void controller.setEngine(value).then((landed) => {
                // Session views established under the previous engine's factory do not
                // migrate: a committed switch reloads the page so every session
                // re-attaches against the new composition.
                if (landed)
                    window.location.reload();
            });
        }
    };
    const cancelSwitch = () => { setPending(null); };
    return (_jsxs(_Fragment, { children: [_jsx(Menu, { open: open, onClose: () => { setOpen(false); }, items: ENGINE_OPTIONS.map(option => ({ id: option.value, label: t(option.key) })), selectedId: engine, onSelect: onSelect, align: "start", portal: true, getAnchorRect: () => triggerRef.current?.getBoundingClientRect() ?? null, anchor: (_jsxs("button", { type: "button", ref: triggerRef, "aria-haspopup": "menu", "aria-expanded": open, disabled: disabled, style: disabled ? triggerDisabled : trigger, title: title, onClick: () => { setOpen(!open); }, children: [label, _jsx(IconChevronDownOutline14, { size: 14 })] })) }), _jsx(Modal, { open: pending !== null, onClose: cancelSwitch, title: t('confirmTitle'), footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "outline", onClick: cancelSwitch, children: t('cancelAction') }), _jsx(Button, { variant: "primary", onClick: confirmSwitch, children: t('confirmAction') })] })), children: _jsx("p", { style: confirmBody, children: t('confirmBody') }) })] }));
}
//# sourceMappingURL=LoopEngineComposerSelect.js.map