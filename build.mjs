/**
 * Standalone build:
 *   1. tsc emits lib/types/** (declarations; the JS also lands there but is
 *      unused at runtime — esbuild re-bundles the real runtime from src)
 *   2. node half: esbuild bundles src/index.ts -> lib/index.js and
 *      src/invariant.ts -> lib/invariant.js. Relative .ts imports inline;
 *      @deepseek-ai/* peers, schemastery, and node builtins stay external and
 *      resolve through the package's node_modules at runtime.
 *   3. browser half: esbuild bundles src/client/index.ts into lib/client.js
 *      as a client-module factory (window.__ModuleLoader__.load + cjs closure)
 *
 * Usage: node build.mjs
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const PACKAGE_ID = '@deepseek-ai/dsh-loop-engine'

/** Run a command and inherit its streams; exit on failure. */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** Run tsc without a shell: node directly executes the TypeScript bin entry. */
function runTsc() {
  const bin = join(import.meta.dirname, 'node_modules', 'typescript', 'bin', 'tsc')
  run(process.execPath, [bin, '-p', 'tsconfig.build.json'])
}

// Node-half externals: every harness package must stay a single shared
// runtime instance (junctions point at the monorepo SOURCE dir, so esbuild's
// node_modules-based auto-external would inline them and split the cordis
// instance). Explicitly externalize each value import here.
const NODE_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-invariants',
  // Claude Code engine peers: each must stay a single shared runtime instance.
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-timeout',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  // Codex engine SDK + CLI: resolved through node_modules at runtime.
  '@openai/codex-sdk',
  '@openai/codex',
]

// Module-table specifiers the browser bundle must NOT inline: the baseline
// platform list, the preloaded runtime row, and this package's dsh.client.external.
const BROWSER_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-settings/types',
]

// 1. tsc emit (declarations + the type graph both halves import)
runTsc()

// 2. node half bundles
await build({
  entryPoints: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  // Keep every harness peer external; only relative ./src modules inline.
  external: NODE_EXTERNALS,
  sourcemap: true,
  outdir: 'lib',
  entryNames: '[name]',
})

// 3. browser client-module bundle
await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: BROWSER_EXTERNALS,
  sourcemap: true,
  banner: {
    js: `var module = { exports: {} }; var exports = module.exports; window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  outfile: 'lib/client.js',
})

console.log('build ok: lib/index.js lib/invariant.js lib/client.js')