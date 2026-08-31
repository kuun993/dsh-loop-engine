# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/@vidge/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/@vidge/dsh-loop-engine)

Switch the agent loop engine of **dsh web** the same way you switch a model: a
"Loop engine" dropdown in Settings chooses which driver runs your agents — the
built-in in-process loop, the Claude Code CLI, the Codex CLI, or the Pi CLI —
without changing anything in the main repository.

## Install

```sh
dsh plugin --profile web add @vidge/dsh-loop-engine
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

## Usage

1. Pick an engine in **Settings → Loop engine** — `in-process` (default),
   `claude-code`, `codex`, or `pi` — then restart `dsh web`.
2. To return to the default, pick **In-process** and restart again.
3. To remove the plugin: `dsh plugin --profile web remove @vidge/dsh-loop-engine`, then
   restart `dsh web`.

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

## License

MIT
