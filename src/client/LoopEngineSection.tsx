/**
 * Loop engine settings section component: one dropdown choosing the agent
 * loop engine, backed by the duplicated settings scope through the inject face.
 * @module @deepseek-ai/dsh-loop-engine/client
 */

import type { ChangeEvent, JSX } from 'react'
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

/** Render the engine dropdown plus the interrupt notice. */
export function LoopEngineSection(props: LoopEngineSectionProps): JSX.Element {
  const { controller, useSnapshot, t } = props as SectionFace
  const { status, engine, writable } = useSnapshot(snapshot => snapshot)

  if (status === 'unavailable') {
    return (
      <section aria-label={t('nav')}>
        <h3>{t('nav')}</h3>
        <p>{t('description')}</p>
        <p role="alert">{t('unavailable')}</p>
      </section>
    )
  }

  const disabled = status === 'saving' || !writable
  const onSelect = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value as LoopEngineId
    if (next === engine) return
    void controller.setEngine(next)
  }

  return (
    <section aria-label={t('nav')}>
      <h3>{t('nav')}</h3>
      <p>{t('description')}</p>
      <label>
        <select value={engine} onChange={onSelect} disabled={disabled}>
          {ENGINE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{t(option.key)}</option>
          ))}
        </select>
      </label>
      {status === 'saving' ? <p>{t('saving')}</p> : <p>{t('switchNotice')}</p>}
    </section>
  )
}