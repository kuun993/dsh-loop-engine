import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const mono = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))
/**
 * The browser half's React entry points are harness module-table externals, not
 * dependencies of this package (`package.json` `dsh.client.external`), so a spec
 * that calls one of its components resolves them to the node stand-ins under
 * `tests/helpers/`.
 */
const fakeReact = fileURLToPath(new URL('./tests/helpers/fake-react.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: fakeReact },
      { find: /^react\/jsx-runtime$/, replacement: fakeReact },
      { find: /^react\/jsx-dev-runtime$/, replacement: fakeReact },
      // Both vendored packages resolve to SOURCE, so the suite needs no harness
      // install and no built `lib/`. The checkout CI provides is a bare
      // `git clone`: there is no `vendor/cordis/node_modules/@deepseek-ai/cosmokit`
      // junction (pnpm only creates it on an install) and no built
      // `vendor/cosmokit/lib/index.js` for it to point at. `vendor/cosmokit` has
      // no dependencies of its own, and cordis's only other external import is
      // type-only, so the sources are sufficient.
      { find: '@deepseek-ai/cordis', replacement: `${mono}vendor/cordis/src/index.ts` },
      { find: '@deepseek-ai/cosmokit', replacement: `${mono}vendor/cosmokit/src/index.ts` },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts'],
      // Browser half is verified at the real profile-mount smoke; importing it
      // here would execute the client bundle (window.__ModuleLoader__) in node.
      exclude: ['src/client/**'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})