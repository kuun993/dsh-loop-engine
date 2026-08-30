/**
 * Loop engine settings page copy (Chinese product copy; comments in English).
 * @module dsh-loop-engine/client/locales
 */
/** Copy keys of the loop engine settings page. */
export interface LoopEngineKey {
    /** Settings navigation label. */
    nav: string;
    /** Panel description under the title. */
    description: string;
    /** Option label: the default in-process loop driver. */
    engineInProcess: string;
    /** Option label: the Claude Code CLI driver. */
    engineClaudeCode: string;
    /** Option label: the Codex CLI driver. */
    engineCodex: string;
    /** Option label: the Pi CLI driver. */
    enginePi: string;
    /** Settings toggle: show the engine picker in the chat page composer. */
    showInComposerLabel: string;
    /** Unavailable-state message. */
    unavailable: string;
    /** Notice shown when the selection would interrupt running agents. */
    switchNotice: string;
    /** Saving state label. */
    saving: string;
    /** Confirmation dialog title. */
    confirmTitle: string;
    /** Confirmation dialog body. */
    confirmBody: string;
    /** Confirmation action label. */
    confirmAction: string;
    /** Cancel action label. */
    cancelAction: string;
    /** Notice shown while the Claude Code engine owns the slot: model selection is native. */
    claudeModelNotice: string;
}
/** Simplified Chinese copy. */
export declare const zh: Record<keyof LoopEngineKey, string>;
/** English copy. */
export declare const en: Record<keyof LoopEngineKey, string>;
//# sourceMappingURL=locales.d.ts.map