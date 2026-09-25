/**
 * Composer loop-engine picker: a compact dropdown registered at the
 * `conversation.input.right` seat, so it sits immediately left of the model
 * select in the composer's tool row.
 *
 * It picks the engine of the session it is rendered in — the picker's value is
 * this plugin's own authoritative read of that session's engine, and a pick
 * moves the session over this plugin's own `loopEngine/select` Remote. Any
 * session can be moved, at any point in its life, as long as it is open and no
 * turn is in flight, and the host picks one of two ways to make the pick land:
 *
 *  - between two hosted engines it REBUILDS that session's agent IN PLACE, on the
 *    session's own live Session object, so the conversation it is rendered beside
 *    never closes;
 *  - when the harness loop is on either side of the change, the host RELEASES
 *    that session's agent and answers `reload: true`: the session goes cold with
 *    its record naming the new engine, this page is reloaded (which is what
 *    clears the client state a `session/disposed` leaves behind), and the page
 *    that comes back opens the same session again — the host then builds it on
 *    the engine the record names (`src/client/reload.ts`). This control says so
 *    in a notice rather than letting the reload look like a glitch.
 *
 * Either way the host refuses one that is
 * running, and a refusal leaves the session's engine untouched — the label goes
 * back to the engine the session actually runs. The refusal is rendered from its
 * CODE in the user's own language (`refusalFace`), with the host's own sentence
 * kept as detail — never as the message itself, which is how a raw
 * `session "…" is running; …` used to reach the user.
 *
 * A pick commits as soon as the host can apply it, with ONE exception: when the
 * target and the engine this session ACTUALLY runs differ in being the in-process
 * one, the host cannot hand the session over in place, so the switch releases its
 * agent and reloads this page — and a reload costs this page's scroll position and
 * any unsent draft in it. That one pick is staged behind a confirmation
 * (`switchNeedsReload(报告里的实际引擎, 目标引擎)`, resolved before anything is
 * sent) and only then committed; a pick between two hosted engines, which swaps
 * the agent in place and reloads nothing, still commits immediately and opens no
 * dialog at all. That judgement is only ever made about an engine somebody knows:
 * until the host has answered what this session runs there is no engine to judge,
 * and a session with no answer may reload in EITHER direction — so the control is
 * DISABLED for as long as it is reading (`engineSwitchReady`), rather than
 * guessing a direction. This control deliberately asks NOTHING else: whether the session
 * can be moved right now is the host's own judgement — it refuses one that is not
 * open, one that is mid-turn, and a subagent's own session, each with a code and a
 * sentence — so a pick that cannot land costs nothing, and the control never
 * reads an idle hint off a cached session list.
 *
 * So it opens two dialogs, with different jobs: the CONFIRMATION (two buttons,
 * cancel and switch) that a reloading pick must pass before it is sent, and the
 * NOTICE (one button, close) that reports what the host answered — the refusal's
 * localized copy with the host's sentence as detail, or this plugin's own
 * sentence for a reloaded pick.
 *
 * WITH a session, the settings default is never shown — not even while the first
 * answer is still in flight: a session on the pre-routing single preset id reads
 * "legacy hosted engine", one whose engine is not recorded (or not readable)
 * reads "not recorded", and a session whose engine has not been answered yet
 * reads "reading" AND is disabled while it does (see above) — a default or a stale
 * hint would be a claim about a session this control has no facts for, and a pick
 * would have to be judged against an engine nobody knows. Without a session (the
 * seat renders only with one, so this is the defensive branch) the trigger names
 * the default and a pick writes it — immediately, like every other pick here, and
 * with the control usable from the start: a new-session page is waiting for
 * nothing, and that pick reloads nothing. The settings section's own picker is the
 * one that still stages its choice behind a confirmation.
 *
 * Styling is token-driven inline styles like the badge and section (the
 * client-module bundle is esbuild-built without a CSS loader).
 * @module dsh-loop-engine/client/composer
 */

import { useRef, useState, type CSSProperties, type JSX } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  Button,
  FishLogo,
  Menu,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoopEngineStore, LoopEngineState } from './store.ts'
import type { LoopEngineId } from '../agent-preset-ids.ts'
import { isHostedEngine } from '../agent-preset-ids.ts'
import { useEngineOfSession } from './use-session-engine.ts'
import {
  engineSwitchReady, switchNeedsReload,
  type SessionEngineCache, type SessionEngineReport, type SessionEngineSwitcher, type SessionSeat,
} from './session-engine.ts'
import {
  engineLabelKey, engineStateLabelKey, pendingEngineText, refusalFace, type LoopEngineKey, type en,
} from './locales.ts'

