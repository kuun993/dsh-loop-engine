/**
 * The idle countdown every persistent child is closed through. Each case drives
 * the countdown with fake timers, so "the window passed" is an exact advance
 * rather than a race against a real clock.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdleChildCloser, type IdleChildCloserOptions } from '../../src/driver-core/idle-child.ts'

/** The closer under test plus the two spies it reports through. */
function makeCloser(overrides: Partial<IdleChildCloserOptions> = {}): {
  closer: ReturnType<typeof createIdleChildCloser>
  close: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  const close = vi.fn()
  const warn = vi.fn()
  const built = createIdleChildCloser({ idleMs: 1000, close, warn, ...overrides })
  return { closer: built, close, warn }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createIdleChildCloser', () => {
  it('closes the child once the idle window passes', () => {
    vi.useFakeTimers()
    const { closer, close } = makeCloser()
    closer.arm()
    vi.advanceTimersByTime(999)
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('stays inert while the idle window is not positive', () => {
    vi.useFakeTimers()
    const disabled = makeCloser({ idleMs: 0 })
    const negative = makeCloser({ idleMs: -1 })
    disabled.closer.arm()
    negative.closer.arm()
    vi.advanceTimersByTime(10_000)
    expect(disabled.close).not.toHaveBeenCalled()
    expect(negative.close).not.toHaveBeenCalled()
  })

  it('restarts the countdown when it is armed again', () => {
    vi.useFakeTimers()
    const { closer, close } = makeCloser()
    closer.arm()
    vi.advanceTimersByTime(600)
    closer.arm()
    vi.advanceTimersByTime(600)
    // 1200ms of wall clock, but only 600ms since the last arm.
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending countdown', () => {
    vi.useFakeTimers()
    const { closer, close } = makeCloser()
    closer.arm()
    closer.cancel()
    vi.advanceTimersByTime(10_000)
    expect(close).not.toHaveBeenCalled()
  })

  it('cancels a countdown that never armed', () => {
    const { closer, close } = makeCloser()
    closer.cancel()
    expect(close).not.toHaveBeenCalled()
  })

  it('drops a pending countdown on dispose', () => {
    vi.useFakeTimers()
    const { closer, close } = makeCloser()
    closer.arm()
    closer.dispose()
    vi.advanceTimersByTime(10_000)
    expect(close).not.toHaveBeenCalled()
  })

  it('arms again after a countdown has fired', () => {
    vi.useFakeTimers()
    const { closer, close } = makeCloser()
    closer.arm()
    vi.advanceTimersByTime(1000)
    closer.arm()
    vi.advanceTimersByTime(1000)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('reports a failing close instead of throwing it out of the countdown', () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    const closer = createIdleChildCloser({
      idleMs: 1000,
      close: () => { throw new Error('child would not die') },
      warn,
    })
    closer.arm()
    expect(() => { vi.advanceTimersByTime(1000) }).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('child would not die'))
  })
})
