# 托管引擎共享层：driver-core、路由器与会话命令面

**目标读者**：要修改 `src/driver-core/`、`src/router-loop.ts`、`src/engine-surface.ts`、`src/skills.ts`、`src/commands.ts` 的工程师。本文讲清每个共享模块解决什么问题、契约是什么、四个引擎各自怎么用、改它会波及谁。**引擎按会话并发**（进程内唯一的路由器按会话把 create/resume 分派给各引擎运行时）是当前结构的前提：§4 与 §10–§12 讲这套结构与它带来的模块，§5–§7 讲引擎无关的共享设施，§8–§9 是改动影响矩阵与测试要点。所有论断均标注源码位置，可逐条核实。

## 1. 共享层定位

dsh-loop-engine 的四个托管引擎驱动（`src/engine-claude`、`src/engine-codex`、`src/engine-pi`、`src/engine-kimi`）面向四种完全不同的外部进程：

- **claude**：Claude Agent SDK 的 `query()`，自带权限回调与技能目录；
- **codex**：Codex app-server JSON-RPC，权限是线程启动时声明的 `sandboxMode + approvalPolicy` 对；
- **pi**：`pi --mode rpc` 严格 LF JSONL，没有任何原生权限系统，整个子进程靠 dsh 沙箱包裹；
- **kimi**：`kimi acp` 子进程，权限以 ACP 反向 RPC `session/request_permission` 回调形式出现。

引擎之间的差异集中在**传输层、权限映射、上下文文件策略、技能 provider** 四件事上，这四件事都留在各引擎自己的目录里。而下面这些设施要么四个引擎完全一致，要么与引擎无关，一律抽到 `src/driver-core/`：

| 模块 | 解决的问题 |
|---|---|
| `prompt.ts` | 把持久会话日志序列化成一次托管查询的 prompt 文本 |
| `permission-knobs.ts` | 从会话日志折叠出 dsh 的沙箱/审批旋钮 |
| `ownership.ts` | 工厂所有权、活体 agent 跟踪、setup 与中止信号的竞速（**原语**） |
| `hosted-engine-runtime.ts` | 把上面的原语编排成 create/resume 的 prepare→setup→publish **事务**（四个引擎共用一份；引擎差异只剩配置与 `buildAgent` 一个抽象方法），并给每个托管引擎一个进程内的**引擎运行时**对象——普通类，不是 cordis Service，不占 AgentFactory 槽位（槽位归路由器，见 §4、§10） |
| `session-lifetime.ts` | 一个活会话的生命周期资源（在 `ctx.sessions` store 里的条目 + 存放它事件的写句柄）由**哪个 agent 持有**：原地换手时整个对象从旧机器交到继任者手里，所以会话不会离开 `ctx.sessions`，也就不会发出 `session/disposed`（见 §4） |
| `inbox.ts` | 驱动自有的 durable 收件箱：从会话自己的 `agent/inbox/spliced` 事件折叠待处理输入，每次改动先落日志再改内存列表 |
| `assistant-stream.ts` | 一次流式尝试的 live 帧发布（`agent/assistant-stream` 的 start/chunk/end）、交给 durable `assistant/message` 的精确计时 stream 压缩，以及按内容边界切分该 stream 的 `takeStream()` |
| `hosted-tool-vocabulary.ts` | 把托管引擎的工具名与参数归一化到 dsh 词汇（同一组值喂给 `tool/call` 事件与 assistant 消息的 `tool-call` block），并抽出计划工具的 `todo/write` 列表 |
| `context-files.ts` | 从会话 cwd 向上走到 git root 的上下文文件发现与读取 |
| `skill-inject.ts` | 复刻 dsh `/name` 技能手势扫描与 `<skill_content>` 渲染 |
| `agents-md-skill-provider.ts` | "逐目录指令文件 + 技能目录"这套发现的**算法**，由各引擎用一份数据 spec 参数化 |
| `host-servers.ts` | 插件消费的宿主服务（命令 / 技能 / preset 花名册 / settings 变更 / llm / 会话投影）的**结构化最小切片**，见 §12 |

非 `driver-core/` 目录下的共享层还有四个文件：`src/router-loop.ts`（进程内唯一的 AgentFactory，按会话把 create/resume 分派给引擎运行时，见 §10）、`src/engine-surface.ts`（在 agent 自己的 scope 上注册引擎的斜杠命令与技能 provider，见 §11）、`src/skills.ts`（Claude Code 技能 provider + 被各引擎 provider 复用的 `parseSkillFile` 与类型镜像）和 `src/commands.ts`（斜杠命令转发桥 + 被 kimi 复用的命令类型）。

> **注意**：driver-core 各文件的头部注释原先大多写着 "Both the Claude Code and Codex drivers"，那是 kimi/pi 引擎加入前的旧表述，实际四个引擎都在用；按会话并发多引擎重构后，另有一批注释仍按"进程内只有这一个托管工厂、引擎是全局选择"的旧架构写（`ownership.ts` 的模块头、`hosted-engine-runtime.ts:182` 的 jscpd 注释，以及四个 `src/engine-*/loop.ts` 模块头的 "constructs this factory when the … engine is selected"）——**这批现已订正**，模块头与同文件的子类 docstring 不再并存两种说法（订正内容见文末附录 §B）。driver-core 侧真正仍待订正的，只有附录 §A 里那两条 kimi/pi 时代的旧表述。

## 2. prompt.ts：每步 prompt 的组装契约

### 解决什么问题

托管引擎每次查询都是**无状态**的：外部 CLI 看不到 dsh 的会话历史，必须把历史塞进当次 prompt。同时 dsh 有一条硬约束——"模型可见 ⟺ 已落日志"（Model-visible ⟺ logged），所以 prompt 必须是会话日志的**精确投影**：同一份日志重放必须得到逐字节相同的 prompt（`src/driver-core/prompt.ts:1-15` 的模块头注，`serializeHistory` 是"日志前缀的纯函数"，`src/driver-core/prompt.ts:140-149`）。

### 契约

`serializeHistory(messages)`（`src/driver-core/prompt.ts:150`）接收 `Session.deriveMessages()` 在步进时刻派生的消息序列（最旧在前，最后一条是触发本步的用户请求），返回纯文本。序列化规则：

- 每条消息用 `<role>...</role>` 框架包裹（`frame`，`src/driver-core/prompt.ts:35`），段落间以 `\n\n` 连接；
- **assistant**：text 块逐字输出；tool-call 块压缩成一行 `[tool call: name(args)]`（`src/driver-core/prompt.ts:55`）；image 块替换为占位文本 `OMITTED_IMAGE_TEXT`（`src/driver-core/prompt.ts:26-27`）；**reasoning 块不转写**——每个引擎在每次全新查询里自己重新推导思考（`src/driver-core/prompt.ts:60-62`）；
- **user（source.kind 为 'tool'）**：走 `renderToolResult`（`src/driver-core/prompt.ts:74`），失败调用标为 `<tool-result-error>`，成功为 `<tool-result>`（`src/driver-core/prompt.ts:86`）；正文为空时输出 `(no content)`（`src/driver-core/prompt.ts:87`）；
- **user（其他 source）**：text 逐字、image 替换占位文本，空正文同样兜底 `(no content)`（`src/driver-core/prompt.ts:164-175`）；
- **system 角色**：不进派生会话面，直接跳过（`src/driver-core/prompt.ts:178-180`）；
- assistant 正文为空的整条消息不进 transcript（`src/driver-core/prompt.ts:156`）。

### 斜杠命令步：`engineSlashPrompt`

框架本身会吃掉引擎自己的命令面：四家的 slash 展开都只看**开头**——Kimi 的 ACP 适配器只看首个 prompt block 是否 `startsWith('/')`，Claude Code 的本地命令派发（`rCb` 里 `F.startsWith("/")` → `processSlashCommand`）与 Pi 的输入展开（`text.startsWith("/")` / `startsWith("/skill:")` / prompt template）同理。而转录文本以 `<user>` 开头，于是转发回来的 `/status` 会被当成散文交给模型（实测：Kimi 侧模型开始猜"用户是不是打了斜杠命令"）。

`engineSlashPrompt(messages)`（`src/driver-core/prompt.ts:122`）就是把这一步认出来：**最后一条消息**是 `source.kind === 'user'` 的直接用户消息、只含一个 text 块、无换行、且整条匹配 `ENGINE_SLASH_LINE`（`/name` 加可选同行参数，名字里不含空白与 `/`，所以 `/etc/hosts`、`//server/share`、单独的 `/` 都不算）时，返回该行原文；否则返回 `undefined`。三个 driver 的取值方式一致：

```ts
const prompt = engineSlashPrompt(history) ?? serializeHistory(history)
```

- `src/engine-claude/agent.ts:532`
- `src/engine-pi/agent.ts:609`
- `src/engine-kimi/agent.ts:550`

命中时本步的 prompt 就是那一行：**不带 `<user>` 框架、也不回放历史**——斜杠命令是引擎的控制行，不是给模型的对话。它仍然只由日志前缀决定，所以投影约束不破。被注入的技能内容（`skill-inject.ts` 落成一条 `skill-invocation` 用户消息）会顶掉"最后一条"，于是那一步照常走转录路径——用户显式调用的技能优先。

codex **不使用**这条路径：app-server 协议没有文本斜杠面（`turn/start` 的 `UserInput` 只有 text/image/localAudio/skill/mention，压缩是独立 RPC `thread/compact/start`），传裸行只会平白丢掉上下文。见 `docs/engine-codex.md`。

### 哪些引擎怎么用

四个 agent 都先取 `this.session.deriveMessages()`，再组装 prompt，空 prompt 抛错（v8-ignore 的兜底分支）。claude/pi/kimi 走 `engineSlashPrompt(history) ?? serializeHistory(history)`（见上一节），codex 仍只用 `serializeHistory(history)`：

- `src/engine-claude/agent.ts:528-532`
- `src/engine-codex/agent.ts:623-624`
- `src/engine-pi/agent.ts:606-609`
- `src/engine-kimi/agent.ts:547-550`

kimi 额外把 prompt 发送本身包进 `raceAbort`（`src/engine-kimi/agent.ts:581`），因为 ACP prompt 是一个需要等响应帧的 RPC。

### 改它会波及谁

这是共享层里**爆炸半径最大**的模块：序列化格式的任何改动（标签名、tool-call 行格式、占位文本、空正文兜底）都会同时改变四个引擎发给模型的每一段 prompt。修改前必须先想清楚：外部 CLI 对同一份历史是否有自己的展开逻辑（例如 Claude Code CLI 对 `/name` 的原生展开与这里的 skill 注入文本是否会叠加）——`engineSlashPrompt` 就是这条边界上补的一刀。测试上 `serializeHistory` 由 `tests/engine-claude/mapping.spec.ts` 直接 import（`tests/engine-claude/mapping.spec.ts:19`）并间接被四个 `tests/engine-*/agent.spec.ts` 的步进路径覆盖；`engineSlashPrompt` 由 `tests/driver-core/prompt.spec.ts` 覆盖，三个引擎各有一步"命令行走裸行、下一步回到转录"的步进用例。

## 3. permission-knobs.ts：会话权限旋钮的统一读取

### 解决什么问题

dsh web 的权限预设（只读 / 工作区可写 / 完全放开 × ask / never）以 `sandbox/mode` 与 `approval/policy` 事件的形式**钉在会话日志里**：创建时写入，每次切换再记一条。四个引擎都需要把"当前生效的旋钮"折叠出来，且中途切换必须即时生效——所以读取必须每次查询都从日志重扫，而不是缓存。

### 契约

- `sessionSandboxMode(events)` / `sessionApprovalPolicy(events)`（`src/driver-core/permission-knobs.ts:29`、`:40`）：**从后往前**扫描，取最后一条对应事件的 `data.mode` / `data.policy`；值不在合法枚举内（含日志里从未出现过）一律返回 `undefined`，把回退语义留给调用方；
- 合法枚举内联镜像在本文件里（`DshSandboxMode` / `DshApprovalPolicy`，`src/driver-core/permission-knobs.ts:20`、`:23`），刻意不引 `@deepseek-ai/dsh-sandbox-policy` / `dsh-user-approval` 这两个 peer；
- 输入类型 `PermissionEvent` 是最小结构形状（`Pick<SessionEvent, 'data'> & { type: string }`，`src/driver-core/permission-knobs.ts:12-17`），因为本编译单元的 `SessionEvent` 联合类型不带 sandbox/approval 包的增强键，折叠直接读线上形状。

### 各引擎的回退语义（同一旋钮，四种映射）

| 引擎 | 映射位置 | full-access | ask | 无旋钮/其他 |
|---|---|---|---|---|
| claude | `src/engine-claude/permission.ts:33-37` | `bypass` | `ask`（转发 dsh 审批缝） | `deny`（无人值守默认全拒） |
| codex | `src/engine-codex/permission.ts:145-153` | `danger-full-access` + `never` | `workspace-write` + `on-request` | `read-only` + `never`（`DEFAULT_CODEX_PERMISSION`，`:35-38`） |
| pi | `src/engine-pi/permission.ts:67-80` | 不剪 `--tools`，不包沙箱 | **降级为 read-only 拒绝**（pi 无审批回调） | `read-only` + 只读工具集（`DEFAULT_PI_PERMISSION`，`:36-39`；`--tools` 派生见 `toolsForSandbox`，`:54-62`） |
| kimi | `src/engine-kimi/permission.ts:30-31` | 不查 sandbox 旋钮 | `ask` → 拒绝 | 其他（`never`/无旋钮）→ 自动批准 |

claude 还有一个**部署级覆盖**：`cordis.yml` 里钉死的 `config.permissionMode` 直接赢过会话旋钮（`src/engine-claude/agent.ts:370-371`）。kimi 不读 sandbox 旋钮是刻意的——Kimi 自己的工具策略约束工具能做什么，ACP 审批是宿主侧闸门，只由 `approval/policy` 信号驱动（`src/engine-kimi/permission.ts:22-27` 的头注）。