/** Injected dependencies of {@link LoopEngineComposerSelect} (slot `inject`). */
export interface LoopEngineComposerSelectInjected {
  /** The selection store (loaded on mount, refreshed by scope pushes). */
  controller: LoopEngineStore
  hooks: {
    /** Engine snapshot bound by the UI renderer as useSnapshot. */
    snapshot: SnapshotStore<LoopEngineState>
  }
  /** The plugin's authoritative per-session engine cache. */
  sessionEngines: SessionEngineCache
  /** Move one session to another engine. */
  switchEngine: SessionEngineSwitcher
  /** Composer copy bound to the loop engine dictionaries. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet (the renderer erases the share boundary).
 * The seat members stay partial here so the registration face matches the slot's
 * own props; {@link ComposerFace} asserts them the way the component reads them.
 */
export type LoopEngineComposerSelectProps =
  PropsRuntime<'conversation.input.right'>
  & Partial<SessionSeat>
  & Partial<InjectFace<LoopEngineComposerSelectInjected>>

type ComposerFace = InjectFace<LoopEngineComposerSelectInjected> & SessionSeat

/** A chevron glyph component, as both primitives generations type it. */
type ChevronGlyph = (props: { size?: number }) => JSX.Element

/**
 * The chevron glyph, picked at runtime: the 0.1.7 primitives renamed
 * `IconChevronDownOutline14` to `IconChevronDownOutlineRegular` (size is a prop
 * on both), so one bundle serves either generation by reading whichever the
 * running primitives export.
 */
const IconChevronDown = ((
  primitives as Record<string, unknown>
).IconChevronDownOutlineRegular ?? (
  primitives as Record<string, unknown>
).IconChevronDownOutline14) as ChevronGlyph

const ENGINE_OPTIONS: readonly { value: LoopEngineId; key: keyof typeof en }[] = [
  { value: 'in-process', key: 'engineInProcess' },
  { value: 'claude-code', key: 'engineClaudeCode' },
  { value: 'codex', key: 'engineCodex' },
  { value: 'pi', key: 'enginePi' },
  { value: 'kimi', key: 'engineKimi' },
]

/**
 * What the trigger shows for one resolved status: the copy key, the engine whose
 * mark leads the label (none when the session's engine is not known), and the
 * menu row to highlight (none in the same case, so no engine is claimed).
 */
interface TriggerFace {
  /** Copy key of the trigger's label. */
  label: keyof LoopEngineKey
  /** Engine whose mark leads the trigger, or undefined when no engine is known. */
  engine: LoopEngineId | undefined
  /** Menu row shown as selected, or undefined when the status names no engine. */
  selectedId: string | undefined
  /**
   * The engine this session's record names while something else is driving it,
   * when there is one: it is appended to the label as a marker and never becomes
   * the label, the mark, or the highlighted row — see {@link triggerFace}. It also
   * marks that engine's own menu row ({@link pendingRowMark}), which is the one
   * thing a user who opens the menu can see without reading the trigger's tooltip.
   */
  pending?: LoopEngineId
}

/** Trigger face while a session's engine has no answer yet: no engine claimed. */
const READING: TriggerFace = { label: 'engineLoading', engine: undefined, selectedId: undefined }

/**
 * Resolve the trigger's face. A session always speaks for itself, including when
 * all it can say is that its engine was never recorded; the settings default
 * answers only for the seat's defensive no-session branch
 * ({@link defaultFace}).
 *
 * The face names the engine the session RUNS. A report whose record names a
 * different engine means one thing only — a switch whose release did not take,
 * so the session is still driven by the engine it had — and that engine is
 * carried as {@link TriggerFace.pending}: a marker beside the name, never the
 * name, so the control cannot claim a swap that has not happened, and the user
 * is not left thinking the pick was lost either.
 * @param report - what the session's engine read answered.
 * @returns the copy key, mark, highlighted row, and the recorded-engine marker.
 */
function triggerFace(report: SessionEngineReport): TriggerFace {
  const { engine: state, pending } = report
  const face: TriggerFace = state.kind === 'engine'
    ? { label: engineLabelKey(state.engine), engine: state.engine, selectedId: state.engine }
    : { label: engineStateLabelKey(state), engine: undefined, selectedId: undefined }
  return pending === undefined ? face : { ...face, pending }
}

/** The trigger face for a seat with no session: the settings default. */
function defaultFace(fallback: LoopEngineId): TriggerFace {
  return { label: engineLabelKey(fallback), engine: fallback, selectedId: fallback }
}

/**
 * Official mark per engine, tinted by `currentColor` so it follows the trigger
 * and menu text. The composer bundle is esbuild-built without a CSS loader, so
 * these are inline SVGs with each source's own viewBox (scaled to a `size`px
 * square by the renderer): the dsh fish for the harness's own in-process loop,
 * the Simple Icons Claude Code mark, OpenAI's knot mark (codex has no distinct
 * vector mark and carries the OpenAI blossom), and pi.dev's official Pi logo.
 */
function engineGlyph(engine: LoopEngineId, size = 16): JSX.Element {
  switch (engine) {
    case 'claude-code':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path fill="currentColor" d="M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z" />
        </svg>
      )
    case 'codex':
      return (
        <svg width={size} height={size} viewBox="0 0 256 260" fill="none" aria-hidden>
          <path fill="currentColor" d="M239.183914,106.202783 C245.054304,88.5242096 243.02228,69.1733805 233.607599,53.0998864 C219.451678,28.4588021 190.999703,15.7836129 163.213007,21.739505 C147.554077,4.32145883 123.794909,-3.42398554 100.87901,1.41873898 C77.9631105,6.26146349 59.3690093,22.9572536 52.0959621,45.2214219 C33.8436494,48.9644867 18.0901721,60.392749 8.86672513,76.5818033 C-5.443491,101.182962 -2.19544431,132.215255 16.8986662,153.320094 C11.0060865,170.990656 13.0197283,190.343991 22.4238231,206.422991 C36.5975553,231.072344 65.0680342,243.746566 92.8695738,237.783372 C105.235639,251.708249 123.001113,259.630942 141.623968,259.52692 C170.105359,259.552169 195.337611,241.165718 204.037777,214.045661 C222.28734,210.296356 238.038489,198.869783 247.267014,182.68528 C261.404453,158.127515 258.142494,127.262775 239.183914,106.202783 L239.183914,106.202783 Z M141.623968,242.541207 C130.255682,242.559177 119.243876,238.574642 110.519381,231.286197 L112.054146,230.416496 L163.724595,200.590881 C166.340648,199.056444 167.954321,196.256818 167.970781,193.224005 L167.970781,120.373788 L189.815614,133.010026 C190.034132,133.121423 190.186235,133.330564 190.224885,133.572774 L190.224885,193.940229 C190.168603,220.758427 168.442166,242.484864 141.623968,242.541207 Z M37.1575749,197.93062 C31.456498,188.086359 29.4094818,176.546984 31.3766237,165.342426 L32.9113895,166.263285 L84.6329973,196.088901 C87.2389349,197.618207 90.4682717,197.618207 93.0742093,196.088901 L156.255402,159.663793 L156.255402,184.885111 C156.243557,185.149771 156.111725,185.394602 155.89729,185.550176 L103.561776,215.733903 C80.3054953,229.131632 50.5924954,221.165435 37.1575749,197.93062 Z M23.5493181,85.3811273 C29.2899861,75.4733097 38.3511911,67.9162648 49.1287482,64.0478825 L49.1287482,125.438515 C49.0891492,128.459425 50.6965386,131.262556 53.3237748,132.754232 L116.198014,169.025864 L94.3531808,181.662102 C94.1132325,181.789434 93.8257461,181.789434 93.5857979,181.662102 L41.3526015,151.529534 C18.1419426,138.076098 10.1817681,108.385562 23.5493181,85.125333 L23.5493181,85.3811273 Z M203.0146,127.075598 L139.935725,90.4458545 L161.7294,77.8607748 C161.969348,77.7334434 162.256834,77.7334434 162.496783,77.8607748 L214.729979,108.044502 C231.032329,117.451747 240.437294,135.426109 238.871504,154.182739 C237.305714,172.939368 225.050719,189.105572 207.414262,195.67963 L207.414262,134.288998 C207.322521,131.276867 205.650697,128.535853 203.0146,127.075598 Z M224.757116,94.3850867 L223.22235,93.4642272 L171.60306,63.3828173 C168.981293,61.8443751 165.732456,61.8443751 163.110689,63.3828173 L99.9806554,99.8079259 L99.9806554,74.5866077 C99.9533004,74.3254088 100.071095,74.0701869 100.287609,73.9215426 L152.520805,43.7889738 C168.863098,34.3743518 189.174256,35.2529043 204.642579,46.0434841 C220.110903,56.8340638 227.949269,75.5923959 224.757116,94.1804513 L224.757116,94.3850867 Z M88.0606409,139.097931 L66.2158076,126.512851 C65.9950399,126.379091 65.8450965,126.154176 65.8065367,125.898945 L65.8065367,65.684966 C65.8314495,46.8285367 76.7500605,29.6846032 93.8270852,21.6883055 C110.90411,13.6920079 131.063833,16.2835462 145.5632,28.338998 L144.028434,29.2086986 L92.3579852,59.0343142 C89.7419327,60.5687513 88.1282597,63.3683767 88.1117998,66.4011901 L88.0606409,139.097931 Z M99.9294965,113.5185 L128.06687,97.3011417 L156.255402,113.5185 L156.255402,145.953218 L128.169187,162.170577 L99.9806554,145.953218 L99.9294965,113.5185 Z" />
        </svg>
      )
    case 'pi':
      return (
        <svg width={size} height={size} viewBox="0 0 800 800" fill="none" aria-hidden>
          <path fill="currentColor" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
          <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
        </svg>
      )
    case 'kimi':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path fill="currentColor" d="M6 3h2.6v6.5L14.4 3h3.4l-5.6 7.4L17.8 21h-3.4l-5.9-8v8H6z" />
        </svg>
      )
    default:
      return <FishLogo size={size} />
  }
}

