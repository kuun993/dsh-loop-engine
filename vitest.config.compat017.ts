/**
 * Vitest configuration that runs the SAME suite against the 0.1.7 harness line.
 *
 * The plugin ships one build for the 0.1.5, 0.1.7 and 0.2.0 harness generations
 * across the three compat configs, so the specs must pass under all
 * of them. This config resolves every `@deepseek-ai/*` package the suite imports
 * through the isolated 0.1.7 dependency set installed in `.compat/017/` (see
 * `.compat/017/package.json`), instead of the 0.2.0 install in `node_modules/`.
 * Only packages present at `.compat/017/node_modules/@deepseek-ai` are aliased,
 * so a nested transitive dependency still resolves through pnpm's own layout
 * rather than being redirected at a path that does not exist.
 *
 * The two React entry points the browser half imports are aliased to the same
 * node stand-ins the other configs use: they are harness module-table externals
 * and are installed neither here nor in `node_modules`.
 *
 * Run with: `npx vitest run --config vitest.config.compat017.ts`.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const compatScope = fileURLToPath(new URL('./.compat/017/node_modules/@deepseek-ai/', import.meta.url))
const fakeReact = fileURLToPath(new URL('./tests/helpers/fake-react.ts', import.meta.url))

/** One alias per harness-scope package installed in the 0.1.7 set. */
const alias = readdirSync(compatScope).map(name => ({
  find: `@deepseek-ai/${name}`,
  replacement: join(compatScope, name),
}))

export default defineConfig({
  resolve: {
    alias: [
      ...alias,
      { find: /^react$/, replacement: fakeReact },
      { find: /^react\/jsx-runtime$/, replacement: fakeReact },
      { find: /^react\/jsx-dev-runtime$/, replacement: fakeReact },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