### 改它会波及谁

改读取逻辑（比如换成"取第一条"或放宽枚举校验）会同时改变四个引擎每一次查询的权限立场——这是安全相关代码，"无旋钮时失败闭合"是所有引擎共同的底线，任何让它变得宽松的改动都需要逐引擎重新论证。新增旋钮（比如第三种 sandbox mode）要同步改 `SANDBOX_MODES` 常量（`src/driver-core/permission-knobs.ts:25`）并审查四个 permission 模块的 switch 是否出现静默落空。

## 4. ownership.ts + hosted-engine-runtime.ts：所有权、事务与引擎运行时

### 解决什么问题

dsh 里**恰好只有一个工厂**能占住 `AgentFactory` 槽位（第二次注册抛 `an agent factory is already registered`，`../deepseek-harness/packages/core/agent/src/index.ts:355-356`）。按会话并发多引擎之后，占槽位的是**路由器**（`src/router-loop.ts`，见 §10），它同时服务 `in-process` 会话；每个托管引擎则是路由器持有的一份**引擎运行时**（`HostedEngineRuntime`，见本节「事务机制只有一个实现」）。所有权被判定的对象因此从一个"全局工厂"变成"一进程一路由器 + 每引擎一份运行时"，但**并发问题一条都没少**：

1. 一个引擎运行时被卸载（插件卸载就是全部运行时一起卸载）时，还在进行中的 `create/resume` setup 必须立刻被中止；
2. 已发布的活体 agent 必须全部 teardown 完毕后，该运行时的 dispose 才能返回；
3. setup 中途 fiber 状态已变（UNLOADING/DISPOSED/FAILED）时，新的创建请求必须被拒绝。

`FactoryOwnership`（`src/driver-core/ownership.ts:41`）就是这三件事的统一答案，`raceAbort` / `raceAbortCall` 处理"setup await 与融合中止信号竞速"。harness 自己的 `AgentLoop` 内有一份同形的私有实现（`../deepseek-harness/packages/core/agent-loop/src/index.ts:97`，`:417` 构造），负责 `in-process` 那条路径与声明式 agent 的启动；那个类没有导出，插件无法复用，因此托管引擎这一侧保留了同款原语（`src/driver-core/ownership.ts` 是独立一份，行为对齐而不是 import 复用）。

### 契约

- `INACTIVE_STATES`（`src/driver-core/ownership.ts:34-38`）：`UNLOADING | DISPOSED | FAILED` 三种 fiber 状态不能拥有或服务新生命周期；cordis 的 `FiberState` 是 `const enum`（`vendor/cordis/src/fiber.ts:147`），打包发布时会内联抹掉、不再有运行时导出，因此这里用本地数字常量镜像这三个状态（`FAILED 3`、`DISPOSED 4`、`UNLOADING 5`），**不能**从 `@deepseek-ai/cordis` 值导入 `FiberState`——否则插件树加载会报 `does not provide an export named 'FiberState'`（见 `src/driver-core/ownership.ts:17-31`）；
- `isActive()`（`:55-57`）：`accepting` 标志与 fiber 状态双判；
- `signal`（`:51-53`）：运行时级中止信号，`dispose()` 一开始就以 `agent loop is not active` 错误 abort（`:77-85`）；引擎运行时把它并进 prepare 的融合中止信号（`src/driver-core/hosted-engine-runtime.ts:205-207`），resume 路径则把它直接并进 `AbortSignal.any([...])`（`:503`）；
- `track(dispose)`（`:60-63`）：登记一个活体 agent 的 teardown，返回反注册函数；
- `trackStartup(job)`（`:66-70`）/ `trackWrapper(job)`（`:73-75`）：把 agent 尚未存在前的配置启动工作、以及 create/resume 的发布延续挂进运行时，dispose 会等它们全部 settle；
- `dispose()`（`:77-85`）：先关门（`accepting = false` + abort），再并发等待所有活体 agent teardown 与启动任务；
- `raceAbort(operation, signal, id)`（`:89-105`）：operation 与 signal 竞速，abort 时抛出 signal 的 reason（非 Error 时包装成 `agent "<id>" creation aborted`）；
- `raceAbortCall(..., releaseAbandoned)`（`:107-128`）：额外处理"operation 在取消后才产出值"的孤儿资源——取消后仍 then 一次 `releaseAbandoned` 释放它（典型场景：子进程/连接在取消后恰好建好了）。
- 引擎运行时直接调用 harness 的 `SessionPersistence` **单签名** seam：新建走 `persistence.create(session.header, { inheritedEventCount, signal })`（`src/driver-core/hosted-engine-runtime.ts:415-418`），恢复走 `persistence.open(id, 'write', { signal })` 拿 `SessionHandle`，`handle.read(0, undefined, { signal })` 返回 `{ eventState, events }`，再交给 `sessions.prepare(id, { seed, meta, inheritedEventCount, eventState })`（`src/driver-core/hosted-engine-runtime.ts:510-530`）。

### 事务机制只有一个实现：hosted-engine-runtime.ts

`ownership.ts` 提供**原语**；把原语编排成"prepare → setup → publish"、以及 create/resume 两条入口的**事务**，原先在四个 `src/engine-*/loop.ts` 里各写了一遍（每份约 325 行、claude↔pi 归一化相似度 97.6%）。现在只有一份：`src/driver-core/hosted-engine-runtime.ts` 的 `HostedEngineRuntime<TConfig, TAgent>`（`:132`）——文件名与类名都由 `hosted-loop-factory.ts` / `HostedLoopFactory` 改来，"factory" 这个名字不再准确，因为它已经不占工厂槽位了。

它把引擎差异压缩到两个点，都由子类提供：

| 引擎差异 | 提供方式 |
|---|---|
| 自省标签 + 全部 effect label 前缀 | 构造参数 `label`（`agentLoopClaudeCode` / `agentLoopCodex` / `agentLoopPi` / `agentLoopKimi`）；label 拼出 `<label>.transactions()`、`<label>.lifecycle(id)`、`<label>.resume-load(id)` |
| 驱动构造 | 抽象方法 `buildAgent(loopCtx, id, options, session)`（`:169`），四个子类各三行 |

`buildAgent` 是**唯一**的协议接缝——引擎特有的 spawn/argv 等全部由子类在构造闭包里捕获（pi 的 `spawn`/`bin`、kimi 的 `spawn` 即如此），共享体一行都不碰引擎协议。子类**不再**声明 `static inject`（见下）。

#### 所有权模型（按会话并发多引擎之后）

> 下面几条里未标注文件的行号均指 `src/driver-core/hosted-engine-runtime.ts`（本条讨论的对象），标注了文件名的按标注读。

- **它不再是 cordis Service。** `HostedEngineRuntime` 是普通抽象类：不 `extends Service`、全仓 `grep -rn "static inject" src/` 为空、构造时**不**调 `ctx.agents.setFactory`、**不**注册 `provider`/`model`/`cwd` 这三个 system-prompt 变量。这些全部由路由器继承的 harness `AgentLoop` 提供：`static inject`（`../deepseek-harness/packages/core/agent-loop/src/index.ts:360`）、`setFactory` effect（`:420`）、三个 prompt 变量（`:421-423`）、`turnBoundary` 投影注册（`:416`）、`agent-loop` settings section（`:401`）。缺宿主服务时改用 `ctx.get` 惰性取——kimi 就是这样拿 `subprocess` 的（`src/engine-kimi/loop.ts:83-86`，取不到就抛，只让选中该引擎的那个会话失败）。
- **但仍在构造时暴露自省面。** `ctx.reflect.provide(label, this)`（`src/driver-core/hosted-engine-runtime.ts:155`），所以 `ctx.agentLoopKimi` / `agentLoopCodex` / `agentLoopPi` / `agentLoopClaudeCode` 依旧可用（标签常量 `KIMI_ENGINE_LABEL` 等，`src/engine-kimi/loop.ts:58`）。这不是 AgentFactory 注册（槽位归路由器），只是"这个进程真建了哪些驱动"的自省面：per-engine spec 与 `--dump-config` 读者用它。
- **每个引擎运行时一份 ownership**，不是"每个 factory 一份"。构造时 `new FactoryOwnership(ctx.fiber)`（`:149`），然后以 `<label>.transactions()` 为 label 注册 effect：`ctx.effect(() => () => this.ownership.dispose(), …)`（`:161`）。触发 teardown 的是**构造这个运行时所用 ctx 的 fiber**：路由器把 builder 绑在自己的 inject fiber 上（`src/index.ts:588-615` 的 inject gate，构造分支在 `buildEngine`，`:557-568`），运行时由它在第一次有会话用到该引擎时惰性构造并常驻（`src/router-loop.ts:226-232`），所以**插件卸载 = 路由器卸载 = 全部托管引擎全量回收**——活体 agent 逐个 teardown，未完成的 create/resume 延续一起 settle。
- **单个会话的 agent 不走 ownership 全量回收**：路由器按 handle 单独 dispose（`src/router-loop.ts:245-264` 包一层 `handle.dispose()` 并先抹掉自己的账），这是换引擎（空白期与运行中）唯一需要的回收粒度（见 §10）。运行时的 ownership 只管兜底集合——它名下所有还活着的 agent（`prepare` 里 `this.ownership.track(dispose)`，`:251`）。
- 因此"dispose 会拆掉该 factory 名下全部 agent"这句话要按新粒度读两遍：**运行时 dispose = 该引擎名下全部 agent**（全量，只在插件卸载时发生）；**单个 agent 的回收 = 路由器按 handle 做**（会话级，见 §10）。

#### 会话侧的那一半：`SessionLifetime`

一次发布产出两半资源：**agent 那一半**（registry 条目、scope、收件箱、子进程）归引擎运行时，**会话那一半**——会话在 `ctx.sessions` store 里的条目、以及存放它事件的写句柄——归 `SessionLifetime`（`src/driver-core/session-lifetime.ts:35`）。抽成一个对象而不是事务里的两个闭包变量，是因为**原地换手要把它整个搬走**：`swap` 不释放会话，旧机器的 `retire()` 只停掉自己、从 agent registry 摘掉自己，store 条目与写句柄随这个对象交给继任者，由继任者按"我就是那个进入这条会话的 agent"的方式在以后释放。

三个动作各有分工：

- `bind(detach)`（`:66-68`）把进入 store 换来的 disposer 记在对象上，`entered`（`:57-59`）因此能回答"这条会话已经被某台机器进入过了吗"——`publish` 用它决定要不要再调 `sessions.enter` / `sessions.announce`（两者对已活的 id / 已 announce 的条目都直接抛）；
- `closeHandle()`（`:71-73`）排空并关闭写句柄，是离开 store 之前的 durability 屏障；
- `leaveStore()`（`:76-78`）才把会话摘出 store，并发出配对的 disposal。

顺序也是契约：句柄先关、agent 后摘、最后离开 store。写句柄**必须**跟着会话走，不能在换手点关掉——后端按 sessionId 只认一个 writer，会话还活着就把句柄关掉，下一次 `open` 会被拒绝。`retire()` / `swap()`（`src/driver-core/hosted-engine-runtime.ts:274-279`、`:468-483`）正是这对动作的两半：前者置位 `handedOver`（`:213`），让 teardown 跳过 `closeHandle()` 与 `leaveStore()`（`:236`、`:242`）；后者把**同一个 `Session` 对象**交给新引擎的 `prepare`，`publish` 里 `joining = lifetime.entered`（`:294`）为真时只做 agent 那一半发布。

### 哪些引擎怎么用

四个子类现在各自只剩「docstring + 配置 + 一个三行子类」，且都由路由器的 builder 构造（`src/index.ts:557-568`），不再作为 cordis 行挂载：claude `src/engine-claude/loop.ts:96`、codex `src/engine-codex/loop.ts:90`、pi `src/engine-pi/loop.ts:149`、kimi `src/engine-kimi/loop.ts:71`。下表是共享体里的调用点（唯一一份，四个引擎共用）：

| 调用点 | 位置（`src/driver-core/hosted-engine-runtime.ts`） |
|---|---|
| 构造 `FactoryOwnership` | `:149` |
| fiber effect 里 dispose | `:161` |
| prepare 入口 `isActive()` 守门 | `:187`（resume 侧同款在 `:537`） |
| runtime 中止信号并进 prepare 融合信号 | `:205-207`（resume 侧在 `:503` 的 `AbortSignal.any([...])`） |
| `track(dispose)` | `:251` |
| owner effect `lifecycle(id)` | `:254-258` |
| `trackWrapper(published)` | `:397`（create）/ `:557`（resume） |
| setup `raceAbort` | `:339` |
| resume 加载 `raceAbortCall` | `:510` |
| `persistence.create` | `:415-418` |
| `persistence.open` + `handle.read` + `sessions.prepare` | `:510-530` |

kimi agent 在步进路径上还单独用了一次 `raceAbort` 等 ACP prompt 响应（`src/engine-kimi/agent.ts:581`）。

### 改它会波及谁

`ownership.ts` 的 128 行是**原语**；真正的编排在 `hosted-engine-runtime.ts`（共享体约 380 行，`:183-560`），四个引擎的生命周期正确性全部压在这两份文件上。任何判定时序的变化（比如 `dispose()` 里 abort 与等待的顺序、`isActive()` 的双判条件）**同时**改变四个引擎的行为——这正是它现在只有一份的原因。改完必须跑 kimi/pi 的 `tests/engine-*/loop.spec.ts`、claude/codex 落在各自 `tests/engine-*/index.spec.ts` 里的挂载与中途卸载场景，以及 `tests/router-loop.spec.ts`（路由器分派给运行时的契约，§10）。注意 `dispose()` 里的错误文案 `agent loop is not active` 同时被守门分支复用（`src/driver-core/hosted-engine-runtime.ts:187`、`:537`），改文案要全局搜。

