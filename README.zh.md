# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

像切换模型一样切换 **dsh web** 的 agent 循环引擎:设置页的「Loop engine」下拉选择运行 agent 的驱动——内置 in-process 循环、Claude Code CLI、Codex CLI、Pi CLI,或 Kimi Code CLI——**无需改动主仓库**。

## 安装

```sh
dsh plugin --profile web add dsh-loop-engine
```

重启 `dsh web`,然后打开 **Settings → Loop engine**。

> 切换引擎会重写 `cordis.patch.yml` 中一小段受管理的内容,文件里你写的其它部分都会保留,只改动插件自己的区间。

> **pnpm 用户:** pnpm 10+ 默认拦截依赖的 build script,安装可能以
> `ERR_PNPM_IGNORED_BUILDS` 失败,并列出 `esbuild`、`@google/genai`、
> `protobufjs`(都经引擎 SDK 传递而来)。这是预期行为——放行后重试即可:可用
> `pnpm approve-builds` 交互放行,或在安装项目的 `pnpm-workspace.yaml` 里声明:
>
> ```yaml
> allowBuilds:
>   esbuild: true
>   '@google/genai': true
>   protobufjs: true
> ```
>
> 只有安装方能授予该权限,插件无法预先放行自己的依赖。注意 `allowBuilds` 是
> pnpm 11 的写法——pnpm 11 会**删除** `package.json` 里遗留的
> `onlyBuiltDependencies`(以及 `neverBuiltDependencies`、`ignoredBuiltDependencies`)
> 且不再识别它们,写在那里会静默失效。

### 源码启动 harness 时的额外步骤

上面的安装针对 **发布版** dsh(`npx @deepseek-ai/dsh`),不需要额外操作。若改用**源码**启动 harness(`cd deepseek-harness && pnpm dsh web`),则要多做一步——因为两边会把 harness 的包解析到不同文件:

| 一侧 | `@deepseek-ai/dsh-scope` 解析到 |
|---|---|
| 源码启动的 harness | `packages/core/scope/src/index.ts`(经 tsconfig `paths`) |
| 安装的插件(包内只有 `lib/`) | `packages/core/scope/lib/index.js` |

也就是同一个包被加载成了两个模块实例。`dsh-scope` 用模块私有的 `Symbol('dsh.scope')` 给 context 打标记,一个实例打的标记另一个实例读不到,于是恢复会话时报错:

```
agent-presets: refusing to compose an unscoped context;
the scope key is what joins an agent to its preset
```

把 profile 的 peer 桥接到 harness 源码,让两边共用同一个实例。把 `HARNESS` 设为 harness checkout 的 **`file://` URL**,在 profile 目录下执行:

```sh
HARNESS=file:///path/to/deepseek-harness   # 例如 file:///D:/repos/deepseek-harness
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

再把这些写进 profile 的 `package.json` 并重新安装:

```sh
node -e 'const f="package.json",j=require("./"+f),d=j.dependencies??={}
for(const n of ["cordis","schemastery","dsh-agent","dsh-scope","dsh-session","dsh-session-persistence","dsh-settings","dsh-subprocess","dsh-timeout","dsh-llm","dsh-invariants","dsh-home-paths"])
  d["@deepseek-ai/"+n]="file:./shims/"+n
