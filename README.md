# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

Pick the agent loop engine of **dsh web** the same way you pick a model — per
session. A session created on the `Claude Code`, `Codex`, `Pi`, or `Kimi Code`
agent preset runs on that CLI; any other preset, including the deployment's own
`standard`, runs the built-in in-process loop. The engine itself is the plugin's
own per-session record, so **any session can be moved to another engine while it
is open and idle** — including one that has already run many turns. Between two
hosted engines the move happens **in place** (the conversation stays open, only
the agent is replaced); a move involving the **in-process** engine makes the host
release that session's agent and reload the page, which comes back to the same
session and builds it on the new engine — the process itself never restarts, and
nothing else can deliver the switch (a plain refresh or a session switch hands
back the same live agent, because a live agent belongs to the host process). The
header chip never pretends such a switch landed early: while the record and the
live agent disagree it names the engine that runs and marks the other one. Sessions are
independent, so one chat can run Codex while another runs Kimi. The **Settings →
Loop engine** dropdown chooses what *new* sessions start on. None of this
changes anything in the main repository.

## Install

```sh
dsh plugin --profile web add dsh-loop-engine
```

Boot `dsh web` so the profile recomposes with the plugin — the bundle list and
the plugin's code are read at boot — then open **Settings → Loop engine**. One
boot is enough: the managed block is only read at the *next* composition, so on
the first boot after installing, the base bundle's `agent-loop` row still holds
the factory slot when the router tries to register. The router retries for a
bounded window (`src/index.ts:588-615`, regression suite
`tests/router-mount.spec.ts:192`) and mounts as soon as the harness's live patch
reload drops that row.

