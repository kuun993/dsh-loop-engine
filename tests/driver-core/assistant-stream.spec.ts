/**
 * Unit tests for the shared driver-side assistant-attempt framing: the compact
 * stream the durable message carries plus the ordered live frames.
 * @module tests/driver-core/assistant-stream
 */

import { describe, expect, it } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { expandAssistantStream, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { DriverAssistantStream } from '../../src/driver-core/assistant-stream.ts'

/** One streamed text delta. */
function delta(text: string): StreamChunk {
  return { type: 'text-delta', index: 0, text }
}

/** A stream whose frames land in `frames`. */
function stream(frames: AssistantStreamFrame[]): DriverAssistantStream {
  return new DriverAssistantStream(
    SessionId('stream-s'),
    1,
    2,
    3,
    (frame) => { frames.push(frame) },
  )
}

describe('DriverAssistantStream', () => {
  it('frames an attempt from open through committed settlement', () => {
    const frames: AssistantStreamFrame[] = []
    const live = stream(frames)
    expect(live.ended).toBe(false)
    expect(live.attemptId).toBe('stream-s:1')

    live.start()
    live.push(delta('hello '))
    live.push(delta('world'))
    live.settle(() => SessionSeq(9))

    expect(live.ended).toBe(true)
    expect(frames).toMatchObject([
      { type: 'start', attemptId: 'stream-s:1', revision: 1, turn: 2, step: 3 },
      { type: 'chunk', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'hello ' } },
      { type: 'chunk', revision: 3, index: 1, chunk: { type: 'text-delta', index: 0, text: 'world' } },
      { type: 'end', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } },
    ])
    // The compact stream replays the exact members that were pushed.
    expect(expandAssistantStream(live.stream).map(member => member.chunk)).toEqual([
      { type: 'text-delta', index: 0, text: 'hello ' },
      { type: 'text-delta', index: 0, text: 'world' },
    ])
  })

  it('abandons the attempt when the durable append is rejected', () => {
    const frames: AssistantStreamFrame[] = []
    const live = stream(frames)
    live.start()
    live.push(delta('partial'))

    expect(() => live.settle(() => { throw new Error('append boom') })).toThrow('append boom')

    // The rejection still closes the live frames, so the client stops painting.
    expect(live.ended).toBe(true)
    expect(frames.at(-1)).toMatchObject({ type: 'end', index: 1, outcome: { kind: 'abandoned' } })
  })

  it('abandons an attempt explicitly without a durable settlement', () => {
    const frames: AssistantStreamFrame[] = []
    const live = stream(frames)
    live.start()
    live.abandon()

    expect(live.ended).toBe(true)
    expect(frames.at(-1)).toMatchObject({ type: 'end', index: 0, outcome: { kind: 'abandoned' } })
  })

  it('cuts the record run at a content boundary without breaking the live frames', () => {
    const frames: AssistantStreamFrame[] = []
    const live = stream(frames)
    live.start()
    live.push(delta('first'))
    const first = live.takeStream()

    live.push(delta('second'))
    const second = live.takeStream()

    expect(expandAssistantStream(first).map(member => member.chunk)).toEqual([delta('first')])
    expect(expandAssistantStream(second).map(member => member.chunk)).toEqual([delta('second')])
    // Both segments still streamed through one uninterrupted attempt.
    expect(live.stream).toEqual([])
    expect(live.ended).toBe(false)
    expect(frames.map(frame => frame.type)).toEqual(['start', 'chunk', 'chunk'])
  })
})
