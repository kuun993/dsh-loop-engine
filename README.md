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

> **pnpm users:** pnpm 10+ blocks dependency build scripts by default, so the
> install may fail with `ERR_PNPM_IGNORED_BUILDS` naming `esbuild`,
> `@google/genai`, and `protobufjs` (all reached through the engine SDKs). This
> is expected — allow them and retry, either interactively with
> `pnpm approve-builds`, or by declaring them in the installing project's
> `pnpm-workspace.yaml`:
>
> ```yaml
> allowBuilds:
>   esbuild: true
>   '@google/genai': true
>   protobufjs: true
> ```
>
> Only the installing project can grant this; the plugin cannot pre-approve its
> own dependencies. Note that `allowBuilds` is the pnpm 11 spelling — pnpm 11
> **deletes** the legacy `onlyBuiltDependencies` (and `neverBuiltDependencies`,
> `ignoredBuiltDependencies`) keys from `package.json` and no longer honors
> them, so putting them there silently does nothing.

### Running against a harness source checkout

The install above assumes a **published** dsh (`npx @deepseek-ai/dsh`) and needs
no extra setup. Booting the harness from its **source checkout**
(`cd deepseek-harness && pnpm dsh web`) takes one more step, because the two
halves then resolve harness packages to different files:

| Side | `@deepseek-ai/dsh-scope` resolves to |
|---|---|
| Source-launched harness | `packages/core/scope/src/index.ts` (via tsconfig `paths`) |
| Installed plugin (its tarball ships only `lib/`) | `packages/core/scope/lib/index.js` |

That is one package loaded as two module instances. `dsh-scope` tags a context
with a module-local `Symbol('dsh.scope')`, so a scope minted through one instance
is invisible to the other, and resuming a session fails with:

```
agent-presets: refusing to compose an unscoped context;
the scope key is what joins an agent to its preset
```

Bridge the profile's peers to the harness source so both halves share one
instance. Set `HARNESS` to the harness checkout **as a `file://` URL**, then run
this from the profile directory:

```sh
HARNESS=file:///path/to/deepseek-harness   # e.g. file:///D:/repos/deepseek-harness
cd "$DSH_HOME/profiles/web" && mkdir -p shims
while IFS='|' read -r name rel; do
  mkdir -p "shims/$name"
  printf '{"name":"@deepseek-ai/%s","version":"0.0.0","private":true,"type":"module","main":"index.mjs"}\n' \
    "$name" > "shims/$name/package.json"
  printf "export * from '%s/%s'\nimport * as mod from '%s/%s'\nexport default mod.default\n" \
    "$HARNESS" "$rel" "$HARNESS" "$rel" > "shims/$name/index.mjs"
done <<EOF
cordis|vendor/cordis/src/index.ts
schemastery|vendor/schemastery/src/index.ts
dsh-agent|packages/core/agent/src/index.ts
dsh-scope|packages/core/scope/src/index.ts
dsh-session|packages/core/session/src/index.ts
dsh-session-persistence|packages/session/session-persistence/src/index.ts
dsh-settings|packages/settings/settings/src/index.ts
dsh-subprocess|packages/subprocess/subprocess/src/index.ts
dsh-timeout|packages/util/timeout/src/index.ts
dsh-llm|packages/llm/llm/src/index.ts
dsh-invariants|packages/runtime-diagnostics/invariants/src/index.ts
dsh-home-paths|packages/util/home-paths/src/index.ts
EOF
```

Then point the profile's `package.json` at them and reinstall:

```sh
node -e 'const f="package.json",j=require("./"+f),d=j.dependencies??={}
for(const n of ["cordis","schemastery","dsh-agent","dsh-scope","dsh-session","dsh-session-persistence","dsh-settings","dsh-subprocess","dsh-timeout","dsh-llm","dsh-invariants","dsh-home-paths"])
  d["@deepseek-ai/"+n]="file:./shims/"+n
require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")'
pnpm install
```

Restart `dsh web`. If something loads the `@deepseek-ai/dsh-scope/invariant`
subpath, also give that shim an `invariant.mjs` (`export * from
'$HARNESS/packages/core/scope/src/invariant.ts'`) and add
`"./invariant": "./invariant.mjs"` to its `exports`.

> Installing the plugin as a local **`link:`** checkout sidesteps this entirely:
> when the checkout sits beside the harness repo it inherits the harness's own
> `tsconfig.json` and with it the same `paths` mapping. The split only appears
> when a *packed* plugin (npm or tarball) meets a *source* harness.

## Version compatibility

