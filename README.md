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

## Configuration

1. Build the plugin:

   ```sh
   pnpm install && pnpm run build
   ```

2. Add the dependency in `$DSH_HOME/profiles/web/package.json`:

   ```json
   "dependencies": {
     "@deepseek-ai/dsh-loop-engine": "file:D:/workspace/github/dsh-loop-engine",
     "...keep existing deps"
   }
   ```

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

## Usage

1. Open **Settings → Loop engine**.
2. Choose an engine:
   - **In-process** (default) — the built-in loop driver;
   - **Claude Code CLI** — the Claude Code driver.
3. Switching between these two applies after restarting `dsh web`.

## License

MIT