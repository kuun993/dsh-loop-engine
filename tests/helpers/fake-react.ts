/**
 * The `react` entry points the browser half imports, as node stand-ins.
 *
 * The client bundle does not depend on React: `react`, `react/jsx-runtime`, and
 * `react/jsx-dev-runtime` (the transform Vite emits outside a production build)
 * are harness module-table externals the browser supplies at runtime (see the
 * `dsh.client.external` list in `package.json` and the browser externals in
 * `build.mjs`), so none of them is installed in this package and importing a
 * component from a spec would fail to resolve. The two vitest configs alias all
 * three specifiers to this module, which is what lets a spec call a component as
 * a plain function: the hooks record nothing and the JSX factory returns a
 * descriptor instead of a rendered tree.
 *
 * Deliberately minimal — it is not a renderer. A spec that needs a component's
 * OUTPUT checks the descriptor (`type`, `props`); one that needs the component's
 * decision (does it render at all) needs nothing more, because a component that
 * returns `null` never reaches the JSX factory.
 * @module tests/helpers/fake-react
 */

/** One rendered element, as the JSX factory below records it. */
export interface FakeElement {
  /** The element type the JSX produced (a tag name or a component). */
  type: unknown
  /** The element's props, `children` included. */
  props: Record<string, unknown>
}

/**
 * A state slot that holds the initial value and never changes it: the call
 * returns the value React would return on the first render, and a setter that
 * does nothing (nothing here schedules a re-render).
 * @param initial - the value of the first render.
 * @returns the current value and an inert setter.
 */
export function useState<S>(initial: S): [S, (next: S) => void] {
  return [initial, () => {}]
}

/**
 * An effect that never runs: the call is accepted so a component's hook order
 * is intact, but nothing observes, subscribes, or cleans up.
 * @param effect - the effect the component wanted to install.
 * @param deps - its dependency list.
 */
export function useEffect(effect?: () => void | (() => void), deps?: readonly unknown[]): void {
  void effect
  void deps
}

/** Record one JSX element (the `react/jsx-runtime` factory). */
export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown): FakeElement {
  void key
  return { type, props }
}

/** The same factory for several static children. */
export const jsxs = jsx

/** The development-mode factory; Vite emits it outside production builds. */
export const jsxDEV = jsx

/** The fragment sentinel (`react/jsx-runtime`). */
export const Fragment: unique symbol = Symbol.for('react.fragment')

/** The same exports under a default, for either interop shape. */
export default { Fragment, jsx, jsxDEV, jsxs, useEffect, useState }
