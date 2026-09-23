# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

像选模型一样选 **dsh web** 的 agent 循环引擎——**按会话**选。会话建在 `Claude Code`、`Codex`、`Pi` 或 `Kimi Code` 预设上,就用对应的 CLI;其它预设(含部署自己的 `standard`)走内置 in-process 循环。引擎本身是本插件的逐会话记录,所以**只要会话处于打开且空闲状态,任何时候都能换成别的引擎**——包括已经跑过很多轮的会话。**托管引擎之间是原地换手**(对话不关,只替换 agent);**有一边是 in-process 时,宿主会释放这条会话的 agent 并让页面自动重新载入**(回来仍是这条会话,由新引擎重建)——`dsh web` 进程本身**不重启**。会话之间互不影响:一个对话跑 Codex,另一个可以同时跑 Kimi。设置页的 **Settings → Loop engine** 下拉选的是**新会话**的默认引擎。以上**无需改动主仓库**。

## 安装

```sh
dsh plugin --profile web add dsh-loop-engine
```

启动 `dsh web` 让 profile 重新组合出这个插件(bundle 列表与插件代码都在启动时读取),然后打开 **Settings → Loop engine**。启动一次就够:受管理块要到**下一次** composition 才被读到,所以全新安装的首次启动里,基础 bundle 的 `agent-loop` 行仍占着 factory 槽位;路由器会在一个有界窗口内重试(`src/index.ts:588-615`,回归测试 `tests/router-mount.spec.ts:192`),等 harness 的 live patch reload 摘掉那行后即挂载成功。