/**
 * Pill trigger matching the composer's access-mode control (PermissionSelect):
 * 28px rounded chip, transparent ground, secondary label, caption chevron
 * that rotates on open. This plugin's client bundle is esbuild-built without a
 * CSS loader, so the hover/focus/rotate states are driven inline (the access
 * mode does the same with a CSS module).
 */
const trigger: CSSProperties = {
  appearance: 'none',
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
  maxWidth: 220,
  height: 28,
  padding: '0 4px 0 8px',
  border: 'none',
  borderRadius: 24,
  outline: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  fontWeight: 500,
  cursor: 'pointer',
}

const triggerHover: CSSProperties = { ...trigger, background: 'var(--dsw-alias-interactive-bg-hover)' }

const triggerDisabled: CSSProperties = { ...trigger, color: 'var(--dsw-alias-label-dimmed)', cursor: 'default' }

/** Leading engine mark on the trigger (like the access mode's shield raft). */
const triggerIcon: CSSProperties = {
  display: 'inline-flex',
  flex: '0 0 auto',
}

/** Truncating label, one line, overflowing into ellipsis like the access mode. */
const triggerLabel: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const chevron: CSSProperties = {
  display: 'inline-flex',
  flex: '0 0 auto',
  color: 'var(--dsw-alias-label-caption)',
  transition: 'transform 120ms ease',
}

