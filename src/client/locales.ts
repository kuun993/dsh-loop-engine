/**
 * Loop engine settings page copy (Chinese product copy; comments in English).
 * @module dsh-loop-engine/client/locales
 */

/** Copy keys of the loop engine settings page. */
export interface LoopEngineKey {
  /** Settings navigation label. */
  nav: string
  /** Panel description under the title. */
  description: string
  /** Option label: the default in-process loop driver. */
  engineInProcess: string
  /** Option label: the Claude Code CLI driver. */
  engineClaudeCode: string
  /** Option label: the Codex CLI driver. */
  engineCodex: string
  /** Option label: the Pi CLI driver. */
  enginePi: string
  /** Unavailable-state message. */
  unavailable: string
  /** Notice shown when the selection would interrupt running agents. */
  switchNotice: string
  /** Saving state label. */
  saving: string
  /** Confirmation dialog title. */
  confirmTitle: string
  /** Confirmation dialog body. */
  confirmBody: string
  /** Confirmation action label. */
  confirmAction: string
  /** Cancel action label. */
  cancelAction: string
  /** Notice shown while the Claude Code engine owns the slot: model selection is native. */
  claudeModelNotice: string
}

/** Simplified Chinese copy. */
export const zh: Record<keyof LoopEngineKey, string> = {
  nav: '循环引擎',
  description: '选择驱动会话的 Agent 执行引擎，切换对后续会话生效。',
  engineInProcess: '进程内引擎（默认）',
  engineClaudeCode: 'Claude Code CLI',
  engineCodex: 'Codex CLI',
  enginePi: 'Pi CLI',
  unavailable: '循环引擎设置不可用',
  switchNotice: '切换引擎会中断当前使用旧引擎运行中的会话。',
  saving: '保存中…',
  confirmTitle: '切换循环引擎？',
  confirmBody: '切换会中断当前使用旧引擎运行中的会话，确认后页面将自动刷新，新对话使用新引擎。确认切换吗？',
  confirmAction: '切换',
  cancelAction: '取消',
  claudeModelNotice: '当前使用 Claude Code 引擎：实际模型由 Claude Code 原生决定，页面上的模型选择不生效。',
}

/** English copy. */
export const en: Record<keyof LoopEngineKey, string> = {
  nav: 'Loop engine',
  description: 'Choose the agent execution engine that drives sessions; the switch applies to new turns.',
  engineInProcess: 'In-process engine (default)',
  engineClaudeCode: 'Claude Code CLI',
  engineCodex: 'Codex CLI',
  enginePi: 'Pi CLI',
  unavailable: 'Loop engine settings are unavailable',
  switchNotice: 'Switching engines interrupts sessions currently running on the previous engine.',
  saving: 'Saving…',
  confirmTitle: 'Switch loop engine?',
  confirmBody: 'Switching interrupts sessions currently running on the previous engine; the page reloads after the switch and new turns use the new engine. Switch now?',
  confirmAction: 'Switch',
  cancelAction: 'Cancel',
  claudeModelNotice: 'Claude Code engine active: the actual model is decided natively by Claude Code; the model selector in this session has no effect.',
}