dsh-loop-engine is versioned **in lockstep with the harness it targets**: the
version is the harness version plus a plugin release counter (`0.1.5-rc1` and
`0.1.5-rc2` target harness `0.1.5-rc.1`; `0.1.5-rc3` targets harness
`0.1.5-rc.2`), and every harness package it consumes is pinned exactly in
`peerDependencies`. The two must be matched — a mismatch fails loudly at boot
or session resume:

| dsh-loop-engine | Requires harness |
|---|---|
| 0.1.5-rc3 | **0.1.5-rc.2** |
| 0.1.5-rc1, 0.1.5-rc2 | 0.1.5-rc.1 |
| 1.0.0-rc8 … 1.0.0-rc15 | 0.1.2-rc.1 |
| 1.0.0-rc7 and earlier | 0.1.1-rc.2 |

- **Each 0.1.5-rcN release requires the 0.1.5 patch it was built for.**
  `0.1.5-rc1`/`0.1.5-rc2` require harness `0.1.5-rc.1`; `0.1.5-rc3` requires
  harness `0.1.5-rc.2`. All three use the 0.1.5
  assistant-stream contract (`assistant/message` embeds its exact timed
  `stream` and rejects `sourceEventSeqs`), the driver-owned `Inbox` interface,
  the two-argument `AgentSetup`, and the `SessionPersistence.create` / `open`
  handle seam. `0.1.5-rc.2` is a client-UI/docs backport that leaves those
  seams untouched, so the driver code is identical across `0.1.5-rc.1` and
  `0.1.5-rc.2`.
- Releases up to `1.0.0-rc15` used the plugin's own version series and target
  harness `0.1.2-rc.1`; they are not compatible with harness `0.1.5-rc.1`.
- To use the plugin with an older harness, install the release matching it
  (e.g. `npm i dsh-loop-engine@1.0.0-rc15` for harness 0.1.2-rc.1).
- The GitHub Release body of each tag states the harness version it targets.

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

The same takeover covers the tool surface: a hosted engine's calls are projected
onto dsh's tool vocabulary in the durable `tool/call` event, so the Web GUI
renders them with the native rows — a Claude `Write`/`Edit`, a Codex
`command_execution`, or a Kimi `Bash` becomes dsh's `write`/`edit`/`bash`, which
also feeds the finished turn's "Files changed" row and its inline file links.
Claude's `TodoWrite` additionally drives dsh's todo panel. The engine's own
assistant message keeps its spelling, so the next step's prompt is unaffected;
a call with no lossless dsh equivalent — Codex's multi-file `apply_patch` —
stays generic rather than mis-rendering.

### Engine notes

- The Claude Code driver runs one SDK query per step; its slash commands are
  bridged into the web menu (built-ins plus user-level `~/.claude/commands/`)
  and forwarded to the engine, which expands them natively — the CLI dispatches
  a local command only when the prompt opens with `/`, so a bridged line is sent
  as the step's whole prompt instead of the framed transcript. Project-level
  `.claude/commands/` files stay engine-side and also work typed directly.
- The Codex driver runs `codex app-server`; the thread starts with the
  session's `sandboxMode` + `approvalPolicy` stance, and the model's runtime
  approval requests (command, file-change, permissions) are answered through
  the dsh approval seam — `request_user_input` questions go to the
  user-questions seam and MCP elicitations are declined, all fail-closed when
  their seam is absent. Its `AGENTS.md` instruction files are surfaced through
  the dsh skill-injection seam across every directory from the session cwd up
  to the git root, plus `~/.codex/AGENTS.md`.
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
  incrementally as live `agent/assistant-stream` frames, and the step's durable
  `assistant/message` embeds that exact timed stream; it maps tool calls/streams
  (`tool_call` / `tool_call_update`) into `tool/call` + `tool/result`. ACP surfaces tool
  approvals as `session/request_permission`, which the driver answers from the
  session's dsh approval knobs (an `ask` policy denies, fail-closed). The child
  is spawned through the dsh subprocess seam — the only privilege boundary
  (default read-only sandbox). Its project `AGENTS.md` chain (cwd→git root) and
  `.kimi-code/skills/` catalogs (user and project) are surfaced through the dsh
  skill-injection seam, and its slash commands are bridged (built-ins forward the
  raw `/name` line back to the engine, which expands it; the line is sent as the
  step's whole prompt, since Kimi's ACP adapter only parses a command that opens
  the prompt). Bridged built-ins are the six the ACP surface actually implements
  (`compact`, `status`, `usage`, `mcp`, `tasks`, `help`). The prompt is an ACP
  request body — not an argv positional — so there is no command-line length
  ceiling. Note Kimi's remaining slash-command surface is TUI-only
  (`/login`, `/provider`, `/settings`, `/sessions`, …); those are not bridged
  because the ACP prompt surface answers `Unknown ACP command` for them, but
  `skill:` commands are carried by the skill seam and Kimi's own shorthand.

## License

MIT