**新增一个引擎时**：写一个 `extends HostedEngineRuntime<ResolvedConfig, XAgent>` 的子类，给出 label、配置解析、`buildAgent` 三件事即可，**不要**再复制事务体——`package.json` 的 `files` 与构建产物都会跟着涨，而事务体的正确性只需要维护一次。另外三处会自动或强制跟上：`src/agent-preset-ids.ts:27` 的 `LOOP_ENGINE_IDS` 加 id 后 `HOSTED_ENGINE_IDS`（`:36-38`）、per-engine preset 的 authoring（`ensureEnginePresets` 按 `HOSTED_ENGINE_IDS` 循环，`src/preset.ts:200`）与 `engineOfPreset`（`src/agent-preset-ids.ts:119-125`）都自动生效；`src/engine-surface.ts` 的 `SURFACES` 是 `Record<HostedEngineId, EngineSurface>`，新引擎不加一份就会编译报错（这是刻意的，命令/技能面必须显式声明）；最后在 `src/index.ts:557-568` 的 `buildEngine` 加一个分支。

## 5. inbox.ts / assistant-stream.ts：驱动自有的收件箱与流式尝试

### 解决什么问题

harness 0.1.5 把两件原本由 `dsh-agent` 提供的东西收了回去：`Inbox` 从具体类变成**由驱动自己实现的接口**；逐 chunk 落盘的 session 事件 `assistant/chunk` 被删除，改为 `assistant/message` 内嵌精确计时的 `stream`，且该消息禁止再带 `sourceEventSeqs`。托管引擎的 agent 不继承 harness loop，而 `@deepseek-ai/dsh-agent-loop` 的公开面只有 `.`（loop 插件）与 `./invariant` 两个子路径（`../deepseek-harness/packages/core/agent-loop/package.json` 的 `exports`），它内部那套 Inbox / assistant-stream 实现拿不到，所以这两件事在驱动层自建。

### 契约

- `DriverInbox`（`src/driver-core/inbox.ts:38`）实现 harness 的 `Inbox` 接口：读取面是 `nextTurn` / `nextStep` / `hasPending`（`src/driver-core/inbox.ts:56-68`），变更面是 `clear` / `claim` / `append` / `prepend` / `replace` / `remove` / `splice`（`:71-158`）。构造时重放本会话已有的 `agent/inbox/spliced` 事件（`:45-53`）；每次变更先 `session.append('agent/inbox/spliced', …)` 把归一化后的 splice **落盘**，再改内存列表并发出 live 通知（`:170-205`）——web 会话 reducer 与 session resume 都读这份持久事件流，所以语义与 harness 移除的那个类逐字对齐。持久 splice 非法时直接抛错：坐标越界抛 `invalid inbox splice`（`:218-221`），重复 id 抛 `message "<id>" is already pending`（`:223-230`）。
- `DriverAssistantStream`（`src/driver-core/assistant-stream.ts:32`）框住**一次流式尝试**：`start()` 发 `agent/assistant-stream` 的 `start` 帧（`:61-69`）；`push(chunk)` 给 chunk 打时间戳、喂进 `AssistantStreamAccumulator` 并发 `chunk` 帧（`:72-82`）；`stream` getter 交出 compact stream 快照（`:85-87`）；`takeStream()` 关掉当前 record run 并把这段 stream 返回，后续 chunk 落进新的一段（`:97-101`）——协议能标出内容分段的引擎（codex）就在每个边界切一刀，使每条 durable 消息只内嵌自己流出的那段 chunk，而 live 帧仍走同一个 attempt。收尾二选一：`settle(append)` 在 durable 事件提交**之后**发 `end`（`committed`，带回落盘事件的类型与 seq，`:107-123`）；提交失败或整段没有 durable 落点则 `abandon()` 发 `end`（`abandoned`，`:126-135`）。它只发帧与压缩，**不组装内容块**——每个引擎仍从自己的协议组装权威转录。

### 哪些引擎怎么用

四个 agent 的调用方式高度一致（差异只有下面点出的两处）；下表路径均指各引擎目录下的 `src/engine-*/agent.ts`：

| 用途 | claude | codex | pi | kimi |
|---|---|---|---|---|
| 构造 `DriverInbox` | agent.ts:151-155 | agent.ts:179-189 | agent.ts:156-160 | agent.ts:149-153 |
| 开一次流式尝试（`new DriverAssistantStream` + `start()`） | agent.ts:573-580 | agent.ts:698-705 | agent.ts:643-650 | agent.ts:765-772 |
| chunk 入流 | agent.ts:622 | agent.ts:785-787 | agent.ts:844-848 | agent.ts:686-698 |
| 写 `assistant/message` 并 `settle` | agent.ts:680-682 | agent.ts:741-743 | agent.ts:715-717 | agent.ts:843-845 |
| 段尾 `abandon()` | agent.ts:782 | agent.ts:937 | agent.ts:935 | agent.ts:609 |

kimi 是唯一把 flush 抽成独立方法的引擎，也是唯一**按 phase 惰性打开流尝试**的引擎：`currentStream(phase)`（`src/engine-kimi/agent.ts:763-775`）在第一个 chunk 到达时建 `DriverAssistantStream` 并 `start()`，`flushSegment`（`:756-764`）与它调用的 `flushAssistant`（`:781-820`）负责收尾，段与段之间把 `this.live` 置空。codex 是唯一在内容分段边界调用 `takeStream()` 的引擎：`item-completed` 在推理 item 与正文 item 结束时各切一刀（`src/engine-codex/agent.ts:831`、`:820`），plan item 结束时也切一刀但这段 chunk 直接丢弃（plan 没有内容块，`:811`），`HeldMessage.stream` 装的就是这一段自己的 chunk；claude / pi / kimi 不切段，整段尝试的 `attempt.stream` 一起内嵌。

### 改它会波及谁

`inbox.ts` 的改动落在**会话并发语义**上：`claim` 的批次顺序、`splice` 的归一化坐标、以及"先落盘再改内存"的次序都由 `agent/inbox/spliced` 的持久流承载，而 web reducer 与 resume 都从该流重建，回滚或重放时的可见性因此同时受四个引擎的 followup/steer/inject 路径影响。`assistant-stream.ts` 的改动则同时改变四条流式路径的 live 帧节奏与内嵌 stream 内容——它是"web 实时 partial"与"replay 还原 partial"两条链路的唯一交汇点；改帧序或压缩规则必须让四个 `tests/engine-*/agent.spec.ts` 与 `tests/driver-core/assistant-stream.spec.ts` 一起过。

## 6. context-files.ts：上下文文件的发现与加载

### 解决什么问题

codex / pi / kimi 都读"从会话 cwd 向上走到 git root，每目录一个指令文件"这套约定（AGENTS.md 系），但每个引擎接受的文件名与覆盖规则不同。这个模块把**目录链行走**与**每目录选文件策略**分开：前者共享，后者由各引擎以 `ContextFilePolicy` 声明。

### 契约

- `ContextFilePolicy`（`src/driver-core/context-files.ts:20-25`）：`override`（可选，存在即顶替）+ `primary`（按序尝试直到命中）；**每个目录最多贡献一个文件**（`dirContextFile`，`:62-72`）；
- `projectAncestors(cwd)`（`:34-43`）：目录链从 cwd 到 git root、**最近的在前**；git root 判定复用 `src/skills.ts` 的 `findProjectRoot`（向上找 `.git`，找不到回退为入参 cwd 本身，`src/skills.ts:336-348`）——没有仓库时链上只有 cwd，保证行走有界；
- `collectProjectContextFiles(cwd, policy)`（`:52-59`）：沿链收集存在的上下文文件，最近目录优先；
- 正文加载助手（`:89-133`）：`readOptionalFile`（读不到返回 `undefined`，不抛）；`anySourceNonEmpty` / `fileNonEmpty`（存在且 trim 后非空白）；`readSources`（按序拼接所有非空正文，`\n\n` 分隔，全部读不到返回 `undefined`）。

### 各引擎的策略

| 引擎 | 策略声明（spec 的 `contextPolicy`） | 用户级补充（spec 的 `userContext`） |
|---|---|---|
| codex | `{ primary: ['AGENTS.md'] }`，无 override（`src/engine-codex/skills.ts:30`） | `{ file: 'AGENTS.md', rank: 160 }`，在 `userDir: () => ~/.codex` 下（`src/engine-codex/skills.ts:33-40`） |
| pi | `{ override: 'AGENTS.override.md', primary: ['AGENTS.md', 'CLAUDE.md'] }`（`src/engine-pi/skills.ts:43-46`） | `{ file: 'AGENTS.md', rank: 160 }`，在 `piAgentDir()`（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）下（`src/engine-pi/skills.ts:53-58`、`:66`） |
| kimi | `{ primary: ['AGENTS.md'] }`（`src/engine-kimi/skills.ts:46-48`） | **没有**：kimi 的 spec 不带 `userContext`，`list()` 只用项目链（`src/engine-kimi/skills.ts:62-73`） |

claude **不用**这个模块：CLAUDE.md 由 `ClaudeCodeSkillProvider` 按"带 frontmatter 才算技能"的另一套逻辑处理（见下节）。

### 改它会波及谁

- 改 `projectAncestors` / `collectProjectContextFiles` 的行走语义 → 影响 codex、pi、kimi 三个 provider 的项目级发现范围；
- 改 `readSources` 的拼接分隔符或空文件过滤 → 影响三个引擎 `agents-md` 技能的最终正文（会被 `renderSkillContent` 包进 prompt）；
- `ContextFilePolicy` 加字段是安全的（各引擎用 `satisfies` 声明），但改 `dirContextFile` 的"每目录一个文件"上限是结构性变化，要同时审三个 provider 的 candidate 构造；
- 注意它 import 了 `src/skills.ts` 的 `findProjectRoot`（`src/driver-core/context-files.ts:17`），两个文件存在**反向依赖**：改 `findProjectRoot` 的回退行为同时影响 claude 技能锚定和三个引擎的目录链。

## 7. skill-inject.ts + skills.ts + commands.ts：技能与斜杠命令接缝

### 7.1 skill-inject.ts：为什么托管引擎要自己复刻 `/name`

进程内引擎的技能注入由 dsh-tool-skill 的 handler 完成，但它挂在 agent-preset 上下文链上，而托管引擎 agent 的上下文**不从那条链派生**（`src/driver-core/skill-inject.ts:1-8` 头注；claude agent 里也有同样的注释，`src/engine-claude/agent.ts:313-316`）。所以四个 agent 各自复制同一段注入流程，共享部分抽在这里：

- `SKILL_GESTURE`（`:18`）：空白边界的 `/name` 手势正则，name 必须 kebab-case（`SKILL_NAME_RE`，`:15`）；
- `invokedSkillNames(messages)`（`:84-97`）：只扫 `source.kind === 'user'` 的消息文本块，按首次出现顺序去重——**tool 结果、技能注入消息自身不会被递归扫描**；
- `renderSkillContent(skill)`（`:67-81`）：渲染 `<skill_content>` XML；`resourceBase.kind === 'directory'` 时写明基目录让模型自行解析相对路径，否则声明资源由 provider 管理；`escapeText` / `escapeAttr`（`:57-64`）防注入；
- `SkillInvocationSource`（`:38-42`）+ `MessageSourceMap` 模块增强（`:44-49`）：注入的消息带持久 source `{ kind: 'skill-invocation', name, form: 'instructions' }`，镜像 dsh-skill 的线上形状，保证重放时能被识别。

四个 agent 的 `injectSkills` 逐字一致（claude `src/engine-claude/agent.ts:333-359`；codex `:444-470`；pi `:352-378`；kimi `src/engine-kimi/agent.ts:340-366`）：从 `loopCtx` 取 `skills` 服务（`SkillsService` 最小形状，`:52-54`），逐个 `skills.get(name, { cwd, signal, scope: this })`，加载失败静默跳过、`userInvocable === false` 跳过、中途 abort 整批放弃返回原消息，最后把注入消息**追加**到本步消息批末尾。

### 7.2 skills.ts：ClaudeCodeSkillProvider 与各引擎 provider 的共性

`src/skills.ts` 有三重身份：

1. **类型镜像源头**：`SkillCandidate` / `SkillProvider` / `SkillProviderControl` 等接口（`src/skills.ts:18-58`），刻意不引 `@deepseek-ai/dsh-skill` peer；codex/pi/kimi 的 provider 与本共享模块全部从这里 import 类型（如 `src/driver-core/agents-md-skill-provider.ts:31`）。注意 `SkillDefinition` 不在这里定义，而是**从 `driver-core/skill-inject.ts` 转出**（`src/skills.ts`），使 provider 与消费它的引擎 agent 用同一个定义，不会各自漂移；
2. **frontmatter 解析器**：`parseSkillFile`（`:159`）+ `parseFrontmatter`（`:80-120`）——一个 YAML 子集解析器，支持平量、`>`/`|` 块标量（`:104-116`）、成对引号剥离（`unquote`，`:123-132`）、`true/yes/false/no` 布尔（`booleanField`，`:190-196`）；三个引擎的 `SKILL.md` 由共享 provider 统一复用它解析（`src/driver-core/agents-md-skill-provider.ts:30`、`:221`）；
3. **Claude Code 技能 provider**：`ClaudeCodeSkillProvider`（`:215`）。

ClaudeCodeSkillProvider 的发现规则：项目侧锚定 git root（`findProjectRoot`，`:336-348`）扫 `<root>/.claude/skills/` 与项目根 `CLAUDE.md`（仅当带技能 frontmatter，`collectClaudeMd`，`:298-310`），用户侧扫 `~/.claude/skills/`；同一目录兼容两种布局——`<name>/SKILL.md`（目录本身成为 resourceBase）与扁平 `<name>.md`（resourceBase 是整个 skills 目录），见 `collectSkillsDir`（`:264-295`）。rank 刻意插在 project-dsh (100) 与 custom (300) 之间：项目 150、用户 160（`:65-67`）。`list()` 结束时检查 abort，已中止则返回空目录（`:234-235`）。

### 7.2.1 codex / pi / kimi 共用同一个 provider 类

