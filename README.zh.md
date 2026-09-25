# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

像选模型一样选 **dsh web** 的 agent 循环引擎——**按会话**选:内置的 `in-process`(默认),或四个托管引擎 `claude-code`、`codex`、`pi`、`kimi`。引擎本身是本插件的逐会话记录,所以**只要会话处于打开且空闲状态,任何时候都能换成别的引擎**——两个托管引擎之间是**原地换手**,而有一边是 `in-process` 时,宿主会释放这条会话的 agent 并让页面重新载入(`dsh web` 进程本身**不重启**)。会话之间互不影响:一个对话跑 Codex,另一个可以同时跑 Kimi。以上**无需改动主仓库**。

## 安装

```sh
dsh plugin --profile web add dsh-loop-engine
```

启动 `dsh web` 让 profile 重新组合出这个插件,然后打开 **Settings → Loop engine**。启动一次就够:路由器会在一个有界窗口内重试,等基础 bundle 的 `agent-loop` 行让出 factory 槽位。

> 安装会重写 `cordis.patch.yml` 里一小段**不带引擎 id** 的受管理块:它禁用基础 bundle 的 `agent-loop` 行,好让插件自己的路由器占据进程内唯一的 agent factory 槽位;文件里你写的其它部分逐字节保留。从更早版本升级**不需要手工改文件**——点名了那一个钉住引擎的旧块会在下一次启动时被改写成这种形式,并把那个引擎作为设置页默认值的初始 seed。

> **pnpm 用户:** pnpm 10+ 默认拦截依赖的 build script,安装可能以 `ERR_PNPM_IGNORED_BUILDS` 失败,并列出 `esbuild`、`@google/genai`、`protobufjs`(都经引擎 SDK 传递而来)。放行后重试即可——`pnpm approve-builds`,或在 `pnpm-workspace.yaml` 里用 `allowBuilds`。只有安装方能授予该权限,插件无法预先放行自己的依赖。

### 源码启动 harness 时的额外步骤

**发布版** dsh 不需要额外操作。若改用**源码**启动 harness(`cd deepseek-harness && pnpm dsh web`),则要多做一步:用 `file:` shim 把 profile 的 harness peer 包桥接到 checkout 源码,让两边共用同一个模块实例(一个实例打的 scope 标记另一个实例读不到,恢复会话时会报 `agent-presets: refusing to compose an unscoped context`)。清单里包含 `@deepseek-ai/dsh-agent-loop`。可跑的 shim 步骤在 [docs/source-checkout.md](docs/source-checkout.md);每个 `@deepseek-ai/*` 包必须保持单实例的原因见 [docs/architecture.md](docs/architecture.md)。用本地 **`link:`** 方式安装插件可以完全绕开这一步。

## 版本兼容

`dsh-loop-engine` 与它针对的 harness **同版本对齐**:`<harness version>-rcN`。自 `0.1.7-rc1` 起,**一个发布版本同时服务两代 harness**:0.1.5 线(`>=0.1.5-rc.1 <0.1.6-0`,三段 `rc` 共用同一套旧 settings API)与 `0.1.7-rc.1`(`>=0.1.7-rc.1 <0.1.8-0`)。它在加载期探测当前是哪一代、走对应分支,所以同一份已发布产物在两代上都能安装运行。它消费的每个 harness 包都在 `peerDependencies` 里声明这个并集范围;超出范围会在启动或会话恢复时响亮地失败。`0.1.5-rc3` … `0.1.5-rc5` 针对 harness `0.1.5-rc.2`;`0.1.5-rc1`/`0.1.5-rc2` 针对 `0.1.5-rc.1`;`1.0.0-rc8` … `1.0.0-rc15` 针对 `0.1.2-rc.1`;`1.0.0-rc7` 及更早针对 `0.1.1-rc.2`。

### 环境要求

- **Claude Code**:本机已安装并登录 Claude Code CLI。
- **Codex**:本机执行过 `codex login`,或配置 `CODEX_API_KEY` 环境变量。
- **Pi**:以 `pi` 要求的方式完成认证(其自身的 `~/.pi/agent/auth.json`,或提供方的 API-key 环境变量,如 `ANTHROPIC_API_KEY`)。
- **Kimi Code**:本机已安装并登录 `kimi` CLI(例如 `kimi login`),且在 `PATH` 上(或在组合条目里用 `kimiBin` 固定为绝对路径)。
- 用源码 checkout 跑 harness 时还要补上那份 `dsh-agent-loop` 的 `file:` shim。

## 使用方法

**引擎是按会话选的。** 在**新会话页**的 preset 选择器(工作区选择器旁的 preset chip)上选 `Claude Code`、`Codex`、`Pi` 或 `Kimi Code`;保留部署自己的默认预设(通常是 `standard`)则走内置 in-process 循环。不同会话可以同时跑不同引擎,子 agent 沿用拉起它的那个 agent 的引擎。

