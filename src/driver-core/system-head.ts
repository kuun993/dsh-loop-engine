/**
 * Give a session started on a hosted engine the protected system head the
 * harness's own loop would have logged.
 *
 * The harness loop logs the rendered system prompt as a `system/message` on a
 * session's first step (`packages/core/agent-loop/src/agent.ts`:
 * `systemPrompt.project` → `session.append('system/message', …)`). A hosted
 * engine's external CLI owns its own system prompt, so these drivers log no dsh
 * system message at all: a session that STARTS on a hosted engine has no surface
 * head, and if it is later served by the in-process loop the harness logs its
 * system message MID-log. Session format v4 requires the system message — when
 * one exists — to be the FIRST surface event, so such a mixed session is refused
 * on the v3→v4 migration (`packages/session/session-format-v3-to-v4/src/
 * relationships.ts` `foldSurface`: "system/message requires a protected first
 * surface head").
 *
 * Appending an EMPTY system message as the session's first surface event closes
 * that hole: the head is protected from the start (a later in-process system
 * message REPLACES it rather than arriving misplaced), and empty content is
 * dropped from the derived history (`deriveEventMessage` yields `null`), so no
 * system prompt is injected into what the engine is handed — the drivers build
 * their prompt from `serializeHistory`, which ignores the `system` role too.
 *
 * Conservative and idempotent: it appends ONLY while the session has no surface
 * event of its own, so a session the harness loop created (or one already
 * carrying history) is left exactly as it is. A mid-surface system head would be
 * refused by the SAME v4 rule and is never produced here.
 *
 * @module dsh-loop-engine/driver-core/system-head
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { LEGACY_HARNESS } from '../compat.ts'

/** Event types that join the derived model-visible surface. */
const SURFACE_TYPES: ReadonlySet<string> = new Set([
  'system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result',
])

/**
 * Append an empty `system/message` head when the session has no surface event
 * yet, so a hosted-engine session carries the protected head format v4 expects.
 *
 * A no-op once any surface event exists: the head can only ever be the FIRST
 * surface event, and a later one would be refused on migration.
 * @param session - the session a hosted driver is about to run a step on.
 * @param turn - the open turn's number.
 * @param step - the open step's number.
 */
export function appendSystemHeadIfMissing(session: Session, turn: number, step: number): void {
  // The protected head is a 0.1.7-line requirement (format v4). The 0.1.5 line
  // still writes format v3, which tolerates a session with no system head and
  // whose `system/message` append this build cannot drive; adding it there only
  // aborts the turn, so the legacy generation is left byte-for-byte as it was.
  /* v8 ignore start -- legacy generation; exercised by vitest.config.compat015.ts */
  if (LEGACY_HARNESS) return
  /* v8 ignore stop */
  for (const event of session.snapshotEvents()) {
    if (SURFACE_TYPES.has(event.type) && (event as { surfaceOp?: unknown }).surfaceOp !== undefined) return
  }
  session.append('system/message', { turn, step, message: createSystemMessage('') }, { surfaceOp: 'append' })
}