这三个引擎的发现**算法**逐字相同（项目链上的指令文件合并成一个候选、技能目录逐个收集、`get()` 按 locator 分派），不同的只有位置、名字和 rank——所以算法只写一次，放在 `driver-core/agents-md-skill-provider.ts` 的 `AgentsMdSkillProvider`，各引擎模块只提供一份 `AgentsMdProviderSpec` 数据（spec 类型在 `:62-77`，类在 `:83`）：

- `list()`（`:93`）：项目侧收集上下文文件与技能目录，用户侧读 `userDir()` 下的 `userContext` 与技能目录，末尾检查 abort；
- `get()`（`:119`）：locator 为 `skill-file` 时重新解析该 `SKILL.md`（文件已被删除则返回 `undefined`），为 `agents-md` 时用 `readSources` 拼接正文；
- `agentsCandidate`（`:153`）/ `collectSkillsDir`（`:170`）/ `skillCandidate`（`:202`）/ `tryParse`（`:218`）：候选构造与目录扫描，六层嵌套的那套原样保留，含 `stat` 的 v8-ignore 兜底。

三个引擎文件因此各自只剩「docstring + 常量 + 一份 spec + 一个三行子类」：

| provider | 文件 | 上下文文件 | 技能目录 | rank 布局 |
|---|---|---|---|---|
| claude-code | `src/skills.ts:215`（**不**用共享类，见下） | 项目根 `CLAUDE.md`（需 frontmatter） | 项目/用户 `.claude/skills/` | 150 / 160 |
| codex | `src/engine-codex/skills.ts:46`（spec 在 `:33`） | `AGENTS.md` 链 + `~/.codex/AGENTS.md`，合并为一个 `agents-md` 技能 | 无 | 140 / 160 |
| pi | `src/engine-pi/skills.ts:83`（spec 在 `:60`） | `AGENTS.md`/`CLAUDE.md` 链（override 优先）+ pi 配置目录 `AGENTS.md` | 项目 `.pi/skills/`（沿目录链每级都查）+ 用户 `skills/` | 140 / 150 / 160 / 170 |
| kimi | `src/engine-kimi/skills.ts:84`（spec 在 `:62`） | `AGENTS.md` 链 | 项目 `.kimi-code/skills/` + `$KIMI_CODE_HOME/skills/` | 140 / 150 / 160 |

各 spec 只声明**它真有**的东西，所以差异本身即文档：codex 没有 `skills` 段（它没有技能目录），kimi 没有 `userContext`（它没有用户级指令文件）。合并型上下文候选统一叫 `agents-md`、`modelInvocable + userInvocable` 双开、locator 记录路径集留待 `get()` 时用 `readSources` 拼正文。pi 与 kimi 都**刻意不扫** `.agents/skills/`——dsh 自己的 skill-filesystem provider 已在 web profile 里覆盖了它（`src/engine-pi/skills.ts`、`src/engine-kimi/skills.ts` 头注）。

`ClaudeCodeSkillProvider` 仍是独立实现：它的发现规则不同（锚定 git root 而非走整条目录链、`CLAUDE.md` 必须带 frontmatter 才算技能），把它塞进同一个 spec 只会让 spec 长出互斥的可选块，因此**有意不合并**。

### 7.3 commands.ts：斜杠命令转发桥

dsh 的 `commands` 运行时**本地执行**已注册命令——这一行被消费、永远到不了模型（`src/commands.ts:1-22` 头注）。而 Claude Code 的命令真正展开发生在 CLI 内部，所以桥的语义是**转发**：handler 把原始行 `/<name> [args]` 作为普通 user 消息 `followup` 回给接收 agent，CLI 再原生展开（`forwardClaudeCodeCommand`，`src/commands.ts:72-80`）。注册内建命令（`CLAUDE_CODE_COMMANDS` 四条，`:88-93`）的意义是让 dsh web 斜杠菜单看得见命令面；未注册的 `/行` 也能透传为普通文本，但菜单会隐藏引擎的命令能力。

转发只解决「行回到 agent」，真正让它生效的是驱动侧的斜杠命令步（`engineSlashPrompt`，见 §2 与 `docs/architecture.md` §3.4）：引擎只在 prompt 以 `/` 开头时才走自己的命令面。内建清单按实测收敛（claude 4 条：`help`/`compact`/`clear`/`review`，`/explain`/`/fix`/`/tests` 实测回 `Unknown command`；kimi 6 条见 `docs/engine-kimi.md` §7.1）。

`discoverUserSlashCommands()`（`:103-129`）同步扫描 `~/.claude/commands/*.md`：名字须过 dsh 命令文法（`COMMAND_NAME`，`:62`）、不得与内建重名、必须能产出描述——描述取 frontmatter `description` 字段，否则取正文首个非空非标题行，超 120 字符截断（`commandDescription`，`:143-168`）。同步扫描（`readdirSync`/`readFileSync`）是因为注册点没有 await 点：`registerEngineSurface` 在 agent 刚建好时一次调完（`src/engine-surface.ts:77-97`，见 §11）。**项目级 `.claude/commands/` 刻意不注册**：只扫用户级目录（`userCommandsDir`，`:132-134`），项目级那些文件留给 CLI 自己展开（`:16-18` 头注）。

kimi 有自己的命令桥 `src/engine-kimi/commands.ts`，复用这里的 `CommandDefinition` / `CommandInvocation` / `CommandResult` 类型（`src/engine-kimi/commands.ts:34`），转发模式相同（`forwardKimiCommand`，`:44-52`），但只注册 ACP 面**实测实现**的 6 条内建（`compact`/`status`/`usage`/`mcp`/`tasks`/`help`，`:60-67`）；其余 TUI 控制类命令 ACP 面只会回 `Unknown ACP command`，因此不注册（`:1-31` 头注），`skill:` 已由技能缝承载。

### 7.4 注册点：不再是进程级，而是 agent 自己的 scope

注册不再发生在 `src/index.ts` 的引擎挂载路径上——那里原先按引擎各 mount 一份命令与 provider，进程级注册会让 A/B 两个跑不同引擎的会话互相看见菜单（旧的 `commandDisposers` / `skillDisposer` 已删除）。现在只有一个注册点：agent 建好之后，路由器在 `adopt` 里调 `registerEngineSurface(handle.agent, engine, warn)`（`src/router-loop.ts:243`，只对非 `in-process` 调），由它把引擎的命令与技能 provider 注册到 **`agent.ctx`** 上（`src/engine-surface.ts:77-97`）——为什么这天然是会话级，见 §11。

`src/index.ts` 现在只剩五件事：managed block 的读写（`syncManagedBlock`，`:192-204`；apply 里的同步写入见 `:264-285`）、挂载路由器（`:588-615` 的 inject gate）、为每个引擎 authoring preset（`:435-454`）并把花名册默认值 steer 到所选引擎（`:504-528`）、一个共享的 provider 路由占位（`external`，`mountProviderRoutes`）、settings section（`:662-677`）。宿主服务（`commands` / `skills` / `agentPresets` / `settings` / `llm` / `sessionProjections`）统一以最小结构切片经 `ctx.get` 取，缺失时静默跳过——切片定义集中在 `src/driver-core/host-servers.ts`（见 §12）。

## 7.5 hosted-tool-vocabulary.ts：工具名与计划的归一化

### 解决什么问题

Web 客户端的工具行（`@deepseek-ai/dsh-client-ui-chat` 的 tool Definition）、产出文件行与正文行内文件链接（`@deepseek-ai/dsh-client-ui-deliverables` 的 `mutationPath`）、轨迹视图，都只认 dsh 自己的工具名与参数形状；todo 面板则只由 `todo/write` 事件驱动。托管引擎的工具是另一套词汇：Claude 的 `Write`/`Edit`/`Read`/`Bash`，Codex 的 `apply_patch`/`command_execution`，Kimi 用人类可读的 `title` 当名字，Pi 用 `path` 而非 `file_path`。不归一化时这些界面全部落空——文件改动行不出现、diff 行退化成通用卡片、dsh 待办面板永远为空。

### 契约

- `normalizeHostedToolCall(engine, name, argumentsJson)`（`src/driver-core/hosted-tool-vocabulary.ts`）返回 `{ name, arguments }`，只做**无损**投影：
  - claude-code：`Write→write`、`Edit→edit`、`Read→read`、`Bash→bash`、`TodoWrite→todo_write`（参数已是 dsh 形状，逐字透传）；
  - codex：`command_execution→bash`；`apply_patch` 是多文件补丁，没有单文件 dsh 等价物，**刻意保留原名**；
  - kimi：`title` 级映射 `Bash/Read/Write/Edit → bash/read/write/edit`；
  - pi：名字本就是 dsh 拼写，只重塑参数——`path→file_path`（保留 `offset`/`limit` 等未知字段），单条 `edits[0]` 的 `{oldText,newText}` 摊平成 `old_string/new_string`；多条 edit 无单条等价物，保留原参数。
- 归一化后的 `{ name, arguments }` 会**同时**喂给两个写入方：driver 新 append 的 `tool/call` 事件，以及该调用所属 `assistant/message` 里同 `id` 的 `tool-call` block。Session V4 按 `id` 配对这两者并要求 `name` 与 `arguments` **逐字节相同**（`../../deepseek-harness/packages/session/session-format-v3-to-v4/src/relationships.ts` 的 `ToolState`），否则每次加载该日志都抛 `tool/call <id> does not match one advertised tool call`——会话不可加载。因此两侧都取 dsh 拼写：`tool/call` 是 Web 工具行与 dsh 工具词汇的读取面，而 assistant 消息若被回放进 in-process turn，也必须命名一个 dsh 注册表里真实存在的工具（`bash`，不是 `Bash`）。
- 参数 JSON 解析失败、或不是对象时，名字照常投影、参数原样保留——宁可退化成通用行，也不误渲染。
- **每个 call 恰好一条 `tool/result`**：Session V4 的待配对表只按 `callId` 建键，第一条 `tool/result` 就把该 call 从表中删除（`relationships.ts` 的 `tool()`，`packages/session/session-format-v3-to-v4/src/relationships.ts:165-179`），第二条对同一 call 的结果会抛 `tool/result <id> has no advertised tool lifecycle`——**一条重复就让整份日志不可加载**。因此每个驱动都必须保证一个 call 只落一次结果——这与「投影一致」（上面的 block/事件逐字节相同）并列，是写入侧的另一条硬不变量。目前四个引擎的实际情况：
  - **claude**：Claude Agent SDK 把同一 `tool_result` 发两条 `user` 消息（实测相隔 ~57 ms）。驱动在每个 step 内维护 `settledCalls: Set<ToolCallId>`，已落盘的 call 再次到达直接丢弃（`src/engine-claude/agent.ts` 的 `user` 分支；集合在每个 `step()` 开始时清空）。键取 `result.source.callId`——0.1.5 的 tool-result 消息是 `user` 角色、call id 嵌在 block 里而非顶层 `toolCallId`，`source.callId` 是两代都有的那个字段。
  - **pi**：Pi 会把同一次执行报两遍——先 `tool_execution_end`，再在 `turn_end.toolResults` 里批量重发同一批结果（`turn_end.toolResults` 是前者缺失时的兜底）。驱动在每个 step 内维护 `settledToolCalls: Set<string>`，两条路径共享它，先到者落盘、后到者丢弃（`src/engine-pi/agent.ts`）。
  - **kimi**：`toolContent.delete(callId)`（结果落盘后立即删除）天然让每个 call 只落一次——重复的 settled update 走 `!this.toolContent.has(callId)` 直接 return，无需额外集合。
  - **codex**：app-server 协议对每个 item id 只发一次 `item/completed`，驱动尚无重复结果路径，未加守卫。
- `planTodosOfHostedTool(engine, name, argumentsJson)` 读出计划工具的整表快照，形状对齐 `todo/write` 的 `TodoItem`。目前只有 Claude 的 `TodoWrite` 有明确映射（其 `status` 枚举与 dsh 完全相同）；未知状态与畸形条目被丢弃而不是抛错。
- 因为插件只是 append 这个事件、从不 import `@deepseek-ai/dsh-tool-todo` 包，`todo/write` 的 `SessionEventMap` 成员在本模块用 `declare module '@deepseek-ai/dsh-session/types'` 镜像了一份；profile 总会装载真实包，两份同形声明合并为同一接口。

### 哪些引擎怎么用

四个 agent 都在**构造消息与事件之前**对一个调用只调用一次归一化，把同一组 `{ name, arguments }` 喂给两个写入方：

| 引擎 | 归一化点（同一组值喂给 block 与事件） |
|---|---|
| claude | `src/engine-claude/agent.ts` 的 `assistant` 分支：由 `mapped.toolCalls` 建 `id→归一化值` 表，用它重写 `mapped.content` 里的 `tool-call` block，并驱动 `tool/call` 事件（`TodoWrite` 另 append `todo/write`） |
| codex | `src/engine-codex/agent.ts` 的 `commandExecution`/`fileChange`/`mcpToolCall` 三个 `item-completed` 分支：先归一化，再把归一化值折进 `held`（`foldToolCall`），并用同一值 append 事件 |
| pi | `src/engine-pi/agent.ts` 的 `emitToolCall`：登记时归一化，归一化值同时进 `pendingToolCalls`（→ assistant block）与 `pendingCallLog`（→ 事件） |
| kimi | `src/engine-kimi/agent.ts` 的 `flushSegment`：归一化整段调用列表，再喂给 `flushAssistant` 与 `tool/call` 事件 |

### 未接入的部分（已知缺口）

