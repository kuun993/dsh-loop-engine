/**
 * Session header engine badge: a read-only chip naming the loop engine that
 * drives this session. The engine is a deployment-level choice, so the chip
 * reports the same value for every session — naming what sessions run is the
 * honest affordance; the switch itself lives in the settings section.
 *
 * Styling is token-driven inline styles like the settings section (the
 * client-module bundle is esbuild-built without a CSS loader).
 * @module dsh-loop-engine/client/badge
 */

import type { CSSProperties, JSX } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { LoopEngineState } from './store.ts'
import type { en } from './locales.ts'

/** Registration-side business face for the header badge. */
export interface LoopEngineBadgeInjected {
  hooks: {
    /** Engine snapshot bound by the renderer as useSnapshot. */
    snapshot: SnapshotStore<LoopEngineState>
  }
  /** Section copy bound to the engine dictionaries. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineBadgeProps = Partial<InjectFace<LoopEngineBadgeInjected>>

type BadgeFace = InjectFace<LoopEngineBadgeInjected>

/** Quiet pill token-colored like the settings shell. */
const pill: CSSProperties = {
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
}

/**
 * Render the session header's loop-engine chip. Hides until the settings
 * scope settles, so the header never flashes a provisional engine.
 * @param props - composed slot props.
 * @returns the chip, or null while the engine is unknown.
 */
export function LoopEngineBadge(props: LoopEngineBadgeProps): JSX.Element | null {
  const { useSnapshot, t } = props as BadgeFace
  const { status, engine } = useSnapshot((state: LoopEngineState) => state)
  if (status !== 'ready') return null
  const label = t(
    engine === 'claude-code' ? 'engineClaudeCode'
      : engine === 'codex' ? 'engineCodex'
        : engine === 'pi' ? 'enginePi'
          : 'engineInProcess',
  )
  return (
    <span style={pill} title={t('description')}>
      {t('nav')} · {label}
    </span>
  )
}
