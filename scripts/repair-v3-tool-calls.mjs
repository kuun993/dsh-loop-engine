#!/usr/bin/env node
/**
 * @file One-off data repair for V3 session logs written by an older
 * `dsh-loop-engine` hosted-driver build.
 *
 * A hosted engine (claude-code / codex / pi / kimi) drives a session by writing
 * the durable session log itself. Driver builds from before the `71ccdea`,
 * `c293e25`, `5de4b91`, and `1c94078` fixes (all before 2026-09-19) wrote a
 * transcript the harness's *format v3* reader tolerated but the *format v4*
 * lifecycle rules reject, so the v3→v4 migration refuses the session and leaves
 * the v3 artifact unchanged. The observed defects, each repaired here:
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
 * This is a one-off repair tool, not part of the plugin runtime: nothing under
 * `lib/` imports it and it is not published. The pure repair path uses only the
 * Node standard library. Only `--verify` reaches into the sibling
 * `deepseek-harness` checkout, to run that checkout's real v3→v4 migration and
 * v4 relationship validation over the result and the backup; run it as
 * `node --import tsx/esm scripts/repair-v3-tool-calls.mjs --verify <file...>`
 * (the harness path defaults to `../deepseek-harness` next to this repo and can
 * be overridden with `--harness <dir>`).
 *
 *   node scripts/repair-v3-tool-calls.mjs <file...>            repair in place (writes <file>.v3.bak)
 *   node scripts/repair-v3-tool-calls.mjs --check [<file...>]  report only
 *   node scripts/repair-v3-tool-calls.mjs --verify <file...>   repair, then verify with the harness
 *
 * `--check` lists the logs carrying defect 1 — the missing-advertisement scan
 * that the read-only `scan.cjs` performs — with the sibling defect counts on the
 * same line, then a summary including the number of logs carrying only sibling
 * defects. With `--check` and no file arguments it scans the session root
 * (`$DSH_SESSIONS_ROOT`, else `~/.dsh/sessions`). A repair that changes nothing
 * leaves the file byte-for-byte untouched; every write goes to a temp file in
 * the same directory and is renamed into place, so a failure never leaves a
 * partially written log.
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
const SESSION_LOG_NAME = /^session\.v3\.jsonl(\.zstd)?$/
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
 * Repair one decoded log.
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
  if (repaired === events) return { log, delta: 0, before: events.length, after: events.length, changed: false }
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
 * Count the repairs one artifact needs without writing anything.
 * @param {string} path - artifact path.
 * @returns {{ unadvertised: number, lateAdvertisement: number, duplicateResults: number, unresolved: number, systemHead: boolean }} finding counts.
 */
function inspectArtifact(path) {
  const { eventLines } = readArtifact(path)
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
  return { unadvertised: count, lateAdvertisement, duplicateResults, unresolved, systemHead: needsSystemHead(events) }
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
  const backup = `${path}.v3.bak`
  if (existsSync(backup)) throw new Error(`refusing to overwrite existing backup ${backup}`)
  writeFileSync(backup, readFileSync(path))
  return backup
}

/** Enumerate v3 session artifacts under a root. */
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
 * @returns {Promise<object>} the loaded migration declarations.
 */
async function loadHarness(harnessDir) {
  const base = pathToFileURL(join(harnessDir, 'packages/session/session-format-v3-to-v4/src') + '/')
  const { createSessionFormatV3ToV4 } = await import(new URL('migration.ts', base).href)
  const { assertReleasedV4Relationships } = await import(new URL('validation.ts', base).href)
  return { createSessionFormatV3ToV4, assertReleasedV4Relationships }
}

/**
 * Run the harness's real v3→v4 migration plus v4 relationship validation over one file.
 * @param {string} path - artifact path.
 * @param {object} harness - loaded harness migrations.
 * @returns {string} `OK: ...` or `FAIL: ...`.
 */
function migrateOne(path, harness) {
  try {
    const { headerLine, eventLines } = readArtifact(path)
    const header = { ...JSON.parse(headerLine) }
    delete header.type
    const events = eventLines.map(line => JSON.parse(line))
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
    return `OK: migrated + validated ${out.length} events, inherited ${inherited}`
  } catch (error) {
    return `FAIL: ${error?.constructor?.name ?? 'Error'} - ${error?.message ?? String(error)}`
  }
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
    let affected = 0
    let siblings = 0
    for (const path of scanned) {
      const finding = inspectArtifact(path)
      const sibling = finding.lateAdvertisement + finding.duplicateResults + finding.unresolved + (finding.systemHead ? 1 : 0)
      if (sibling > 0) siblings += 1
      if (finding.unadvertised === 0) continue
      affected += 1
      console.log(`${path}  unadvertised: ${finding.unadvertised}  late: ${finding.lateAdvertisement}`
        + `  duplicate-results: ${finding.duplicateResults}  unresolved: ${finding.unresolved}`
        + `  system-head: ${finding.systemHead ? 'yes' : 'no'}`)
    }
    console.log(`scanned: ${scanned.length} affected: ${affected} recurring-sibling-defects: ${siblings}`)
    return
  }

  let harness
  if (options.verify) {
    try {
      harness = await loadHarness(options.harness)
    } catch (error) {
      throw new Error('--verify needs the sibling harness and the tsx loader: run with '
        + `"node --import tsx/esm scripts/repair-v3-tool-calls.mjs --verify <file...>" (cause: ${error?.message})`)
    }
  }

  let changed = 0
  let failed = false
  for (const path of scanned) {
    const result = repairFile(path)
    if (result.changed) changed += 1
    console.log(`${result.changed ? 'repaired' : 'unchanged'} ${path}  event delta: ${result.delta >= 0 ? '+' : ''}${result.delta} (${result.before} -> ${result.after})`)
    if (result.changed) console.log(`  backup: ${path}.v3.bak`)
    if (options.verify) {
      const repairedVerdict = migrateOne(path, harness)
      const backupVerdict = migrateOne(`${path}.v3.bak`, harness)
      console.log(`  verify repaired: ${repairedVerdict}`)
      console.log(`  verify backup:   ${backupVerdict}`)
      if (!repairedVerdict.startsWith('OK')) failed = true
    }
  }
  console.log(`repaired files: ${changed} of ${scanned.length}`)
  if (failed) {
    process.exitCode = 1
    throw new Error('a repaired artifact did not pass the harness migration')
  }
}

main().catch(error => {
  console.error(`repair-v3-tool-calls: ${error?.message ?? String(error)}`)
  process.exitCode = 1
})
