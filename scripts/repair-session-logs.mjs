#!/usr/bin/env node
/**
 * @file One-off data repair for V3 and V4 session logs written by an older
 * `dsh-loop-engine` hosted-driver build.
 *
 * A hosted engine (claude-code / codex / pi / kimi) drives a session by writing
 * the durable session log itself. Old driver builds wrote transcripts the
 * harness's readers tolerated in their own generation but which the *format v4*
 * rules reject, so the v3→v4 migration refuses a v3 session and the V4 load
 * path refuses a v4 session. Both generations carry the same two defect
 * families, each repaired here.
 *
 * Structural defects — driver builds from before the `71ccdea`, `c293e25`,
 * `5de4b91`, and `1c94078` fixes (all before 2026-09-19) — are what the v3
 * migration refuses:
 *
 *   1. no advertisement. The driver logged `tool/call` + `tool/result` without
 *      the `assistant/message` whose content carries the matching
 *      `{type:'tool-call', id, name, arguments}` block, so v4 reports
 *      `tool/call <id> has no advertised tool lifecycle`.
 *   2. late advertisement. The driver logged `tool/call` before the assistant
 *      message that requested it (the call was emitted at `toolcall_end`, the
 *      message flushed at `message_end`). The advertising message is moved
 *      before its call.
 *   3. duplicate results. The driver recorded the same `tool/result` twice. The
 *      repeat is dropped; the two are byte-identical but for the message id.
 *   4. misplaced or unresolved call. The driver's step rotation could place a
 *      call's `tool/result` in a later step, while v4 clears a step's open calls
 *      at `step/end`; such a result is moved back into its call's step. A call
 *      with no result at all (an aborted turn) is settled with the harness's own
 *      synthetic closer (`@deepseek-ai/dsh-session/repair`) — `TOOL_OUTCOME_UNKNOWN`
 *      when the call started, `TOOL_NOT_STARTED` when only the advertisement
 *      exists — so the repaired log closes its step without inventing an outcome.
 *   5. misplaced system head. A session that started on a hosted engine logged
 *      no system message, so the in-process loop's later `system/message`
 *      arrived mid-log; v4 requires the system message, when one exists, to be
 *      the first surface event. An EMPTY `system/message` head is prepended —
 *      the same repair the plugin's runtime `driver-core/system-head.ts` applies
 *      to new sessions.
 *
 * After the structural repairs, event `seq` coordinates are renumbered densely
 * from zero and every payload reference to them is remapped.
 *
 *   6. projection mismatch. An `assistant/message` `tool-call` block must agree
 *      with its `tool/call` event on `id` AND byte-identical `name` and
 *      `arguments` (`session-format-v3-to-v4/src/relationships.ts`:
 *      `tool/call <id> does not match one advertised tool call`). Driver builds
 *      from before the `005ab3a` fix advertised the engine's raw call (`Bash`,
 *      `Read`, or a raw `path` argument) while the event carried the projected
 *      dsh call (`bash`, `read`, `file_path`). The direction is settled: the
 *      block is rewritten to the event's values and the event is never touched,
 *      because the projected dsh spelling is what the Web tool rows, the dsh
 *      tool vocabulary, and any later in-process replay rely on. This family
 *      changes no event, only block payload bytes, so it never requires `seq`
 *      renumbering — verified for both generations rather than assumed.
 *
 * This is a one-off repair tool, not part of the plugin runtime: nothing under
 * `lib/` imports it and it is not published. The pure repair path uses only the
 * Node standard library. Only `--verify` reaches into the sibling
 * `deepseek-harness` checkout, running the generation's own oracle over the
 * result and the backup: for a v3 artifact the real v3→v4 migration plus v4
 * relationship validation, for a v4 artifact the V4 relationship validation the
 * load path runs (`assertReleasedV4Relationships`). Run it as
 * `node --import tsx/esm scripts/repair-session-logs.mjs --verify <file...>`
 * (the harness path defaults to `../deepseek-harness` next to this repo and can
 * be overridden with `--harness <dir>`).
 *
 *   node scripts/repair-session-logs.mjs <file...>            repair in place (writes <file>.bak)
 *   node scripts/repair-session-logs.mjs --check [<file...>]  report only
 *   node scripts/repair-session-logs.mjs --verify <file...>   repair, then verify with the harness
 *
 * Both generations are accepted: `session.v3.jsonl.zstd` and
 * `session.v4.jsonl.zstd` (`.jsonl` without the zstd suffix works too). A
 * backup is written next to the artifact as `<file>.bak`, whatever the
 * generation.
 *
 * `--check` reports, per file, the structural defect counts (family 1) and the
 * projection-mismatch count (family 6), then a summary broken down by
 * generation. With `--check` and no file arguments it scans the session root
 * (`$DSH_SESSIONS_ROOT`, else `~/.dsh/sessions`). A repair that changes nothing
 * leaves the file byte-for-byte untouched; every write goes to a temp file in
 * the same directory and is renamed into place, so a failure never leaves a
 * partially written log. A log is only rewritten after the repair itself
 * succeeds; with `--verify` the harness oracle is run over every repaired file
 * and a failure is reported (and surfaced as a non-zero exit).
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const SESSION_LOG_NAME = /^session\.v[34]\.jsonl(\.zstd)?$/
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
const SYSTEM_PROMPT_SOURCE = { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }
const FALLBACK_ATTRIBUTION = { provider: 'kimi', model: 'kimi-native' }
/** Model-visible wording of the started-call closer defined by `@deepseek-ai/dsh-session/repair`. */
const OUTCOME_UNKNOWN_TEXT = 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
/** Model-visible wording of the never-started closer defined by `@deepseek-ai/dsh-session/repair`. */
const NOT_STARTED_TEXT = 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'

