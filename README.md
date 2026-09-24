# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

Pick the agent loop engine of **dsh web** the same way you pick a model — **per session**: the built-in `in-process` loop (the default), or one of the four hosted engines `claude-code`, `codex`, `pi`, `kimi`. The engine is the plugin's own per-session record, so **any open, idle session can be moved to another engine** — between two hosted engines it is an **in-place handover**, and a move involving `in-process` releases that session's agent and reloads the page (the `dsh web` process never restarts). Sessions are independent, so one chat can run Codex while another runs Kimi. None of this changes anything in the main repository.

## Install

```sh
dsh plugin --profile web add dsh-loop-engine
```

Boot `dsh web` so the profile recomposes with the plugin, then open **Settings → Loop engine**. One boot is enough: the router retries for a bounded window while the base bundle's `agent-loop` row still holds the factory slot.

> Installing rewrites one **engine-agnostic** managed block in `cordis.patch.yml`: it disables the base bundle's `agent-loop` row so the plugin's own router can own the process's single agent-factory slot, and every other byte you wrote in that file is preserved. Upgrading from an earlier release needs no hand edit — a block that named the one pinned engine is rewritten to this form on the next boot, and seeds the Settings default with that engine.

> **pnpm users:** pnpm 10+ blocks dependency build scripts by default, so the install may fail with `ERR_PNPM_IGNORED_BUILDS` naming `esbuild`, `@google/genai`, and `protobufjs` (all reached through the engine SDKs). Allow them and retry — `pnpm approve-builds`, or `allowBuilds` in `pnpm-workspace.yaml`. Only the installing project can grant this; the plugin cannot pre-approve its own dependencies.

### Running against a harness source checkout

A **published** dsh needs no extra setup. Booting the harness from its **source checkout** (`cd deepseek-harness && pnpm dsh web`) takes one more step: bridge the profile's harness peer packages to the checkout source with `file:` shims, so both halves share one module instance (a scope minted through one instance is invisible to the other, and session resume fails with `agent-presets: refusing to compose an unscoped context`). The peer list includes `@deepseek-ai/dsh-agent-loop`. The runnable shim steps are in [docs/source-checkout.md](docs/source-checkout.md); why every `@deepseek-ai/*` package must stay a single instance is in [docs/architecture.md](docs/architecture.md). Installing the plugin as a local **`link:`** checkout sidesteps this entirely.

## Version compatibility

dsh-loop-engine is versioned **in lockstep with the harness it targets**: `<harness version>-rcN`. `0.1.5-rc3` targets harness `0.1.5-rc.2`; `0.1.5-rc1`/`0.1.5-rc2` target `0.1.5-rc.1`; `1.0.0-rc8` … `1.0.0-rc15` target `0.1.2-rc.1`; `1.0.0-rc7` and earlier target `0.1.1-rc.2`. Every harness package it consumes is pinned exactly in `peerDependencies`, and the two must be matched — a mismatch fails loudly at boot or session resume. To use the plugin with an older harness, install the release matching it (each GitHub Release states the harness version it targets).

### Requirements

