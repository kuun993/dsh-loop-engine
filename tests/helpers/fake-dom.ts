/**
 * The smallest document the turn-status reflection runs against.
 *
 * That reflection is the one piece of the browser half a node test can drive, so
 * what it touches is faked here instead of pulled in: a tree deep enough for
 * `querySelector(All)`, the attributes the module writes, and a
 * `MutationObserver` whose records a test delivers by hand — a real one fires on
 * its own schedule, which would leave the row follower untestable.
 *
 * The fake answers the `tag[attr]` and bare `[attr]` selector forms only — the
 * first for the 0.1.7 turn-process rows, the second for the 0.2.0
 * `[data-chat-running]` node — and it answers the elements that carry the
 * attribute rather than a parsed query: a selector the module cannot reach
 * through it is a selector this fake knows nothing about, and the test that
 * depends on it fails rather than silently passing.
 *
 * @module tests/helpers/fake-dom
 */

/** The callback a `MutationObserver` is constructed with. */
type ObserverCallback = (records: MutationRecord[], observer: MutationObserver) => void

/**
 * The turn-process row selector the reflection looks rows up by — spelled here as
 * the harness markup spells it, so a fake that answered nothing would fail every
 * test that depends on the lookup rather than pass them quietly.
 */
const ROW_BUTTON = 'button[data-turn-process]'

/**
 * The 0.2.0 running row, likewise — the node that generation's live indicator
 * carries, and the one the mark has to stand down for.
 */
const RUNNING_ROW = '[data-chat-running]'

/** The observers built since the last install; `disconnect()` takes one out of the loop. */
let observers: FakeMutationObserver[] = []

/**
 * Match one `tag[attr]` or `[attr]` selector — the two forms this fake DOM
 * understands. The bare form is what a `data-*`-only anchor needs (0.2.0's
 * `[data-chat-running]` names no tag), and both forms answer the elements that
 * carry the attribute rather than a parsed query.
 * @param element - the element to test.
 * @param selector - the selector text.
 * @returns whether the element carries the tag, when one is named, and the attribute.
 */
function matchesAttrSelector(element: FakeElement, selector: string): boolean {
  const parsed = /^(?:([a-z]+))?\[([a-z-]+)\]$/.exec(selector)
  if (parsed === null) return false
  if (parsed[1] !== undefined && element.tagName !== parsed[1]) return false
  return element.attributes.has(parsed[2]!)
}

/** One fake element: the handful of DOM members the turn-status reflection uses. */
export class FakeElement {
  /** The `Node.ELEMENT_NODE` marker the reflection filters mutation records by. */
  readonly nodeType = 1
  /** The attributes set on this element, by exact name. */
  readonly attributes = new Map<string, string>()
  /** The child elements, in document order. */
  readonly children: FakeElement[] = []
  /** The `dataset` record, camelCase-keyed, as a real `DOMStringMap` is. */
  readonly dataset: Record<string, string | undefined> = {}
  /** The element's text — set by the style tag the sheet installs. */
  textContent = ''
  /** Whether `remove()` was called on this element. */
  removed = false
  /** The element this one sits in, when it sits in one. */
  parent: FakeElement | undefined

  /**
   * @param tagName - the lowercase tag name, as the reflection compares it.
   */
  constructor(readonly tagName: string) {}

  /**
   * @param name - the attribute name.
   * @param value - the attribute value.
   */
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }

  /** @param name - the attribute to take off; a missing one is a no-op. */
  removeAttribute(name: string): void { this.attributes.delete(name) }

  /** @param name - the attribute to test for. */
  hasAttribute(name: string): boolean { return this.attributes.has(name) }

  /**
   * Append a child, wiring up the parent link `remove()` needs.
   * @param child - the element to append.
   * @returns the appended element.
   */
  append(child: FakeElement): FakeElement {
    child.parent = this
    this.children.push(child)
    return child
  }

  /** Detach this element from its parent and mark it removed. */
  remove(): void {
    this.removed = true
    const siblings = this.parent?.children
    if (siblings !== undefined) siblings.splice(siblings.indexOf(this), 1)
  }

  /**
   * @param selector - a `tag[attr]` or `[attr]` selector.
   * @returns whether this element matches it.
   */
  matches(selector: string): boolean { return matchesAttrSelector(this, selector) }

  /**
   * @param selector - a `tag[attr]` or `[attr]` selector.
   * @returns the first matching descendant, or `null` when none — as a real
   *   `Element.querySelector` answers, which the reflection's `!== null` tests
   *   depend on.
   */
  querySelector(selector: string): FakeElement | null {
    return this.descendants().find(descendant => descendant.matches(selector)) ?? null
  }

  /**
   * @param selector - a `tag[attr]` or `[attr]` selector.
   * @returns every matching descendant, in document order.
   */
  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter(descendant => descendant.matches(selector))
  }

  /** @returns every descendant, depth first, in document order. */
  descendants(): FakeElement[] {
    return this.children.flatMap(child => [child, ...child.descendants()])
  }
}

