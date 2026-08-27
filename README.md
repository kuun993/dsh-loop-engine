# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/@kuun993/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/@kuun993/dsh-loop-engine)

Switch the agent loop engine of **dsh web** the same way you switch a model: a
"Loop engine" dropdown in Settings chooses which driver runs your agents — the
built-in in-process loop, the Claude Code CLI, the Codex CLI, or the Pi CLI —
without changing anything in the main repository.

## What it does

- **Engine chosen from Settings, not from code.** Pick `in-process` (default),
  `claude-code`, `codex`, or `pi` in the settings page; the choice is stored
  durably and survives profile edits.
- **Claude Code execution.** The Claude Code CLI drives agents, with token
  streaming forwarded into the session log.
- **Codex execution.** The driver spawns `codex app-server` and streams its
  token-level deltas into the session log, one turn per step.
- **Pi execution.** The driver spawns `pi --mode rpc` and streams its
  `message_update` deltas into the session log, one stateless `new_session` +
  `prompt` per step.
- **Extensible.** Adding an engine is one driver module plus one entry in the
  settings schema.
- **Zero main-repo changes.** Installed purely as a profile dependency plus one
  composition row.

## Requirements

- dsh `0.1.1-rc.2` (or a build whose peer packages match).
- For the Claude Code engine: the Claude Code CLI installed and logged in on
  the host.
- For the Codex engine: authenticated either via `codex login` on the host or a
  `CODEX_API_KEY` environment entry.
- For the Pi engine: authenticated the way `pi` expects (its own
  `~/.pi/agent/auth.json` or the provider's API-key environment variable such as
  `ANTHROPIC_API_KEY`).
- When the harness runs from a **source checkout** (e.g. `pnpm dsh` inside the
  `deepseek-harness` repository), the profile must resolve this plugin's
  harness peer packages to the monorepo **sources** via local `file:` shims
  (the profile's `shims/` directory). A deployed install with one published
  `node_modules` needs no shims.

## Configuration

1. Build the plugin:

   ```sh
   pnpm install && pnpm run build
   ```

2. Add the dependency in `$DSH_HOME/profiles/web/package.json`:

   ```json
   "dependencies": {
     "@kuun993/dsh-loop-engine": "1.0.0-rc1",
     "...keep existing deps"
   }
   ```

   The package is published on npm as `@kuun993/dsh-loop-engine`. For local
   development, use a `file:` reference to your checkout instead of the version
   string.

3. Append one composition row in `$DSH_HOME/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: loop-engine
         name: '@kuun993/dsh-loop-engine'
   ```

4. Install and restart:

   ```sh
   cd $DSH_HOME/profiles/web && pnpm install
   ```

   Restart `dsh web` once so the plugin is picked up.

> Switching engines rewrites a small managed block in `cordis.patch.yml`.
> Everything else you wrote in that file is preserved; only the plugin's own
> span changes.

## Usage

1. Open **Settings → Loop engine**.
2. Choose an engine:
   - **In-process** (default) — the built-in loop driver;
   - **Claude Code CLI** — the Claude Code driver;
   - **Codex CLI** — the OpenAI Codex driver;
   - **Pi CLI** — the Pi (earendil-works/pi) driver.
3. Switching between these applies after restarting `dsh web`. To return
   to the default, pick **In-process** and restart again.
4. To remove the plugin: delete the `loop-engine` row from
   `cordis.patch.yml`, drop the dependency from `package.json`, then
   `pnpm install` and restart `dsh web`.

### Codex engine details

The driver bypasses the `@openai/codex-sdk` (which only exposes whole-item
output) and spawns `codex app-server` as a child process, speaking JSON-RPC
over stdio. The app-server streams **token-level deltas** via
`item/agentMessage/delta` and `item/reasoning/summaryTextDelta`, so thinking
and replies paint progressively in the session — like the Claude Code engine.

- **Streaming.** Reasoning deltas and agent-message deltas are forwarded live
  as `assistant/chunk` events; durable messages land at the correct step
  boundaries with usage attached on turn completion.
- **Skills.** The Codex engine registers a skill provider that surfaces
  `AGENTS.md` (project root and `~/.codex/AGENTS.md`) through the same dsh
  skill-injection seam as Claude skills.
- **No interactive tool approval.** Permissions are the declarative
  `sandboxMode` + `approvalPolicy` pair resolved per query from the session's
  permission knobs (or pinned via the plugin's `sandboxMode`/`approvalPolicy`
  config). A session `ask` policy maps to `on-request`, whose CLI prompt
  degrades to a denial in the unattended dsh runtime.
- **No dsh subprocess sandbox integration.** The driver spawns `codex
  app-server` itself; the dsh subprocess service (and its sandbox) does not
  wrap it.
- **No engine-specific slash commands** are registered for Codex in this
  version.

### Pi engine details

The driver spawns `pi --mode rpc` as a child process and speaks the strict-LF
(`\n`) JSONL protocol over stdio — never a generic line reader, because Pi
allows Unicode separators like U+2028 inside JSON strings. It runs **one
stateless session per dsh step**: a fresh `new_session`, then a single `prompt`
carrying the serialized session history. Like the Codex/Claude drivers, Pi owns
its own system prompt natively, so the dsh system-prompt assembly is not run —
the durable session log remains the sole source of model context.

- **Streaming.** `message_update` deltas (`text_delta` / `thinking_delta`) are
  forwarded live as `assistant/chunk` events; tool calls and results land as
  `tool/call` + `tool/result`, and usage is attached on `turn_end`.
- **Sandboxed by the dsh subprocess seam.** Pi has **no permission system** ("it
  runs with the permissions of the user"), so the driver routes the whole `pi`
  child through the dsh subprocess service and prunes `--tools` to the resolved
  sandbox stance — `read-only` (default), `workspace-write`, or
  `danger-full-access` (no pruning). An `ask` policy degrades to a read-only
  denial because Pi has no interactive approval callback.
- **Skills.** The Pi engine registers a skill provider that surfaces
  `AGENTS.md` (project root and `~/.pi/AGENTS.md`) through the same dsh
  skill-injection seam.
- **Model/provider.** Provider and model are passed to the child via
  `--provider` / `--model` (a pinned `thinkingLevel` is appended as
  `:<level>`); when omitted, Pi's native settings own the model.

## License

MIT