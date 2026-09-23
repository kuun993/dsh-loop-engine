/**
 * Loop engine settings page copy (Chinese product copy; comments in English).
 * @module dsh-loop-engine/client/locales
 */

import { type LoopEngineId, type LoopEngineRefusalCode, type SessionEngine } from '../agent-preset-ids.ts'

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
  /** Option label: the Kimi Code CLI driver. */
  engineKimi: string
  /** Option label: a session on the pre-routing single preset id. */
  engineLegacy: string
  /** Option label: a session this plugin holds no engine record for. */
  engineUnrecorded: string
  /** Composer picker label while the session's own engine has no answer yet. */
  engineLoading: string
  /** Settings toggle: show the engine picker in the chat page composer. */
  showInComposerLabel: string
  /** Unavailable-state message. */
  unavailable: string
  /** Notice shown when the selection would interrupt running agents. */
  switchNotice: string
  /** Saving state label. */
  saving: string
  /** Settings-section confirmation title: the picker that changes the new-session default. */
  confirmTitle: string
  /** Settings-section confirmation body: the picker that changes the new-session default. */
  confirmBody: string
  /** Session-header chip tooltip: the engine this session runs, and what decides it. */
  sessionNotice: string
  /** Session-header chip tooltip when the session's engine was never recorded. */
  legacySessionNotice: string
  /** Marker lead-in naming the engine a session's record holds while another one drives it. */
  enginePendingPrefix: string
  /** Marker trailer saying that recorded engine is not what the session runs. */
  enginePendingSuffix: string
  /** Composer menu-row suffix marking the engine a session's record holds but is not running. */
  engineMenuPendingSuffix: string
  /** Session-header chip tooltip while the record names an engine the session is not running. */
  pendingSessionNotice: string
  /** Composer picker tooltip while the record names an engine the session is not running. */
  pendingComposerHint: string
  /** Composer picker tooltip: it chooses this session's engine, and which picks apply immediately. */
  composerHint: string
  /** Title of the notice reporting a refused per-session switch. */
  switchFailedTitle: string
  /** Body of a refused per-session switch: the session is not open yet. */
  refusedSessionClosed: string
  /** Body of a refused per-session switch: a turn is in flight and is not interrupted. */
  refusedTurnRunning: string
  /** Body of a refused per-session switch: a delegated child's engine follows its parent. */
  refusedSubagentSession: string
  /** Body of a refused per-session switch while this process has no loop engine router. */
  refusedRouterNotReady: string
  /** Body of a refused per-session switch whose engine record could not be written. */
  refusedRecordFailed: string
  /** Body of a refused per-session switch whose successor engine could not be built. */
  refusedRebuildFailed: string
  /** Title of the confirmation shown before a switch that reloads the page. */
  switchReloadConfirmTitle: string
  /** Body of that confirmation: what the reload is for, and what this page loses with it. */
  switchReloadConfirmBody: string
  /** Confirm action label of that confirmation. */
  switchReloadConfirmAction: string
  /** Title of the notice shown while a per-session switch reloads the page. */
  switchReloadTitle: string
  /** Body of that notice: what the reload is doing, and that it returns to this session. */
  switchReloadBody: string
  /** Message when this page cannot reach the engine switch endpoint at all. */
  switchUnavailable: string
  /** Confirmation action label of the settings section's own dialog. */
  confirmAction: string
  /** Cancel action label of the settings section's own dialog. */
  cancelAction: string
  /** Accessible close-button label of the settings confirmation and the switch notices. */
  closeLabel: string
  /** Notice shown while the Claude Code engine owns the slot: model selection is native. */
  claudeModelNotice: string
}