- **Settings → Loop engine** 只决定**新会话**的默认引擎——改完立即生效,**不需要重启,也不需要刷新页面**,已经在跑的会话不受影响。选 **In-process** 会把插件接手前的默认值恢复回去。
- **改动你当前这条会话**用对话页 composer 的引擎选择器(勾选 *在对话页显示引擎选择器*),它调用本插件自己的 `remote.loopEngine.select`。只要会话处于打开且空闲状态就能换——包括已经跑过很多轮的会话。
  - **两个托管引擎之间是原地换手**:会话保持打开,只替换 agent——选中即生效,不弹任何确认。
  - **只要有一边是 `in-process` 就无法原地接管**(harness 的 loop 既不接受不是它创建的会话,也不把活会话交出去),所以 composer 会**先弹确认框**说清这次切换要重新载入页面、这一页的滚动位置与还没发出的草稿会跟着丢(会话记录不受影响)。确认后宿主**释放这条会话的 agent** 并回包 `reload: true`;页面自动重载并回到同一条会话,宿主随即按记录构建它。**`dsh web` 进程不重启。**
  - **正在跑一轮时会话会被拒绝**而不是被打断;由 subagent 派生的**子会话**完全不能换。
- **模型**:模型菜单里所有托管引擎共用一个 `external` 分组,名下只有一条 `default`——含义是「由引擎决定」。选一条**真实 dsh 模型**会把它连同**端点与凭据**一起交给该引擎(能不能用取决于该引擎——不支持会**报错**,而不是静默退回)。`in-process` 会话照常用 dsh 的模型。
- **卸载**:`dsh plugin --profile web remove dsh-loop-engine`,然后手工删掉 profile 的 `cordis.patch.yml` 里插件的受管理块——这块比插件本身活得更久,只要它还在,基础 `agent-loop` 行就一直被禁用,profile 会完全没有 agent factory。

### 托管引擎接管什么

- 它的预设是 `standard` 的副本,去掉了外部引擎会替代掉的 dsh 原生行——dsh 的 `/plan`、`/compact`(与自动压缩)、模型可见的 goal 工具、人类 `/goal` 命令、以及 dsh skill 行(每引擎一份剥离后的 preset,位于 `$DSH_HOME/.agent-presets/loop-engine-<engine>/`)。
- 引擎自己的斜杠命令与技能目录会注册进**这个 agent 自己的 scope**,因此两个跑不同引擎的会话互相看不到对方的菜单,整份表面随 agent 一起回收。
- 与引擎无关的 dsh 命令(`/export`、`/feedback`、`/permission`)照常可用、保留在菜单里。

## 已知限制

- **引擎记录落在插件自己的侧车文件 `$DSH_HOME/.loop-engine/engines.json`,不在会话日志里。** 换机器或换 `DSH_HOME` 会丢掉它,会话会优雅回退到 preset 映射。详见 [docs/per-session-engine.md](docs/per-session-engine.md) §5.5 与 [docs/architecture.md](docs/architecture.md) §3.9。
- **涉及 `in-process` 的切换要重新载入页面**,因为 harness 的 loop 既交不出活会话、也不接管别人的。详见 [docs/per-session-engine.md](docs/per-session-engine.md) §5.2/§5.4。
- **引擎在会话创建/空白期确定**;跑过一轮之后再换引擎,会重建这条会话的 agent(只在空闲时才行)。详见 [docs/per-session-engine.md](docs/per-session-engine.md) §5。
- **日志里记着旧版单 preset id(`loop-engine`)的老会话**显示为「旧版托管引擎」,需要一次重建才由新语义接管。详见 [docs/per-session-engine.md](docs/per-session-engine.md) §7。
- **托管引擎下 dsh 的模型选择只有在你真的选了真实 dsh 模型时才有意义**——`default` 意思是「交回引擎自己决定」。详见 [docs/per-session-engine.md](docs/per-session-engine.md) §5.2。
- **同一引擎上的多条会话共享该 CLI 自己的认证目录**,插件没有加任何锁。详见 [docs/per-session-engine.md](docs/per-session-engine.md) §6。
- **换成 `in-process` 时,那个共享的 `external` provider 分组仍会留在模型菜单里**(目录不按会话过滤)。详见 [docs/architecture.md](docs/architecture.md) §3.6。

## 细节在哪

- [docs/per-session-engine.md](docs/per-session-engine.md)——按会话选引擎的用户可见行为全解。
- [docs/source-checkout.md](docs/source-checkout.md)——源码启动 harness 时需要的那套 `file:` shim。
- [docs/architecture.md](docs/architecture.md)——插件核心:唯一 factory 槽位、受管理块、路由、逐会话引擎事实、provider 路由。
- [docs/driver-core.md](docs/driver-core.md)——共享驱动基础设施。
- [docs/engine-claude.md](docs/engine-claude.md)、[docs/engine-codex.md](docs/engine-codex.md)、[docs/engine-kimi.md](docs/engine-kimi.md)、[docs/engine-pi.md](docs/engine-pi.md)——逐引擎内部实现。
- [docs/optimization-backlog.md](docs/optimization-backlog.md)——已知问题与优化清单。
- [docs/proposals/](docs/proposals/)——主仓提案:`append-ignorable-events.md`、`harness-agent-handover.md`,以及模型选择相关的两篇(`dsh-model-into-hosted-engines.md`、`per-session-model-for-hosted-engines.md`)。

## License

MIT