> 安装会重写 `cordis.patch.yml` 中一小段受管理的内容(`src/patch-manager.ts:59`)。这段块**不带引擎 id**:它禁用基础 bundle 的 `agent-loop` 行,好让插件自己的路由器占据进程内唯一的 agent factory 槽位(`src/router-loop.ts:172`),并且只要插件处于安装状态,它在任何引擎下都存在。它同时禁用 host 面的 `command-goal` 行——这样只装 base、没有 `web-app` overlay 的最小 profile 也不会冒出 dsh 的 `/goal`;在托管会话里真正剥掉 `/goal` 的是托管 preset(见[托管引擎接管什么](#托管引擎接管什么))。文件里你写的其它部分逐字节保留。

**从更早版本升级。** 在按会话路由之前写下的块会点名 profile 当时钉住的那一个引擎(`# -- dsh-loop-engine managed block: claude-code --`)。下一次启动会把该块重写成不带引擎 id 的形式,并把块里那个引擎作为设置页默认值的初始 seed(`src/patch-manager.ts:95`、`src/index.ts:271`)——原引擎不会丢,只是从「进程级切换」变成「新会话的默认引擎」,不需要手工改文件。用源码 checkout 跑 harness 的,还要按[环境要求](#环境要求)把 `dsh-agent-loop` 加进那份 `file:` shim 清单。

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

再把这些写进 profile 的 `package.json` 并重新安装:

```sh
node -e 'const f="package.json",j=require("./"+f),d=j.dependencies??={}
for(const n of ["cordis","schemastery","dsh-agent","dsh-agent-loop","dsh-scope","dsh-session","dsh-session-persistence","dsh-settings","dsh-subprocess","dsh-timeout","dsh-llm","dsh-invariants","dsh-home-paths"])
  d["@deepseek-ai/"+n]="file:./shims/"+n
require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")'
pnpm install
```

重启 `dsh web`。若有代码加载 `@deepseek-ai/dsh-scope/invariant` 子路径,再给该 shim 补一个 `invariant.mjs`(`export * from '$HARNESS/packages/core/scope/src/invariant.ts'`),并在它的 `exports` 里加上 `"./invariant": "./invariant.mjs"`。

> 用本地 **`link:`** 方式安装插件可以完全绕开这一步:checkout 与 harness 仓库相邻时,它会继承 harness 自己的 `tsconfig.json`,从而共用同一份 `paths` 映射。这个分裂只在**打包版**插件(npm 或 tarball)遇到**源码版** harness 时出现。

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

### 环境要求

- harness 的循环包是本插件的 peer:路由器继承 `@deepseek-ai/dsh-agent-loop` 的 `AgentLoop`(`src/router-loop.ts:172`),并且只要插件处于安装状态,基础 bundle 的 `agent-loop` 行就一直被禁用。因此用源码 checkout 跑 harness 时要多补一份 `file:` shim——把 `dsh-agent-loop` 加进[源码启动 harness 时的额外步骤](#源码启动-harness-时的额外步骤)那份清单。
- 使用 Claude Code 引擎时需要本机已安装并登录 Claude Code CLI。
- 使用 Codex 引擎时需要完成认证:本机执行过 `codex login`,或配置 `CODEX_API_KEY` 环境变量。
- 使用 Pi 引擎时需要以 `pi` 要求的方式完成认证(其自身的 `~/.pi/agent/auth.json`,或提供方的 API-key 环境变量,如 `ANTHROPIC_API_KEY`)。
- 使用 Kimi Code 引擎时需要本机已安装并登录 `kimi` CLI(例如 `kimi login`),且在 `PATH` 上(或在组合条目里用 `kimiBin` 固定为绝对路径)。

## 使用方法

1. 在**新会话页**的 preset 选择器(工作区选择器旁的 preset chip)上选你要的引擎预设:**Claude Code**、**Codex**、**Pi** 或 **Kimi Code**,该会话就用对应 CLI;保留部署自己的默认预设(通常是 `standard`)则走内置 in-process 循环。预设决定的是**新会话**起步时的组合面;之后这个会话跑哪个引擎由插件自己的记录决定(见下)。
2. 在 **Settings → Loop engine** 改**新会话**的默认引擎:改完立即生效,**不需要重启,也不需要刷新页面**,已经存在的会话不受影响。选 **In-process** 会把插件接手前的默认值恢复回去。勾选 `在对话页显示引擎选择器` 时,对话页 composer 的选择器动的是**你当前这条会话**,而不是默认值(见下)。
3. 卸载插件:`dsh plugin --profile web remove dsh-loop-engine`,然后重启 `dsh web`。同时要手工删掉 `cordis.patch.yml` 里插件的受管理块:这块比插件本身活得更久,只要它还在,基础 `agent-loop` 行就一直被禁用,profile 会完全没有 agent factory。

每个引擎都有一份自己的受管理 agent 预设(`$DSH_HOME/.agent-presets/loop-engine-<engine>/`,由 `src/preset.ts:200` 生成),这份预设是会话的 **agent-plane 组合**(它的 prompt 面、命令面、技能面)。不属于本插件的预设——部署的 `standard` 以及你自己写的其它预设——走 in-process 循环;子 agent 沿用拉起它的那个 agent 的引擎(`src/router-loop.ts:209-219`)。会话之间互相独立,可以多个会话同时跑不同引擎。

**只要会话处于打开且空闲状态,任何时候都能换引擎**——包括已经跑过很多轮的会话:composer 的选择器调用本插件自己的 `remote.loopEngine.select`,把选择写进 `$DSH_HOME/.loop-engine/engines.json` 再搬动这条会话(`src/router-loop.ts:378`)。**两个托管引擎之间是原地换手**:会话的 `Session` 对象、store 条目与写句柄全部保留,只换 agent,对话面不会关闭——这一类选中即生效,不弹任何东西。**只要有一边是 in-process 就无法原地接管**(harness 的 loop 既不接受不是它创建的会话,也不把活会话交出去),所以选择器会**先弹一个确认框**说清这次切换要重新载入页面、这一页的滚动位置与还没发出的草稿会跟着丢(会话记录不受影响),用户确认后才提交(判据 `switchNeedsReload`,`src/client/session-engine.ts:250`)。提交之后:宿主**释放这条会话的 agent**(会话因此变冷,而记录就是它下一次构建要用的引擎),回包带 `reload: true`,客户端**把这条会话的 id 存进本标签页的 `sessionStorage` 并重新载入页面**——重载后的页面自动 `sessions.open(id)` 回到同一条会话,宿主随即按记录构建它(主仓 `packages/api/session-controller/src/agent.ts:183-192` 的 `resolve` 此时找不到活 agent,于是走 `resume`)。**`dsh web` 进程不重启,也不需要重启**。为什么必须重载:释放会发 `session/disposed`,客户端把它读成"这条会话没了"(删行、清空当前会话,并在那个 Session 实例上留下没有复位路径的 `removed` 标记,`packages/api/session-controller/src/client/sessions/session.ts:572-573`),重载是清掉这份页面状态的最小动作。这一切在切换完成、页面重载之前;若那次释放**没有成功**,报告会同时给出两个事实,chip / composer 写成「正在跑的那个 · 切到 X · 尚未接管」,再选一次目标引擎即可重试。**进行中的输出不会被中断**——正在跑一轮时直接拒绝,而且拒绝文案按宿主回的原因码说本地化的话(宿主那句英文原话只作详情,`refusalFace`,`src/client/locales.ts:299`)。还没跑过一轮的会话也可以用 harness 自己的 preset 选择器换;若这条会话已经有插件记录,那次选择同样会把记录更新过去,所以"最后一次用户动作胜出"(`src/router-loop.ts:580`)。引擎记录是按会话的:部署的 `engine` 设置只决定**新会话**起步用什么。插件没有记录的会话——本版本之前的所有会话——继续按它的 agent preset 回答,行为与以前完全一致。

### 托管引擎接管什么

托管引擎接管**它那个会话**的命令与技能面。它的预设是 `standard` 的副本,去掉了外部引擎会替代掉的 dsh 原生行——`/compact` 与自动压缩、`/plan`、模型可见的 goal 工具、dsh 的人类 `/goal` 命令、以及 dsh skill 行(`src/preset.ts:79`)——而该会话的 agent 建好时,引擎自己的斜杠命令与技能目录会注册进**这个 agent 自己的 scope**(`src/engine-surface.ts:77`)。因此两个跑不同引擎的会话互相看不到对方的菜单,整份表面随 agent 一起回收。与引擎无关的 dsh 命令(`/export`、`/feedback`、`/permission`)照常可用、保留在菜单里。

`/goal` 值得单独说清楚:把 dsh 的 `/goal` 从托管会话里拿掉的**不是**受管理块。dsh 把人类 `/goal` 命令注册在 **preset 层**——`standard` 组合自己带一行 `command-goal`(主仓 `packages/preset/agent-presets/presets/standard/agent.cordis.yml:95`)——所以在 profile patch 里禁用 host 面那一行够不到由这份组合出来的会话。受管理块照样禁了它,理由是不依赖 `web-app` overlay(它本来就禁了同一行,主仓 `packages/bundle/web-app/cordis.patch.yml:411-412`),让只装 base 的最小 profile 也生效;真正剥掉 `/goal` 的是托管 preset(`src/preset.ts:79`、`:123`)。剥掉后这个名字留给了引擎自己的命令面:Kimi 的 ACP 面没有 `/goal`,所以它的桥接也不注册(`src/engine-kimi/commands.ts:11-27`)。

四个引擎的 provider 标签在 llm registry 里**同时**常驻(`src/provider-route.ts:27`):每个引擎把自己那个标签写进所属会话的 `request/header`,而 Web 宿主会拒绝 provider 没有适配器服务的回合。这些占位适配器不广告任何模型——只有 Pi 会注入自己探测到的目录——所以模型目录其余部分不变。

同一层投影也覆盖工具面:托管引擎的调用在 durable `tool/call` 事件里被投影到 dsh 的工具词汇,于是 Web GUI 用原生行渲染它们——Claude 的 `Write`/`Edit`、Codex 的 `command_execution`、Kimi 的 `Bash` 会变成 dsh 的 `write`/`edit`/`bash`,同时喂给该回合成品区的「Files changed」行与正文行内文件链接;Claude 的 `TodoWrite` 还会驱动 dsh 的待办面板。引擎自己的 assistant 消息保留原拼写,所以下一步的 prompt 不受影响;没有无损 dsh 等价物的调用——Codex 的多文件 `apply_patch`——保持通用行,而不是误渲染。

### 引擎说明

- Claude Code 驱动每步跑一次 SDK query;它的斜杠命令桥接进 web 菜单(内置命令加上用户级 `~/.claude/commands/`),再转发给引擎由它原生展开——CLI 只在 prompt 以 `/` 开头时才分派本地命令,所以桥接行是作为该步的整个 prompt 发出的,而不是发成带框架的转写文本。项目级 `.claude/commands/` 留在引擎侧,直接手敲同样可用。
- Codex 驱动运行 `codex app-server`;线程以会话的 `sandboxMode` + `approvalPolicy` 姿态启动,模型运行时的工具审批请求(command、file-change、permissions)经 dsh 审批 seam 应答——用户提问走 user-questions seam,MCP elicitation 一律拒绝,seam 缺席时均失败关闭。其 `AGENTS.md` 指令文件经 dsh 技能注入接缝暴露:从会话 cwd 逐级到 git 根,外加 `~/.codex/AGENTS.md`。
- Pi 驱动运行 `pi --mode rpc`;Pi 没有权限系统,所以整个子进程经 dsh subprocess 服务做沙箱化(默认 `read-only`)。它的上下文文件(`AGENTS.md`/`CLAUDE.md`,优先 `AGENTS.override.md`,外加 pi 配置目录下的用户级文件)与 `skills/` 目录(`~/.pi/agent/skills/` 和 `.pi/skills/`)经 dsh 技能注入接缝暴露。
- Kimi Code 驱动运行一个常驻的 `kimi acp` 子进程(Agent Client Protocol over stdio),每步一次无状态的 `session/new` + `session/prompt`;durable 会话日志是唯一模型上下文。它把助手文本(`agent_message_chunk`)与**思考**(`agent_thought_chunk`)**增量**写入日志,并把工具调用/流(`tool_call` / `tool_call_update`)映射为 `tool/call` + `tool/result`。ACP 通过 `session/request_permission` 暴露工具审批,驱动根据会话的 dsh 审批旋钮应答(ask 策略拒绝,失败关闭)。子进程经 dsh subprocess seam 拉起——唯一权限边界(默认只读沙箱)。其项目 `AGENTS.md` 链(cwd→git 根)与 `.kimi-code/skills/` 目录(用户与项目)通过 dsh 技能注入接口暴露,其斜杠命令也已桥接(内置命令把原始 `/name` 行转发回引擎展开,该行作为该步的整个 prompt 发出,因为 Kimi 的 ACP 适配层只解析开头的命令)。桥接的内置命令是 ACP 面真正实现的六个(`compact`、`status`、`usage`、`mcp`、`tasks`、`help`)。prompt 是 ACP 请求体而非 argv 位置参数,因此**不存在命令行长度上限**。注意 Kimi 剩余的斜杠命令面是纯 TUI(`/login`、`/provider`、`/settings`、`/sessions`…),这些不桥接(ACP prompt 面对它们返回 `Unknown ACP command`);`skill:` 命令由技能接口与 kimi 自身的 shorthand 承载。

## 已知限制

- **托管引擎之间是原地换手,涉及 in-process 会先确认、再释放这条会话并重载页面(进程不重启)。** 引擎是本插件的逐会话记录,所以任何时候都能换(只要会话打开且空闲)。两个托管引擎之间:会话不重建、对话不关闭,只替换 agent(原地换手),选中即生效、不弹任何确认。任一边是 in-process:composer 先弹确认框说清代价(这一页的滚动位置与未提交草稿会丢,会话记录一字不少),确认后宿主写记录 → 释放这条会话的 agent → 回包 `reload: true`,客户端把会话 id 存进 `sessionStorage` 并 `window.location.reload()`,重载后的页面自动打开同一条会话,宿主按记录重建它。**为什么必须重载**:释放会发 `session/disposed`,客户端把它读成这条会话没了(删行、清空当前会话,并在那个 Session 实例上留下无法复位的 `removed` 标记),而重载是清掉这份页面状态的最小动作。若那次释放**没有成功**,chip / composer 会写「正在跑的那个 · 切到 X · 尚未接管」,再选一次目标引擎即可重试。正在跑一轮的会话会被拒绝而不是被打断——拒绝文案按宿主回的原因码说本地化的话,宿主那句英文原话只作详情;子会话(由 subagent 派生的会话)完全不能换,它的 agent 属于那次派发。详见 `docs/per-session-engine.md` §1.3 与 §5。
- **设置页的下拉是默认值,不是实时切换。** 它决定新会话用什么引擎。要改动已有会话,用 composer 的选择器——只要会话处于打开且空闲状态即可。会话头的引擎 chip **不是**这个默认值:它显示的是屏幕上这条会话**实际在跑**的引擎——有活 agent 时就是驱动它的那个 agent 的引擎,没有活 agent 时才看插件自己的逐会话记录(没有记录再回退到会话的持久日志)——也就是插件自己的 Remote(`remote.loopEngine.engine`),与路由用的是同一份读取,所以显示 Pi 的会话就是真的由 Pi 驱动的。同一个 header 里 harness 自带的 preset 标签读的是会话列表里的缓存投影,所以在被换过引擎的会话上它仍可能写着**创建时**的 agent preset;chip 不会。
- **托管引擎下页面上的模型选择不生效。** 模型由引擎自己原生决定,所以会话实际用什么模型由对应 CLI 说了算;同理,那个会话里没有 dsh 的 `/plan`、`/compact`、`/goal`、goal 工具与 dsh skill 目录(`src/preset.ts:79`)。
- **会话之间不共享引擎进程。** 每个会话拥有自己的引擎子进程——`codex app-server`、`kimi acp`、Pi 的 RPC 子进程、Claude 每步一次的 query——随该 agent 的 scope 回收(`src/engine-codex/agent.ts:166`、`src/engine-kimi/agent.ts:126`)。同一引擎上 N 个并发会话就是 N 个子进程。

## License

MIT