/** Simplified Chinese copy. */
export const zh: Record<keyof LoopEngineKey, string> = {
  nav: '循环引擎',
  description: '选择新会话默认使用的 Agent 执行引擎；每个会话也可以在新会话页单独选择自己的引擎。',
  engineInProcess: '进程内引擎（默认）',
  engineClaudeCode: 'Claude Code CLI',
  engineCodex: 'Codex CLI',
  enginePi: 'Pi CLI',
  engineKimi: 'Kimi Code CLI',
  engineLegacy: '旧版托管引擎',
  engineUnrecorded: '未记录',
  engineLoading: '读取中…',
  showInComposerLabel: '在对话页显示引擎选择器',
  unavailable: '循环引擎设置不可用',
  switchNotice: '这一选择只决定新会话用哪个引擎，已经在跑的会话不受影响。',
  saving: '保存中…',
  confirmTitle: '切换循环引擎？',
  confirmBody: '此后新建的会话会使用这个引擎；已存在的会话保持它们各自的引擎不变，也不需要刷新页面。确认切换吗？',
  confirmAction: '切换',
  cancelAction: '取消',
  closeLabel: '关闭',
  claudeModelNotice: '当前使用 Claude Code 引擎：实际模型由 Claude Code 原生决定，页面上的模型选择不生效。',
  sessionNotice: '本会话当前运行的引擎：有活 agent 时就是正在驱动它的那个引擎；没有活 agent 时才看插件的会话级记录，没有记录再回退到它自己的 agent preset。',
  legacySessionNotice: '这是本插件早期版本创建的会话：它当时跑的托管引擎没有被记录。选一个引擎即可在本会话里切换。',
  enginePendingPrefix: '切到 ',
  enginePendingSuffix: ' · 尚未接管',
  engineMenuPendingSuffix: '（尚未接管）',
  pendingSessionNotice: '本会话的记录写着一个引擎，但它没能接管：本会话此刻仍由另一个引擎驱动（所以这里先写的是正在跑的那个）。出现这种情况只有一种原因——上一次切换要拆掉旧 agent 才能让新引擎接管，而那次拆卸没有完成。再选一次目标引擎即可重试。',
  pendingComposerHint: '本会话的记录写着一个引擎，但它没能接管：本会话此刻仍由另一个引擎驱动（标签上先写的是正在跑的那个）。涉及进程内引擎的切换要拆掉旧 agent 才能落到下一次构建上，出现这种情况说明那次拆卸没有成功——再选一次目标引擎即可重试；选当前正在跑的那个引擎则会把记录改回去，让它保持原样。',
  composerHint: '选择本会话运行的引擎：托管引擎之间选中即生效，原地换手，会话保持打开、agent 被替换；与进程内引擎之间的切换无法原地接管（harness 的 loop 既不交出活会话、也不接管别人建的会话），选中时会先说明代价并等确认，确认后宿主拆掉这条会话的 agent 并让页面重新载入，回来时仍是这条会话，由新引擎重建（那次重载会丢掉这一页的滚动位置与未提交的草稿，会话记录不受影响）。会话需已打开且空闲，否则宿主会说明原因。',
  switchFailedTitle: '切换未生效',
  refusedSessionClosed: '这条会话还没有打开。先打开它，再切换引擎。',
  refusedTurnRunning: '这条会话正在运行中——等这一轮结束后再切换引擎。当前这一轮不会被打断。',
  refusedSubagentSession: '这是子代理会话；它的引擎跟随派发它的主会话，不能单独切换。',
  refusedRouterNotReady: '这个进程暂时无法切换引擎（循环引擎路由器还没就绪）。',
  refusedRecordFailed: '引擎记录写入失败，切换没有生效。',
  refusedRebuildFailed: '切换没有生效：新引擎没能建起来，这条会话的 agent 已经释放。再打开一次这条会话，它就会用新引擎重建。',
  switchReloadConfirmTitle: '切换需要重新载入页面',
  switchReloadConfirmBody: '与进程内引擎之间的切换无法原地接管：宿主会释放这条会话的 agent，并重新载入页面，由新引擎重建它。这一页的滚动位置、还没发出的草稿会丢失；会话记录（对话历史）不受影响。现在切换吗？',
  switchReloadConfirmAction: '切换并重载',
  switchReloadTitle: '切换已生效，正在重新载入页面',
  switchReloadBody: '已切到新引擎，正在重新载入页面并回到本会话…',
  switchUnavailable: '当前页面拿不到引擎切换服务，无法切换本会话的引擎。',
}