require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")'
pnpm install
```

重启 `dsh web`。若有代码加载 `@deepseek-ai/dsh-scope/invariant` 子路径,再给该 shim 补一个 `invariant.mjs`(`export * from '$HARNESS/packages/core/scope/src/invariant.ts'`),并在它的 `exports` 里加上 `"./invariant": "./invariant.mjs"`。

> 用本地 **`link:`** 方式安装插件可以完全绕开这一步:checkout 与 harness 仓库相邻时,它会继承 harness 自己的 `tsconfig.json`,从而共用同一份 `paths` 映射。这个分裂只在**打包版**插件(npm 或 tarball)遇到**源码版** harness 时出现。

### 环境要求

- 使用 Claude Code 引擎时需要本机已安装并登录 Claude Code CLI。
- 使用 Codex 引擎时需要完成认证:本机执行过 `codex login`,或配置 `CODEX_API_KEY` 环境变量。
- 使用 Pi 引擎时需要以 `pi` 要求的方式完成认证(其自身的 `~/.pi/agent/auth.json`,或提供方的 API-key 环境变量,如 `ANTHROPIC_API_KEY`)。
- 使用 Kimi Code 引擎时需要本机已安装并登录 `kimi` CLI(例如 `kimi login`),且在 `PATH` 上(或在组合条目里用 `kimiBin` 固定为绝对路径)。

## 版本兼容

`dsh-loop-engine` 与它针对的 harness **同版本对齐**:版本号即 harness 版本加插件发布序号(`0.1.5-rc1`、`0.1.5-rc2` 针对 harness `0.1.5-rc.1`,`0.1.5-rc3` 针对 harness `0.1.5-rc.2`),它消费的每个 harness 包都在 `peerDependencies` 里精确钉住。两者必须匹配——不匹配会在启动或会话恢复时响亮地失败:

| dsh-loop-engine | 需要 harness |
|---|---|
| 0.1.5-rc3 | **0.1.5-rc.2** |
| 0.1.5-rc1、0.1.5-rc2 | 0.1.5-rc.1 |
| 1.0.0-rc8 … 1.0.0-rc15 | 0.1.2-rc.1 |
| 1.0.0-rc7 及更早 | 0.1.1-rc.2 |

- **每个 0.1.5-rcN 版本需要它为之构建的那个 0.1.5 补丁。** `0.1.5-rc1`/`0.1.5-rc2` 需要 harness `0.1.5-rc.1`;`0.1.5-rc3` 需要 harness `0.1.5-rc.2`。三者都使用 0.1.5 的 assistant-stream 契约(`assistant/message` 内嵌精确计时的 `stream`,并禁止 `sourceEventSeqs`)、由 driver 自己实现的 `Inbox` 接口、双参数 `AgentSetup`,以及 `SessionPersistence.create` / `open` 句柄 seam。`0.1.5-rc.2` 是一次客户端 UI/文档 backport,没有触碰这些 seam,因此 driver 代码在 `0.1.5-rc.1` 与 `0.1.5-rc.2` 之间完全一致。
- `1.0.0-rc15` 及以前的版本沿用插件自己的版本序列,针对 harness `0.1.2-rc.1`,与 harness `0.1.5-rc.1` 不兼容。
- 要在更老的 harness 上使用本插件,请安装与之匹配的版本(例如 harness 0.1.2-rc.1 用 `npm i dsh-loop-engine@1.0.0-rc15`)。
- 每个 tag 的 GitHub Release 正文会写明它针对的 harness 版本。

## 使用方法

1. 在 **Settings → Loop engine** 选择引擎——`in-process`(默认)、`claude-code`、`codex`、`pi` 或 `kimi`——然后重启 `dsh web`。
2. 要切回默认,选 **In-process** 再重启即可。
3. 卸载插件:`dsh plugin --profile web remove dsh-loop-engine`,然后重启 `dsh web`。

### 托管引擎接管什么

选中托管引擎后,它接管该会话的命令与技能面:插件禁用 dsh 自己的 `/goal`,并把新会话指向一个受管理的 `loop-engine` agent 预设——它是 `standard` 的副本,去掉了外部引擎无法履行的 dsh 原生 `/compact`、`/plan`、goal 工具与 skill 行——于是斜杠菜单只显示引擎桥接过来的命令与它自己的技能目录。与引擎无关的 dsh 命令(`/export`、`/feedback`、`/permission`)照常可用、保留在菜单里。切回 `in-process` 会恢复之前的预设默认值;已经在跑的会话始终保留它创建时的预设。

同一层投影也覆盖工具面:托管引擎的调用在 durable `tool/call` 事件里被投影到 dsh 的工具词汇,于是 Web GUI 用原生行渲染它们——Claude 的 `Write`/`Edit`、Codex 的 `command_execution`、Kimi 的 `Bash` 会变成 dsh 的 `write`/`edit`/`bash`,同时喂给该回合成品区的「Files changed」行与正文行内文件链接;Claude 的 `TodoWrite` 还会驱动 dsh 的待办面板。引擎自己的 assistant 消息保留原拼写,所以下一步的 prompt 不受影响;没有无损 dsh 等价物的调用——Codex 的多文件 `apply_patch`——保持通用行,而不是误渲染。

### 引擎说明

- Claude Code 驱动每步跑一次 SDK query;它的斜杠命令桥接进 web 菜单(内置命令加上用户级 `~/.claude/commands/`),再转发给引擎由它原生展开。项目级 `.claude/commands/` 留在引擎侧,直接手敲同样可用。
- Codex 驱动运行 `codex app-server`;线程以会话的 `sandboxMode` + `approvalPolicy` 姿态启动,模型运行时的工具审批请求(command、file-change、permissions)经 dsh 审批 seam 应答——用户提问走 user-questions seam,MCP elicitation 一律拒绝,seam 缺席时均失败关闭。其 `AGENTS.md` 指令文件经 dsh 技能注入接缝暴露:从会话 cwd 逐级到 git 根,外加 `~/.codex/AGENTS.md`。
- Pi 驱动运行 `pi --mode rpc`;Pi 没有权限系统,所以整个子进程经 dsh subprocess 服务做沙箱化(默认 `read-only`)。它的上下文文件(`AGENTS.md`/`CLAUDE.md`,优先 `AGENTS.override.md`,外加 pi 配置目录下的用户级文件)与 `skills/` 目录(`~/.pi/agent/skills/` 和 `.pi/skills/`)经 dsh 技能注入接缝暴露。
- Kimi Code 驱动运行一个常驻的 `kimi acp` 子进程(Agent Client Protocol over stdio),每步一次无状态的 `session/new` + `session/prompt`;durable 会话日志是唯一模型上下文。它把助手文本(`agent_message_chunk`)与**思考**(`agent_thought_chunk`)**增量**写入日志,并把工具调用/流(`tool_call` / `tool_call_update`)映射为 `tool/call` + `tool/result`。ACP 通过 `session/request_permission` 暴露工具审批,驱动根据会话的 dsh 审批旋钮应答(ask 策略拒绝,失败关闭)。子进程经 dsh subprocess seam 拉起——唯一权限边界(默认只读沙箱)。其项目 `AGENTS.md` 链(cwd→git 根)与 `.kimi-code/skills/` 目录(用户与项目)通过 dsh 技能注入接口暴露,其斜杠命令也已桥接(内置命令把原始 `/name` 行转发回引擎展开)。prompt 是 ACP 请求体而非 argv 位置参数,因此**不存在命令行长度上限**。注意 Kimi 剩余的斜杠命令面是纯 TUI(`/login`、`/provider`、`/settings`、`/sessions`…),这些不桥接(ACP prompt 面不扩展它们);`skill:` 命令由技能接口与 kimi 自身的 shorthand 承载。

## License

MIT
