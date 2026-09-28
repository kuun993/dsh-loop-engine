/**
 * The mark that tells the turn-status sheet WHICH row is the live one.
 *
 * The 0.1.7 line renders one row per turn and keeps every one of them on screen
 * after its turn ends (the collapsed "用时 4秒" summary), so the session-wide
 * mid-turn gate is not enough on its own: while turn N runs, turns 1..N-1 are
 * still there and would wear the glyph and the sweep with it. The sheet
 * therefore paints the row the module marks — the LAST row in the document, the
 * turn in flight — and this spec pins that mark: where it lands, that it moves
 * as the turns advance, and that it is gone the moment the gate is.
 *
 * The row's own `disabled` is deliberately NOT what the mark is derived from. It
 * reads "this turn cannot be collapsed", which ui-chat leaves set forever on a
 * turn that ended `aborted` or `error` — so a rule keyed on it keeps painting
 * those zombie rows for as long as any later turn runs, which is the bug this
 * mark replaces.
 *
 * The DOM is faked (`../helpers/fake-dom.ts`): a real `MutationObserver` fires on
 * its own schedule, so its records are delivered by hand here.
 * @module tests/client/turn-status-live-row
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  blurTurnStatusSession, focusTurnStatusSession, reflectTurnStatusEngine,
} from '../../src/client/turn-status.ts'
import { FakeElement, installFakeTurnStatusDom, type FakeTurnStatusDom } from '../helpers/fake-dom.ts'

/**
 * The mark's exact attribute name — spelled out rather than imported, because
 * the name is half of the contract this spec pins (the other half is the
 * selector the sheet emits, asserted in `tests/session-engine-cache.spec.ts`).
 */
const LIVE_ATTR = 'data-loop-engine-live'

describe('the live turn-status row', () => {
  let dom: FakeTurnStatusDom | undefined

  /** Install one fake document for this test. */
  const install = (): FakeTurnStatusDom => (dom = installFakeTurnStatusDom())

  /** The rows currently carrying the mark, in document order. */
  const marked = (): FakeElement[] => dom?.rows.filter(row => row.hasAttribute(LIVE_ATTR)) ?? []

  /**
   * Reflect the way a surface of the session on screen does: declare the subject
   * this reflection speaks for, then speak for it.
   * @param engine - the engine that session runs, when it is known.
   * @param running - whether that session is mid-turn, when the surface knows.
   */
  const reflect = (engine: 'pi' | 'kimi' | undefined, running?: boolean): void => {
    focusTurnStatusSession('s1')
    reflectTurnStatusEngine('s1', engine, running)
  }

  afterEach(() => {
    // Release the gate, so no test inherits a mark or a live observer from the
    // one before it, and hand the globals back.
    reflect('pi', false)
    blurTurnStatusSession('s1')
    dom?.restore()
    dom = undefined
  })

  it('marks the last row in the document — the turn in flight — and no other', () => {
    const installed = install()
    const zombie = installed.addRow(1)
    // A turn that ended `aborted` or `error` keeps its button `disabled` for
    // good — the row the old `:disabled` rule mistook for the live one, and the
    // reason the mark is derived from position rather than from the row's state.
    zombie.setAttribute('disabled', '')
    installed.addRow(3)
    installed.addRow(5)

    reflect('pi', true)

    expect(marked().map(row => row.attributes.get('data-turn-process'))).toEqual(['5'])
    expect(zombie.hasAttribute(LIVE_ATTR)).toBe(false)
    // The gate's other half is unchanged: the session-level attribute is what
    // lets the sheet paint at all.
    expect(installed.dataset.loopEngineRunning).toBe('')
    expect(installed.dataset.loopEngine).toBe('pi')
  })

  it('moves to the newer row when the next turn starts', () => {
    const installed = install()
    installed.addRow(1)
    const running = installed.addRow(3)
    reflect('pi', true)
    expect(marked()).toEqual([running])

    // The turn advanced: a new row was appended after the marked one, which is
    // now the previous turn's summary. Exactly one row wears the mark.
    const next = installed.addRow(5)
    installed.mutate([next])

    expect(marked()).toEqual([next])
    expect(running.hasAttribute(LIVE_ATTR)).toBe(false)
  })

  it('finds a new row inside markup React inserted whole', () => {
    const installed = install()
    installed.addRow(1)
    reflect('pi', true)

    // A row does not have to be the node the record reports — it can arrive
    // anywhere inside an inserted subtree, and the mark still has to move to it.
    const wrapper = new FakeElement('div')
    const row = wrapper.append(new FakeElement('button'))
    row.setAttribute('data-turn-process', '3')
    installed.body.append(wrapper)
    installed.mutate([wrapper])

    expect(marked()).toEqual([row])
  })

  it('ignores mutations that cannot change the last row', () => {
    const installed = install()
    const row = installed.addRow(1)
    reflect('pi', true)

    // The chat's own streaming churn: text arriving inside a message, and markup
    // that is no row at all. The observer sees all of it, and neither may move
    // the mark — nor blow up on a node that has no `matches`.
    installed.mutate(
      [{ nodeType: 3 } as unknown as FakeElement, installed.body.append(new FakeElement('span'))],
      [installed.body.append(new FakeElement('div'))],
    )

    expect(marked()).toEqual([row])
  })

  it('takes the mark off when the turn ends, and stops watching with it', () => {
    const installed = install()
    installed.addRow(1)
    reflect('pi', true)
    expect(marked()).toHaveLength(1)

    reflect('pi', false)
    expect(marked()).toHaveLength(0)
    expect(installed.dataset.loopEngineRunning).toBeUndefined()

    // Nothing is watched any more, so a row that appears later cannot be marked
    // by a follower left running behind the gate.
    const late = installed.addRow(3)
    installed.mutate([late])
    expect(marked()).toHaveLength(0)
    expect(installed.observers.every(observer => !observer.connected)).toBe(true)
  })

  it('clears the mark when the last row is unmounted', () => {
    const installed = install()
    const only = installed.addRow(1)
    reflect('pi', true)
    expect(marked()).toEqual([only])

    installed.removeRow(only)
    installed.mutate([], [only])

    expect(marked()).toHaveLength(0)
  })

  it('marks nothing while the gate is off', () => {
    const installed = install()
    installed.addRow(1)
    installed.addRow(3)

    // The engine is known, but the surface did not say the session is mid-turn
    // (`undefined` is "no answer", not "not running"): no mark, and nothing
    // watching for one.
    reflect('pi')
    expect(marked()).toHaveLength(0)
    expect(installed.observers).toHaveLength(0)

    const late = installed.addRow(5)
    installed.mutate([late])
    expect(marked()).toHaveLength(0)
  })

  it('watches the chat container once, for the whole turn', () => {
    const installed = install()
    reflect('pi', true)
    // The chip and the composer of one session both reflect a running turn.
    reflect('pi', true)

    expect(installed.observers).toHaveLength(1)
    expect(installed.observers[0]!.watched).toEqual([
      { target: installed.body, options: { childList: true, subtree: true } },
    ])
  })
})