/** A malformed input artifact: bad framing, bad JSON, or an unresolvable reference. */
class ArtifactError extends Error {}

// --- concatenated-frame Zstandard container ---------------------------------

/**
 * Locate structurally complete Zstandard frames without decompressing them.
 * Mirrors the persistence backend's scanner so a torn final frame is detected
 * rather than misread as complete.
 * @param {Buffer} buffer - the artifact's bytes.
 * @returns {{ frames: {start: number, end: number}[], tornStart?: number }} frame ranges in file order.
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new ArtifactError(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new ArtifactError(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new ArtifactError(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode a Zstandard artifact into its header line, event lines, and trailing-newline convention.
 * @param {Buffer} bytes - the complete artifact.
 * @returns {{ headerLine: string, eventLines: string[], trailingNewline: boolean }} decoded plaintext.
 */
function decodeLog(bytes) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== ZSTD_MAGIC) return splitLog(bytes.toString('utf8'))
  const { frames, tornStart } = scanFrames(bytes)
  if (tornStart !== undefined) throw new ArtifactError(`artifact ends in an incomplete frame at byte ${tornStart}`)
  return splitLog(Buffer.concat(frames.map(frame => zstdDecompressSync(bytes.subarray(frame.start, frame.end)))).toString('utf8'))
}

/** Split decoded plaintext into the header line and event lines. */
function splitLog(text) {
  const newline = text.indexOf('\n')
  if (newline < 0) throw new ArtifactError('artifact has no complete header line')
  const headerLine = text.slice(0, newline + 1)
  const rest = text.slice(newline + 1)
  const trailingNewline = rest.endsWith('\n')
  const eventLines = rest.split('\n')
  if (trailingNewline) eventLines.pop()
  if (eventLines.some(line => line.length === 0)) throw new ArtifactError('artifact contains an empty event line')
  return { headerLine, eventLines, trailingNewline }
}

/**
 * Encode a repaired artifact as a concatenated-frame container: the header line
 * alone in the first frame, every event line in the following frame.
 * @param {{ headerLine: string, eventLines: string[], trailingNewline: boolean }} log - decoded log.
 * @returns {Buffer} encoded bytes.
 */
function encodeLog(log) {
  const headerFrame = zstdCompressSync(log.headerLine, CHECKSUM_OPTIONS)
  if (log.eventLines.length === 0) return headerFrame
  const body = log.eventLines.join('\n') + (log.trailingNewline ? '\n' : '')
  return Buffer.concat([headerFrame, zstdCompressSync(body, CHECKSUM_OPTIONS)])
}

// --- transcript repair ------------------------------------------------------

/** The `turn:step` key that scopes tool advertisement and lifecycle. */
const stepKey = (turn, step) => `${turn}:${step}`

/** The tool-call block ids advertised by one assistant message. */
function advertisedIds(event) {
  const blocks = event.data?.message?.content
  if (!Array.isArray(blocks)) return []
  return blocks.filter(block => block?.type === 'tool-call').map(block => block.id)
}

/** The model attribution of a message source, when it names one. */
function providerOf(source) {
  if (source === null || typeof source !== 'object') return undefined
  const { provider, model } = source
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined
}

/**
 * Resolve the model attribution for a synthetic assistant message: the nearest
 * preceding `request/header`, else the nearest preceding assistant message,
 * else the fallback recorded for a log that names neither.
 * @param {object[]} events - source events.
 * @param {number} before - insertion index the attribution must precede.
 * @returns {{ provider: string, model: string }} provider and model.
 */
