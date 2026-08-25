# dsh-loop-engine

Switch the agent loop engine of **dsh web** the same way you switch a model: a
"Loop engine" dropdown in Settings chooses which driver runs your agents — the
built-in in-process loop, the Claude Code CLI, or (future) Codex — without
changing anything in the main repository.

## What it does

- **Engine chosen from Settings, not from code.** Pick `in-process` (default)
  or `claude-code` in the settings page; the choice is stored durably and
  survives profile edits.
- **Claude Code execution.** The Claude Code CLI drives agents, with token
  streaming forwarded into the session log.
- **Extensible.** Adding an engine (e.g. Codex) is one driver module plus one
  entry in the settings schema.
- **Zero main-repo changes.** Installed purely as a profile dependency plus one
  composition row.

## Requirements

- dsh `0.1.1-rc.2` (or a build whose peer packages match).
- For the Claude Code engine: the Claude Code CLI installed and logged in on
  the host.
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
     "@deepseek-ai/dsh-loop-engine": "0.1.1-rc.2",
     "...keep existing deps"
   }
   ```

   Until the package is published, use a local `file:` reference to your
   checkout instead of the version string.

3. Append one composition row in `$DSH_HOME/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: loop-engine
         name: '@deepseek-ai/dsh-loop-engine'
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
   - **Claude Code CLI** — the Claude Code driver.
3. Switching between these two applies after restarting `dsh web`. To return
   to the default, pick **In-process** and restart again.
4. To remove the plugin: delete the `loop-engine` row from
   `cordis.patch.yml`, drop the dependency from `package.json`, then
   `pnpm install` and restart `dsh web`.

## License

MIT