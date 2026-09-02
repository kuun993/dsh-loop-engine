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

import { useRef, useState, type CSSProperties, type JSX } from 'react'
import {
  Button,
  FishLogo,
  IconChevronDownOutline14,
  Menu,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoopEngineStore, LoopEngineState } from './store.ts'
import type { LoopEngineId } from '../settings.ts'
import type { en } from './locales.ts'

/** Injected dependencies of {@link LoopEngineComposerSelect} (slot `inject`). */
export interface LoopEngineComposerSelectInjected {
  /** The selection store (loaded on mount, refreshed by scope pushes). */
  controller: LoopEngineStore
  hooks: {
    /** Engine snapshot bound by the UI renderer as useSnapshot. */
    snapshot: SnapshotStore<LoopEngineState>
  }
  /** Composer copy bound to the loop engine dictionaries. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineComposerSelectProps = Partial<InjectFace<LoopEngineComposerSelectInjected>>

type ComposerFace = InjectFace<LoopEngineComposerSelectInjected>

const ENGINE_OPTIONS: readonly { value: LoopEngineId; key: keyof typeof en }[] = [
  { value: 'in-process', key: 'engineInProcess' },
  { value: 'claude-code', key: 'engineClaudeCode' },
  { value: 'codex', key: 'engineCodex' },
  { value: 'pi', key: 'enginePi' },
  { value: 'kimi', key: 'engineKimi' },
]

/** Locale key of one engine's option label. */
function engineLabelKey(engine: LoopEngineId): keyof typeof en {
  switch (engine) {
    case 'claude-code': return 'engineClaudeCode'
    case 'codex': return 'engineCodex'
    case 'pi': return 'enginePi'
    case 'kimi': return 'engineKimi'
    default: return 'engineInProcess'
  }
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

const confirmBody: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--dsw-alias-label-secondary)',
}

/**
 * Render the composer's loop-engine dropdown. Hides until the settings scope
 * settles, so the composer never flashes a provisional engine.
 * @param props - composed slot props.
 * @returns the picker, or null while the engine is unknown.
 */
export function LoopEngineComposerSelect(props: LoopEngineComposerSelectProps): JSX.Element | null {
  const { controller, useSnapshot, t } = props as ComposerFace
  const { status, engine, showInComposer, writable } = useSnapshot((snapshot: LoopEngineState) => snapshot)
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [pending, setPending] = useState<LoopEngineId | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // Hidden until the settings scope settles (no provisional engine), and
  // again when the settings toggle clears the composer picker.
  if (status !== 'ready' || !showInComposer) return null

  const disabled = !writable
  const label = t(engineLabelKey(engine))
  // The hint a user needs at a glance: what this control does (and, for the
  // Claude Code engine, that the model seat in this session is inert).
  const title = engine === 'claude-code' ? t('claudeModelNotice') : t('description')

  // Pick only stages the choice; the switch itself waits for confirmation.
  const onSelect = (next: string): void => {
    setOpen(false)
    const value = next as LoopEngineId
    if (value === engine) return
    setPending(value)
  }
  const confirmSwitch = (): void => {
    const value = pending
    setPending(null)
    if (value !== null) {
      void controller.setEngine(value).then((landed) => {
        // Session views established under the previous engine's factory do not
        // migrate: a committed switch reloads the page so every session
        // re-attaches against the new composition.
        if (landed) window.location.reload()
      })
    }
  }
  const cancelSwitch = (): void => { setPending(null) }

  return (
    <>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={ENGINE_OPTIONS.map(option => ({
          id: option.value,
          label: t(option.key),
          icon: engineGlyph(option.value),
        }))}
        selectedId={engine}
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
            <span style={triggerIcon} aria-hidden>{engineGlyph(engine, 14)}</span>
            <span style={triggerLabel}>{label}</span>
            <span style={open ? chevronOpen : chevron} aria-hidden>
              <IconChevronDownOutline14 size={14} />
            </span>
          </button>
        )}
      />
      <Modal
        open={pending !== null}
        onClose={cancelSwitch}
        title={t('confirmTitle')}
        footer={(
          <>
            <Button variant="outline" onClick={cancelSwitch}>{t('cancelAction')}</Button>
            <Button variant="primary" onClick={confirmSwitch}>{t('confirmAction')}</Button>
          </>
        )}
      >
        <p style={confirmBody}>{t('confirmBody')}</p>
      </Modal>
    </>
  )
}