function resolveAttribution(events, before) {
  for (let index = before - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'request/header') continue
    const config = event.data?.header?.config
    if (config !== null && typeof config === 'object'
      && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  for (let index = before - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const found = providerOf(event.data?.message?.source)
    if (found !== undefined) return found
  }
  return FALLBACK_ATTRIBUTION
}

/**
 * The open `turn/step` coordinates at one event index.
 * @param {object[]} events - source events.
 * @param {number} index - index to resolve for.
 * @returns {{ turn: number, step: number } | undefined} the open step, or undefined outside one.
 */
function openStepAt(events, index) {
  let turn
  let step
  for (let cursor = 0; cursor <= index; cursor += 1) {
    const event = events[cursor]
    if (event.type === 'turn/start') { turn = event.data?.turn; step = undefined } else if (event.type === 'step/start') { step = event.data?.step } else if (event.type === 'step/end') { step = undefined } else if (event.type === 'turn/end') { turn = undefined; step = undefined }
  }
  return typeof turn === 'number' && typeof step === 'number' ? { turn, step } : undefined
}

/**
 * Move each assistant message that advertises a call which appeared earlier in
 * the same step to immediately before that call, restoring the
 * `assistant/message → tool/call → tool/result` order the driver now writes.
 * @param {object[]} events - source events.
 * @returns {object[]} reordered events, or the input when nothing moves.
 */
function orderAdvertisements(events) {
  const list = [...events]
  const advertised = new Map()
  let moved = false
  let index = 0
  while (index < list.length) {
    const event = list[index]
    if (event.type === 'assistant/message') {
      const key = stepKey(event.data.turn, event.data.step)
      const ids = advertised.get(key) ?? new Set()
      advertised.set(key, ids)
      for (const id of advertisedIds(event)) ids.add(id)
      index += 1
      continue
    }
    if (event.type !== 'tool/call') { index += 1; continue }
    const key = stepKey(event.data.turn, event.data.step)
    const ids = advertised.get(key) ?? new Set()
    advertised.set(key, ids)
    if (!ids.has(event.data.callId)) {
      const source = list.findIndex((candidate, at) => at > index && candidate.type === 'assistant/message'
        && candidate.data.turn === event.data.turn && candidate.data.step === event.data.step
        && advertisedIds(candidate).includes(event.data.callId))
      if (source > index) {
        const [message] = list.splice(source, 1)
        list.splice(index, 0, message)
        moved = true
        continue
      }
    }
    ids.add(event.data.callId)
    index += 1
  }
  return moved ? list : events
}

/**
 * Drop repeated appended `tool/result` events for one call id; the old driver
 * recorded some results twice, and v4 settles a call exactly once.
 * @param {object[]} events - source events.
 * @returns {object[]} deduplicated events, or the input when nothing repeats.
 */
function dropDuplicateResults(events) {
  const settled = new Set()
  const output = []
  let changed = false
  for (const event of events) {
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const callId = event.data?.message?.source?.callId
      if (typeof callId === 'string') {
        if (settled.has(callId)) { changed = true; continue }
        settled.add(callId)
      }
    }
    output.push(event)
  }
  return changed ? output : events
}

/**
 * Build the synthetic advertising message for one step.
 * @param {object[]} calls - the step's unadvertised `tool/call` events in order.
 * @param {{ provider: string, model: string }} attribution - resolved model attribution.
 * @returns {object} a synthetic `assistant/message` carrying one tool-call block per call.
 */
function syntheticAdvertisement(calls, attribution) {
  const first = calls[0]
  return {
    type: 'assistant/message',
    seq: -1,
    time: first.time,
    surfaceOp: 'append',
    data: {
      turn: first.data.turn,
      step: first.data.step,
      message: {
        role: 'assistant',
        content: calls.map(call => ({
          type: 'tool-call',
          id: call.data.callId,
          name: call.data.name,
          arguments: call.data.arguments,
        })),
        source: { kind: 'model', provider: attribution.provider, model: attribution.model },
        id: randomUUID(),
      },
      stream: [],
    },
  }
}

/**
 * Insert one synthetic advertisement before the first call of each step that no
 * assistant message advertises.
 * @param {object[]} events - events after advertisement reordering.
 * @returns {object[]} events with synthetic advertisements, or the input when none is needed.
 */
function insertAdvertisements(events) {
  const advertised = new Map()
  const steps = new Map()
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const key = stepKey(event.data.turn, event.data.step)
      const ids = advertised.get(key) ?? new Set()
      advertised.set(key, ids)
      for (const id of advertisedIds(event)) ids.add(id)
      continue
    }
    if (event.type !== 'tool/call') continue
    const key = stepKey(event.data.turn, event.data.step)
    const ids = advertised.get(key)
    if (ids === undefined || !ids.has(event.data.callId)) {
      const group = steps.get(key) ?? []
      group.push(event)
      steps.set(key, group)
    }
  }
  if (steps.size === 0) return events
  const insertAt = new Map()
  for (const calls of steps.values()) {
    const index = events.indexOf(calls[0])
    insertAt.set(index, syntheticAdvertisement(calls, resolveAttribution(events, index)))
  }
  const output = []
  for (const [index, event] of events.entries()) {
    const advertisement = insertAt.get(index)
    if (advertisement !== undefined) output.push(advertisement)
    output.push(event)
  }
  return output
}

/**
 * Build the synthetic `TOOL_OUTCOME_UNKNOWN` result that settles one started
 * call whose step closed without recording an outcome.
 * @param {object} call - the unresolved `tool/call` event.
 * @returns {object} a synthetic appended `tool/result`.
 */
function syntheticOutcomeUnknown(call) {
  return closer(call.data.turn, call.data.step, call.time, call.data.callId, call.seq,
    'ToolOutcomeUnknownError', 'TOOL_OUTCOME_UNKNOWN', OUTCOME_UNKNOWN_TEXT)
}

