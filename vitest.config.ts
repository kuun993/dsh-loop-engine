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
      { find: '@deepseek-ai/cordis', replacement: `${mono}vendor/cordis/src/index.ts` },
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