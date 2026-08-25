/**
 * Loop engine settings page copy (Chinese product copy; comments in English).
 * @module @deepseek-ai/dsh-loop-engine/client/locales
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
  /** Unavailable-state message. */
  unavailable: string
  /** Notice shown when the selection would interrupt running agents. */
  switchNotice: string
  /** Saving state label. */
  saving: string
}

/** Simplified Chinese copy. */
export const zh: Record<keyof LoopEngineKey, string> = {
  nav: '循环引擎',
  description: '选择驱动会话的 Agent 执行引擎，切换对后续会话生效。',
  engineInProcess: '进程内引擎（默认）',
  engineClaudeCode: 'Claude Code CLI',
  unavailable: '循环引擎设置不可用',
  switchNotice: '切换引擎会中断当前使用旧引擎运行中的会话。',
  saving: '保存中…',
}

/** English copy. */
export const en: Record<keyof LoopEngineKey, string> = {
  nav: 'Loop engine',
  description: 'Choose the agent execution engine that drives sessions; the switch applies to new turns.',
  engineInProcess: 'In-process engine (default)',
  engineClaudeCode: 'Claude Code CLI',
  unavailable: 'Loop engine settings are unavailable',
  switchNotice: 'Switching engines interrupts sessions currently running on the previous engine.',
  saving: 'Saving…',
}