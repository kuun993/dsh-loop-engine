/**
 * Session header engine chip: a read-only pill naming the engine THIS session
 * runs, read from this plugin's own Remote — which answers from the plugin's own
 * per-session record and, for a session with none, from the session's durable
 * log: the same read the router routes on, so the chip cannot disagree with what
 * the session is actually driven by.
 *
 * It deliberately does NOT read the client session list's `agentPreset`
 * projection: that value is a cache-shaped hint, and it names the preset the
 * session was CREATED with, which is the wrong answer both for a session that
 * switched while it was blank and for one that switched after it started. The
 * harness's own preset label reads that same hint and lags the same way; this
 * chip does not.
 *
 * The settings section's engine is NOT what this chip shows: that value is only
 * the default for sessions created later, and a session created before a default
 * change keeps running the engine it has. The two sessions that name no engine
 * are reported as themselves rather than as the in-process loop: the pre-routing
 * single preset id reads as "legacy hosted engine" (it ran a hosted engine, the
 * id just never recorded which), and a session whose engine is not known — no
 * record, no preset, or no answer from the host — renders nothing, which is also
 * what the chip does until the host's first answer arrives.
 *
 * "What the session runs" is the ACTUAL engine, and for a live session that is
 * the agent in front of it rather than the plugin's record: a switch onto the
 * harness loop makes the host RELEASE the session's agent and reload the page,
 * and if that release did not take, the session keeps running the engine it had
 * while its record names another. This chip never renders the record as its name;
 * it appends the `切到 X · 尚未接管` marker beside the engine that really runs,
 * and its tooltip says what to do about it (`pendingSessionNotice`). See
 * `SessionEngineReport` in `src/agent-preset-ids.ts`.
 *
 * Styling is token-driven inline styles like the settings section (the
 * client-module bundle is esbuild-built without a CSS loader).
 * @module dsh-loop-engine/client/badge
 */

import type { CSSProperties, JSX } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useEngineOfSession } from './use-session-engine.ts'
import type { SessionEngineCache, SessionSeat } from './session-engine.ts'
import { engineStateLabelKey, pendingEngineText, type en } from './locales.ts'

/** Registration-side business face for the header badge. */
export interface LoopEngineBadgeInjected {
  /** The plugin's authoritative per-session engine cache. */
  sessionEngines: SessionEngineCache
  /** Section copy bound to the engine dictionaries. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet (the renderer erases the share boundary).
 * The seat members stay partial here so the registration face matches the slot's
 * own props; {@link BadgeFace} asserts them the way the component reads them.
 */
export type LoopEngineBadgeProps =
  PropsRuntime<'conversation.session.header.actions'>
  & Partial<SessionSeat>
  & Partial<InjectFace<LoopEngineBadgeInjected>>

type BadgeFace = InjectFace<LoopEngineBadgeInjected> & SessionSeat

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
 * Render the session header's loop-engine chip for the session on screen.
 * @param props - composed slot props.
 * @returns the chip, or null when the seat carries no session to speak about or
 * the session's engine is not known yet (or not recorded at all).
 */
export function LoopEngineBadge(props: LoopEngineBadgeProps): JSX.Element | null {
  const { sessionId, sessionEngines, useSession, t } = props as BadgeFace
  // The session's live state, so the row stops painting when the turn ends —
  // the badge is a surface of the session on screen and carries the same
  // session-scoped kit as the composer. Called before the early returns below.
  const running = useSession?.(snapshot => snapshot.running)
  const report = useEngineOfSession(sessionEngines, sessionId, running)
  if (sessionId === undefined || report === undefined) return null
  const engine = report.engine
  // A session the host reads as recording no preset: nothing is claimed for it,
  // which is the same silence the harness's own preset label keeps when it has
  // no preset to name.
  if (engine.kind === 'unset') return null
  // The chip names the engine the session RUNS — never the one it has merely
  // recorded. A committed switch the live session could not take over yet is
  // stated beside it, as a marker (`切到 X 待生效`), and the tooltip says when it
  // lands; that is the only place the pending engine appears.
  const label = t(engineStateLabelKey(engine))
  const named = engine.kind === 'engine' ? engine.engine : undefined
  const pending = report.pending
  const notice = pending === undefined
    ? named === undefined ? t('legacySessionNotice') : t('sessionNotice')
    : t('pendingSessionNotice')
  return (
    <span style={pill} title={notice}>
      {t('nav')} · {label}
      {pending === undefined ? null : ` · ${pendingEngineText(t, pending)}`}
    </span>
  )
}