/**
 * A `MutationObserver` that only remembers what it was asked to watch: the
 * records a real one would compute arrive through {@link FakeTurnStatusDom.mutate},
 * so a test says exactly when the DOM moved.
 */
class FakeMutationObserver {
  /** Whether this observer still watches — `disconnect()` clears it. */
  connected = true
  /** The target and options of every `observe()` call, in order. */
  readonly watched: Array<{ target: FakeElement; options: MutationObserverInit }> = []

  /** @param callback - the callback the reflection handed in. */
  constructor(private readonly callback: ObserverCallback) { observers.push(this) }

  /**
   * @param target - the element the reflection asked to watch.
   * @param options - what it asked to watch for.
   */
  observe(target: FakeElement, options: MutationObserverInit): void {
    this.watched.push({ target, options })
  }

  /** Stop watching: a disconnected observer receives no further records. */
  disconnect(): void { this.connected = false }

  /** @returns nothing, as an observer with no pending records yields. */
  takeRecords(): MutationRecord[] { return [] }

  /**
   * Hand this observer one child-list record, the way the browser would.
   * @param added - the nodes the record reports as inserted.
   * @param removed - the nodes it reports as removed.
   */
  deliver(added: readonly FakeElement[], removed: readonly FakeElement[]): void {
    if (!this.connected) return
    const record = { addedNodes: added, removedNodes: removed } as unknown as MutationRecord
    this.callback([record], this as unknown as MutationObserver)
  }
}

/** One installed fake document, and the handles its tests need. */
export interface FakeTurnStatusDom {
  /** The fake `document.body` — the chat container everything below hangs in. */
  readonly body: FakeElement
  /** The turn rows currently rendered, in document order — the chat's own markup. */
  readonly rows: FakeElement[]
  /** The `<html>` `dataset` the reflection writes its two root attributes to. */
  readonly dataset: Record<string, string | undefined>
  /** Every element `document.createElement` has handed out, in order. */
  readonly created: FakeElement[]
  /** The observers built since the install, in order. */
  readonly observers: FakeMutationObserver[]
  /**
   * Append one more turn row, the way the chat renders a new turn.
   * @param turn - the turn number, which becomes `data-turn-process`.
   * @returns the row element.
   */
  addRow(turn: number): FakeElement
  /**
   * Mount the 0.2.0 running row (`data-chat-running`), the way `RunningStatus`
   * does for a running session.
   * @returns the running-row element.
   */
  addRunning(): FakeElement
  /**
   * Take a row out of the document, the way React unmounts it.
   * @param row - the row to remove.
   */
  removeRow(row: FakeElement): void
  /**
   * Deliver one child-list record to every connected observer.
   * @param added - the nodes the record reports as inserted.
   * @param removed - the nodes it reports as removed.
   */
  mutate(added?: readonly FakeElement[], removed?: readonly FakeElement[]): void
  /** Uninstall the globals this installed. */
  restore(): void
}

/**
 * Install a fake `document` and `MutationObserver` over the real globals, and
 * hand back the handles a turn-status test needs.
 * @returns the installed fake DOM.
 */
export function installFakeTurnStatusDom(): FakeTurnStatusDom {
  observers = []
  // The observers THIS install builds, held separately from the module-level
  // variable a later install would replace.
  const registry = observers
  const html = new FakeElement('html')
  const body = new FakeElement('body')
  const created: FakeElement[] = []
  const document = {
    documentElement: html,
    body,
    head: { appendChild: () => {} },
    createElement: (tagName: string) => {
      const tag = new FakeElement(tagName)
      created.push(tag)
      return tag
    },
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  }
  const globals = globalThis as { document?: unknown; MutationObserver?: unknown }
  globals.document = document
  globals.MutationObserver = FakeMutationObserver
  return {
    body,
    // Read from the document rather than kept beside it, so a row a test hangs
    // inside its own wrapper still counts — the chat's markup is not flat.
    get rows() { return body.querySelectorAll(ROW_BUTTON) },
    dataset: html.dataset,
    created,
    observers: registry,
    addRow: (turn) => {
      const row = body.append(new FakeElement('button'))
      row.setAttribute('data-turn-process', String(turn))
      return row
    },
    addRunning: () => {
      const row = body.append(new FakeElement('div'))
      row.setAttribute('data-chat-running', '')
      return row
    },
    removeRow: (row) => { row.remove() },
    mutate: (added = [], removed = []) => {
      for (const observer of registry) observer.deliver(added, removed)
    },
    restore: () => {
      delete globals.document
      delete globals.MutationObserver
    },
  }
}
