import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Loop engine settings section component: one dropdown choosing the agent
 * loop engine, backed by the duplicated settings scope through the inject face.
 * Changing the engine asks for confirmation first, because the switch
 * interrupts sessions still running on the previous engine.
 *
 * Styling is token-driven like the rest of the settings shell (`--dsw-*`
 * aliases), with the picker rendered through the shared `Menu` primitive and
 * the confirmation through `Modal`. The client-module bundle is esbuild-built
 * without a CSS loader, so the section shell uses token-based inline styles
 * instead of a CSS module.
 * @module dsh-loop-engine/client
 */
import { useId, useRef, useState } from 'react';
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
/** Token-colored section shell (settings modal: column, 720px, label-primary). */
const shell = {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    maxWidth: 720,
    color: 'var(--dsw-alias-label-primary)',
};
const titleStyle = {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
};
const intro = {
    margin: 0,
    fontSize: 13,
    color: 'var(--dsw-alias-label-tertiary)',
};
/** The picker trigger: the app's input-like control over a quiet background. */
const trigger = {
    appearance: 'none',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    width: 'fit-content',
    minWidth: 200,
    padding: '9px 12px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
};
const triggerDisabled = { ...trigger, opacity: 0.5, cursor: 'default' };
const notice = {
    margin: 0,
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
};
const error = {
    margin: 0,
    fontSize: 13,
    color: 'var(--dsw-alias-state-error-primary)',
};
/** The composer-visibility toggle row: a labelled checkbox in the section tone. */
const toggleRow = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
};
const toggleCheckbox = {
    width: 16,
    height: 16,
    accentColor: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))',
    cursor: 'pointer',
};
const confirmBody = {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.55,
    color: 'var(--dsw-alias-label-secondary)',
};
/** Render the engine dropdown plus the interrupt notice and the switch confirmation. */
export function LoopEngineSection(props) {
    const { controller, useSnapshot, t } = props;
    const { status, engine, showInComposer, writable } = useSnapshot((snapshot) => snapshot);
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(null);
    const navId = useId();
    const triggerRef = useRef(null);
    if (status === 'unavailable') {
        return (_jsxs("section", { "aria-labelledby": navId, style: shell, children: [_jsx("h3", { id: navId, style: titleStyle, children: t('nav') }), _jsx("p", { style: intro, children: t('description') }), _jsx("p", { role: "alert", style: error, children: t('unavailable') })] }));
    }
    const disabled = status === 'saving' || !writable;
    const label = t(engineLabelKey(engine));
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
                // Session views established under the previous engine's factory do
                // not migrate: a committed switch reloads the page so every session
                // re-attaches against the new composition.
                if (landed)
                    window.location.reload();
            });
        }
    };
    const cancelSwitch = () => { setPending(null); };
    return (_jsxs("section", { "aria-labelledby": navId, style: shell, children: [_jsx("h3", { id: navId, style: titleStyle, children: t('nav') }), _jsx("p", { style: intro, children: t('description') }), _jsx(Menu, { open: open, onClose: () => { setOpen(false); }, items: ENGINE_OPTIONS.map(option => ({ id: option.value, label: t(option.key) })), selectedId: engine, onSelect: onSelect, align: "start", portal: true, getAnchorRect: () => triggerRef.current?.getBoundingClientRect() ?? null, anchor: (_jsxs("button", { type: "button", ref: triggerRef, "aria-haspopup": "menu", "aria-expanded": open, disabled: disabled, style: disabled ? triggerDisabled : trigger, onClick: () => { setOpen(!open); }, children: [label, _jsx(IconChevronDownOutline14, { size: 14 })] })) }), status === 'saving' ? _jsx("p", { style: notice, children: t('saving') }) : _jsx("p", { style: notice, children: t('switchNotice') }), engine === 'claude-code' ? _jsx("p", { style: notice, children: t('claudeModelNotice') }) : null, _jsxs("label", { style: toggleRow, children: [_jsx("input", { type: "checkbox", checked: showInComposer, disabled: disabled, style: toggleCheckbox, onChange: (event) => { void controller.setShowInComposer(event.currentTarget.checked); } }), t('showInComposerLabel')] }), _jsx(Modal, { open: pending !== null, onClose: cancelSwitch, title: t('confirmTitle'), footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "outline", onClick: cancelSwitch, children: t('cancelAction') }), _jsx(Button, { variant: "primary", onClick: confirmSwitch, children: t('confirmAction') })] })), children: _jsx("p", { style: confirmBody, children: t('confirmBody') }) })] }));
}
//# sourceMappingURL=LoopEngineSection.js.map