- **Codex `apply_patch`** 不产生产出文件行（多文件补丁无 dsh 单文件等价物）。
- **托管引擎的压缩（compaction）** 没有映射到 dsh 的 `compaction/*` 事件：pi 已发 `compaction_start`/`compaction_end` 但被 `case` 直接忽略（`src/engine-pi/agent.ts`），claude/kimi 也没有对应处理，所以转录里看不到检查点。这需要新增 `@deepseek-ai/dsh-compaction` 的事件类型并遵守其 start/end 配对不变量，留待后续。
- **模型选择**：**现在四个托管引擎都消费会话选择**（共享判据 `src/driver-core/session-model.ts`，见 §7.6）——真实 dsh 模型透传给引擎、引擎拒绝则报错。此外宿主的 `selectModel` 还会把提交的值存成**部署默认**（`packages/api/session-controller/src/commands.ts`），所以插件把这条会话的**模型座位**跟着引擎写进日志（新建会话在托管引擎上写共享的 `external/default`、换引擎时跟着换、切回 `in-process` 换成部署默认；`resetFor` 换引擎那一刻、`guardFor` 构建那一刻，`src/model-selection-reset.ts`；判据与用户可见语义见 `docs/per-session-engine.md` §5.2）。托管引擎那一侧，模型菜单里唯一的占位路由只广告一个 `default` 条目（`src/provider-route.ts`），正是座位写的那个词。
- **显式交付（`present`）**：托管引擎无法调用 dsh 工具，故不会产生 `deliverables/presented`。

### 改它会波及谁

改映射表会同时改变四个引擎的 UI 呈现、产出文件行，以及 assistant 消息里 tool-call block 的工具名（它现在与 `tool/call` 事件取同一投影），但不改变会话配对。测试上：`tests/driver-core/hosted-tool-vocabulary.spec.ts` 覆盖全部投影分支；每个引擎的 `tests/engine-*/agent.spec.ts` 既断言投影后的 `tool/call` 事件，也断言 assistant 消息里同 `id` 的 tool-call block 与之**逐字节相同**（`name` 与 `arguments` 都覆盖）。

## 7.6 session-model.ts：模型选择的透传判据

### 解决什么问题

一条会话可以在 web 里选模型（`session.selectModel` → 日志里一条 `model/selection`），而托管引擎默认用自己的原生模型。四个驱动若各写一份"读会话选择、决定要不要下发给引擎"的逻辑，判据必然漂移。这个模块是**一处判定、四处消费**：判据只有一个，读法只有一个。

### 契约

- `currentSelection(session, projections)`：**宿主的读法**（`ApiSessionAgentController.selectionFor` 的复刻）——投影 `modelSelection.pending` 优先，否则会话最新 `request/header` 的 config，都没有则 `undefined`。投影服务缺席时跳过 pending 那一半（只有 header）。`model-selection-reset.ts` 与四个驱动共用它。
- `sessionModelOverride(selection)`：**纯判据**。`undefined` → `undefined`；provider 是本插件服务过的托管标签（共享 `external` 或旧四家，判据 `isHostedProviderRoute`）→ `undefined`（"交回引擎自己决定"）；否则 `{ provider, model }`。
- `sessionModelOverrideOf(ctx, session)`：读取 + 判据，四个驱动的入口（`ctx.get('sessionProjections')` 惰性取，缺席也工作）。

### 哪些引擎怎么用

每个驱动**在每个 `step()` 里**重取一次（不冻结在构造期），拿到 `{ provider, model } | undefined` 后按引擎接口下发，**会话选择优先、部署 `config.model` 回落**：

| 引擎 | 下发形式 | 备注 |
|---|---|---|
| pi | `--model <provider>/<model>`（+ `:thinkingLevel`） | pi 的 `--model` 接受 `"provider/id"` 复合串；有会话选择时**不下发** `--provider`（复合串自带 provider） |
| claude-code | `Options.model` | 裸 model id/alias |
| codex | `thread/start` 与 `turn/start` 的 `model` | 裸 slug |
| kimi | ACP `session/set_model { sessionId, modelId }` | `session/new` 之后、`prompt` 之前；回包错误即那一步失败 |

`undefined` 时**不下发任何模型参数**，引擎用原生默认/部署 pin。**不做目录校验、不恢复探针**：引擎自己用它的凭据与 provider 配置解析；拒绝就报错（kimi 的 `set_model` reject 直接浮上来）。

### 改它会波及谁

判据的任何改动（例如把"provider 是托管标签"换成别的、或加入 reasoning effort）会同时改变四个引擎下发的模型参数与 `model-selection-reset.ts` 的读取。测试：`tests/driver-core/session-model.spec.ts` 覆盖判据与读取的每个分支；四个 `tests/engine-*/agent.spec.ts` 各有"真实模型下发 / `external` 或空不下发 / pin 回落 / 中途改值"一组。共享 `modelSelection` 折叠在 `tests/helpers/model-selection-projection.ts`。

## 7.7 model-handover.ts：端点、协议与凭据的共同解析

### 解决什么问题

§7.6 只解决"**模型名**怎么送到引擎"。引擎拿到模型名之后，仍用**它自己那份**凭据与 provider 配置去解析——所以"把 dsh 模型交给引擎"过去实际是"引擎能不能在自己那份配置里找到这个模型名"，而不是"用 dsh 的那个端点对话"。这个模块是**后半截**：把会话选中的那条 dsh 模型解析成 `{ model, baseURL, api, apiKey }`，四个驱动各自翻译进自己的入口（`resolveModelHandover`，一次解析、四处消费）。

### 契约

- **输入**：`(ctx, override)`，`override` 就是 §7.6 的 `sessionModelOverrideOf(...)` 结果。`undefined`（托管座位/没有选择）→ 直接 `undefined`，**不注入任何东西**。
- **provider → namespace 的映射规则**（这一步是"不许猜"的关键）：取自 **llm 注册表自己的"可配置 provider 目录"**——`ctx.llm.listConfigurableProviders()`（主仓 `LlmRuntime`，外形见 `packages/llm/llm/src/types.ts` 的 `LlmConfigurableProvider`：`{ provider, displayName, settingsNs, settingsPath }`）。也就是说**不是**本插件硬编 `llm-pi-ai` / `llm-deepseek`，而是问注册表"这条 provider 路由由哪个 ns 的哪一段配置"。当前两个 provider 插件给出的答案是：`llm-pi-ai` → `settingsNs: 'llm-pi-ai'`、`settingsPath: ['providers', <路由名>]`；`llm-deepseek` → `settingsNs: 'llm-deepseek'`、`settingsPath: []`（整段就是 profile）。注册表缺席、没有 `listConfigurableProviders`、或目录里没有这条 provider → **映射失败 → 不注入 + warn 一次**。
- **profile 读取**：`ctx.settings.get(ns)` 拿到该 ns 的 resolved 值（**会套 schema 默认值**，主仓 `packages/settings/settings/src/index.ts:748`——所以 `llm-deepseek` 那种只写 `models`/`baseURL` 的段，仍能读出 `apiKeyEnv` 的默认值），按 `settingsPath` 走；读到的对象**只要求非空字符串的 `baseURL`**，`api` 与 `apiKeyEnv` 都可选（非空字符串才认）。缺 `baseURL` → 不注入 + warn 一次。`api` 是 dsh 的 wire 协议名（`llm-pi-ai` 的 `PROTOCOLS`：`anthropic-messages` / `openai-completions` / `openai-responses`）；**`api` 缺失不再拒绝移交给**——见下条。
- **wire 协议不是准入门槛**（0.1.5-rc5 起）：profile 里没写 `api` 时，仍把端点与凭据交出去，`DshModelHandover.api` 为 `undefined`。理由：拒绝会退回"引擎拿 dsh 的模型名去打**它自己**的端点"，那是个像鉴权/模型问题的假象（真机实例见 `docs/optimization-backlog.md` BL-19），比让引擎按自己的默认协议去打**正确端点**并报错更糟。对**adapter 自己拥有 wire** 的 shipped 路由（主仓 `llm-deepseek` 这类，schema 里根本没有 `api` 字段），插件用一张**一行表** `SHIPPED_ROUTE_APIS` 补上协议（当前只有 `deepseek-official → openai-completions`，依据是该 adapter 自己就 POST `{baseURL}/chat/completions`，主仓 `packages/llm/llm-deepseek/src/adapter.ts:651`）；**profile 里写了 `api` 就永远以它为准**。表外的未知协议仍走 `undefined`，由各引擎自己降级。
- **凭据**：`apiKeyEnv` 是**环境变量名**（`CredentialRef`），值在 harness 的凭据存储里，**不在 process.env**（主仓 `packages/bundle/base/cordis.patch.yml`:83-93 明说不 materialize 进进程环境）。解析顺序：`ctx.credentials.resolve(apiKeyEnv)?.value`（seam 缺席或答空时）→ `process.env[apiKeyEnv]`；两者都拿不到 → 不注入 + warn 一次。
- **warn 去重**：一条会话**每个 step** 都重解析，所以每条"provider/model + 失败原因"只 warn **一次**（`WeakMap<Context, Set<string>>`）。warn 文案只带 provider 与 model，**绝不带凭据值**。
- 返回的 `DshModelHandover` 含 `apiKey`；调用方只把它放进子进程 env（或 pi 自建的 `0600` 目录文件 / argv），**不写日志、不进事件、不进 `request/header`**。

### 逐引擎翻译（各驱动内联或各自的 `model-handover.ts`）

