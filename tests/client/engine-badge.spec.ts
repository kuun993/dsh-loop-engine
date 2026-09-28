/**
 * The header engine chip's display toggle.
 *
 * The chip is the plugin's one piece of always-on chrome in a session header, so
 * `showEngineBadge` has to be able to take it off the screen entirely — the same
 * promise `showInComposer` makes for the composer picker, and for the same
 * reason: a deployment that does not want the plugin's selection surface in the
 * chat page must not have to look at a chip naming the engine instead. The
 * component is called here as a plain function (the browser half's React is a
 * harness module-table external, aliased to `../helpers/fake-react.ts`), which is
 * enough to pin the contract this toggle is: OFF renders nothing at all.
 *
 * The two answers the chip already had are pinned alongside it, because the gate
 * must not have moved them: a session whose engine is not recorded renders
 * nothing either, and a recorded engine renders the chip.
 * @module tests/client/engine-badge
 */

import { describe, expect, it } from 'vitest'
import { LoopEngineBadge, type LoopEngineBadgeProps } from '../../src/client/LoopEngineBadge.tsx'
import type { SessionEngineCache } from '../../src/client/session-engine.ts'
import type { LoopEngineState } from '../../src/client/store.ts'
import { en } from '../../src/client/locales.ts'

/** The session every case here is the header of. */
const SESSION = 'session-1'

/** A copy function over the real English dictionary. */
const t = (key: keyof typeof en): string => en[key]

/** One session-engine cache holding a single recorded engine. */
function cacheFor(engine: 'pi' | null): SessionEngineCache {
  return {
    read: (sessionId: string) => sessionId !== SESSION
      ? undefined
      : engine === null ? { engine: { kind: 'unset' as const } } : { engine: { kind: 'engine' as const, engine } },
    watch: () => () => {},
    invalidate: () => {},
  } as unknown as SessionEngineCache
}

/** One settings snapshot, with the badge toggle as the only moving part. */
function state(showEngineBadge: boolean): LoopEngineState {
  return {
    status: 'ready',
    engine: 'in-process',
    showInComposer: true,
    showEngineBadge,
    writable: true,
    error: null,
  }
}

/**
 * The props one render of the header seat receives: the seat's session and the
 * injected face, with the store's snapshot hook answered synchronously.
 * @param showEngineBadge - the toggle the settings are holding.
 * @param engine - the engine the session's record names, or null for a session with none.
 * @returns props the component reads as its own face.
 */
function propsFor(showEngineBadge: boolean, engine: 'pi' | null = 'pi'): LoopEngineBadgeProps {
  const snapshot = state(showEngineBadge)
  return {
    sessionId: SESSION,
    sessionEngines: cacheFor(engine),
    useSnapshot: <S,>(selector: (value: LoopEngineState) => S): S => selector(snapshot),
    t,
  } as unknown as LoopEngineBadgeProps
}

describe('the session header engine badge', () => {
  it('renders the chip for the session on screen while the setting is on', () => {
    const element = LoopEngineBadge(propsFor(true))

    expect(element).not.toBeNull()
    expect((element as { type: unknown }).type).toBe('span')
    expect((element as { props: { title: string } }).props.title).toBe(en.sessionNotice)
  })

  it('renders nothing at all while the setting is off', () => {
    // Not a hidden or empty chip: no element, so the header carries no trace of
    // the plugin whatever else the seat would have rendered.
    expect(LoopEngineBadge(propsFor(false))).toBeNull()
  })

  it('renders nothing for a session whose engine was never recorded, either way', () => {
    expect(LoopEngineBadge(propsFor(true, null))).toBeNull()
    expect(LoopEngineBadge(propsFor(false, null))).toBeNull()
  })
})