> Installing rewrites one small managed block in `cordis.patch.yml`
> (`src/patch-manager.ts:59`). The block names no engine: it disables the base
> bundle's `agent-loop` row so the plugin's own router can own the process's
> single agent-factory slot (`src/router-loop.ts:172`), and it is present under
> every engine while the plugin is installed. It also disables the host-plane
> `command-goal` row, which keeps dsh's `/goal` off in a minimal profile with no
> `web-app` overlay — in a hosted session it is the managed preset that removes
> `/goal` (see [What a hosted engine takes over](#what-a-hosted-engine-takes-over)).
> Everything else you wrote in that file is preserved byte for byte.

**Upgrading from an earlier release.** Blocks written before the plugin routed
per session named the one engine the profile was pinned to
(`# -- dsh-loop-engine managed block: claude-code --`). The next boot rewrites
that block to the engine-agnostic form and seeds the Settings default with the
engine it named (`src/patch-manager.ts:95`, `src/index.ts:271`), so the pinned
engine carries over as the default for new sessions — there is nothing to edit by
hand. A harness source checkout also needs the extra `dsh-agent-loop` shim listed
under [Requirements](#requirements).

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
dsh-agent-loop|packages/core/agent-loop/src/index.ts
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
for(const n of ["cordis","schemastery","dsh-agent","dsh-agent-loop","dsh-scope","dsh-session","dsh-session-persistence","dsh-settings","dsh-subprocess","dsh-timeout","dsh-llm","dsh-invariants","dsh-home-paths"])
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

- The harness loop package is a peer of the plugin: the router subclasses
  `@deepseek-ai/dsh-agent-loop`'s `AgentLoop` (`src/router-loop.ts:172`), and the
  base bundle's `agent-loop` row is left disabled for as long as the plugin is
  installed. Running the harness from a source checkout therefore needs one extra
  `file:` shim — add `dsh-agent-loop` to the list in
  [Running against a harness source checkout](#running-against-a-harness-source-checkout).
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

1. Start a session on the engine you want by picking its preset on the
   new-session screen's preset chip, beside the workspace picker: **Claude
   Code**, **Codex**, **Pi**, or **Kimi Code**. Keep the deployment's own default
   (usually `standard`) to run the built-in in-process loop. The preset decides
   the composition a NEW session starts on; the engine a session runs after that
   is the plugin's own record (see below).
2. Change the default for *new* sessions in **Settings → Loop engine** — the
   switch lands immediately, with no restart and no page reload, and sessions
   already running keep the engine they run. Choosing **In-process** restores
   whatever default the plugin replaced. With `Show the engine selector in the
   chat page` enabled, the composer's picker moves the session you are in rather
   than writing the default (see below).
3. To remove the plugin: `dsh plugin --profile web remove dsh-loop-engine`, then
   restart `dsh web`. Delete the plugin's managed block from `cordis.patch.yml`
   as well: the block outlives the plugin, and while it is present the base
   `agent-loop` row stays disabled, leaving the profile with no agent factory.

Each engine has a managed agent preset of its own
(`$DSH_HOME/.agent-presets/loop-engine-<engine>/`, authored by
`src/preset.ts:200`), and that preset is the session's **agent-plane
composition** — the prompt, command, and skill surface it is composed from.
Presets this plugin does not own — the deployment's `standard` and anything else
you authored — run the in-process loop, and a child agent inherits the engine of
the agent that spawned it (`src/router-loop.ts:209-219`). Sessions are independent,
so several of them can run different engines at the same time.

**Any session can be moved to another engine at any time**, as long as it is open
and no turn is in flight: the composer's picker calls this plugin's own
`remote.loopEngine.select`, which records the choice in
`$DSH_HOME/.loop-engine/engines.json` and then moves the session over
(`src/router-loop.ts:378`). **Between two hosted engines the move is an in-place
handover**: the session's `Session` object, its store entry, and its write handle
are all kept, only the agent is replaced, and the conversation on screen never
closes — that pick applies on the spot, with nothing to confirm. **A move that
involves the in-process engine on either side cannot be
handed over in place** — the harness loop neither accepts a session it did not
create nor hands a live one over — so the composer asks first: it says the switch
reloads the page and that this page's scroll position and unsent draft go with it
(the conversation record does not), and only commits once the user confirms
(`switchNeedsReload`, `src/client/session-engine.ts:250`). On commit the host
RELEASES that session's agent and
answers `reload: true`: the session goes cold with its record already naming the
new engine, the page reloads itself, and the page that comes back opens the same
session, which is what makes the host build it on the recorded engine. The
process is never restarted, and nothing needs one. A reload is required because
releasing an agent publishes `session/disposed`, and the client's session object
is then marked `removed` with nothing in that page's lifetime to clear it
(`docs/per-session-engine.md` §5.2/§5.4). In that window — and after a release
that did not take — the header chip names the engine that runs and adds a
`Pi CLI · → In-process engine (default) · not in force` marker, the composer's
menu marks that same row, and picking that engine again retries the release;
the chat row's animation follows the engine that really runs. Output already in
flight is never
interrupted — a session that is mid-turn is refused instead, and the refusal is
shown in the user's own language from the code the host returned (the host's
English sentence is kept as detail; `refusalFace`,
`src/client/locales.ts:299`). A session that has
not run a turn can also be moved with the harness's own preset picker, and when
it already has a record that picker updates the record too, so the last thing the
user did always wins (`src/router-loop.ts:580`). The engine record is per
session: the deployment's `engine` setting only decides what NEW sessions start
on. A session the plugin has no record for — every session from before this
version — keeps answering from its agent preset, exactly as it used to.

### What a hosted engine takes over

A hosted engine owns its session's command and skill surface. Its preset is a
copy of `standard` minus the dsh-native rows an external engine replaces —
`/compact` and auto-compaction, `/plan`, the model-facing goal tool, dsh's human
`/goal` command, and the dsh skill rows (`src/preset.ts:79`) — and when that
session's agent is built, the engine's own slash commands and skill catalog are
registered into **that agent's own scope** (`src/engine-surface.ts:77`). Two
sessions on different engines therefore never see each other's menus, and the
whole surface is released with the agent. Engine-agnostic dsh commands
(`/export`, `/feedback`, `/permission`) keep working and stay.

`/goal` is worth spelling out, because the managed block is not what removes it
from a hosted session. dsh registers the human `/goal` command in the **preset
layer** — the `standard` composition carries its own `command-goal` row
(`../deepseek-harness/packages/preset/agent-presets/presets/standard/agent.cordis.yml:95`)
— so disabling the host-plane row from the profile patch cannot reach a session
composed from that preset. The managed block disables that row anyway, for a
minimal profile with no `web-app` overlay, which already disables it
(`../deepseek-harness/packages/bundle/web-app/cordis.patch.yml:411-412`); what
actually strips `/goal` from a hosted session is the managed preset
(`src/preset.ts:79`, `:123`). That leaves the name to the engine's own command
surface: Kimi's ACP surface implements no `/goal`, so its bridge registers none
(`src/engine-kimi/commands.ts:11-27`).

Every hosted engine's provider label is served in the llm registry at once
(`src/provider-route.ts:27`): an engine logs its own label into its sessions'
`request/header`, and the web host refuses a turn whose session selection names a
provider no adapter serves. The placeholders advertise no models — only Pi
injects its probed catalog — so the model catalog is otherwise unchanged.

The same projection covers the tool surface: a hosted engine's calls are projected
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

## Known limitations

- **Hosted engines swap in place; a move involving the in-process engine releases
  the session and reloads the page (the process never restarts).** The engine is
  the plugin's own per-session record, so a session can be moved at any time (it
  must be open and idle). Between two hosted engines nothing is rebuilt: the
  session's `Session` object, store entry, and write handle are kept, only the
  agent is replaced, and the conversation stays open — the pick applies at once
  and no dialog opens. With the in-process engine on either side the composer
  confirms first (the reload takes this page's scroll position and unsent draft;
  the conversation record is untouched), and on confirm the host cannot hand the
  session over at all, so it RELEASES the
  session's agent — the session goes cold with the record already naming its new
  engine — and answers `reload: true`. The browser half then stashes the session
  id in tab storage and reloads the page; when the page comes back it opens that
  session again, which makes the host resolve it and build it on the recorded
  engine. A reload is needed because releasing an agent publishes
  `session/disposed`, and the client's own session object is then marked `removed`
  with nothing in that page's lifetime to clear it (see
  `docs/per-session-engine.md` §5.2/§5.4); the process itself is never restarted.
  In the window before the reload (and after a release that did not take) the chip
  and the composer name the engine that runs and add a `→ X · not in force` marker
  — the composer's menu marks that same row — and picking that engine again
  retries the release. A session that is mid-turn is refused rather than
  interrupted — in the user's own language, from the refusal code the host
  returned, with the host's English sentence kept as detail — and a subagent's own
  session cannot be moved at all (its agent belongs to the delegation). See
  `docs/per-session-engine.md` §1.3 and §5.
- **The Settings dropdown is a default, not a live switch.** It decides what new
  sessions start on. To move an existing session, use the composer's picker — any
  session that is open and idle will do. The chat header's engine chip is not that
  default: it reports what the session on screen actually runs — the agent driving
  it when one is live, and only otherwise this plugin's own per-session record
  (falling back, with no record, to the session's durable log) through this
  plugin's own Remote (`remote.loopEngine.engine`) — the same read the router
  routes on, so a session shown as Pi is a session driven by Pi. When the record
  names an engine the session is not running (a release that did not take), the
  chip names the engine that runs and adds the `→ X · not in force` marker, never
  the other way round. The harness's own preset
  label in that header reads the session list's cached projection instead, so on a
  session that has been moved that label can still name the agent preset the
  session was CREATED with; the chip does not.
- **Under a hosted engine the page's model selector does nothing.** The engine
  owns its model natively, so what the session sends is what the engine's CLI
  decides; dsh's `/plan`, `/compact`, `/goal`, goal tool, and dsh skill catalog
  are absent from that session for the same reason (`src/preset.ts:79`).
- **Sessions do not share engine processes.** Each session owns its own engine
  child — a `codex app-server`, a `kimi acp`, a Pi RPC child, a Claude query per
  step — released when that agent's scope unwinds
  (`src/engine-codex/agent.ts:166`, `src/engine-kimi/agent.ts:126`). N concurrent
  sessions on one engine mean N child processes.

## License

MIT