/**
 * Build the synthetic `TOOL_NOT_STARTED` result that settles an advertised call
 * whose step closed before the call ever started (no `tool/call` event).
 * @param {string} callId - the advertised call id.
 * @param {{ turn: number, step: number, time: number }} state - the owning step.
 * @returns {object} a synthetic appended `tool/result`.
 */
function syntheticNotStarted(callId, state) {
  return closer(state.turn, state.step, state.time, callId, undefined,
    'ToolNotStartedError', 'TOOL_NOT_STARTED', NOT_STARTED_TEXT)
}

/** An appended synthetic `tool/result` closer, sharing both recovery shapes. */
function closer(turn, step, time, callId, sourceEventSeq, errorName, errorCode, text) {
  return {
    type: 'tool/result',
    seq: -1,
    time,
    surfaceOp: 'append',
    ...(sourceEventSeq === undefined ? {} : { sourceEventSeqs: [sourceEventSeq] }),
    data: {
      turn,
      step,
      message: {
        id: `interrupted-tool-result-${callId}-0`,
        role: 'tool',
        toolCallId: callId,
        isError: true,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text }],
      },
      error: { name: errorName, code: errorCode },
    },
  }
}

/**
 * Index of the event that closes one step: its `step/end`, else its turn's
 * `turn/end`. Returns -1 for an unfinished open tail.
 * @param {object[]} events - events to search.
 * @param {number} turn - owning turn.
 * @param {number} step - owning step.
 * @returns {number} boundary index, or -1.
 */
function stepBoundary(events, turn, step) {
  const closed = events.findIndex(event => event.type === 'step/end' && event.data.turn === turn && event.data.step === step)
  if (closed >= 0) return closed
  return events.findIndex(event => event.type === 'turn/end' && event.data.turn === turn)
}

/**
 * Fold one log's per-step tool lifecycles: the calls each step advertised,
 * which of those recorded a `tool/call`, and which a `tool/result` settled.
 * @param {object[]} events - source events.
 * @returns {Map<string, { turn: number, step: number, time: number, calls: Map<string, { call?: object, settled: boolean }> }>} one entry per step.
 */
function collectLifecycles(events) {
  const steps = new Map()
  const stepOf = event => {
    const key = stepKey(event.data.turn, event.data.step)
    let state = steps.get(key)
    if (state === undefined) {
      state = { turn: event.data.turn, step: event.data.step, time: event.time, calls: new Map() }
      steps.set(key, state)
    }
    return state
  }
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const state = stepOf(event)
      for (const id of advertisedIds(event)) if (!state.calls.has(id)) state.calls.set(id, { settled: false })
      continue
    }
    if (event.type === 'tool/call') {
      const state = stepOf(event)
      const entry = state.calls.get(event.data.callId) ?? { settled: false }
      entry.call = event
      state.calls.set(event.data.callId, entry)
      continue
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const callId = event.data?.message?.source?.callId
      if (typeof callId !== 'string') continue
      const state = stepOf(event)
      const entry = state.calls.get(callId) ?? { settled: false }
      entry.settled = true
      state.calls.set(callId, entry)
    }
  }
  return steps
}

/**
 * Move each `tool/result` whose call belongs to an earlier step into that call's
 * step, so the result settles its own call instead of leaving it unresolved.
 * @param {object[]} events - source events.
 * @returns {object[]} events with results relocated, or the input when none is misplaced.
 */
function relocateResults(events) {
  const calls = new Map()
  for (const event of events) if (event.type === 'tool/call') calls.set(event.data.callId, event)
  const closersAt = new Map()
  const removed = new Set()
  for (const event of events) {
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') continue
    const callId = event.data?.message?.source?.callId
    const call = typeof callId === 'string' ? calls.get(callId) : undefined
    if (call === undefined || (call.data.turn === event.data.turn && call.data.step === event.data.step)) continue
    const boundary = stepBoundary(events, call.data.turn, call.data.step)
    if (boundary < 0) continue
    const boundaryEvent = events[boundary]
    const relocated = { ...event, data: { ...event.data, turn: call.data.turn, step: call.data.step } }
    closersAt.set(boundaryEvent, (closersAt.get(boundaryEvent) ?? []).concat([relocated]))
    removed.add(event)
  }
  if (closersAt.size === 0) return events
  const output = []
  for (const event of events) {
    if (removed.has(event)) continue
    for (const relocated of closersAt.get(event) ?? []) output.push(relocated)
    output.push(event)
  }
  return output
}

/**
 * Settle every advertised call that no `tool/result` closes, immediately before
 * the step or turn boundary that would otherwise refuse it. Calls in an open
 * tail are left open, matching the harness's own unfinished-tail policy.
 * @param {object[]} events - events after duplicate-result removal.
 * @returns {object[]} events with synthetic closers, or the input when none is needed.
 */
