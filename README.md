# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

Pick **dsh web**'s agent loop engine **per session** — the built-in `in-process` loop (the default), or one of the hosted engines `claude-code` / `codex` / `pi` / `kimi`. Sessions are independent: one chat can run Codex while another runs Kimi. Any open, idle session can move engines — between two hosted engines the handover is **in place**, and a move involving `in-process` **reloads the page** (the `dsh web` process never restarts). Nothing in the main repository changes.

## Install

```sh
dsh plugin --profile web add dsh-loop-engine
```

Boot `dsh web` once (the router retries for a bounded window while the base bundle still holds the agent-factory slot), then open **Settings → Loop engine**.

**Install notes**

- The install rewrites one **engine-agnostic** managed block in the profile's `cordis.patch.yml`; every other byte you wrote there is preserved. Upgrading from an older release needs no hand edit.
- **Installing into any profile but `web`** — the Desktop app's `desktop`, a `headless` deployment, a renamed profile — needs `profile: <name>` in the composition entry for that profile:
  ```yaml
  - id: loop-engine
    config:
      profile: desktop
  ```
  `profile` defaults to `web`, so without it the plugin writes its managed block into `<home>/profiles/web/cordis.patch.yml` while the running profile never reads it: the plugin mounts, but the base `agent-loop` row is never disabled, so its router cannot take the factory slot and no hosted engine is reachable. (Found by installing into the Desktop app.)
- **Uninstall** is `dsh plugin --profile web remove dsh-loop-engine` **plus deleting that managed block** — the block outlives the plugin, and while it is present the profile has no agent factory, so no session can be created.
- **pnpm 10+** may block dependency build scripts (`ERR_PNPM_IGNORED_BUILDS`, naming `esbuild`, `@google/genai`, `protobufjs`). Run `pnpm approve-builds` (or add an `allowBuilds` entry) and retry; only the installing project can grant this.
- **Booting the harness from its source checkout** additionally needs the profile's harness peers bridged with `file:` shims — otherwise session resume fails with `agent-presets: refusing to compose an unscoped context`. Steps in [docs/source-checkout.md](docs/source-checkout.md).

## Requirements

| Engine | Needs, on the host |
|---|---|
| Claude Code | the Claude Code CLI installed and logged in |
| Codex | `codex login`, or a `CODEX_API_KEY` environment entry |
| Pi | whatever `pi` expects (its own `~/.pi/agent/auth.json`, or the provider's API-key variable) |
| Kimi Code | the `kimi` CLI installed and logged in, on `PATH` (or pinned via `kimiBin`) |

## Usage

- **New session** — pick the engine on the preset chip beside the workspace picker, or keep the deployment's default (`standard`) for the in-process loop. A child agent inherits its parent's engine.
- **Settings → Loop engine** sets the default for **new** sessions. It lands immediately; running sessions are unaffected. **In-process** restores whatever default the plugin replaced.
- **Move a session you are in** with the composer's engine selector (enable *Show the engine selector in the chat page*).
  - Hosted → hosted: in place, applies on the spot.
  - Anything involving `in-process`: the composer asks first, then the page reloads and reopens the same session (scroll position and unsent draft are lost; the record is not).
  - A mid-turn session is refused, and a subagent's session cannot be moved.
- **The header chip** beside the preset label names the engine the session on screen actually runs; *Show the engine badge in the conversation header* turns it off (and the header keeps no trace of the plugin).
- **Models** — all hosted engines share one `external` group whose single entry, `default`, means "the engine decides". Picking a **real dsh model** hands it to the engine together with its endpoint and credential; whether the engine can serve it is the engine's business, and a refusal is reported rather than swallowed. `in-process` sessions use dsh's models normally.
- **`childIdleMs`** (composition entry, milliseconds, default `0` = off) — Kimi and Codex keep **one child process per session** across steps; this closes it after that much idle time and respawns it on the next step. Only the child is closed, so nothing reloads. Pi and Claude Code spawn per step and are unaffected.
- **dsh's own commands** (`/export`, `/feedback`, `/permission`) keep working under a hosted engine. Its preset is a copy of `standard` with the dsh-native rows an external engine replaces stripped out (dsh's `/plan`, `/compact`, the goal tool and `/goal`, the skill rows).

