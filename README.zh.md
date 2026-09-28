# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

像选模型一样选 **dsh web** 的 agent 循环引擎——**按会话**选:内置的 `in-process`(默认),或四个托管引擎 `claude-code`、`codex`、`pi`、`kimi`。会话之间互不影响:一个对话跑 Codex,另一个可以同时跑 Kimi。只要会话打开且空闲,任何时候都能换引擎——两个托管引擎之间是**原地换手**,有一边是 `in-process` 时会让**页面重新载入**(`dsh web` 进程本身**不重启**)。以上**无需改动主仓库**。

## 安装

```sh
dsh plugin --profile web add dsh-loop-engine
```

启动一次 `dsh web`(路由器会在有界窗口内重试,等基础 bundle 让出 factory 槽位),然后打开 **Settings → Loop engine**。

**安装须知**

- 安装会重写 profile 的 `cordis.patch.yml` 里一小段**不带引擎 id** 的受管理块;文件里你写的其它部分逐字节保留。从更早版本升级**不需要手工改文件**。
- **装到 `web` 以外的 profile**(桌面版的 `desktop`、`headless` 部署、改过名的 profile)必须在该 profile 的组合条目里写上 `profile: <名字>`:
  ```yaml
  - id: loop-engine
    config:
      profile: desktop
  ```
  `profile` 默认是 `web`,不写的话插件会把受管块写进 `<home>/profiles/web/cordis.patch.yml`,而正在跑的那个 profile 永远不会读它:插件挂着,但基础 `agent-loop` 行没被禁,路由器拿不到 factory 槽位,任何托管引擎都不可达。(这是装进桌面版时踩出来的。)
- **卸载**是 `dsh plugin --profile web remove dsh-loop-engine` **再加上删掉那段受管理块**——块会比插件活得久,而它还在时 profile 里没有任何 agent factory,会话一条也建不出来。
- **pnpm 10+** 可能拦下依赖的 build script(`ERR_PNPM_IGNORED_BUILDS`,列出 `esbuild`、`@google/genai`、`protobufjs`)。执行 `pnpm approve-builds`(或加一条 `allowBuilds`)后重试;只有安装方能授予这个权限。
- **用源码启动 harness** 时还要多做一步:用 `file:` shim 把 profile 的 harness peer 包桥接到 checkout 源码,否则恢复会话会报 `agent-presets: refusing to compose an unscoped context`。步骤见 [docs/source-checkout.md](docs/source-checkout.md)。

## 环境要求

| 引擎 | 本机需要 |
|---|---|
| Claude Code | 已安装并登录 Claude Code CLI |
| Codex | 执行过 `codex login`,或配置 `CODEX_API_KEY` |
| Pi | `pi` 自己要求的认证方式(其 `~/.pi/agent/auth.json`,或提供方的 API-key 环境变量) |
| Kimi Code | 已安装并登录 `kimi` CLI,且在 `PATH` 上(或用 `kimiBin` 固定路径) |

## 使用方法

- **新会话**——在 preset 选择器(工作区选择器旁的 chip)上选引擎;保留部署自己的默认(通常是 `standard`)则走 in-process。子 agent 沿用拉起它的那个 agent 的引擎。
- **Settings → Loop engine** 决定**新会话**的默认引擎:改完立即生效,已经在跑的会话不受影响。选 **In-process** 会把插件接手前的默认值恢复回去。
- **换当前这条会话**用对话页 composer 的引擎选择器(勾选 *在对话页显示引擎选择器*)。
  - 托管 → 托管:原地换手,当场生效。
  - 涉及 `in-process` 的方向:先弹确认框,确认后页面重新载入并回到同一条会话(滚动位置与未发出的草稿会丢,会话记录不丢)。
  - 正在跑一轮的会话会被**拒绝**,子 agent 的会话不能换。