function settleUnresolved(events) {
  const closersAt = new Map()
  for (const state of collectLifecycles(events).values()) {
    const pending = [...state.calls.entries()].filter(([, entry]) => !entry.settled)
    if (pending.length === 0) continue
    const boundary = stepBoundary(events, state.turn, state.step)
    if (boundary < 0) continue
    const boundaryEvent = events[boundary]
    const closers = pending.map(([callId, entry]) => entry.call === undefined
      ? syntheticNotStarted(callId, state)
      : syntheticOutcomeUnknown(entry.call))
    closersAt.set(boundaryEvent, (closersAt.get(boundaryEvent) ?? []).concat(closers))
  }
  if (closersAt.size === 0) return events
  const output = []
  for (const event of events) {
    for (const synthesized of closersAt.get(event) ?? []) output.push(synthesized)
    output.push(event)
  }
  return output
}

/**
 * Whether some `system/message` would append to a non-empty surface with no
 * protected head, which v4 refuses.
 * @param {object[]} events - source events.
 * @returns {boolean} true when an empty protected head must be prepended.
 */
function needsSystemHead(events) {
  let surface = 0
  let protectedHead = false
  for (const event of events) {
    if (!SURFACE_TYPES.has(event.type) || event.surfaceOp === undefined) continue
    if (event.surfaceOp === 'append') {
      if (event.type === 'system/message') {
        if (surface === 0) protectedHead = true
        else if (!protectedHead) return true
      }
      surface += 1
    }
  }
  return false
}

/**
 * Prepend an empty `system/message` protected head when a mid-log system
 * message would otherwise be misplaced. Empty content is dropped from the
 * derived history, so no system prompt is injected.
 * @param {object[]} events - source events.
 * @returns {object[]} events with a synthetic head, or the input when none is needed.
 */
function insertSystemHead(events) {
  if (!needsSystemHead(events)) return events
  const anchor = events.findIndex(event => SURFACE_TYPES.has(event.type) && event.surfaceOp === 'append')
  if (anchor < 0) return events
  const step = openStepAt(events, anchor)
  if (step === undefined) return events
  const head = {
    type: 'system/message',
    seq: -1,
    time: events[anchor].time,
    surfaceOp: 'append',
    data: {
      turn: step.turn,
      step: step.step,
      message: { role: 'system', content: [], source: SYSTEM_PROMPT_SOURCE, id: randomUUID() },
    },
  }
  const output = [...events]
  output.splice(anchor, 0, head)
  return output
}

/**
 * Index every advertised `tool-call` block by its call id. When an id repeats,
 * the last advertisement wins, matching the V4 lifecycle's single live state.
 * @param {object[]} events - events to index.
 * @returns {Map<string, object>} the advertised block objects by call id.
 */
function collectAdvertisedBlocks(events) {
  const blocks = new Map()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool-call' && typeof block.id === 'string') blocks.set(block.id, block)
    }
  }
  return blocks
}

/**
 * Rewrite each advertised `tool-call` block whose `name` or `arguments` disagree
 * with its `tool/call` event, so the block carries the event's projected dsh
 * spelling. The event is never touched. No event is added, removed, or moved, so
 * `seq` coordinates stay valid without renumbering.
 * @param {object[]} events - source events.
 * @returns {object[]} events with corrected blocks, or the input when none disagree.
 */
function repairProjections(events) {
  const calls = new Map()
  for (const event of events) if (event.type === 'tool/call') calls.set(event.data.callId, event)
  if (calls.size === 0) return events
  let changed = false
  const output = events.map(event => {
    if (event.type !== 'assistant/message') return event
    const content = event.data?.message?.content
    if (!Array.isArray(content)) return event
    let touched = false
    const nextContent = content.map(block => {
      if (block?.type !== 'tool-call') return block
      const call = calls.get(block.id)
      if (call === undefined) return block
      if (block.name === call.data.name && block.arguments === call.data.arguments) return block
      touched = true
      return { ...block, name: call.data.name, arguments: call.data.arguments }
    })
    if (!touched) return event
    changed = true
    return { ...event, data: { ...event.data, message: { ...event.data.message, content: nextContent } } }
  })
  return changed ? output : events
}

/**
 * Renumber events densely from zero and remap every payload reference to a
 * source event coordinate.
 * @param {object[]} events - events with placeholder `seq` values, in order.
 * @returns {object[]} events with dense `seq` and remapped references.
 */
function renumberAndRemap(events) {
  const oldToNew = new Map()
  for (const [index, event] of events.entries()) {
    if (event.seq >= 0) oldToNew.set(event.seq, index)
  }
  const remap = seq => {
    const mapped = oldToNew.get(seq)
    if (mapped === undefined) throw new ArtifactError(`reference to unknown source seq ${seq}`)
    return mapped
  }
  const remapList = value => Array.isArray(value) ? value.map(remap) : value
  return events.map((event, index) => {
    const next = { ...event, seq: index }
    if (Array.isArray(event.sourceEventSeqs)) next.sourceEventSeqs = remapList(event.sourceEventSeqs)
    const surface = event.surfaceOp
    if (surface !== null && typeof surface === 'object') {
      next.surfaceOp = { ...surface, startSeq: remap(surface.startSeq), endSeq: remap(surface.endSeq) }
    }
    const data = event.data
    if (data === null || typeof data !== 'object') return next
    if (Array.isArray(data.messageSeqs)) next.data = { ...data, messageSeqs: remapList(data.messageSeqs) }
    if (typeof data.sourceEventSeq === 'number') next.data = { ...next.data, sourceEventSeq: remap(data.sourceEventSeq) }
    if (typeof data.headerSeq === 'number') next.data = { ...next.data, headerSeq: remap(data.headerSeq) }
    if (Array.isArray(data.shadowedSeqs)) {
      next.data = {
        ...next.data,
        shadowedSeqs: remapList(data.shadowedSeqs),
        shadowedRange: data.shadowedRange === undefined ? undefined : {
          ...data.shadowedRange,
          start: remap(data.shadowedRange.start),
          end: remap(data.shadowedRange.end),
        },
      }
    }
    if (Array.isArray(data.targets)) {
      next.data = { ...next.data, targets: data.targets.map(target => ({ ...target, seq: remap(target.seq) })) }
    }
    return next
  })
}