## Version compatibility

One release serves the **0.1.5 line** (`>=0.1.5-rc.1 <0.1.6-0`), the **0.1.7 line** (`>=0.1.7-rc.1 <0.1.8-0`) and the **0.2.0 line** (`>=0.2.0-rc.1 <0.2.1-0`): the plugin detects the running generation at load and takes the matching code path. Those union ranges are what it declares in `peerDependencies`, and a harness outside them fails loudly at boot or session resume.

Read the version as `<harness line>-rcN`, where **`rcN` is this plugin's own release counter for that line** — not the harness's `rc` number. Within a covered line a new harness `rc` needs no plugin release unless an API surface moved; [docs/compatibility.md](docs/compatibility.md) §1 lists those surfaces and the diff command that decides it.

| Plugin | Harness |
|---|---|
| `0.2.0-rc1` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.1.7-rc1` … `0.1.7-rc5` | `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.1.5-rc3` … `0.1.5-rc5` | `0.1.5-rc.2` |
| `0.1.5-rc1` / `0.1.5-rc2` | `0.1.5-rc.1` |
| `1.0.0-rc8` … `1.0.0-rc15` | `0.1.2-rc.1` |
| `1.0.0-rc7` and earlier | `0.1.1-rc.2` |

`0.2.0-rc1` is the first release that serves three lines at once, and the first one published after the harness started enforcing a peer-range gate at boot: the plugin is still mounted alongside an incompatible one, but a harness outside the ranges above is now skipped by dsh itself rather than failing later.

## Known limitations

- **It replaces the harness's agent factory.** One facade serves every session, so the plugin promises to stay out of the way: any session it cannot answer for — including sessions with nothing to do with hosted engines — degrades to the `in-process` loop instead of failing to open. See [docs/per-session-engine.md](docs/per-session-engine.md) §6.
- **The engine record is a sidecar**, `$DSH_HOME/.loop-engine/engines.json`, not part of the session log: changing machine or `DSH_HOME` loses it and the session falls back to its preset. See §5.5.
- **Moving a session involving `in-process` reloads the page** — the harness loop neither hands over a live session nor adopts one it did not create. See §5.2/§5.4.
- **Sessions that already ran a turn** can still move, but only while idle, and the move rebuilds that session's agent. See §5.
- **Old sessions with the legacy preset id `loop-engine`** read as "legacy hosted engine" until rebuilt once. See §7.
- **Same-engine sessions share that CLI's own auth directory**, with no lock added by the plugin. See §6.
- **Switching back to `in-process` leaves the shared `external` group in the model menu** (the catalog is not scoped per session).

## Where the details live

- [docs/per-session-engine.md](docs/per-session-engine.md) — the full user-visible behavior (§ numbers above refer to it).
- [docs/architecture.md](docs/architecture.md) — plugin core: the single factory slot, the managed block, routing, the provider route.
- [docs/compatibility.md](docs/compatibility.md) — **start here when the harness upgrades**: every generation-dependent code site and the checklist for the next generation.
- [docs/driver-core.md](docs/driver-core.md) — the shared driver infrastructure.
- [docs/engine-claude.md](docs/engine-claude.md) · [engine-codex](docs/engine-codex.md) · [engine-kimi](docs/engine-kimi.md) · [engine-pi](docs/engine-pi.md) — per-engine internals.
- [docs/source-checkout.md](docs/source-checkout.md) — the `file:` shims a source-launched harness needs.
- [docs/optimization-backlog.md](docs/optimization-backlog.md) — known issues and the optimization list.
- [docs/proposals/](docs/proposals/) — main-repo proposals.

## License

MIT