- **Claude Code**: the Claude Code CLI installed and logged in on the host.
- **Codex**: authenticated via `codex login` on the host, or a `CODEX_API_KEY` environment entry.
- **Pi**: authenticated the way `pi` expects (its own `~/.pi/agent/auth.json`, or the provider's API-key environment variable such as `ANTHROPIC_API_KEY`).
- **Kimi Code**: the `kimi` CLI installed and logged in (e.g. `kimi login`), and reachable on `PATH` (or pinned to an absolute path via `kimiBin` in the composition entry).
- Running the harness from a source checkout needs the extra `dsh-agent-loop` `file:` shim above.

## Usage

**The engine is chosen per session.** Pick `Claude Code`, `Codex`, `Pi`, or `Kimi Code` on the new-session screen's preset chip (beside the workspace picker); keep the deployment's own default (usually `standard`) to run the built-in in-process loop. Different sessions can run different engines at the same time, and a child agent inherits the engine of the agent that spawned it.

- **Settings → Loop engine** sets the default for **new** sessions only — it lands immediately, with no restart and no page reload, and sessions already running are unaffected. Choosing **In-process** restores whatever default the plugin replaced.
- **Moving a session you are in** uses the composer's engine selector (enable *Show the engine selector in the chat page*), which calls the plugin's own `remote.loopEngine.select`. Any open, idle session can move — including one that has already run many turns.
  - **Between two hosted engines the move is an in-place handover**: the session stays open, only the agent is replaced — it applies on the spot, with nothing to confirm.
  - **A move involving `in-process` cannot be handed over in place** (the harness loop neither accepts a session it did not create nor hands a live one over), so the composer asks first: the switch reloads the page, and this page's scroll position and unsent draft go with it (the conversation record does not). On confirm the host RELEASES that session's agent and answers `reload: true`; the page reloads itself and reopens the same session, which is what makes the host build it on the recorded engine. The process never restarts.
  - A session that is **mid-turn is refused** rather than interrupted, and a **subagent's** session cannot be moved at all.
- **Models**: every hosted engine shares ONE `external` group in the model menu, holding exactly one entry, `default` — meaning "the engine decides". Picking a **real dsh model** hands it to the engine **with its endpoint and credential** (whether the engine can serve it is the engine's business — a refusal is reported, not swallowed). `in-process` sessions use dsh's models as usual.
- **Uninstall**: `dsh plugin --profile web remove dsh-loop-engine`, then manually delete the plugin's managed block from the profile's `cordis.patch.yml` — the block outlives the plugin, and while it is present the base `agent-loop` row stays disabled, leaving the profile with no agent factory.

### What a hosted engine takes over

- Its preset is a copy of `standard` minus the dsh-native rows an external engine replaces — dsh's `/plan`, `/compact` (and auto-compaction), the model-facing goal tool, the human `/goal` command, and the dsh skill rows (one stripped preset per engine, under `$DSH_HOME/.agent-presets/loop-engine-<engine>/`).
- The engine's own slash commands and skill catalog are registered into **that agent's own scope**, so two sessions on different engines never see each other's menus, and the whole surface is released with the agent.
- Engine-agnostic dsh commands (`/export`, `/feedback`, `/permission`) keep working and stay.

## Known limitations

- **The engine record lives in the plugin's sidecar, `$DSH_HOME/.loop-engine/engines.json`, not in the session log.** Changing machine or `DSH_HOME` loses it, and the session falls back gracefully to the preset mapping. See [docs/per-session-engine.md](docs/per-session-engine.md) §5.5 and [docs/architecture.md](docs/architecture.md) §3.9.
- **A move involving `in-process` reloads the page**, because the harness loop neither hands over a live session nor adopts one it did not create. See [docs/per-session-engine.md](docs/per-session-engine.md) §5.2/§5.4.
- **The engine is settled at session creation / blank period**; once a turn has run, changing engines rebuilds that session's agent (idle only). See [docs/per-session-engine.md](docs/per-session-engine.md) §5.
- **Old sessions carrying the legacy single preset id (`loop-engine`)** show as "legacy hosted engine" and need one rebuild before the new semantics take over. See [docs/per-session-engine.md](docs/per-session-engine.md) §7.
- **Under a hosted engine a dsh model pick matters only if you pick a real dsh model** — `default` means "hand it back to the engine". See [docs/per-session-engine.md](docs/per-session-engine.md) §5.2.
- **Same-engine sessions share that CLI's own auth directory**, with no lock added by the plugin. See [docs/per-session-engine.md](docs/per-session-engine.md) §6.
- **Switching to `in-process` leaves the shared `external` provider group in the model menu** (the catalog is not scoped per session). See [docs/architecture.md](docs/architecture.md) §3.6.

## Where the details live

- [docs/per-session-engine.md](docs/per-session-engine.md) — the full user-visible behavior of per-session engines.
- [docs/source-checkout.md](docs/source-checkout.md) — the `file:` shims a source-launched harness needs.
- [docs/architecture.md](docs/architecture.md) — plugin core: the single factory slot, the managed block, routing, per-session engine facts, the provider route.
- [docs/driver-core.md](docs/driver-core.md) — the shared driver infrastructure.
- [docs/engine-claude.md](docs/engine-claude.md), [docs/engine-codex.md](docs/engine-codex.md), [docs/engine-kimi.md](docs/engine-kimi.md), [docs/engine-pi.md](docs/engine-pi.md) — per-engine internals.
- [docs/optimization-backlog.md](docs/optimization-backlog.md) — known issues and the optimization list.
- [docs/proposals/](docs/proposals/) — main-repo proposals: `append-ignorable-events.md`, `harness-agent-handover.md`, and the two model-selection ones (`dsh-model-into-hosted-engines.md`, `per-session-model-for-hosted-engines.md`).

## License

MIT