/**
 * Stamp each synthetic interrupted-call closer with an id naming its own final
 * coordinate, matching the harness's `interrupted-tool-result-<callId>-<seq>`
 * convention (its seq is only known after renumbering).
 * @param {object[]} events - densely renumbered events.
 * @returns {object[]} the same events with canonical closer ids.
 */
function stampCloserIds(events) {
  return events.map(event => {
    const code = event.data?.error?.code
    if (code !== 'TOOL_OUTCOME_UNKNOWN' && code !== 'TOOL_NOT_STARTED') return event
    const callId = event.data.message.toolCallId
    return { ...event, data: { ...event.data, message: { ...event.data.message, id: `interrupted-tool-result-${callId}-${event.seq}` } } }
  })
}

/**
 * Repair one decoded log. Structural repairs may add, drop, or move events and
 * trigger renumbering; the projection repair only rewrites block payload bytes
 * and is applied afterwards so it also covers synthetic advertisements (which
 * already agree, cheaply detected as unchanged).
 * @param {{ headerLine: string, eventLines: string[], trailingNewline: boolean }} log - decoded log.
 * @returns {{ log: object, delta: number, before: number, after: number, changed: boolean }} repaired log and counts.
 */
function repairLog(log) {
  const events = log.eventLines.map(line => JSON.parse(line))
  let repaired = orderAdvertisements(events)
  repaired = relocateResults(repaired)
  repaired = dropDuplicateResults(repaired)
  repaired = settleUnresolved(repaired)
  repaired = insertAdvertisements(repaired)
  repaired = insertSystemHead(repaired)
  const structural = repaired !== events
  repaired = repairProjections(repaired)
  if (repaired === events) return { log, delta: 0, before: events.length, after: events.length, changed: false }
  if (!structural) {
    return {
      log: { ...log, eventLines: repaired.map(event => JSON.stringify(event)) },
      delta: 0,
      before: events.length,
      after: events.length,
      changed: true,
    }
  }
  const final = stampCloserIds(renumberAndRemap(repaired))
  return {
    log: { ...log, eventLines: final.map(event => JSON.stringify(event)) },
    delta: final.length - events.length,
    before: events.length,
    after: final.length,
    changed: true,
  }
}

/**
 * Count the projection-mismatch family in one log: advertised blocks whose
 * `name` or `arguments` disagree with their `tool/call` event.
 * @param {object[]} events - decoded events.
 * @returns {number} mismatching call count.
 */
function countProjectionMismatches(events) {
  const blocks = collectAdvertisedBlocks(events)
  let mismatches = 0
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const block = blocks.get(event.data.callId)
    if (block === undefined) continue
    if (block.name !== event.data.name || block.arguments !== event.data.arguments) mismatches += 1
  }
  return mismatches
}

/**
 * Count the repairs one artifact needs without writing anything.
 * @param {string} path - artifact path.
 * @returns {{ generation: number, unadvertised: number, lateAdvertisement: number, duplicateResults: number, unresolved: number, systemHead: boolean, projectionMismatch: number }} finding counts.
 */
function inspectArtifact(path) {
  const { headerLine, eventLines } = readArtifact(path)
  const generation = generationOf(headerLine)
  const events = eventLines.map(line => JSON.parse(line))
  const advertised = new Map()
  const unadvertised = new Map()
  let lateAdvertisement = 0
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const key = stepKey(event.data.turn, event.data.step)
      const ids = advertised.get(key) ?? new Set()
      advertised.set(key, ids)
      for (const id of advertisedIds(event)) ids.add(id)
      continue
    }
    if (event.type !== 'tool/call') continue
    const key = stepKey(event.data.turn, event.data.step)
    const ids = advertised.get(key)
    if (ids === undefined || !ids.has(event.data.callId)) {
      const group = unadvertised.get(key) ?? []
      group.push(event)
      unadvertised.set(key, group)
      if (ids !== undefined && allStepIds(events, event).has(event.data.callId)) lateAdvertisement += 1
    }
  }
  const settled = new Set()
  const counts = new Map()
  for (const event of events) {
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') continue
    const callId = event.data?.message?.source?.callId
    if (typeof callId !== 'string') continue
    settled.add(callId)
    counts.set(callId, (counts.get(callId) ?? 0) + 1)
  }
  let duplicateResults = 0
  for (const count of counts.values()) duplicateResults += count - 1
  const started = events.filter(event => event.type === 'tool/call').map(event => event.data.callId)
  const unresolved = started.filter(callId => !settled.has(callId)).length
  let count = 0
  for (const group of unadvertised.values()) count += group.length
  return {
    generation,
    unadvertised: count,
    lateAdvertisement,
    duplicateResults,
    unresolved,
    systemHead: needsSystemHead(events),
    projectionMismatch: countProjectionMismatches(events),
  }
}

