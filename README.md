# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

Switch the agent loop engine of **dsh web** the same way you switch a model: a
"Loop engine" dropdown in Settings chooses which driver runs your agents — the
built-in in-process loop, the Claude Code CLI, the Codex CLI, the Pi CLI, or the
Kimi Code CLI — without changing anything in the main repository.

## Install

```sh
dsh plugin --profile web add dsh-loop-engine
```

Restart `dsh web`, then open **Settings → Loop engine**.

> Switching engines rewrites a small managed block in `cordis.patch.yml`.
> Everything else you wrote in that file is preserved; only the plugin's own
> span changes.

### Requirements

- For the Claude Code engine: the Claude Code CLI installed and logged in on
  the host.
- For the Codex engine: authenticated either via `codex login` on the host or a
  `CODEX_API_KEY` environment entry.
- For the Pi engine: authenticated the way `pi` expects (its own
  `~/.pi/agent/auth.json` or the provider's API-key environment variable such as
  `ANTHROPIC_API_KEY`).
- For the Kimi Code engine: the `kimi` CLI installed and logged in on the host
  (e.g. `kimi login`), and reachable on `PATH` (or pinned to an absolute path
  via `kimiBin` in the composition entry).

## Usage

1. Pick an engine in **Settings → Loop engine** — `in-process` (default),
   `claude-code`, `codex`, `pi`, or `kimi` — then restart `dsh web`.
2. To return to the default, pick **In-process** and restart again.
3. To remove the plugin: `dsh plugin --profile web remove dsh-loop-engine`, then
   restart `dsh web`.

### What a hosted engine takes over

While a hosted engine is selected, it owns the session's command and skill
surface: the plugin disables dsh's own `/goal` and points new sessions at a
managed `loop-engine` agent preset — a copy of `standard` minus the dsh-native
`/compact`, `/plan`, goal-tool, and skill rows that an external engine cannot
honor — so the slash menu shows the engine's bridged commands and its own
skill catalog. Engine-agnostic dsh commands (`/export`, `/feedback`,
`/permission`) keep working and stay. Switching back to `in-process` restores
the previous preset default; already-running sessions always keep the preset
they were created with.

### Engine notes

- The Claude Code driver runs one SDK query per step; its slash commands are
  bridged into the web menu (built-ins plus user-level `~/.claude/commands/`)
  and forwarded to the engine, which expands them natively. Project-level
  `.claude/commands/` files stay engine-side and also work typed directly.
- The Codex driver runs `codex app-server` and has no interactive tool
  approval — permissions come from the session's `sandboxMode` +
  `approvalPolicy`. Its `AGENTS.md` instruction files are surfaced through the
  dsh skill-injection seam across every directory from the session cwd up to
  the git root, plus `~/.codex/AGENTS.md`.
- The Pi driver runs `pi --mode rpc`; Pi has no permission system, so the whole
  child is sandboxed through the dsh subprocess service (default `read-only`).
  Its context files (`AGENTS.md`/`CLAUDE.md` with `AGENTS.override.md`
  preferred, plus the user-level file under the pi config dir) and its
  `skills/` catalogs (`~/.pi/agent/skills/` and `.pi/skills/`) are surfaced
  through the dsh skill-injection seam.
- The Kimi Code driver runs a persistent `kimi acp` child (Agent Client
  Protocol over stdio) and speaks one stateless `session/new` + `session/prompt`
  per dsh step; the durable dsh session log is the sole model context. It streams
  assistant text (`agent_message_chunk`) and thinking (`agent_thought_chunk`)
  incrementally into the log, and maps tool calls/streams (`tool_call` /
  `tool_call_update`) into `tool/call` + `tool/result`. ACP surfaces tool
  approvals as `session/request_permission`, which the driver answers from the
  session's dsh approval knobs (an `ask` policy denies, fail-closed). The child
  is spawned through the dsh subprocess seam — the only privilege boundary
  (default read-only sandbox). Its project `AGENTS.md` chain (cwd→git root) and
  `.kimi-code/skills/` catalogs (user and project) are surfaced through the dsh
  skill-injection seam, and its slash commands are bridged (built-ins forward the
  raw `/name` line back to the engine, which expands it). The prompt is an ACP
  request body — not an argv positional — so there is no command-line length
  ceiling. Note Kimi's remaining slash-command surface is TUI-only
  (`/login`, `/provider`, `/settings`, `/sessions`, …); those are not bridged
  because the ACP prompt surface does not expand them, but `skill:` commands are
  carried by the skill seam and Kimi's own shorthand.

## License

MIT