| 引擎 | 端点/凭据入口 | 协议翻译 |
|---|---|---|
| claude-code | `Options.env` 里 `ANTHROPIC_BASE_URL` = `baseURL`、`ANTHROPIC_AUTH_TOKEN` = `apiKey`（在 `src/engine-claude/agent.ts` step 内联；`sdk.ts` 已把 `scrubbedParentEnv()` 铺底再叠 `spec.env`） | 无（Claude Code 天然只说 `/v1/messages`） |
| kimi | 子进程 env：`KIMI_MODEL_NAME` = model、`KIMI_MODEL_API_KEY` = apiKey、`KIMI_MODEL_BASE_URL` = baseURL、`KIMI_MODEL_PROVIDER_TYPE`（`kimiModelEnv`，`src/engine-kimi/model-handover.ts`）；有端点注入时**跳过** `session/set_model`（env model 已是默认） | `anthropic-messages`→`anthropic`；`openai-completions`/`openai-responses`→`openai`；`api` 为 `undefined` 或其余值 → **省略该变量**（端点照旧交出去，退回 kimi 默认协议，由 kimi 报错） |
| pi | 插件自建 agent 目录（`piAgentDir`，`src/engine-pi/model-handover.ts`：`<tmp>/dsh-loop-engine-pi-agent/<hash>/models.json`，0700/0600）+ env `PI_CODING_AGENT_DIR` + argv `--provider` / `--model <provider>/<model>` / `--api-key`；**绝不碰 `~/.pi`** | `api` 原样写进 `models.json`（pi 认 `openai-completions` / `anthropic-messages` 等自由字符串）。**pi 的 provider 声明要求 `api` 存在**（真机：缺了 `pi auth check` 回 `{"status":"invalid","reason":"invalid_state"}`），所以 `api` 为 `undefined` 时驱动**整份 handover 丢弃**、不建目录也不加 argv——插件不写它明知 pi 会拒的文件 |
| codex | `-c model_provider="dsh"` + `-c model_providers.dsh={name,base_url,wire_api,env_key}`（`name` 必填：缺了 codex 0.149.1 在配置加载阶段就拒绝，`app-server` 起不来，见 BL-01）+ env `DSH_LOOP_ENGINE_API_KEY`（`codexModelConfig`，`src/engine-codex/model-handover.ts`）；经 `AppServerClient.create(argv, env)`（env 是**叠加在 `process.env` 之上**，见 `src/engine-codex/appserver/client.ts`）；端点指纹变了就重启 app-server | `openai-responses`→`responses`；`openai-completions`/`anthropic-messages`/**其余一律省略 `wire_api`**（codex 0.149.1 已**移除** `chat`，写它是致命配置错误、`app-server` 起不来；省略后 codex 用自己的默认 wire=  `responses` 去请求并报错） |

**只在必要时注入**：会话选择是 `external/default` 或没有任何选择 → 四家都**完全不注入**（引擎用自己原生配置/部署 pin，即旧行为）。

### 改它会波及谁

`resolveModelHandover` 的判据改动会同时改变四个引擎的端点注入与 warn 行为；映射表（kimi 的 `KIMI_PROVIDER_TYPES`、codex 的 `CODEX_WIRE_APIS`、shipped 路由的 `SHIPPED_ROUTE_APIS`）改动只影响对应分支。测试：`tests/driver-core/model-handover.spec.ts` 覆盖解析的每个分支（无映射 / 无 settings / 无 baseURL / 缺凭据 / 无 `api` 照常交出 / shipped 表补协议 / 声明优先于表 / warn 一次 / 凭据不入文案）；`tests/engine-{kimi,pi,codex}/model-handover.spec.ts` 覆盖三张映射表、`api` 缺省时的省略行为与 pi 目录落盘；四个 `tests/engine-*/agent.spec.ts` 各有"端点/凭据注入到引擎入口 / `external` 或空不注入 / 解析不到不注入 + warn 一次 / 中途改端点生效"一组，pi 另有"无协议则整份 handover 丢弃"，codex 另在 `tests/engine-codex/appserver/client.spec.ts` 覆盖 `create(argv, env)` 通路本身（含 `config.env` 之前无人消费的回归）。驱动器夹具在 `tests/helpers/dsh-model-endpoint.ts`（传 `api: ''` 即模拟"profile 里没有协议"）。

## 8. 改动影响矩阵

| 改动点 | 直接受影响 | 必须跑的测试 |
|---|---|---|
| `prompt.ts` 序列化格式 / 斜杠命令步 | 四个引擎的全部 prompt；claude/pi/kimi 的命令步 | `tests/engine-claude/mapping.spec.ts` + `tests/driver-core/prompt.spec.ts` + 四个 `tests/engine-*/agent.spec.ts` |
| `permission-knobs.ts` 读取/枚举 | 四个引擎每次查询的权限立场 | 四个 `tests/engine-*/permission.spec.ts`（claude 侧直接 import 读者，`tests/engine-claude/permission.spec.ts:8`） |
| `ownership.ts` 生命周期/竞速 | 四个运行时的创建/卸载正确性 | kimi/pi 的 `tests/engine-*/loop.spec.ts` + claude/codex 的 `tests/engine-*/index.spec.ts` + `tests/router-loop.spec.ts` |
| `hosted-engine-runtime.ts` 事务体 | 四个引擎的 create/resume 正确性（进程内唯一一份） | 同上四份 spec + `tests/router-loop.spec.ts` |
| `router-loop.ts` 分发/记账/换引擎（空白期与运行中） | 每个会话的引擎归属；`in-process` 与托管引擎的并发 | `tests/router-loop.spec.ts` + `tests/engine-remote.spec.ts` + 四个 `tests/engine-*/index.spec.ts` |
| `engine-surface.ts` 命令/技能注册 | 托管会话的斜杠菜单与技能目录（按 agent scope 隔离） | `tests/index.spec.ts`（真 agent scope）；`tests/router-loop.spec.ts` 只断言"是否调用"（该模块被 mock） |
| `preset.ts` `engineOfPreset` / `enginePresetId` / `ensureEnginePresets` | 每会话的引擎选择与磁盘上的 preset 文件 | `tests/preset.spec.ts` + `tests/router-loop.spec.ts` |
| `host-servers.ts` 结构切片 | 所有消费方（纯类型，编译期） | 无独立 spec；由 `pnpm run typecheck` 与各消费方 spec 兜住 |
| `model-handover.ts` 解析 / 两张映射表 | 四个引擎的端点与凭据注入、warn 次数 | `tests/driver-core/model-handover.spec.ts` + `tests/engine-{kimi,pi,codex}/model-handover.spec.ts` + 四个 `tests/engine-*/agent.spec.ts` |
| `inbox.ts` 折叠与落盘 | 四个引擎的收件箱语义与 `agent/inbox/spliced` 持久流 | `tests/driver-core/inbox.spec.ts` + 四个 `tests/engine-*/agent.spec.ts` |
| `assistant-stream.ts` 帧与分段压缩 | 四条流式路径的 live 帧与内嵌 stream | `tests/driver-core/assistant-stream.spec.ts` + 四个 `tests/engine-*/agent.spec.ts` |
| `context-files.ts` 行走/加载 | codex、pi、kimi 的 `agents-md` 技能 | `tests/driver-core/context-files.spec.ts` + 三个 `tests/engine-*/skills.spec.ts` |
| `agents-md-skill-provider.ts` 算法/候选构造 | codex、pi、kimi 三个 provider 的全部发现行为 | 三个 `tests/engine-*/skills.spec.ts`（**缺一不可**：分支散布在三份 spec 里，见 §9） |
| `hosted-tool-vocabulary.ts` 映射/重塑/计划 | 四个引擎的 UI 工具行与产出文件呈现；assistant 消息里 tool-call block 的工具名（与 `tool/call` 事件同投影）；claude 的待办面板 | `tests/driver-core/hosted-tool-vocabulary.spec.ts` + 四个 `tests/engine-*/agent.spec.ts` |
| `skill-inject.ts` 手势/渲染 | 四个引擎的技能注入文本 | 四个 `tests/engine-*/agent.spec.ts` |
| `skills.ts` `parseSkillFile` | claude provider + 共享 provider（codex/pi/kimi）的技能解析 | `tests/skills.spec.ts`、`tests/engine-pi/skills.spec.ts`、`tests/engine-kimi/skills.spec.ts` |
| `skills.ts` `findProjectRoot` | claude 技能锚定 + codex/pi/kimi 目录链（context-files 反向依赖） | 全部 skills 相关 spec |
| `commands.ts` 类型/转发 | claude 命令面 + kimi 命令桥（类型复用） | `tests/commands.spec.ts`、`tests/engine-kimi/commands.spec.ts`、`tests/index.spec.ts` |

## 9. 测试覆盖要点

- **driver-core 的直接 spec** 有五个。`tests/driver-core/context-files.spec.ts`：目录链行走（有/无 git root）、override 优先于 primary、每目录一个文件、四个正文助手的空/缺失/拼接语义——改 context-files 先改这里。`tests/driver-core/inbox.spec.ts`：两个列表的 append/prepend/replace/remove、`clear` 与 `claim` 的批次顺序、越界坐标的归一化、重复 id 的拒绝、构造时的重放折叠。`tests/driver-core/assistant-stream.spec.ts`：一次尝试从 `start` 到 `committed` 的帧序、durable 提交被拒与显式放弃两条 `abandoned` 收尾，以及 `takeStream()` 在内容边界切段而不打断 live 帧。`tests/driver-core/hosted-tool-vocabulary.spec.ts`：四个引擎的改名表、Pi 的参数重塑（含保留 `offset`/`limit`、多条 edit 与非对象条目回退）、Claude 计划抽取（含未知状态与畸形条目丢弃），以及非法 JSON 的透传。`tests/driver-core/prompt.spec.ts`：`engineSlashPrompt` 的每个拒绝臂（空历史、非 user 收尾、tool 结果、技能注入顶位、多块消息、非 text 块、多行、路径状开头）与命中臂，外加 `serializeHistory` 的框架拼接。
- `serializeHistory` 另由 `tests/engine-claude/mapping.spec.ts` 直接 import（`serializeHistory`、`OMITTED_IMAGE_TEXT`）；claude/pi/kimi 各有一条"命令行走裸行、下一步回到转录"的步进用例，新增分支时两边都要看。
- `permission-knobs.ts` 没有独立 spec，靠四个 permission spec 的行为断言间接覆盖；改折叠逻辑时四个 spec 都要看。
- `ownership.ts` 与它上面的事务体（`hosted-engine-runtime.ts`）由 kimi/pi 的 loop spec 与 claude/codex 的 index spec 的卸载/竞速场景覆盖——每个引擎的 create/resume 都会把共享体走一遍；源码里大量 `v8 ignore` 注释标出了理论上不可达的兜底分支，改动时不要用"删分支"来凑覆盖率，这些注释本身就是设计文档。
- **`tests/engine-remote.spec.ts`（本次修复新增）** 是"显示与路由不可能不一致"的回归钉：真实 `SessionStore` + 真实 JSONL 持久化 + 会真正折叠 `agentPreset` 的投影，造一条 header 记 `loop-engine-claude-code`、日志随后 commit `agent-preset/selected = loop-engine-pi` 的**持久化**会话，然后同时问两个读者——Remote 答 `pi`，路由器对同一会话 resume 时构建的是 Pi（fake runtime 记录 build 的引擎）。它另外钉住三态的四条回答（无 preset → `unset`、旧 id → `legacy`、`standard` → `in-process`、库里没有的 id → `unset` 且不抛）、网关会读到的绑定与 `@Remote` 标记、以及"形参名 `request` 就是 wire 字段"这条 SRC 契约（读 `Function.prototype.toString` 断言，见 `docs/architecture.md` §7）。同一份 spec 的 `switching a session's engine` 一段把第二个端点 `loopEngine/select` 钉在真 `RouterLoop` 上：成功路径（托管引擎之间原地换手；**两个涉及 in-process 的方向都走"释放 agent + `reload: true`"，且回包时 `ctx.agents.get` 已经为空、随后一次 `resume` 由 harness loop 重建而不再建任何托管引擎**；冷会话的报告只有记录、没有第二个字段；请求的引擎就是活 agent 的引擎时只写记录不重建；另一个进程新建的 store 读到同一份记录文档）、全部拒绝臂（会话未打开、turn 在飞、subagent 会话、不在本路由器的账上、记录写不进去、请求畸形、路由器还没挂上——每条都断言没有被释放的 agent），以及记录文档坏掉时仍按 preset 回答。`tests/engine-of-session.spec.ts` 单独钉三态判定与那次读取本身（含"没有 `sessionQuery` 服务时答 `unset`"与"读取失败不吞、交给调用方"），客户端那一半（stash + 重载 + 列表就绪后 `sessions.open`）由 `tests/session-engine-cache.spec.ts` 钉住。
- **`tests/router-loop.spec.ts`（本次重构新增）** 单独钉住路由器：分发（每个托管 preset 到对应引擎，其余交给 harness loop）、引擎运行时的记忆化（一个引擎只有一个运行时）、父 agent 的引擎继承与"父 preset 不归本插件"的回退、resume 读持久化投影并释放观察租约、账本（换引擎前先 forget、陈旧 handle 不会误删重建后的记录）、空白期换引擎（同引擎不动、非空白只 warn、没有投影视为空白、in-process → 托管同样回收、释放失败要上报）、记录的镜像规则（有记录的会话让 preset 选择器把选择写进记录、"最后动手的赢"、没有记录的会话一个字节都不写、记录写失败只 warn 且照样释放、已开始的会话记录与引擎都不动），以及 `engine-surface` 桥接只对托管引擎调用。它用 fake `HostedEngineRuntime` 子类 + mock 掉的 `engine-surface`，真实引擎路径由四个 `tests/engine-*/index.spec.ts` 驱动整个插件覆盖；`selectEngine` 自己不在本 spec（由上面 `tests/engine-remote.spec.ts` 的真路由器驱动），记录文档本身（路径、原子替换、懒读一次、降级）由 `tests/session-engine-store.spec.ts` 覆盖。
- `tests/direction-bug.spec.ts`（旧全局切换的调试 spec）已随本次重构删除：那个"切完引擎旧工厂还在服务会话"的问题在按会话分发下不再存在。
- `skill-inject.ts` 由四个 agent spec 的 `/name` 步进场景覆盖。
- `tests/commands.spec.ts` 用 hoisted 的 homedir mock + 临时目录覆盖转发、frontmatter 描述回退、120 字符截断、内建冲突、悬空 frontmatter 等边界；`tests/skills.spec.ts` 覆盖两种布局、rank、CLAUDE.md 三态（有 frontmatter / 无 / 是目录）、frontmatter 解析全部边界。
- 三个 `tests/engine-*/skills.spec.ts`（codex/pi/kimi；claude 的技能 provider 由 `tests/skills.spec.ts` 覆盖）覆盖各 provider 的目录策略与环境变量覆盖（`PI_CODING_AGENT_DIR`、`KIMI_CODE_HOME`）。
- **`agents-md-skill-provider.ts` 没有自己的 spec**，它的 per-file 100% 覆盖率由三份引擎 spec 的**并集**达成——每份只走自己 spec 打开的分支：
  - `spec.skills !== undefined` 的两臂来自 pi/kimi（有技能目录）与 codex（无）；
  - `spec.userContext !== undefined` 的两臂来自 codex/pi（有用户级指令文件）与 kimi（无）；
  - `skill-file` locator 的两臂只在 pi/kimi 的 `SKILL.md` 用例里（codex 从不产生该 locator）；
  - `readSources` 返回 `undefined` 的臂来自各 spec 的"文件已被删除"用例。
  因此**给某个引擎补 spec 或删用例时，必须确认这三份并集仍覆盖全部分支**——删掉 pi 的技能目录用例就会让共享文件掉出 100%。新增引擎若只复用现有 spec 形状，也要补上它自己 spec 打开的那套分支。
- 全仓覆盖率门槛是 per-file 100%（`pnpm run test:coverage`，`src/client` 除外），共享层任何新分支都必须有用例或显式 `v8 ignore` 理由。

## 10. router-loop.ts：单槽路由器

### 解决什么问题

harness 的 `AgentRegistry.setFactory` 只接受一个工厂（第二次注册抛 `an agent factory is already registered`，`../deepseek-harness/packages/core/agent/src/index.ts:355-356`），也没有"按会话解析工厂"的入口。于是"会话 A 跑 codex、会话 B 跑 kimi、同时活着"这件事，只能由那个唯一的工厂自己分发。`RouterLoop` 就是它（`src/router-loop.ts:172`）：`extends AgentLoop`（因此 `@deepseek-ai/dsh-agent-loop` 是插件的 peer 依赖），**完整继承** in-process 的全套语义，只覆写两个 AgentFactory 入口。

它回答的"这个会话跑哪个引擎"里，头一位不是 preset，而是**插件自己的逐会话记录**（`SessionEngineStore`，`src/session-engine-store.ts:147`）。这份侧车之所以存在，是因为引擎可以在会话**开跑之后**换（见「空白期换引擎」末的 `selectEngine`），而 harness 的 preset 通道对已开始的会话一律拒绝（`agent-preset/locked`，`../deepseek-harness/packages/preset/agent-presets/src/index.ts:717-721`）；这条按会话的事实也不能落成会话日志里的事件——插件 append 的事件带不上 envelope 的 `ignorable` 标记，那样一条日志会在下一次冷读时被整条拒绝（`src/session-engine-store.ts:1-24` 的模块头注，`docs/proposals/append-ignorable-events.md` 正在向主仓要这个缝）。存储语义都是刻意的（本段行号指 `src/session-engine-store.ts`）：文档是 `$DSH_HOME/.loop-engine/engines.json`（`:65` 的 `resolveEngineRecordPath`），形状 `{ version, engines: { <sessionId>: <engine> } }`（`:224-226` 的 `formatEngineRecord`），整份走同目录临时文件 + rename 原子替换（`writeFileAtomicSync`，`:109-114`），内存视图在写入提交之后才前进（`:177-182`），文件只在第一次查询时**懒读一次**（`:185-202`）；文件不存在是正常的首次运行状态，读不动或读不懂则降级成"没有记录"并**只 warn 一次**（`:213-216` 的 `degrade`），判定随之回退到 preset 映射——坏掉的记录只能让某个会话丢掉记住的引擎，不能让它打不开。

继承来的东西一件都不用自己再写一遍：依赖声明（`../deepseek-harness/packages/core/agent-loop/src/index.ts:360` 的 `static inject`）、`turnBoundary` 投影注册（`:416`）、AgentFactory 槽位（`:420` 的 effect 调 `ctx.agents.setFactory`）、`provider` / `model` / `cwd` 三个 system-prompt 变量（`:421-423`）、`agent-loop` settings section（`:401`），以及两个入口的 in-process 实现（`:764` 的 `createAgent`、`:843` 的 `resume`）。重构前 `HostedLoopFactory` 手工重做的正是这几件事——现在它们只存在一份，而且是 harness 自己维护的那一份。