/** The set of call ids advertised anywhere in one event's own step. */
function allStepIds(events, call) {
  const ids = new Set()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    if (event.data.turn !== call.data.turn || event.data.step !== call.data.step) continue
    for (const id of advertisedIds(event)) ids.add(id)
  }
  return ids
}

// --- file mechanics ---------------------------------------------------------

/** Read one artifact from disk. */
function readArtifact(path) {
  return decodeLog(readFileSync(path))
}

/**
 * The format generation named by an artifact's header line.
 * @param {string} headerLine - the decoded header line.
 * @returns {number} the header's `version`.
 */
function generationOf(headerLine) {
  const header = JSON.parse(headerLine)
  if (header?.version !== 3 && header?.version !== 4) {
    throw new ArtifactError(`unsupported session format version ${JSON.stringify(header?.version)}`)
  }
  return header.version
}

/** Write one artifact atomically: temp file in the same directory, then rename. */
function writeArtifact(path, log) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, encodeLog(log))
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Back up one artifact next to itself before it is rewritten. */
function backupArtifact(path) {
  const backup = `${path}.bak`
  if (existsSync(backup)) throw new Error(`refusing to overwrite existing backup ${backup}`)
  writeFileSync(backup, readFileSync(path))
  return backup
}

/** Enumerate v3 and v4 session artifacts under a root. */
function scanRoot(root) {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (SESSION_LOG_NAME.test(entry.name)) found.push(path)
    }
  }
  if (existsSync(root)) walk(root)
  return found.sort()
}

/** Repair one artifact in place, returning its counts. */
function repairFile(path) {
  const result = repairLog(readArtifact(path))
  if (!result.changed) return result
  backupArtifact(path)
  writeArtifact(path, result.log)
  return result
}

// --- optional harness verification ------------------------------------------

/**
 * Resolve the harness's migration and validation modules for `--verify`.
 * @param {string} harnessDir - the sibling harness checkout root.
 * @returns {Promise<object>} the loaded migration and relationship-validation declarations.
 */
async function loadHarness(harnessDir) {
  const base = pathToFileURL(join(harnessDir, 'packages/session/session-format-v3-to-v4/src') + '/')
  const { createSessionFormatV3ToV4 } = await import(new URL('migration.ts', base).href)
  const { assertReleasedV4Relationships } = await import(new URL('validation.ts', base).href)
  return { createSessionFormatV3ToV4, assertReleasedV4Relationships }
}

/**
 * Run the generation's own oracle over one file. A v3 artifact goes through the
 * real v3→v4 migration plus v4 relationship validation; a v4 artifact goes
 * straight to the V4 relationship validation the load path runs.
 * @param {string} path - artifact path.
 * @param {object} harness - loaded harness declarations.
 * @returns {string} `OK: ...` or `FAIL: ...`.
 */
function verifyOne(path, harness) {
  try {
    const { headerLine, eventLines } = readArtifact(path)
    const generation = generationOf(headerLine)
    const events = eventLines.map(line => JSON.parse(line))
    return generation === 4
      ? verifyV4(headerLine, events, harness)
      : verifyV3(headerLine, events, harness)
  } catch (error) {
    return `FAIL: ${error?.constructor?.name ?? 'Error'} - ${error?.message ?? String(error)}`
  }
}

/**
 * Run the harness's real v3→v4 migration plus v4 relationship validation.
 * @param {string} headerLine - the v3 header line.
 * @param {object[]} events - the v3 events.
 * @param {object} harness - loaded harness declarations.
 * @returns {string} verdict.
 */
function verifyV3(headerLine, events, harness) {
  const header = { ...JSON.parse(headerLine) }
  delete header.type
  const migration = harness.createSessionFormatV3ToV4([])
  const targetHeader = migration.migrateHeader(header)
  migration.validateTargetHeader(targetHeader)
  const stage = migration.createStage({
    sourceHeader: header, targetHeader, sourceInheritedEventCount: 0, sourceKind: 'decoded',
  })
  const out = []
  const context = { emitEvent: event => out.push(event), emitRun: run => { for (const event of run.expand()) out.push(event) } }
  for (const event of events) stage.transformEvent(event, context)
  const inherited = stage.finish(context)
  const artifact = { header: targetHeader, events: out, inheritedEventCount: inherited }
  harness.assertReleasedV4Relationships(artifact, new Set(out.map(event => event.type)))
  return `OK: v3 migrated + validated ${out.length} events, inherited ${inherited}`
}

