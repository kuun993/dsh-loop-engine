import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const mono = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': `${mono}vendor/cordis/src/index.ts`,
      // The persistence handle refactor (SessionPersistence.create/open +
      // SessionHandle) landed in the monorepo AFTER the 0.1.2-rc.1 publish, so
      // the npm packages still serve the removed `prepare` API. Alias both
      // persistence packages to the monorepo sources, matching what the
      // profile's file: shims resolve at runtime.
      '@deepseek-ai/dsh-session-persistence-jsonl': `${mono}packages/session/session-persistence-jsonl/src/index.ts`,
      '@deepseek-ai/dsh-session-persistence': `${mono}packages/session/session-persistence/src/index.ts`,
    },
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