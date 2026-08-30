import { jsxs as _jsxs } from "react/jsx-runtime";
/** Quiet pill token-colored like the settings shell. */
const pill = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 999,
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12,
    lineHeight: '18px',
    whiteSpace: 'nowrap',
};
/**
 * Render the session header's loop-engine chip. Hides until the settings
 * scope settles, so the header never flashes a provisional engine.
 * @param props - composed slot props.
 * @returns the chip, or null while the engine is unknown.
 */
export function LoopEngineBadge(props) {
    const { useSnapshot, t } = props;
    const { status, engine } = useSnapshot((state) => state);
    if (status !== 'ready')
        return null;
    const label = t(engine === 'claude-code' ? 'engineClaudeCode'
        : engine === 'codex' ? 'engineCodex'
            : engine === 'pi' ? 'enginePi'
                : 'engineInProcess');
    return (_jsxs("span", { style: pill, title: t('description'), children: [t('nav'), " \u00B7 ", label] }));
}
//# sourceMappingURL=LoopEngineBadge.js.map