/**
 * Validate a v4 artifact with the same relationship pass the V4 load path runs.
 * @param {string} headerLine - the v4 header line.
 * @param {object[]} events - the v4 events.
 * @param {object} harness - loaded harness declarations.
 * @returns {string} verdict.
 */
function verifyV4(headerLine, events, harness) {
  const header = JSON.parse(headerLine)
  const artifact = { header, events, inheritedEventCount: inheritedCountOf(header, events) }
  harness.assertReleasedV4Relationships(artifact, new Set(events.map(event => event.type)))
  return `OK: v4 relationship-validated ${events.length} events, inherited ${artifact.inheritedEventCount}`
}

/**
 * The inherited-event cut a v4 header implies: the last inherited
 * `session/end-seed` marker for a seeded session, else zero. Mirrors the v4
 * physical decoder, so a v4 artifact can be handed to the relationship oracle.
 * @param {object} header - the v4 logical header.
 * @param {object[]} events - the v4 events.
 * @returns {number} inherited event count.
 */
function inheritedCountOf(header, events) {
  if (header.isSeeded !== true) return 0
  let cut
  for (const event of events) {
    if (event.type === 'session/end-seed' && event.data?.inherited === true) cut = event.seq
  }
  if (cut === undefined) throw new ArtifactError('seeded v4 artifact lacks an inherited end-seed marker')
  return cut
}

// --- command line -----------------------------------------------------------

/** Parse argv into the tool's options. */
function parseArgv(argv) {
  const options = {
    mode: 'repair',
    verify: false,
    harness: resolve(dirname(fileURLToPath(import.meta.url)), '../../deepseek-harness'),
    files: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--check') options.mode = 'check'
    else if (token === '--verify') options.verify = true
    else if (token === '--harness') options.harness = argv[++index]
    else if (token.startsWith('--')) throw new Error(`unknown option ${token}`)
    else options.files.push(token)
  }
  return options
}

async function main() {
  const options = parseArgv(process.argv.slice(2))
  const root = process.env.DSH_SESSIONS_ROOT ?? join(homedir(), '.dsh', 'sessions')
  const scanned = options.files.length > 0 ? options.files : (options.mode === 'check' ? scanRoot(root) : [])
  if (scanned.length === 0) throw new Error('no input files: pass <file...> or use --check to scan the session root')

  if (options.mode === 'check') {
    const stats = new Map()
    let affected = 0
    for (const path of scanned) {
      const finding = inspectArtifact(path)
      const structural = finding.unadvertised + finding.lateAdvertisement + finding.duplicateResults
        + finding.unresolved + (finding.systemHead ? 1 : 0)
      const totals = stats.get(finding.generation) ?? { files: 0, structural: 0, projection: 0 }
      totals.files += 1
      stats.set(finding.generation, totals)
      if (structural === 0 && finding.projectionMismatch === 0) continue
      affected += 1
      if (structural > 0) totals.structural += 1
      if (finding.projectionMismatch > 0) totals.projection += 1
      console.log(`v${finding.generation} ${path}`)
      console.log(`  family-1 structural: unadvertised ${finding.unadvertised}, late ${finding.lateAdvertisement},`
        + ` duplicate-results ${finding.duplicateResults}, unresolved ${finding.unresolved},`
        + ` system-head ${finding.systemHead ? 'yes' : 'no'}`)
      console.log(`  family-6 projection-mismatch: ${finding.projectionMismatch} tool/call(s)`)
    }
    console.log(`scanned: ${scanned.length} affected: ${affected}`)
    for (const [generation, totals] of [...stats.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`v${generation}: files ${totals.files}, family-1 structural ${totals.structural},`
        + ` family-6 projection ${totals.projection}`)
    }
    return
  }

  let harness
  if (options.verify) {
    try {
      harness = await loadHarness(options.harness)
    } catch (error) {
      throw new Error('--verify needs the sibling harness and the tsx loader: run with '
        + `"node --import tsx/esm scripts/repair-session-logs.mjs --verify <file...>" (cause: ${error?.message})`)
    }
  }

  let changed = 0
  let failed = false
  let touchedFailed = 0
  for (const path of scanned) {
    const result = repairFile(path)
    if (result.changed) changed += 1
    console.log(`${result.changed ? 'repaired' : 'unchanged'} ${path}  event delta: ${result.delta >= 0 ? '+' : ''}${result.delta} (${result.before} -> ${result.after})`)
    if (result.changed) console.log(`  backup: ${path}.bak`)
    if (options.verify) {
      const repairedVerdict = verifyOne(path, harness)
      console.log(`  verify repaired: ${repairedVerdict}`)
      if (result.changed) console.log(`  verify backup:   ${verifyOne(`${path}.bak`, harness)}`)
      if (result.changed && !repairedVerdict.startsWith('OK')) {
        failed = true
        touchedFailed += 1
      }
    }
  }
  console.log(`repaired files: ${changed} of ${scanned.length}`)
  if (failed) {
    process.exitCode = 1
    throw new Error(`${touchedFailed} repaired artifact(s) did not pass their generation oracle`)
  }
}

main().catch(error => {
  console.error(`repair-session-logs: ${error?.message ?? String(error)}`)
  process.exitCode = 1
})