/** English copy. */
export const en: Record<keyof LoopEngineKey, string> = {
  nav: 'Loop engine',
  description: 'Choose the agent execution engine NEW sessions start on; each session can also pick its own engine on the new-session screen.',
  engineInProcess: 'In-process engine (default)',
  engineClaudeCode: 'Claude Code CLI',
  engineCodex: 'Codex CLI',
  enginePi: 'Pi CLI',
  engineKimi: 'Kimi Code CLI',
  engineLegacy: 'Legacy hosted engine',
  engineUnrecorded: 'Not recorded',
  engineLoading: 'Reading…',
  showInComposerLabel: 'Show the engine selector in the chat page',
  unavailable: 'Loop engine settings are unavailable',
  switchNotice: 'This only decides what new sessions run; sessions already running keep their own engine.',
  saving: 'Saving…',
  confirmTitle: 'Switch loop engine?',
  confirmBody: 'Sessions created after this point use the new engine. Sessions that already exist keep the engine they were created with, and nothing reloads. Switch now?',
  confirmAction: 'Switch',
  cancelAction: 'Cancel',
  closeLabel: 'Close',
  claudeModelNotice: 'Claude Code engine active: the actual model is decided natively by Claude Code; the model selector in this session has no effect.',
  sessionNotice: 'The engine this session runs right now: the agent driving it, when one is live, and otherwise the plugin\'s per-session record (falling back to the session\'s own agent preset when there is no record).',
  legacySessionNotice: 'This session was created by an earlier version of the plugin: the hosted engine it ran was never recorded. Pick any engine to switch it here.',
  enginePendingPrefix: '→ ',
  enginePendingSuffix: ' · not in force',
  engineMenuPendingSuffix: ' (not in force)',
  pendingSessionNotice: 'This session\'s record names an engine that has not taken over: the session is still driven by another engine right now — which is the one named first. There is exactly one way this happens: a switch had to release the old agent for the new engine to take over, and that release did not complete. Pick the target engine again to retry it.',
  pendingComposerHint: 'This session\'s record names an engine that has not taken over: the session is still driven by another engine (the label names that one first). A switch involving the in-process engine has to release the old agent for the new engine to take over on the session\'s next build, and this state means that release did not succeed — pick the target engine again to retry it, or pick the engine the session is actually running to put the record back and leave it as it is.',
  composerHint: 'Choose the engine this session runs. A pick between two hosted engines applies at once — the agent is swapped in place and the session stays open. A switch involving the in-process engine cannot be taken over in place (the harness loop neither hands over a live session nor takes over one it did not create), so it says what it costs and waits for a confirmation first; once confirmed, the host releases this session\'s agent and the page reloads itself, coming back to this same session, rebuilt on the new engine — that reload drops this page\'s scroll position and any unsent draft, while the conversation record is unaffected. The session must be open and idle, or the host says why.',
  switchFailedTitle: 'Switch not applied',
  refusedSessionClosed: 'This session is not open yet. Open it, then switch its engine.',
  refusedTurnRunning: 'This session is running — switch its engine after this turn ends. The turn in flight is not interrupted.',
  refusedSubagentSession: 'This is a subagent session; its engine follows the main session that spawned it and cannot be switched on its own.',
  refusedRouterNotReady: 'This process cannot switch engines right now (the loop engine router is not ready).',
  refusedRecordFailed: 'The engine record could not be written, so the switch did not happen.',
  refusedRebuildFailed: 'The switch did not happen: the new engine could not be started and this session\'s agent has already been released. Open this session again and it is rebuilt on the new engine.',
  switchReloadConfirmTitle: 'This switch reloads the page',
  switchReloadConfirmBody: 'A switch involving the in-process engine cannot be handed over in place: the host releases this session\'s agent and reloads the page, which rebuilds the session on the new engine. Your scroll position and any unsent draft in this page are lost; the conversation record is not. Switch now?',
  switchReloadConfirmAction: 'Switch and reload',
  switchReloadTitle: 'Switch applied — reloading the page',
  switchReloadBody: 'Switched. Reloading the page and returning to this session…',
  switchUnavailable: 'This page cannot reach the engine switch endpoint, so the session engine was not switched.',
}

/**
 * The copy key naming one engine, shared by the session header chip and the
 * composer picker (both name a resolved engine, and neither may invent a name
 * for one of the two non-engine session states).
 * @param engine - a resolved engine id.
 * @returns the key of that engine's own label.
 */
export function engineLabelKey(engine: LoopEngineId): keyof LoopEngineKey {
  switch (engine) {
    case 'claude-code': return 'engineClaudeCode'
    case 'codex': return 'engineCodex'
    case 'pi': return 'enginePi'
    case 'kimi': return 'engineKimi'
    default: return 'engineInProcess'
  }
}

