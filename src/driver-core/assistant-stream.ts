/**
 * Live assistant-stream framing for the hosted engines.
 *
 * Harness 0.1.5 made the model stream the durable record of an assistant
 * attempt: `assistant/message` embeds its exact timed stream and may no longer
 * cite `sourceEventSeqs`, and the transient per-chunk log events the plugin
 * used to append (`assistant/chunk`) no longer exist. Live partials now travel
 * through the process-local `agent/assistant-stream` notification instead, and
 * the compact records are handed to the durable message.
 *
 * This is the driver-side equivalent of the loop's `AssistantStreamAttempt`,
 * minus the block assembly: a hosted engine keeps assembling its own
 * authoritative transcript from its own protocol, and this class only frames
 * the attempt and compacts its stream for replay fidelity.
 *
 * @module dsh-loop-engine/driver-core/assistant-stream
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  LlmAttemptId,
  type AssistantStreamRecord,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/**
 * One model attempt on a hosted engine: ordered live frames plus the compact
 * stream the durable `assistant/message` carries.
 */
export class DriverAssistantStream {
  private accumulator = new AssistantStreamAccumulator()
  private index = 0
  private revision = 0
  private terminal = false
  /** Attempt identity unique within this agent lifecycle. */
  readonly attemptId: LlmAttemptId

  /**
   * @param sessionId - identity embedded only in the agent-lifecycle-local attempt id.
   * @param attempt - agent-local attempt counter.
   * @param turn - durable turn owning the request.
   * @param step - durable step owning the request.
   * @param emit - agent-scoped notification publisher.
   */
  constructor(
    sessionId: SessionId,
    attempt: number,
    private readonly turn: number,
    private readonly step: number,
    private readonly emit: (frame: AssistantStreamFrame) => void,
  ) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`)
  }

  /** Whether this attempt has already published its terminal frame. */
  get ended(): boolean { return this.terminal }

  /** Publish the opening marker before the first delivered chunk. */
  start(): void {
    this.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: ++this.revision,
      turn: this.turn,
      step: this.step,
    })
  }

  /** Snapshot one chunk once, then feed durable compaction and live publication. */
  push(chunk: StreamChunk): void {
    const timed = this.accumulator.push({ time: Date.now(), chunk })
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: ++this.revision,
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  /** Exact compact stream for the durable assistant message. */
  get stream(): AssistantStreamRecord[] {
    return [...this.accumulator.snapshot()]
  }

  /**
   * Close the current record run and return it, leaving later chunks in a
   * fresh run. An engine whose protocol reports content segments (rather than
   * one stream per message) cuts at each segment boundary, so every durable
   * message embeds exactly the chunks its own content produced even though the
   * live frames keep flowing through one attempt.
   * @returns the compact records accumulated since the previous cut.
   */
  takeStream(): AssistantStreamRecord[] {
    const records = this.stream
    this.accumulator = new AssistantStreamAccumulator()
    return records
  }

  /**
   * Publish terminal settlement after the matching durable event commits.
   * @param append - synchronous durable append returning its committed seq.
   */
  settle(append: () => SessionSeq): void {
    let seq: SessionSeq
    try {
      seq = append()
    } catch (error: unknown) {
      this.abandon()
      throw error
    }
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: ++this.revision,
      index: this.index,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq },
    })
  }

  /** Publish abandonment when no durable settlement can be committed. */
  abandon(): void {
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: ++this.revision,
      index: this.index,
      outcome: { kind: 'abandoned' },
    })
  }
}