- **对话头部那个标记**(preset 标签旁边)写的是这条会话**实际在跑**的引擎;取消勾选 *在对话头部显示引擎标记* 即可关掉它(关掉后 header 上不留插件的任何痕迹)。
- **模型**——所有托管引擎共用 **一个** `external` 分组,里面只有一条 `default`,含义是"交给引擎自己决定"。选一条**真实的 dsh 模型**会把模型连同它的端点与凭据一起交给引擎;引擎能不能用是引擎的事,**被拒会如实报错而不是悄悄吞掉**。`in-process` 会话照常用 dsh 的模型。
- **`childIdleMs`**(组合条目,毫秒,默认 `0` = 不启用)——Kimi 与 Codex **每条会话保有一个常驻子进程**跨 step 复用;设了它就在空闲这么久之后把子进程关掉,下一步再重新拉起。只关子进程,所以不会触发任何重载。Pi 与 Claude Code 每步各起一次,不受影响。
- **dsh 自己的命令**(`/export`、`/feedback`、`/permission`)在托管引擎下照常可用。托管引擎的 preset 是 `standard` 的副本,去掉了被外部引擎接管的那几行(dsh 的 `/plan`、`/compact`、goal 工具与 `/goal`、以及技能相关行)。

## 版本兼容

**一个发布版本同时服务两代 harness**:0.1.5 线(`>=0.1.5-rc.1 <0.1.6-0`)与 0.1.7 线(`>=0.1.7-rc.1 <0.1.8-0`)——它在加载期探测当前是哪一代、走对应分支。这两个并集范围就是它在 `peerDependencies` 里声明的范围;超出范围的 harness 会在启动或会话恢复时**响亮地失败**。

版本读作 `<harness 线>-rcN`,其中 **`rcN` 是本插件对那条线的第 N 次发布号**,不是 harness 自己的 `rc` 号。在被覆盖的线里,新的 harness `rc` **不需要**插件跟版——除非某个 API 面动了;[docs/compatibility.md](docs/compatibility.md) §1 列出了这些面与"要不要改代码"的判定命令。

| 插件 | 目标 harness |
|---|---|
| `0.1.7-rc1` … `0.1.7-rc5` | `0.1.7-rc.1`、`0.1.7-rc.2` |
| `0.1.5-rc3` … `0.1.5-rc5` | `0.1.5-rc.2` |
| `0.1.5-rc1` / `0.1.5-rc2` | `0.1.5-rc.1` |
| `1.0.0-rc8` … `1.0.0-rc15` | `0.1.2-rc.1` |
| `1.0.0-rc7` 及更早 | `0.1.1-rc.2` |

## 已知限制

- **它替掉了 harness 的 agent factory。** 唯一那个门面服务所有会话,所以插件对此的承诺是:它读不出引擎的会话——包括跟托管引擎毫无关系的会话——一律**降级到 `in-process`**,而不是打不开。见 [docs/per-session-engine.md](docs/per-session-engine.md) §6。
- **引擎记录是侧车文件** `$DSH_HOME/.loop-engine/engines.json`,不在会话日志里:换机器或换 `DSH_HOME` 就丢,会话回退到自己的 preset。见 §5.5。
- **涉及 `in-process` 的换引擎会重新载入页面**——harness loop 既不交出活会话,也不接受不是它建的会话。见 §5.2/§5.4。
- **已经跑过一轮的会话**仍可换引擎,但只能在空闲时,且会重建那条会话的 agent。见 §5。
- **带旧 preset id `loop-engine` 的老会话**在重建一次之前显示为"旧版托管引擎"。见 §7。
- **同引擎的多条会话共享该 CLI 自己的认证目录**,插件不加锁。见 §6。
- **切回 `in-process` 之后**,模型菜单里那个共享的 `external` 分组仍在(模型目录不按会话裁剪)。

## 细节都在哪

- [docs/per-session-engine.md](docs/per-session-engine.md) —— 按会话选引擎的完整用户可见行为(上面引的 § 就是它)。
- [docs/architecture.md](docs/architecture.md) —— 插件核心:唯一 factory 槽位、受管理块、路由、provider 路由。
- [docs/compatibility.md](docs/compatibility.md) —— **harness 升级时先看这篇**:所有依赖代际的代码点与"加下一代"的清单。
- [docs/driver-core.md](docs/driver-core.md) —— 四个引擎共享的驱动层。
- [docs/engine-claude.md](docs/engine-claude.md) · [engine-codex](docs/engine-codex.md) · [engine-kimi](docs/engine-kimi.md) · [engine-pi](docs/engine-pi.md) —— 逐引擎内部实现。
- [docs/source-checkout.md](docs/source-checkout.md) —— 源码启动 harness 需要的 `file:` shim。
- [docs/optimization-backlog.md](docs/optimization-backlog.md) —— 已知问题与优化清单。
- [docs/proposals/](docs/proposals/) —— 提交给主仓的提案。

## License

MIT