构造：`super(ctx, { agents: [] })`（`src/router-loop.ts:203`）。除 ctx 与 builder 外，构造参数还收下这份记录，供两个入口的判定与换引擎使用（`:195-209`；store 由插件建在 `src/index.ts:546`、在 `:591-596` 交给路由器）。`agents: []` 是刻意的——声明式 agent 列表是 harness loop 的部署配置能力（启动时按配置拉起会话），本部署一个都不声明，路由器是纯分派器。

> 本节以下（§10）未标注文件的行号均指 `src/router-loop.ts`，标注了文件名的按标注读——尤其是引用 harness 的 `agent-presets` / `session-controller` 时。

### preset → 引擎

引擎判定只有一条链、一个读点：`engineOfSession`（`src/engine-of-session.ts:78-92`）先读**插件自己的记录**，记录缺席才读**会话持久化的 `agentPreset` 投影**（投影把会话 header 与日志里每一条 `agent-preset/selected` 折在一起——读它就是在读日志）。所以下面这张表是**回退路径**：所有没有记录的会话（含所有本次改动之前的老会话）与"父 preset 不归本插件管"的继承都走它。**`engineReportOfSession`（`:128-141`）在它之上叠一层「活 agent 优先」**：这条会话有活 agent 时，报告里的 `engine` 取自路由器自己的 `live` 记账（`RouterLoop.reportEngine`，`src/router-loop.ts:362-369`），记录只在它与活 agent 不同的时候以 `pending` 单独返回——换句话说**这张表只回答「没有活 agent 的会话跑什么」**，有活 agent 的会话由路由器自己回答（用户可见的一面见 `docs/per-session-engine.md` §1.3）：

| preset id | 引擎 | 谁来跑 |
|---|---|---|
| `loop-engine-codex` | codex | 该会话的 `CodexLoop` 运行时 |
| `loop-engine-kimi` | kimi | `KimiLoop` 运行时 |
| `loop-engine-claude-code` | claude-code | `ClaudeCodeLoop` 运行时 |
| `loop-engine-pi` | pi | `PiLoop` 运行时 |
| 其他（含部署自己的 `standard`） | `in-process` | `super`（harness 自己的 loop） |

映射由 `engineOfPreset`（`src/agent-preset-ids.ts:119-125`）做：`loop-engine-` 前缀（`HOSTED_PRESET_PREFIX`，`:41`）之后的名字必须是本插件认得的引擎 id（`HOSTED_ENGINE_IDS`，`:36-38`），否则一律 `undefined`——部署自己写的 preset 不归本插件管，不能因为名字巧合就抢过来。（旧版单 preset id `loop-engine`（`LEGACY_HOSTED_PRESET_ID`，`:55`）正是被这条规则挡在外面的一位：它在磁盘上仍可能出现于旧会话的记录里，但永远不匹配任何引擎；`sessionEngineOf`（`:264-268`）把它单独认成三态里的 `legacy`，而 `hostedEngineOf`（`:281-284`）——路由用的那一半——把它读作"没有托管引擎"。报告用的也是同一个判定：`legacy` 是**没有活 agent** 时的回答，有活 agent 时报的是活 agent 的引擎。）反向是 `enginePresetId`（`src/agent-preset-ids.ts:97-99`）：`in-process` 映到 `standard`（本插件不为 harness loop 自己 author preset）。

### create 侧

`createAgent`（`src/router-loop.ts:284-292`）先问记录，记录缺席才走判定链（`engineFor`，`:212-223`）：

1. 插件自己的记录（`:286`）：有记录就以它为准，连调用方已经 compose 好的 preset 都不看——否则路由与 Remote 会对同一个会话给出不同答案；
2. 读 `options.meta?.agentPreset`。这个 meta 不用自己 resolve——主仓的 `composeAgent` 已经 resolve 好并塞进创建选项（`../deepseek-harness/packages/api/session-controller/src/agent.ts:374`、`:484`）；
3. preset 不归本插件（部署自己的 preset，或根本没有）且传了 `parentAgent` 时，读**父会话**的记录或投影来继承引擎（`:218-221`）——被委派的子 agent 不该因为自己 preset 的名字而悄悄换引擎；
4. 都不命中 → `in-process`，走 `super.createAgent`；
5. 命中托管引擎 → `runtimeOf(engine).createAgent(...)`（`:226-232` 的记忆化 builder；分派在 `:289-291`）。

### resume 侧

`resume`（`src/router-loop.ts:316-324`）必须走另一条路：`ResumeAgentOptions` **没有 meta**，会话头（header）也只记"创建时用的 preset"，不记空白会话后来 commit 的那次切换。判定同样从记录开始，而读它的函数**不在路由器里**：`engineOfSession`（`src/engine-of-session.ts:77-91`）先查插件记录（`:82-83`，命中就直接返回，连日志都不读），没有记录才做 `ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })`、取 `observation.projections.values.agentPreset`、`using` 立刻释放观察租约（`:84-90`），再用共享的 `sessionEngineOf` / `hostedEngineOf` 折成引擎。这不是"路由器顺手抽出去的 helper"：**插件自己的 Remote（`src/engine-remote.ts`，端点 `loopEngine/engine`）调的是同一个函数**（没有路由器挂载时是它回答；路由器在时由 `reportEngine` 在它之上叠一层"活 agent 优先"，见上），所以"路由用哪个引擎"与"页面显示哪个引擎"在构造上是同一段代码（`docs/architecture.md` §4.3）。

这也是主仓自己选组合时读的同一个投影（`../deepseek-harness/packages/api/session-controller/src/agent.ts:508`），两边读同一份事实。**代价**：没有记录的会话在 resume 与浏览器半的每次查询各多一次只读观察（都不占写锁）。**有活 agent 的会话不付这个代价**：报告的 `engine` 来自 `live` 记账、另一个字段来自侧车记录，两者都不需要日志（`src/engine-of-session.ts:137-140`）。投影读不到（部署没组合 preset 花名册、或没有 `sessionQuery` 服务）时答 `unset`，路由器据此退回 `engineFor(undefined, options.parentAgent)`（`src/router-loop.ts:321`），即"父引擎或 in-process"。**失败的读取不吞**：`engineOfSession` 让 `observeSession` 的 rejection 抛出去（路由器不能因为读不到就把会话悄悄搬到别的引擎），只有 Remote 那一侧把它收成 `unset` + 一条 warn（UI 要安静）。

### 每会话记账与 handle 包装

`adopt`（`src/router-loop.ts:245-264`）在 agent 发布后做两件事：

1. 非 `in-process` 时把引擎的命令/技能面桥进该会话（`registerEngineSurface`，`:246`，见 §11）；
2. 记下 `sessionId → { engine, agent, dispose, handover?, recipe }`（`LiveSession`，`:153-165`；条目落进 `this.live` 在 `:254`）——`handover` 只有托管引擎有（`lifetime` + `retire`，见 §4），`recipe` 是换手时重建继任者的配方。**`engine` 这个字段就是报告里「实际」的来源**：它是路由器构建这个 agent 时用的引擎，所以它比任何记录都更清楚这条会话现在跑什么（`reportEngine`，见下条）。

返回给宿主的 handle 是**包了一层的**：它的 `dispose()` 先 `forget(entry)` 再调原 handle 的 `dispose`（`:257-263`）。`forget`（`:267-269`）只在记录仍指向**同一个 agent** 时才删——这样"旧 handle 迟到释放"永远不会误删重建后的记录（`tests/router-loop.spec.ts:548` 就是这条）。记账服务两件事：换引擎时要找到"这个会话现在挂着哪个引擎的哪个 agent"，以及**报引擎时要回答"这条会话此刻由什么驱动"**；`release`（`:602-604`）有两个调用点（preset 通道 fire-and-forget、引擎选择器那条 `await`，见下两节）：先 `forget`、再 teardown 旧 agent，失败以 warn 上报而不是吞掉，并返回 teardown 的 promise。

### 空白期换引擎

`rebuildOnEngineChange`（`:637-663`）监听 harness 的无 scope 事件 `agent-preset/selected(sessionId, preset)`——事件类型在本文件用 `declare module '@deepseek-ai/cordis'` 声明（`:84-96`），刻意**不** import `@deepseek-ai/dsh-agent-presets`：最小 profile 可能根本不组合那个花名册。事件的源头是花名册把持久记录转发到事件总线（`../deepseek-harness/packages/preset/agent-presets/src/index.ts:228-230`），而持久记录的写入点是 `swap`（`:726`）。

分支：

1. 该会话不在账上 → 不管（`:639-640`）；
2. 新 preset 映射到的引擎与当前一致 → 不管（`:641-642`）；
3. 会话**非空白** → 只 warn（`:643-647`）。判定读 `sessionProjections.stateOf(session, 'turnBoundary')` 的 `openTurnStartSeq !== null || lastTurn > 0`，与花名册自己 `swap` 前的检查同源（`../deepseek-harness/packages/preset/agent-presets/src/index.ts:714-716`）。会话历史是在一个引擎的命令/技能面下产生的，所以这条 **preset 通道**对已开始的会话到此为止（花名册在 `swap` 里对同一条件直接拒绝 `agent-preset/locked`，`:717-721`）——但"引擎一开跑就锁死"不是本插件的规则：记录让任何打开且空闲的会话都能换（见下）；
4. 空白、且新 preset 映射到**别的**引擎 → 先把这次选择镜像进记录（`:648-654`：**只对本来就有记录的会话写**，写失败只 warn 而不中断），再把**模型座位**跟着换成新引擎的（`moveModelSelection`，`:660` → `:691-693`：托管引擎写 `<新引擎>/default`，映射回 `in-process` 写部署默认，真实 dsh 模型不动，日志里一条选择都没有也不写），最后 `release(entry)`（`:661`）掉旧 agent。注意它**不重建**：宿主下次 resolve 发现这个会话没有 live agent，会走 `resume` 路径（`../deepseek-harness/packages/api/session-controller/src/agent.ts:183` 的私有 `resolve`），于是按记录（有记录时）或日志里记录的新 preset 用正确引擎重建——durable 日志是唯一的交接物，句柄、子进程、scope 全部重建。投影为 `undefined`（会话还没进过任何 turn，或没有投影单元）同样按空白处理（`:643-647`）。**注意这条路径发不出"重载页面"**（它由主仓的控件触发）——释放同样会发 `session/disposed`，那条会话在这一页上会呈现 `docs/per-session-engine.md` §5.4 描述的状态，这是已知限制（同节末条）。

"**最后动手的赢**"：对本来就带记录的会话，harness 自己的 preset 选择器也是一次引擎选择，所以记录要先跟上它、再释放 agent；否则两条入口会互相打架——picker 按 preset 重建会话，而下一次 resume 又按记录把它搬回来（`tests/router-loop.spec.ts` 的 `the plugin's own engine record` 一段钉住这几条）。没有记录的会话保持原样：读继续由 preset 回答，一个字节也不写——只有显式选择才记录。

释放失败不吞：`release` 把 teardown 的 rejection 收成一条 warn，并把 promise 交回调用方（`:602-604`）。**它有两个调用点**：`rebuildOnEngineChange`（preset 通道，本节上一条，fire-and-forget）与 `move`（引擎选择器里涉及 in-process 的那一半，见下条，`await`）。

**另一条入口：`selectEngine`（运行中的会话）。** preset 通道表达的只是"空白会话换引擎"；把会话换到另一个引擎的主入口是路由器自己的 `selectEngine(sessionId, engine)`（`:430-468`），由插件自己的 Remote 以端点 `loopEngine/select` 发布给浏览器半（`src/engine-remote.ts:233-255`；结果形状 `{ ok: true, engine, reload? } | { ok: false, code, reason }` 定义在 `src/agent-preset-ids.ts:234-276`，`code` 是 `LoopEngineRefusalCode`（同文件 `:165-190`，七个值，含 Remote 那一侧的 `router-unmounted`）——界面按 `code` 本地化、把 `reason` 当细节（见 `docs/per-session-engine.md` §4.2、§5.3），**拒绝是一个值**——可预期的"不行"作为数据交给界面渲染，只有畸形的请求才是 `RemoteError`）。它**不要求会话是空白的**：条件是"会话打开、且没有一轮 turn 在飞"。顺序承载语义，现在是三步：**校验 → 写记录并跟着换模型座位 → `move`**。

1. **校验**（`:430-452`）：agent 取不到 → 会话未打开（`session-closed`）；`agent.status === 'running'` → 这一轮绝不打断（`turn-running`）；`agent.session.header.origin === 'subagent'` → 子会话的 agent 属于那次委派（`subagent-session`）；不在本路由器的账上 → 这个 agent 不是本插件能重建的（`not-driven`）。四条都带自己的拒绝码，以 `{ ok: false, code, reason }` 原样返回（`refuse(code, reason)`，`:713-715`）。
2. **写记录**（`:453-457`）：`records.record` 抛错是第五种拒绝（`record-failed`）——记录写不进去，记录与 agent 都保持原样。记录是路由器、Remote、宿主下一次 resolve 共同读的那个答案，所以它必须在 agent 被搬动之前落盘；紧跟着的一行是**模型座位**（`moveModelSelection`，`:465` → `:691-693`）：按目标引擎写（托管引擎 `<新引擎>/default`、`in-process` 部署默认），真实 dsh 模型与"日志里一条选择都没有"都不写（`src/model-selection-reset.ts`），因为换手／重载之后的那次构建立刻就要读它。**请求的引擎就是这条会话活 agent 的引擎时到此为止**（`:466`）：只记账、一个 agent 都不拆，因为记录才是用户的显式选择。这里比的是**活 agent 的引擎**（`entry.engine`）而不是记录：释放失败时两者可以不一致（下一条），而那时正确的问题正是"这个 agent 现在跑什么"——比对记录会让"重新选中当前实际运行的引擎"变成一次把同一个 agent 拆掉重建的空转，也会让"撤回一次记录"变得不可能。
3. **`move`**（`:467` → `:504-511`）：**两边都是托管引擎**时走 `hotSwap`（`:535-570`）——在**同一个 `Session` 对象**上原地换手，store 条目与写句柄随 `SessionLifetime` 交给继任者，`retire()` 只停旧机器并把它从 `ctx.agents` 摘掉，会话本身一个字节都不释放；**任一边是 `in-process`** 时 `await release(entry)` 后返回 `{ ok: true, engine, reload: true }`：会话变冷、记录就是它下一次构建要用的引擎，而 `release` 发出的 `session/disposed` 会在客户端把会话行删掉、把当前会话清空、并在那个 `Session` 实例上留下没有复位路径的 `removed` 标记——所以客户端必须重载页面（`src/client/reload.ts`），重载后由插件自己 `sessions.open(id)` 回到这条会话（`docs/per-session-engine.md` §5.2）。**`await` 是契约的一部分**：回包说"这条会话已经是冷的了"，那就必须已经是。`hotSwap` 自己还有第七种拒绝 `rebuild-failed`（`:555-569`）：旧机器已经退役、继任者却建不起来时，它是唯一在**记录已经写好、会话的 agent 也已经释放**之后才发出的拒绝——这条会话按记录停在冷态。

