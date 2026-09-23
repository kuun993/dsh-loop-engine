/**
 * Shared tool-runtime stand-in for the router suites.
 *
 * `@deepseek-ai/dsh-tools` is not a dependency of this package, and the router's
 * inject gate still requires the `tools` name to be registered and its fiber
 * ACTIVE before the router will mount — that gate is what keeps the harness
 * loop's turn machinery from reading `ctx.tools` on a context that never
 * injected it. A suite that only needs the router up, or that drives a turn
 * whose scripted step calls no tool, therefore supplies this structural
 * stand-in instead of the real registry.
 *
 * @module tests/helpers/tool-runtime
 */

/**
 * The registry slice a prompt contribution reads, answered as "no such tool" so
 * a roster probe contributes nothing instead of failing.
 * @returns a `tools`-shaped service.
 */
export function fakeToolRuntime() {
  return {
    get: (): undefined => undefined,
    schemas: (): readonly never[] => [],
  }
}
