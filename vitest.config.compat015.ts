/**
 * Vitest configuration that runs the SAME suite against the 0.1.5 harness line.
 *
 * The plugin ships one build for two harness generations, so the specs must
 * pass under both. This config resolves every `@deepseek-ai/*` package the suite
 * imports through the isolated 0.1.5 dependency set installed in `.compat-015/`
 * (see `.compat-015/package.json`), instead of the 0.1.7 install in
 * `node_modules/`. Only packages present at `.compat-015/node_modules/@deepseek-ai`
 * are aliased, so a nested transitive dependency still resolves through pnpm's
 * own layout rather than being redirected at a path that does not exist.
 *
 * Run with: `npx vitest run --config vitest.config.compat015.ts`.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const compatScope = fileURLToPath(new URL('./.compat-015/node_modules/@deepseek-ai/', import.meta.url))

/** One alias per harness-scope package installed in the 0.1.5 set. */
const alias = readdirSync(compatScope).map(name => ({
  find: `@deepseek-ai/${name}`,
  replacement: join(compatScope, name),
}))

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
