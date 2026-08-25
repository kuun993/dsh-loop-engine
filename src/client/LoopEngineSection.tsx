/**
 * Loop engine settings section component: one dropdown choosing the agent
 * loop engine, backed by the duplicated settings scope through the inject face.
 *
 * Styling is token-driven like the rest of the settings shell (`--dsw-*`
 * aliases), with the picker itself rendered through the shared `Menu`
 * primitive so the dropdown matches the app's other settings pickers. The
 * client-module bundle is esbuild-built without a CSS loader, so the section
 * shell uses token-based inline styles instead of a CSS module.
 * @module @deepseek-ai/dsh-loop-engine/client
 */

import { useId, useRef, useState, type CSSProperties, type JSX } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoopEngineStore, LoopEngineState } from './store.ts'
import type { LoopEngineId } from '../settings.ts'
import type { en } from './locales.ts'

/** Injected dependencies of {@link LoopEngineSection} (slot `inject`). */
export interface LoopEngineSectionInjected {
  /** The selection store (loaded on mount, refreshed by scope pushes). */
  controller: LoopEngineStore
  hooks: {
    /** Section snapshot bound by the UI renderer as useSnapshot. */
    snapshot: SnapshotStore<LoopEngineState>
  }
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineSectionProps = Partial<InjectFace<LoopEngineSectionInjected>>

type SectionFace = InjectFace<LoopEngineSectionInjected>

const ENGINE_OPTIONS: readonly { value: LoopEngineId; key: keyof typeof en }[] = [
  { value: 'in-process', key: 'engineInProcess' },
  { value: 'claude-code', key: 'engineClaudeCode' },
]

/** Token-colored section shell (settings modal: column, 720px, label-primary). */
const shell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 720,
  color: 'var(--dsw-alias-label-primary)',
}

const title: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
}

const intro: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--dsw-alias-label-tertiary)',
}

/** The picker trigger: the app's input-like control over a quiet background. */
const trigger: CSSProperties = {
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
}

const triggerDisabled: CSSProperties = { ...trigger, opacity: 0.5, cursor: 'default' }

const notice: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const error: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--dsw-alias-state-error-primary)',
}

/** Render the engine dropdown plus the interrupt notice. */
export function LoopEngineSection(props: LoopEngineSectionProps): JSX.Element {
  const { controller, useSnapshot, t } = props as SectionFace
  const { status, engine, writable } = useSnapshot((snapshot: LoopEngineState) => snapshot)
  const [open, setOpen] = useState(false)
  const navId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  if (status === 'unavailable') {
    return (
      <section aria-labelledby={navId} style={shell}>
        <h3 id={navId} style={title}>{t('nav')}</h3>
        <p style={intro}>{t('description')}</p>
        <p role="alert" style={error}>{t('unavailable')}</p>
      </section>
    )
  }

  const disabled = status === 'saving' || !writable
  const label = t(engine === 'in-process' ? 'engineInProcess' : 'engineClaudeCode')
  const onSelect = (next: string): void => {
    setOpen(false)
    const value = next as LoopEngineId
    if (value === engine) return
    void controller.setEngine(value)
  }

  return (
    <section aria-labelledby={navId} style={shell}>
      <h3 id={navId} style={title}>{t('nav')}</h3>
      <p style={intro}>{t('description')}</p>
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
            onClick={() => { setOpen(!open) }}
          >
            {label}
            <IconChevronDownOutline14 size={14} />
          </button>
        )}
      />
      {status === 'saving' ? <p style={notice}>{t('saving')}</p> : <p style={notice}>{t('switchNotice')}</p>}
    </section>
  )
}