const chevronOpen: CSSProperties = { ...chevron, transform: 'rotate(180deg)' }

/**
 * Trailing annotation on the menu row of the engine a session's record names
 * while another engine is driving it: dimmer and smaller than the row's own
 * label, so the row still reads as a row of the menu rather than as a different
 * kind of entry.
 */
const rowPendingMark: CSSProperties = {
  marginLeft: 4,
  color: 'var(--dsw-alias-label-caption)',
  fontSize: 12,
}

/** Body copy of the failure notice that carries the host's own reason. */
const noticeBody: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--dsw-alias-label-secondary)',
}

/**
 * The host's own sentence under a refusal's localized copy: dimmer and smaller
 * than the copy above it, so it reads as the technical detail it is (a write
 * error, a driver that would not start) rather than as a second message. It wraps
 * instead of overflowing, because the underlying error is not sized for a dialog.
 */
const noticeDetail: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
  wordBreak: 'break-word',
}

/**
 * Render the composer's loop-engine dropdown for the session on screen. Hides
 * until the settings scope settles, so the picker never flashes a provisional
 * default while a session's own engine is already known.
 * @param props - composed slot props.
 * @returns the picker, or null while the picker is unavailable or switched off.
 */
export function LoopEngineComposerSelect(props: LoopEngineComposerSelectProps): JSX.Element | null {
  const { controller, useSnapshot, sessionId, sessionEngines, switchEngine, useSession, t } = props as ComposerFace
  const { status, engine: defaultEngine, showInComposer, writable } = useSnapshot((snapshot: LoopEngineState) => snapshot)
  // The session's own live state, read here (not in the hook) because this is the
  // seat that has it: `useSession` is the session-scoped standard kit every seat
  // receives, and its `running` is what tells the turn-status sheet to keep
  // painting the row or let it go back to stock — the 0.1.7 row stays on screen
  // as the finished turn's summary. Called unconditionally, before every early
  // return below, so the hook order is the same on every render.
  const running = useSession?.(snapshot => snapshot.running)
  // The session's own engine, as the plugin's Remote reports it. Until the host
  // answers — and for a session whose engine is not recorded at all — the picker
  // claims nothing: it never falls back to the settings default, and never keeps
  // showing a stale hint.
  const resolved = useEngineOfSession(sessionEngines, sessionId, running)
  const { label, engine, selectedId, pending } = sessionId === undefined
    ? defaultFace(defaultEngine)
    : resolved === undefined ? READING : triggerFace(resolved)
  /**
   * Whether this session's engine is known, and a pick therefore judgeable — the
   * reason the trigger is greyed out while it reads. Only a session can be
   * waiting for an answer: the no-session seat writes the default for sessions
   * created later, moves nothing, and reloads nothing.
   */
  const switchReady = sessionId === undefined || engineSwitchReady(resolved)
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  /**
   * The host's notice about the last pick: a refusal (this plugin's own copy for
   * its code, with the host's sentence as `detail` when that sentence carries the
   * cause) or a switch that reloaded the page.
   */
  const [notice, setNotice] = useState<
    { readonly title: keyof LoopEngineKey; readonly body: string; readonly detail?: string } | null
  >(null)
  /** The pick staged behind the reload confirmation, or null when none is. */
  const [pendingReload, setPendingReload] = useState<LoopEngineId | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // Hidden until the settings scope settles (no provisional default), and
  // again when the settings toggle clears the composer picker.
  if (status !== 'ready' || !showInComposer) return null

  // Two different reasons the trigger is not usable, and both leave the label
  // saying what it is showing: the settings may not be writable (deployment
  // policy), or this session's engine may not be known yet — a pick would then
  // have to be judged against an engine nobody has. The second case keeps
  // reading「读取中…」rather than hiding the control, so the user sees what the
  // wait is for.
  const disabled = !writable || !switchReady
  const labelText = t(label)
  // The recorded-engine marker, when the host reports one that is not what this
  // session runs: appended to the label, so the control names the engine that
  // runs and states the one the record holds rather than showing that one as if
  // it had already taken over.
  const pendingText = pending === undefined ? undefined : ` · ${pendingEngineText(t, pending)}`
  // The hint a user needs at a glance: what this control does (and, while a
  // hosted engine drives the session, that the model seat belongs to that
  // engine). A session whose record names another engine gets the hint that
  // says what that means.
  const title = pending !== undefined
    ? t('pendingComposerHint')
    : isHostedEngine(engine)
      ? t('hostedEngineModelNotice')
      : sessionId === undefined ? t('description') : t('composerHint')

  // A pick commits as soon as the host will take it. Whether this session can be
  // moved is the host's answer to give, so this control asks and reports — it
  // never infers "idle" from a cached list hint, and only a pick that reloads the
  // page is ever held back (and then for the user's confirmation, not for a
  // permission this control cannot grant; see `onSelect` below).
  const commitSwitch = (value: LoopEngineId): void => {
    if (sessionId === undefined) {
      // No session to switch: the pick chooses what sessions created later run.
      void controller.setEngine(value)
      return
    }
    // A session's engine is this plugin's own per-session record, so the pick
    // asks the host to move that session. The host refuses a session that is not
    // open, one that is mid-turn, and a subagent's own session; a refusal leaves
    // the record untouched — the trigger's label is therefore already back on the
    // engine the session runs, and only the notice is left to say why. A switch
    // that DID land already dropped the cached answer (`onSwitched`), so the
    // trigger, the header chip and the turn-status row all read the new engine.
    void switchEngine(sessionId, value).then((result) => {
      if (!result.ok) {
        if (result.kind === 'unavailable') {
          // This page cannot reach the plugin's own Remote at all, which is not a
          // refusal the host made and therefore carries no code.
          setNotice({ title: 'switchFailedTitle', body: t('switchUnavailable') })
          return
        }
        // A refusal is reported from its CODE, in the user's language: the host's
        // sentence is detail under that copy (the two failures that carry an
        // underlying error), or the message itself when the code is one this
        // build does not know. Either way something readable is shown — the raw
        // English sentence is never the whole message.
        const face = refusalFace(result.code)
        setNotice({
          title: 'switchFailedTitle',
          body: face.body === undefined ? result.reason : t(face.body),
          ...face.detail ? { detail: result.reason } : {},
        })
        return
      }
      // A pick the host had to land by releasing this session's agent: the page
      // is already reloading (the switcher does it), so this notice is the last
      // thing painted on it. It says what happened and where the page returns
      // to, which is the difference between a switch and a glitch.
      if (result.reload === true) {
        setNotice({ title: 'switchReloadTitle', body: t('switchReloadBody') })
        return
      }
    })
  }
  // The one pick that is staged instead of committed: it reloads the page, which
  // costs this page's scroll position and any unsent draft — so the user decides
  // with that cost in front of them. Which picks those are is not guessed here:
  // `switchNeedsReload` applies the host's own split against the engine this
  // session ACTUALLY runs (the report, never the record), and its rule is the
  // reason a hosted-to-hosted pick opens nothing at all.
  const onSelect = (next: string): void => {
    setOpen(false)
    const value = next as LoopEngineId
    // No-op on the row already in force — the session's own engine, or the
    // default this seat writes when it carries no session. A legacy or
    // unrecorded session highlights no row, so any pick asks for a switch.
    if (value === selectedId) return
    if (sessionId !== undefined) {
      // A session's pick is only judgeable against an engine the host has named,
      // and the trigger cannot be used before it has: this is the one way a pick
      // can still arrive with no answer — a menu opened just before the answer
      // was dropped (a committed switch invalidates it) outlives it. Such a pick
      // is dropped, never guessed at; `engineSwitchReady` narrows the report, so
      // the judgement below cannot be reached without one.
      if (!engineSwitchReady(resolved)) return
      if (switchNeedsReload(resolved.engine, value)) {
        setPendingReload(value)
        return
      }
    }
    commitSwitch(value)
  }
  const confirmReload = (): void => {
    const value = pendingReload
    setPendingReload(null)
    if (value !== null) commitSwitch(value)
  }
  const cancelReload = (): void => { setPendingReload(null) }
  const dismissNotice = (): void => { setNotice(null) }

  return (
    <>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={ENGINE_OPTIONS.map(option => ({
          id: option.value,
          // The recorded engine's own row carries the marker too: the trigger may
          // be truncated to ellipsis, and a user who opens the list has to be
          // able to see which row was recorded instead of concluding the pick
          // did nothing. The check mark stays on the row in force (selectedId),
          // which is never the marked one.
          label: option.value === pending
            ? <>{t(option.key)}<span style={rowPendingMark}>{t('engineMenuPendingSuffix')}</span></>
            : t(option.key),
          icon: engineGlyph(option.value),
        }))}
        selectedId={selectedId}
        onSelect={onSelect}
        align="start"
        portal
        getAnchorRect={() => triggerRef.current?.getBoundingClientRect() ?? null}
        anchor={(
          <button
            type="button"
            ref={triggerRef}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            style={disabled ? triggerDisabled : hovered ? triggerHover : trigger}
            title={title}
            onMouseEnter={() => { setHovered(true) }}
            onMouseLeave={() => { setHovered(false) }}
            onClick={() => { setOpen(!open) }}
          >
            {engine === undefined ? null : <span style={triggerIcon} aria-hidden>{engineGlyph(engine, 14)}</span>}
            <span style={triggerLabel}>{labelText}{pendingText}</span>
            <span style={open ? chevronOpen : chevron} aria-hidden>
              <IconChevronDown size={14} />
            </span>
          </button>
        )}
      />
      <Modal
        open={pendingReload !== null}
        onClose={cancelReload}
        title={t('switchReloadConfirmTitle')}
        closeLabel={t('cancelAction')}
        footer={(
          <>
            <Button variant="outline" onClick={cancelReload}>{t('cancelAction')}</Button>
            <Button variant="primary" onClick={confirmReload}>{t('switchReloadConfirmAction')}</Button>
          </>
        )}
      >
        <p style={noticeBody}>{t('switchReloadConfirmBody')}</p>
      </Modal>
      <Modal
        open={notice !== null}
        onClose={dismissNotice}
        title={t(notice?.title ?? 'switchFailedTitle')}
        closeLabel={t('closeLabel')}
        footer={<Button variant="primary" onClick={dismissNotice}>{t('closeLabel')}</Button>}
      >
        <p style={noticeBody}>{notice?.body}</p>
        {notice?.detail === undefined ? null : <p style={noticeDetail}>{notice.detail}</p>}
      </Modal>
    </>
  )
}