**报告与选择读的是同一份记账**：`reportEngine(sessionId)`（`:385-392`）把 `live` 记账里的引擎作为报告里的 `engine`、把与之不同的侧车记录作为 `pending`，所以「这条会话现在跑什么」在路由、选择、显示三处是同一个答案，而「它记下了什么」单独可读（`docs/per-session-engine.md` §1.3）。这个组合在正常路径上不出现（原地换手让两者一起变、释放之后没有活 agent），只剩**释放没成功**那一种来源——那时 chip / composer 写「正在跑的那个 · 切到 X · 尚未接管」，用户再选一次目标引擎即可重试。

`release` 在这两条路径上承担不同角色：preset 通道里它是 fire-and-forget（同步事件处理器），引擎选择器那一半里它是被 `await` 的（回包的承诺要成立）；两条路径都不让继任者原地发布——前者因为要换的是 **preset 的 composition**（只有 API 层会组装），后者因为 harness 的 loop 根本不肯接一条不是它自己创建的会话（完整链路与取证见 `docs/architecture.md` §3.7 与 `docs/per-session-engine.md` §5.4）。

### EngineBuilder 与运行时的生命周期

`EngineBuilder = (engine: HostedEngineId) => RouterEngine`（`:116`），`RouterEngine` 是类型擦除后的 `HostedEngineRuntime<object, HostedAgent>`（`:113`）——引擎之间只有配置与驱动不同，路由器调的事务面完全一致。builder 由插件提供（`src/index.ts:557-568` 的 `buildEngine`），且**在路由器所在的 inject fiber 上构造**（`src/index.ts:589-596`）：运行时的 ownership 因此绑在那根 fiber 上，插件卸载即全量回收（§4）。`runtimeOf` 的记忆化（`:223-229`）保证"一个引擎只有一个运行时"，这正是并发成立的前提：A 会话的 codex agent 与 B 会话的 kimi agent 各自持自己的子进程、scope 与流，互不干涉。

### 改它会波及谁

路由器是**每会话引擎归属的唯一判定点**。改判定规则（记录 → preset 映射 → 父继承 → resume 投影）会改变所有会话在哪个引擎上运行，动手前先确认三件事：`in-process` 仍走 `super`（否则进程内会话直接没了）、resume 不丢记录与持久化 preset（丢了会按 in-process 重建，用户的会话会突然换引擎）、换引擎仍只对"打开且空闲"的会话生效（`selectEngine` 的三步见 §10 末条：**校验 → 写记录 → `move`**；守门分支是会话未打开、turn 在飞、subagent 会话、路由器没有它的活记录，一律以 `code`（+ `reason` 作细节）拒绝；`move` 的实际效果分两种——**托管引擎之间是原地换手**（会话不重建、不释放），**涉及 `in-process` 时释放这条会话并回包 `reload: true`**（客户端重载页面并 `sessions.open(id)` 回到它，宿主随后按记录 `resume`；进程不重启）。**"已经在这个引擎上了"必须按活 agent 判断**：用记录判断会让释放失败留下的那个窗口里的重新选择变成空转，也会让用户无法把记录改回实际运行的引擎。

测试：`tests/router-loop.spec.ts` 覆盖本条的全部契约（fake 运行时 + mock 掉的 `engine-surface`）；`selectEngine` 与 `reportEngine` 由 `tests/engine-remote.spec.ts` 用真 `RouterLoop` 驱动（成功路径含两个方向上的"释放 + `reload: true`"、释放后 `ctx.agents.get` 已空、以及随后 `resume` 由 harness loop 重建而不再建任何托管引擎；全部拒绝臂；以及报告的形状）；`engineReportOfSession` 自己的折叠规则由 `tests/engine-of-session.spec.ts` 钉住（活 agent 优先、记录一致时不报 pending、冷会话没有 pending）；客户端的重载与回到会话由 `tests/session-engine-cache.spec.ts` 钉住（stash + `location.reload`、列表就绪后 `open`、列表里没有它时的 warn）；四个 `tests/engine-*/index.spec.ts` 用真实引擎驱动整个插件，验证运行时真被建起来、真被调用。

## 11. engine-surface.ts：按会话隔离的命令与技能面

### 解决什么问题

托管引擎拥有它自己会话的命令菜单与技能目录：`/name` 由引擎自己展开（§2 的斜杠命令步），指令文件由引擎自己读。插件要做的只是把这份面**桥进它服务的那个会话**——不多不少。

旧做法是在 `src/index.ts` 里按"当前挂载的引擎"全局注册（`commandDisposers` / `skillDisposer`，已删除）。那在按会话并发下必然错：A 会话跑 codex、B 会话跑 kimi 时，两个会话会看见同一个合并后的菜单。

### 为什么 `agent.ctx` 决定作用域

`registerEngineSurface(agent, engine, warn)`（`src/engine-surface.ts:77-97`）用 **`agent.ctx`** 而不是插件的 ctx 去取服务并注册，这一处选择就是全部作用域机制：

- `commands.register` / `skills.registerProvider` 把定义写进**调用方 ctx 所在 scope 的那一层**（harness `../deepseek-harness/packages/core/scope/src/store.ts:231` 的 `scopeOf(ctx)`）；
- agent 的 scope key 就是 agent 自己：默认 loop 用 `createScope(loopCtx, this)` 建 scope（`../deepseek-harness/packages/core/agent-loop/src/agent.ts:104`），四个托管驱动也各自这么做（`src/engine-claude/agent.ts:158`、`src/engine-codex/agent.ts:192`、`src/engine-pi/agent.ts:163`、`src/engine-kimi/agent.ts:156`），并把 `agent.ctx` 挂成 `scope.ctx.extend({ agent: this })`（同一处的下一行）。

于是注册天然按 agent 隔离：A/B 两个会话的菜单与技能目录互不可见，agent 的 scope 被拆掉时注册自动回收。插件侧因此不需要记账、不需要按引擎卸载，也不会在切引擎时泄漏。

### 每个引擎贡献什么

`SURFACES`（`:47-62`）是一份 `Record<HostedEngineId, EngineSurface>`，新增引擎不加一份就编译不过（刻意的，见 §4）：

| 引擎 | 命令 | 技能 provider |
|---|---|---|
| claude-code | `CLAUDE_CODE_COMMANDS` + `discoverUserSlashCommands()`（**每次调用现发现**用户级命令，`:49`） | `ClaudeCodeSkillProvider` |
| codex | 无（app-server 协议没有文本斜杠面，§2） | `CodexSkillProvider` |
| pi | 无 | `PiSkillProvider` |
| kimi | `KIMI_COMMANDS`（`src/engine-kimi/commands.ts:60`） | `KimiSkillProvider` |

命令写成惰性函数（`commands?()`）而不是常量，是因为 Claude Code 那份要在每次建 agent 时重扫 `~/.claude/commands/*.md`——会话中途新建的命令文件会出现在下一个会话的菜单里。调用点只有一个：`src/router-loop.ts:246`（`adopt` 里，只对非 `in-process` 调）。

### 失败姿态

- `commands` / `skills` 服务取不到（最小 profile 没组合）→ 静默跳过，不抛（`:83`、`:93`）；
- 某个命令与**同一层**已有的重名 → catch 后 warn 跳过这一条（`:86-91`）。重名有实际代价：`ui-commands` 会因为一个冲突的宿主命令把整份命令菜单源丢掉（`src/engine-kimi/commands.ts:21-24` 头注），所以宁可少一条命令，也不能让 agent 起不来。

## 12. host-servers.ts：宿主服务的结构化最小切片

插件消费一批**可选**的宿主服务（命令 / 技能 / preset 花名册 / settings 变更 / llm 路由 / 会话投影）。它们的类型有两种拿法：从各自的 `@deepseek-ai/dsh-*` 包里 import（要加 peer 依赖），或者在本文件里声明**它真正用到的那几个成员**。本文件选了后者：

- 最小 profile 不组合某个服务是合法的，加 peer 依赖会把"可选"变成"必需"；
- 这些服务都在 `ctx.get` 后面，类型上本就是 `T | undefined`，只要成员形状对得上，结构类型就够了——服务来自插件树而不是外部输入，所以这里不做运行时校验（校验只该出现在 parser / 配置 / wire / 进程边界）。

| 切片 | 位置 | 消费方 |
|---|---|---|
| `CommandsService` | `:22-25` | `src/engine-surface.ts:83-92`（在 agent scope 上注册命令） |
| `SkillsService` | `:28-31` | `src/engine-surface.ts:93-96`（在 agent scope 上注册 provider） |
| `AgentPresetsService` | `:34-39` | `src/index.ts:520`（读花名册默认值）与 `ensureEnginePresets` 的 `source.read`（`src/preset.ts:200-210`） |
| `SettingsMutator` | `:42-47` | `src/index.ts:465-491`（改 preset 花名册的 `default`） |
| `LlmRegistry` | `:67-70` | `src/index.ts` `mountProviderRoutes`（挂一个共享 provider 路由占位 `external`） |
| `SessionProjectionsService` + `SessionModelSelection` + `ModelSelectionFacts` + `TurnBoundaryFacts` | `:73-116` | `src/router-loop.ts:643-647`（空白期判定，§10）与 `src/model-selection-reset.ts:171-174、:191-194`（换引擎那一刻与"构建那一刻"写这条会话的模型座位，见 `docs/architecture.md` §3.7） |

两条约束：

- **只声明用到的成员。** 切片里没有的方法不代表宿主没有，只代表插件不靠它。给切片加成员时应当同时指出唯一的调用点。
- **不是所有 ctx 切片都放这里。** `SessionQuery` / `SessionObservationLease`（`src/engine-of-session.ts:49-61`）不在本文件里，而在唯一读它的模块旁边：它们带 `[Symbol.dispose]()` 的租约语义，与 `observeSession` 的调用形状绑得更紧。判断标准是"有几个消费者"——`engineOfSession` 现在有三个（路由器的 `resume`、插件自己的 Remote 的后备读、以及 `engineReportOfSession` 的折叠，`docs/architecture.md` §4.3），所以它有了自己的模块，但切片本身仍然只有一个读取函数。

## 附：代码与注释不一致之处（本文撰写时核实）

### A. kimi/pi 引擎加入前的旧表述

原先有六处模块头注仍是 "Both the Claude Code and Codex …" 这类旧表述。其中四处已订正为"四个引擎"或"每个托管驱动"，另两处仍待订正：

1. ~~`src/driver-core/ownership.ts`、`prompt.ts`、`permission-knobs.ts`、`skill-inject.ts`~~ ——已订正。
2. `src/driver-core/context-files.ts:4-6`："Codex and Pi read per-directory instruction files"——kimi 也通过本模块读 `AGENTS.md` 链；同段 "feed both providers' list/get paths"（`:9-10`）同样漏了 kimi。
3. `tests/driver-core/context-files.spec.ts:2-3`："used by the codex and pi skill providers"——kimi provider 同样是消费方。

第 2 条顺带说明一件事：`context-files.ts` 的三个消费方现在都是**共享 provider** 而非各自的引擎模块——它被 `driver-core/agents-md-skill-provider.ts:29` 导入，而不是被 codex/pi/kimi 的 skills 模块直接调用。改它的行走语义时，要看的是共享 provider 的候选构造（`:153`、`:170`），再看三份引擎 spec。

### B. 按会话并发多引擎重构后未跟上的表述

~~`src/driver-core/ownership.ts` 的模块头、`src/driver-core/hosted-engine-runtime.ts:182` 的 jscpd 忽略标记、四个 `src/engine-*/loop.ts` 的模块头~~——这批按"进程内只有一个托管工厂、引擎是全局选择"旧架构写的注释已订正：

4. `src/driver-core/ownership.ts:1-12` 现在写 "one runtime per engine owns that engine's live agents … The process-wide AgentFactory slot is the router's, not any engine's; these helpers are engine-free"——与该槽位其实归路由器、引擎运行时各有自己一份 ownership 的事实一致（§10、§4）。
5. `src/driver-core/hosted-engine-runtime.ts:182` 的 jscpd 忽略标记把 "depending on agent-loop is forbidden" 换成了"事务体无法复用 `AgentLoop` 的私有实现，所以镜像一份"。旧说法与代码直接冲突：`src/router-loop.ts:55` 本身就 `import AgentLoop from '@deepseek-ai/dsh-agent-loop'`，`package.json` 里它也是 peer 依赖。
6. 四个 `src/engine-*/loop.ts` 的模块头改成了 "drives every session it is handed … The router routes a session here on the plugin's own engine record, else its agent preset; this module is a library, not a Cordis plugin entry"（如 `src/engine-claude/loop.ts:2-6`、`src/engine-kimi/loop.ts:2-7`），与子类 docstring（"The process-wide AgentFactory slot belongs to the router"，claude `src/engine-claude/loop.ts:91-95`、kimi `src/engine-kimi/loop.ts:66-70`）不再并存两种说法——构造时机也与实现一致：第一次有会话用到它时由 builder 惰性构造并常驻（`src/router-loop.ts:223-229`）。
