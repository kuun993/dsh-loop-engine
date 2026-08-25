# dsh-loop-engine

Switch the agent loop engine in dsh web the same way you switch models: a
"Loop engine" dropdown in the settings page chooses the in-process default
(`agent-loop`) or the Claude Code CLI driver (`claude-code`); future engines
(Codex, …) extend the same selection.

This package is the single out-of-tree home for the non-default engines **and**
the switch itself — one repo, one plugin row, zero main-repo changes. The Claude
Code engine (agent driver, streaming, SDK mapping, subprocess projection) lives
here, in `src/engine/`.

## How it works

dsh's agent factory slot is **unique** (`ctx.agents.setFactory`; a second
registration throws). `dsh-loop-engine` hosts one AgentFactory for the
non-default engines; the base bundle's `agent-loop` row stays the default
in-process factory.

The choice is stored in a settings section (`agent-loop-engine.engine`) and
realized by a managed block in the profile's `cordis.patch.yml` that disables
the base `agent-loop` row — freeing the single factory slot for this plugin's
hosted driver:

```yaml
# -- dsh-loop-engine managed block: claude-code --
- id: agent-loop
  disabled: true
# -- /dsh-loop-engine managed block --
```

- `claude-code`: block written, base `agent-loop` disabled, the Claude Code
  factory registers;
- `in-process`: block removed, the base `agent-loop` row is the factory again.

The factory registers at boot (read from the block), so switching between
`in-process` and a hosted engine needs one restart. Two hosted engines
switch live (same factory, chosen per settings at agent creation).

Everything else the user wrote in `cordis.patch.yml` survives the switch byte
for byte; the plugin rewrites only its own span.

## Install (one-time, zero main-repo changes)

1. Build this package (produces `lib/`):
   ```sh
   pnpm install && pnpm run build
   ```
2. Add one file dependency to `$DSH_HOME/profiles/web/package.json`:
   ```json
   "dependencies": {
     "@deepseek-ai/dsh-loop-engine": "file:D:/workspace/github/dsh-loop-engine",
     "...keep existing deps"
   }
   ```
3. Append one entry row to `$DSH_HOME/profiles/web/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: loop-engine
         name: '@deepseek-ai/dsh-loop-engine'
   ```
4. `pnpm install` (in the web profile directory), then **restart `dsh web`
   once** so the client roster and the composed tree pick up the plugin.

## Usage

1. Open the web UI → Settings → "Loop engine".
2. Pick an engine:
   - **In-process (default)**: the base bundle's `agent-loop` driver.
   - **Claude Code CLI**: the hosted Claude Code engine (needs the Claude Code
     CLI installed and logged in; the driver uses its own subprocess with a
     scrubbed env).
3. Switching between `in-process` and `claude-code` applies after a restart of
   `dsh web` (the factory is chosen at boot); sessions running on the old
   engine are interrupted.

## Source layout

| Path | Owner |
| --- | --- |
| `src/namespace.ts` | shared namespace literal (zero imports, both halves) |
| `src/settings.ts` | settings section schema (`z.const('in-process' | 'claude-code')`) |
| `src/patch-manager.ts` | pure managed-block transforms (write/replace/remove, byte-preserving) |
| `src/index.ts` | node half: hosts the engine factory, settings section, onChange → managed block |
| `src/invariant.ts` | invariant companion: block round trip is a fixed point |
| `src/engine/*` | the Claude Code engine module (agent driver + SDK mapping + factory) |
| `src/client/*` | browser half: settings-page dropdown (`settings.section` slot) |

## Verification

- Unit tests: `pnpm run test` (143 cases, per-file coverage 100%).
- Build: `pnpm run build` emits `lib/index.js` (node bundle with
  `@deepseek-ai/*` and `@anthropic-ai/*` externalized), `lib/invariant.js`,
  and `lib/client.js` (the `window.__ModuleLoader__.load` client-module
  contract).
- Typecheck: `pnpm run typecheck`.

## Known Limitations and Deferred Work

- Switching between `in-process` and a hosted engine requires one `dsh web`
  restart (the AgentFactory is registered at boot); switching between two
  hosted engines is live.
- The Claude Code engine drives the official Claude Agent SDK, one stateless
  query per step, with token streaming forwarded to the session log; the
  Claude Code CLI itself must be installed and authenticated on the host.
- Adding an engine (e.g. Codex) is an internal module under `src/engine/` plus
  an entry in `src/settings.ts` and the dispatch in `src/index.ts`.