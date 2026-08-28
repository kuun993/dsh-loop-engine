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
]

/** Locale key of one engine's option label. */
function engineLabelKey(engine: LoopEngineId): keyof typeof en {
  switch (engine) {
    case 'claude-code': return 'engineClaudeCode'
    case 'codex': return 'engineCodex'
    case 'pi': return 'enginePi'
    default: return 'engineInProcess'
  }
}

/** Compact quiet trigger, one row tall like the model pill. */
const trigger: CSSProperties = {
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
}

const triggerDisabled: CSSProperties = { ...trigger, opacity: 0.5, cursor: 'default' }

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
        items={ENGINE_OPTIONS.map(option => ({ id: option.value, label: t(option.key) }))}
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
            style={disabled ? triggerDisabled : trigger}
            title={title}
            onClick={() => { setOpen(!open) }}
          >
            {label}
            <IconChevronDownOutline14 size={14} />
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