/**
 * The copy key naming the engine a session RUNS, for the two surfaces that name
 * one (the header chip and the composer picker's trigger).
 *
 * The three-state is folded in one place so the two surfaces cannot answer the
 * "which engine is this?" question differently — and so neither can hand it the
 * pending engine: {@link SessionEngine} is the ACTUAL answer by construction, and
 * the recorded-but-not-adopted engine travels beside it
 * (`SessionEngineReport.pending`), where {@link pendingEngineText} turns it into
 * a marker rather than a name.
 * @param state - what the session's engine read answered for its live engine.
 * @returns the key of that state's label.
 */
export function engineStateLabelKey(state: SessionEngine): keyof LoopEngineKey {
  if (state.kind === 'engine') return engineLabelKey(state.engine)
  return state.kind === 'legacy' ? 'engineLegacy' : 'engineUnrecorded'
}

/**
 * The marker naming the engine a session's record holds while something else is
 * driving it.
 *
 * It is an aside, never a name: a surface appends it to the engine the session is
 * actually running, so the user reads "Pi CLI, and the record says X" — not "X".
 * Both surfaces that show a session's engine render it, which is why it is
 * composed here rather than in either of them.
 *
 * Its trailer deliberately makes no promise about WHEN the recorded engine takes
 * over (`enginePendingSuffix`): a switch that has to release the session's agent
 * lands through a page reload, and this marker never survives one — it is what
 * the user sees when that release did not take, and picking the engine again is
 * the action that retries it.
 * @param t - the surface's copy function.
 * @param engine - the engine the session's own record names.
 * @returns the complete marker, e.g. `切到 Pi CLI · 尚未接管`.
 */
export function pendingEngineText(
  t: (key: keyof LoopEngineKey) => string,
  engine: LoopEngineId,
): string {
  return `${t('enginePendingPrefix')}${t(engineLabelKey(engine))}${t('enginePendingSuffix')}`
}

/**
 * How one refused switch reads: which local copy says it, and whether the host's
 * own sentence belongs under that copy as detail.
 *
 * The refusal arrives from the host as a code plus the host's English sentence
 * about one session (`LoopEngineRefusal.reason`), and the sentence is what a
 * surface used to show verbatim — which is how a user got a raw
 * `session "…" is running; switch its engine after this turn ends` for a state
 * this plugin can say perfectly well in the user's own language. So the code
 * decides the message here, and the sentence is kept where it is genuinely
 * additional information: the two failures whose copy is generic and whose text
 * carries the underlying cause (a write error, a driver that would not start).
 */
export interface RefusalFace {
  /**
   * Body copy key for this refusal. Absent when no local copy can say it — an
   * absent or unknown code, where the host's own sentence IS the message
   * (`undefined` is also what a client older than the host normalizes an
   * unrecognized code to, `src/client/session-engine.ts` `parseSelectResult`).
   */
  readonly body?: keyof LoopEngineKey
  /** Whether the host's `reason` is rendered under the body as detail. */
  readonly detail: boolean
}

/**
 * The copy every refusal code reads as, keyed by the code so a new code cannot be
 * added without a message (`Record<LoopEngineRefusalCode, …>` is exhaustive).
 *
 * Two codes share a body on purpose: `not-driven` (an agent this router did not
 * build, i.e. the mount window) and `router-unmounted` (no router at all) are the
 * same thing to the user — this process cannot switch engines yet — and telling
 * them apart would only invite guessing at the plugin's internals.
 */
const REFUSAL_FACES: Readonly<Record<LoopEngineRefusalCode, RefusalFace>> = {
  'session-closed': { body: 'refusedSessionClosed', detail: false },
  'turn-running': { body: 'refusedTurnRunning', detail: false },
  'subagent-session': { body: 'refusedSubagentSession', detail: false },
  'not-driven': { body: 'refusedRouterNotReady', detail: false },
  'router-unmounted': { body: 'refusedRouterNotReady', detail: false },
  'record-failed': { body: 'refusedRecordFailed', detail: true },
  'rebuild-failed': { body: 'refusedRebuildFailed', detail: true },
}

/**
 * Resolve what one refused switch shows.
 *
 * A refusal ALWAYS leaves something readable: a known code gets this plugin's own
 * copy (and, for the two technical failures, the host's sentence under it), while
 * an absent or unknown code falls back to that sentence as the message itself.
 * @param code - the code the host's refusal carried, or undefined when it carried
 * none this build knows.
 * @returns the copy key to render, plus whether the host's own text is shown as
 * detail.
 */
export function refusalFace(code: LoopEngineRefusalCode | undefined): RefusalFace {
  return code === undefined ? { detail: false } : REFUSAL_FACES[code]
}
