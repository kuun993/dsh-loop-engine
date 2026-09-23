# claude-code 引擎实现文档

本文面向要修改 dsh-loop-engine 中 **claude-code 引擎**的工程师，讲清机制、数据流、设计约束和坑。所有论断均标注源码位置；行号以当前工作区版本为准，改动后请同步核对。

## 1. 引擎概述

claude-code 引擎用官方 **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`）驱动 dsh 会话。核心模型是：

- **每个 dsh step 一次无状态 query**（`src/engine-claude/loop.ts:2-6` 模块注释）。SDK 进程不保留任何会话状态：`persistSession: false`（`src/engine-claude/sdk.ts:97`），dsh 的持久化 session log 是模型上下文的唯一来源。注意**反方向不成立**：一次 query 里模型会跑很多个内部轮次，driver 会在片段边界把 dsh step 轮转开（§4.1），所以一个 query ≠ 一个 step。
- **prompt 是 session log 的纯序列化**。每个 step 调用 `Session.deriveMessages()` 派生历史，经 `serializeHistory` 渲染成 `<user>...</user>` / `<assistant>...</assistant>` / `<tool-result>...</tool-result>` 标签文本作为整段 prompt（`src/engine-claude/agent.ts:527-531`、`src/driver-core/prompt.ts:150`）。这实现了 harness 的"model-visible ⟺ logged"约束：重放同一份 log 必然得到同一份 prompt。**例外**是本步最后一条消息就是一条斜杠命令：那时改发裸行（`engineSlashPrompt(history) ?? serializeHistory(history)`，`src/driver-core/prompt.ts:122`，见 §7.1），否则 CLI 的本地命令派发看不到它。
- **Claude Code 拥有自己的 prompt、工具和权限**。SDK 子进程是真正的 agent 运行时（自带系统提示、内置工具、技能展开）；dsh 侧只做收件箱、turn/step 边界、事件落盘和审批转发（`src/engine-claude/agent.ts:1-8`）。
- **进程模型**：SDK 的 `query()` 内部 spawn 一个 `claude` CLI 子进程。引擎通过 SDK 的 `spawnClaudeCodeProcess` 钩子把 spawn 请求转交给 dsh 的 subprocess seam（`src/engine-claude/sdk.ts:145-148`），子进程树的生命周期（终止升级阶梯、grace）由 harness 统一管理，而不是 SDK 直接 `child_process.spawn`。

与 dsh 的关系：harness 只有一个 `AgentFactory` 槽位（主仓 `packages/core/agent/src/index.ts:357`，重复注册抛 `an agent factory is already registered`）。插件入口 `src/index.ts` 用**与引擎无关的常量 managed block** 禁用 base bundle 的 `agent-loop` 行（`src/patch-manager.ts:59-68`），把槽位让给路由器 `RouterLoop`（`src/router-loop.ts:114`）——它继承 harness 的 `AgentLoop`，所以 `in-process` 会话也走它。路由器按插件自己的**每会话引擎记录**分发、该会话无记录时回退到它记录的 **agent preset**，某个会话第一次选中 claude-code 时才构造 `ClaudeCodeLoop`（`src/index.ts:558-559`、`src/router-loop.ts:158-164`）。设置页选的引擎只是**新会话的默认引擎**，不改写配置文件，也不需要刷新页面或重启。

## 2. 模块组成与各文件职责

`src/engine-claude/` 是一个**库**而不是 cordis 插件入口（`src/engine-claude/loop.ts:6`）：`ClaudeCodeLoop` 是普通类，由路由器在会话选中 claude-code 时构造（`src/index.ts:558-559`）。

| 文件 | 职责 |
|---|---|
| `loop.ts` | `ClaudeCodeLoop`：AgentFactory 实现 + cordis 服务（ctx key `agentLoopClaudeCode`）。负责配置校验、agent 创建/resume 的事务化发布、工厂级 ownership。 |
| `agent.ts` | `ClaudeCodeAgent`：`Agent` 接口实现。收件箱、turn/step 驱动循环、每个 step 跑一次 SDK query 并把转录映射进 session log、技能注入、权限裁决。 |
| `sdk.ts` | 单次 query 的 `Options` 组装（`claudeQueryOptions`）：无头交互策略（自动拒绝/取消/降级）、权限模式落地、spawn 桥接。不持有任何会话状态（`src/engine-claude/sdk.ts:1-7`）。 |
| `process.ts` | `ManagedClaudeCodeProcess`：把 dsh subprocess seam 的 `SubprocessHandle` 投影成 SDK 的 `SpawnedProcess` 接口（stdin/stdout/exit/kill）。 |
| `mapping.ts` | SDK 消息词汇 → dsh session 事件词汇的**纯函数**翻译，不依赖 SDK 进程，可独立单测（`src/engine-claude/mapping.ts:1-8`）。 |
| `permission.ts` | 从 session log 的权限旋钮折叠出单次 query 的原生权限姿态；生成审批理由文本。 |
| `types.ts` | 公开类型：`ClaudeCodePermissionMode`（SDK `PermissionMode` 的非交互子集）与 `ResolvedConfig`。纯类型，无运行时代码。 |

被引用的共享基础设施（`src/driver-core/`）：

- `prompt.ts` — `serializeHistory`，见第 4 节。
- `ownership.ts` — `FactoryOwnership`（工厂卸载时取消并等待所有存活 agent 的 teardown）、`raceAbort` / `raceAbortCall`（setup 等待与融合 abort 信号竞速）——**原语**。
- `hosted-engine-runtime.ts` — `HostedEngineRuntime`：把上面的原语编排成 create/resume 的 prepare→setup→publish 事务；claude 只提供 label、`resolveConfig` 与 `buildAgent`（第 3.1/3.2 节）。
- `inbox.ts` — `DriverInbox`：会话自己的 durable 收件箱投影（把 `agent/inbox/spliced` 事件重放折叠成待处理输入），替代 harness 已改成接口的 `Inbox`。
- `assistant-stream.ts` — `DriverAssistantStream`：一次流式尝试的 live 帧（`agent/assistant-stream` 的 start/chunk/end）与交给 durable `assistant/message` 的内嵌 `stream` 压缩。
- `permission-knobs.ts` — 从 session log 读取最后一条 `sandbox/mode` / `approval/policy` 事件的引擎无关读取器。
- `skill-inject.ts` — `/name` 手势扫描、`isSkillName` 校验、`<skill_content>` XML 渲染与转义。
- `context-files.ts` — **claude 引擎不使用**。它是 codex/pi/kimi 的 AGENTS.md 收集器；claude 的技能发现在 `src/skills.ts` 自成一套（见第 7 节）。任务清单把它列入"被引用"是误列，改 claude 引擎时不用看它。

引擎外的两块 claude 专属代码：`src/commands.ts`（斜杠命令桥）与 `src/skills.ts`（`ClaudeCodeSkillProvider`），均由 `src/engine-surface.ts` 的 `registerEngineSurface` 在 **agent 创建时**注册进该 agent 自己的 scope（`src/engine-surface.ts:47-62`、`:77-96`；调用点 `src/router-loop.ts:171`）。**不再是插件的全局注册**——两个并发的 claude 会话各有自己的层，菜单互不可见，agent scope 拆除时一起回收。

## 3. 引擎运行时与 Agent 生命周期

### 3.1 引擎运行时与槽位归属

`ClaudeCodeLoop` 是 `HostedEngineRuntime<ResolvedConfig, ClaudeCodeAgent>` 的**三行子类**（`src/engine-claude/loop.ts:96-108`）——一个**普通类**，不是 Cordis Service，不声明 `static inject`，也不自己占用 AgentFactory 槽位。ctx key 仍是 `agentLoopClaudeCode`（`src/engine-claude/loop.ts:83`、`:85-89` 的模块声明）。构造函数里：

- `super(ctx, CLAUDE_CODE_ENGINE_LABEL, resolveConfig(config))`（`:101`）——label 同时是全部 effect label 的前缀。
- `resolveConfig` 在插件配置边界做校验（`src/engine-claude/loop.ts:63-80`）：`disposeGraceMs` 必须是正有限数且不超过 `MAX_TIMER_DELAY_MS`（超过 32 位定时器上限会静默溢出，所以硬拒绝）。
- 唯一的重写是 `buildAgent`（`:105-107`）：`new ClaudeCodeAgent(loopCtx, id, options, session, this.config)`。

`subprocess` 服务不再靠 `static inject` 保证：引擎是 `new` 出来的普通类，没有 Cordis 的注入列表可声明。claude 驱动只需要一个 `loopCtx.subprocess.spawn`（第 6 节），在使用点从 ctx 取；缺服务时是选中 claude-code 的那个会话大声失败，而不是整个插件启动失败。

槽位归路由器：进程内唯一的 AgentFactory 是 `RouterLoop`（`src/router-loop.ts:114`），它继承 harness 的 `AgentLoop`，按插件自己的每会话引擎记录分发（无记录时回退到会话记录的 agent preset），并在某个会话第一次选中 claude-code 时构造 `ClaudeCodeLoop`（`src/index.ts:558-559`，实例缓存于 `RouterLoop.runtimeOf`，`src/router-loop.ts:158-164`）。基类（`src/driver-core/hosted-engine-runtime.ts`）在构造时只做两件事：

- `ctx.reflect.provide(label, this)` 把实例挂到 ctx key（`hosted-engine-runtime.ts:109`）——**这是内省面，不是 `setFactory`**；
- 注册工厂所有权 effect，fiber 卸载时停掉所有权、所有存活 agent 的反向拆解随之执行（`hosted-engine-runtime.ts:115`）。

`provider` / `model` / `cwd` 三个 system-prompt 变量与 `agent-loop` settings section 都**不**在引擎这一层：它们由路由器继承的 harness `AgentLoop` 提供（`src/router-loop.ts:114-141`；注册点在主仓 `packages/core/agent-loop/src/index.ts:421-423`，settings section 在 `:401`）。注意：claude 引擎**不用** dsh 的系统提示组装，这些变量只是喂给下游可能读取它们的消费者。

### 3.2 创建与发布事务

> **这套事务已抽到 `src/driver-core/hosted-engine-runtime.ts`，四个引擎共用一份**（`docs/driver-core.md` §4 有完整说明）。下面描述的是共享体的行为，claude 只是其中一个子类——条目中的行号除特别注明外都指共享文件；路由器对每个会话调用的就是这两个入口（`src/router-loop.ts:203-212`、`:226-235`）。

`createAgent` / `resume` 都走同一个 `prepare → setup → publish` 事务（`prepare` 见 `hosted-engine-runtime.ts:132-246`，`setupAndPublish` 见 `:249`）：

1. `prepare` 通过 `this.buildAgent(...)`（`:218`）构造 `ClaudeCodeAgent`，并建一个**备忘化**（memoized）的反向 teardown。teardown 在发布**之前**就注册进 `FactoryOwnership` 和 owner fiber 的 effect，因此 setup 中途工厂卸载或 owner 卸载都会整体回滚。
2. 三方取消信号融合：caller 的 `signal`、owner fiber 卸载、工厂 teardown，共同驱动一个 `AbortController`，`prepared.signal` 供 setup 等待竞速（`hosted-engine-runtime.ts:148-156`）。
3. `setupAndPublish` 里 `raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id)` 跑调用方的 setup，成功后 `commit()` 再 `publish`：`publish` 回调逐个进 `sessions` / `agents` 两个注册表 → `announce` → 发 `agent/session-start`（`hosted-engine-runtime.ts:272`、`:225-236`）。失败路径 `await prepared.dispose()` 后重抛。
4. `resume` 额外要求 `sessionPersistence` 服务存在，否则响亮失败（`hosted-engine-runtime.ts:377-378`）；加载阶段同样与取消信号竞速，加载完成才被取消的 preparation 会被 `[Symbol.dispose]()` 释放（`hosted-engine-runtime.ts:408-413`、`:449-452`）。

`dispose` 的顺序固定：abort 融合信号 → `machine.cancel({ kind: 'disposed' })` → `whenIdle()` 等驱动退出 → `scope.dispose()` → 摘注册 → 摘 owner 跟随（`hosted-engine-runtime.ts:163-193`）。`disposeGraceMs` 不在这一层生效——它是给 SDK 子进程树的终止宽限（见第 6 节），agent 级 dispose 不等它。

### 3.3 Agent 的 turn/step 驱动

`ClaudeCodeAgent` 的状态机是三态 `Phase`：`idle` / `maintenance` / `running`（`src/engine-claude/agent.ts:64-72`）。

- **收件箱**：`DriverInbox` 区分 `next-turn` 与 `next-step` 两个目标；`followup` 排 next-turn 并唤醒、`steer` 排 next-step 并唤醒、`inject` 排 next-step 不唤醒（`src/engine-claude/agent.ts:156-174`）。`cancel` 默认清空收件箱并 abort 当前 phase；`keepInbox` 保队列（`src/engine-claude/agent.ts:176-182`）。
- **唤醒**：`wakeDriver` 只在 idle 时开新 driver；非 idle 时若原因是 maintenance 或"abort 后唤醒"则 latch `wakeRequested`，driver 退出时若收件箱仍有消息会接力唤醒（`src/engine-claude/agent.ts:219-237`、`254-268`）。一个细节：abort 之后收到的 wakeup 会被 `send` 重分类为 `next-turn`（`src/engine-claude/agent.ts:146-148`），保证它开启新 turn 而不是混入已死的 step。
- **turn**：`turn/start` 落盘 → 循环 `preStep`（claim 消息 → `agent/pre-step` waterfall，可被拦截 reject → 技能注入）→ `step/start` → 每条用户消息落 `user/message` → `step()` → `step/end`。turn 结束原因在 `turn/end` 落盘：`completed` / `blocked` / `aborted` / `error`。`agent/turn-stopping` serial 事件给拦截器最后一次注入输入的机会。
  两个关键点：① `step()` 内部会在助手片段边界轮转 step（§4.1），所以收尾的 `step/end` 关的是 `phase.step` 而非本次迭代开头开的 step；② **轮转出来的 step 不重跑 `preStep`**——只有 turn 的第一个 step 走 inbox claim / waterfall / 技能注入，因为一次 query 是原子的、中途也无法投递 steer/inject。
- **request/header**：每个 loop 实例只在第一个 step 前落一次，`reason` 按 session 是否已有 baseline 区分 `initial` / `resume`（`src/engine-claude/agent.ts:447-458`）。header 的 model 标签是 `config.model ?? 'claude-code-native'`——**故意不镜像** web 会话的模型选择，因为那个选择从不驱动 query（`src/engine-claude/agent.ts:51-56`；背景见 `docs/proposals/model-selection-disable.md`）。provider 标签 `'claude-code'` 由插件**常驻**注册为占位 provider 路由——四个托管标签（`claude-code`/`codex`/`pi`/`kimi`）同时在场，因为任何会话都可能选中任一引擎（`src/index.ts:362-389` 的 `mountProviderRoutes`、`src/provider-route.ts:27-33`；见 `docs/architecture.md` §3.6），否则宿主按 header 推导的会话模型选择会让第二轮 prompt 被 `model-unavailable` 拒绝。

### 3.4 中断与销毁

step 内的取消路径：phase 信号 → 单次监听器转成 per-query `AbortController` 的 abort（`src/engine-claude/agent.ts:482-491`）→ SDK 中断 query、终止子进程。`turn` 的 catch 区分：信号已 abort → `turn/end` 记 `aborted`；否则记 `error` 并经 `throwError` 先派发 `agent/error` 再抛出，由 `kick` 的 driver 边界收容（`src/engine-claude/agent.ts:246-268`、`414-433`）。`finally` 里无条件 `controller.abort()` 并摘掉监听器（`src/engine-claude/agent.ts:659-665`）。

## 4. 事件/消息映射

映射分两个方向。**入方向**（dsh → SDK）只有一件产物：prompt 文本（第 1 节）。**出方向**（SDK → dsh）在 `agent.ts` 的 `for await (const message of query)` 循环里按 `message.type` 分派（`src/engine-claude/agent.ts:532-651`），翻译逻辑全部在 `mapping.ts`：

- **`stream_event`**（SDK 原始流事件，因 `includePartialMessages: true` 才有，`src/engine-claude/sdk.ts:91-96`）：`mapStreamEvent` 把 `content_block_start` / `content_block_delta` 翻成 dsh `StreamChunk`（`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta`），每个 chunk 交给这次尝试的 `DriverAssistantStream`（`currentStream()`）：它把 chunk 按时间戳压进 compact stream，并发一条 `agent/assistant-stream` 的 `chunk` 帧（`src/engine-claude/agent.ts:512-524`、`535-543`；`src/driver-core/assistant-stream.ts:72-82`）。tool_use 的 call 身份（callId + name）在 `content_block_start` 时按 block index 记进 `toolCalls` Map，供后续 `input_json_delta` 命名；匹配不到时合成 `call-${index}`（`src/engine-claude/mapping.ts:221-223`、`236-243`）。`content_block_stop`、`message_*` 等传输事件不产出 chunk——durable 消息由完整 `assistant` 消息另行落盘；chunk 的 live 帧只驱动 web 端的实时 partial 投影，同一批 chunk 还会作为消息内嵌的 stream 落盘。
- **`assistant`**：`mapAssistantMessage` 逐 block 翻译——text 原样、tool_use 同时产出 `tool-call` 内容块和一条 `tool/call` 事件（SDK 的 tool_use id 直接复用为 dsh `ToolCallId` 以便结果配对）、thinking → `reasoning`、redacted-thinking 与未知块丢弃（`src/engine-claude/mapping.ts:72-114`）。usage 经 `mapUsage` 翻译，cache 计数为 null 时省略（`src/engine-claude/mapping.ts:180-187`）。内容块保留 SDK 的原名（`Read`/`Write`/`Edit`/`Bash`/`TodoWrite`），而落盘的 `tool/call` 事件经 `normalizeHostedToolCall('claude-code', …)` 投影成 dsh 名（`Read→read` 等），让客户端工具行与产出文件行认得它；`TodoWrite` 额外 append 一条 `todo/write` 事件驱动 dsh 待办面板。两者按 callId 配对，故下一次查询的 prompt（从内容块序列化）仍是 SDK 词汇（`src/driver-core/hosted-tool-vocabulary.ts`）。
- **`user`**（query 内部只承载工具结果）：`mapToolResults` 提取 `tool_result` block 翻成 dsh `tool/result` 事件；字符串内容原样、block 数组只取 text、空内容补 `(no content)` 占位块以便关联（`src/engine-claude/mapping.ts:123-172`）。
- **`result`**：`success` 标记 `finished`；其余 subtype 抛 `LlmError`，错误码为 `CLAUDE_CODE_<SUBTYPE>`，未知 subtype 归一为 `CLAUDE_CODE_ERROR`（`src/engine-claude/agent.ts:81-91`、`638-643`）。流结束而未见 result 抛 `CLAUDE_CODE_NO_RESULT`（`src/engine-claude/agent.ts:652-657`）。
- **其余**（`system`/init/status/permission/control 等 SDK 传输消息）：直接跳过——durable log 只记模型可见的转录（`src/engine-claude/agent.ts:646-649`）。

**思维链的三种兜底**（`src/engine-claude/agent.ts:544-577`、`610-637`），这是映射里最容易踩坑的部分：

1. provider 把 thinking 拆成独立的 reasoning-only assistant 消息：按住不落盘，折进下一条消息（否则"最后一条 assistant 消息生效"的 step 投影会丢掉 thinking）；其 usage stash 到 `pendingUsage`。
2. provider 流式发了 thinking delta 但完整消息里没有 thinking block：用 chunk 累积的 reasoning 合成 block 补在内容前面；完整消息自带 thinking 时丢弃累积，防止重复。
3. step 以 reasoning-only 消息结束（`result` 到达时仍按着）：作为独立 durable 消息 flush，模型标签记 `claude-code-native`。

### 4.1 一段一步（step 轮转）

一次 query 跑完模型的整个 agentic loop，所以**一个 dsh step 里会出现多个助手片段**（实测一个 step 最多 16 条 `assistant/message`）。这必须拆开，原因是渲染侧的硬约束：chat 的助手节点按 `${turn}:${step}` 建键（`packages/client/ui-chat/src/client/conversation-nodes/assistant.ts`），同一 step 里的多条消息落到**同一个**节点，而 `settleMessage` 是**整体替换** blocks——N 条只渲染最后一条。节点排序又只按 `anchorSeq`（= 消息的 seq），没有"step 的助手节点排在它的工具行之前"这种规则。

所以 `beginSegment`（`src/engine-claude/agent.ts`）在新助手内容落盘前轮转 step：本 step 已有 settled 的 `tool/result` 时补 `step/end` + `step/start` 并就地 `phase.step += 1`；该段自己的 `assistant/message` 与 `tool/call` 随后落进新 step。这复刻了 in-process 引擎的形状（**一步恰好一条消息、且该消息在工具执行之前落盘**，于是消息的 seq 小于它自己的工具行）。`turn()` 的 `finally` 关的是 `phase.step`（当前真正打开的那个），不是本次迭代开头开的那个。

轮转由「本 step 已有 settled 结果」触发，**不是**「有调用被公告」：模型一次请求多个工具时调用会在任何结果之前全部公告，此时仍属同一个模型轮次，必须留在同一个 step。

连带的取舍：`result` 会把**整个 query** 的 token 总量作为一条 usage-only 的 `assistant/attempt` 落盘（见上）。一个 step 独占整个 query 时这就是该 step 的总量、行为不变；一旦轮转过，没有任何一个 step 拥有这个总量，而每个片段的消息已各自携带自己的 request usage，所以该记录在轮转后**不再落盘**（`rotated` 标志）。

另外，`assistant/message` 落盘时把这次尝试的 compact stream **内嵌**成 `data.stream`——harness 禁止内嵌了 stream 的消息再带 `sourceEventSeqs`（主仓 `packages/core/session/src/surface.ts:275` 直接抛错）；提交成功后 `DriverAssistantStream.settle` 发 `end`（`committed`）帧，而流过却没能提交 durable 消息的那一段会在 `finally` 里 `abandon()`，发 `end`（`abandoned`）帧，让 web 端停止绘制被遗弃的 partial。

## 5. 权限模型

权限裁决分两层，每个 query 独立折叠一次（中途切换预设即时生效）：

1. **部署钉死的 `permissionMode`** 无条件胜出（`src/engine-claude/agent.ts:340`）。
2. 否则读 session log 的 dsh 权限旋钮（`resolveSessionPermission`，`src/engine-claude/permission.ts:33-37`）：
   - `sandbox/mode = danger-full-access` → `bypassPermissions`（web 的 "full" 预设会同时钉 `never` 策略，full access 无条件胜出）；
   - `approval/policy = ask` → 若宿主有 `approval` 服务，`permissionMode: 'default'` + `onToolPermission` 把每个原生权限请求转发到 dsh 审批缝（`allowed-once` → `allow` 其余 → `deny`，理由文本带 200 字符上限的工具输入摘要，`src/engine-claude/agent.ts:343-358`、`src/engine-claude/permission.ts:39-53`）；没有审批服务时**落到 deny**；
   - 其他一切（含从未记录过旋钮的会话）→ `deny`，即 `dontAsk`。

落到 SDK `Options` 时（`src/engine-claude/sdk.ts:98-126`）：

- `bypassPermissions` → `allowDangerouslySkipPermissions: true`，**不装** `canUseTool` 钩子。
- 其余模式装 `canUseTool`：有 `onToolPermission` 转发则按裁决 allow/deny；没有则一律 deny 并报诊断。
- `disallowedTools` 恒定禁 `AskUserQuestion`，`plan` 模式追加 `ExitPlanMode`——无头驱动不能阻塞等人回答。
- 三类交互统一自动应答并产生一行诊断（经 `onUnattended` 上抛，agent 在 step 结束时不计顺序地 `logger.warn` 出去，`src/engine-claude/agent.ts:508`、`663-665`）：`canUseTool` 自动 deny、`onElicitation` 自动 decline（不收交互式 MCP 输入）、`onUserDialog` 自动 cancel；`supportedDialogKinds` 只声明 `refusal_fallback_prompt`（`src/engine-claude/sdk.ts:22-23`、`127-145`）。

可选模式全集是 SDK `PermissionMode` 的非交互子集：`dontAsk` / `acceptEdits` / `auto` / `plan` / `bypassPermissions`（`src/engine-claude/types.ts:10-15`、`src/engine-claude/loop.ts:22-28`）。`default` 不出现在配置里——它只在 ask 转发路径内部使用。

## 6. 进程与 SDK 管理

分工：`sdk.ts` 负责"一次 query 要什么"，`process.ts` 负责"SDK 的 spawn 请求怎么交给 dsh"。

**env 注入**（两层，注意别混）：

- `claudeQueryOptions` 给 SDK 的 `env` = `scrubbedParentEnv()` + 部署的 `config.env`（`src/engine-claude/sdk.ts:87-90`）。`scrubbedParentEnv` 是主仓 subprocess 包的公共定义：剔除所有 credential 形状的名字（`/KEY|PASSWORD|SECRET|TOKEN/i`）和全部 `DSH_*`（大小写不敏感），保留 `PATH`/`HOME`/locale/代理（主仓 `packages/subprocess/subprocess/src/index.ts:38-78`）。
- SDK 拿到这个 env 后会再做自己的增删，最后把**完整的子进程环境**放进 `SpawnOptions.env` 传给 spawn 钩子。`sdkEnvironmentOverlay` 把它转成 subprocess spec 的 overlay：SDK 删掉的、但 scrubbed 父环境里存在的名字要补 `undefined` 墓碑，否则它们会从 overlay 基座里复活（`src/engine-claude/process.ts:32-40`）。想显式传 credential（比如给 CLI 用的 token）只能走 `config.env`，它在 scrub 之后合并。

**spawn 桥接**：`claudeSpawnSpec` 把 SDK 的 `SpawnOptions` 翻成 `SubprocessSpawnSpec`：`argv = [command, ...args]`、`stdio` stdin/stdout pipe + stderr inherit、`graceMs = disposeGraceMs`（默认 3000，`src/engine-claude/sdk.ts:21`）、转发 SDK 的 `signal`；`cwd` 缺失直接抛（`src/engine-claude/process.ts:48-63`）。实际 spawn 走 `loopCtx.subprocess.spawn(spec)`（`src/engine-claude/agent.ts:507`），子进程树归 harness 的 subprocess 实现管。

**进程投影**：`ManagedClaudeCodeProcess` 实现 SDK 的 `SpawnedProcess`：透传 stdin/stdout，把 `child.done` 的 settle/reject 投影成 `exit`/`error` 事件；`kill()` 忽略 SDK 选的信号（注释：升级阶梯归共享 seam 所有），幂等地转调 `child.terminate()`，已退出或已请求过返回 `false`（`src/engine-claude/process.ts:69-133`）。构造函数里给 `error` 挂了 no-op 监听器——EventEmitter 对无监听器的 `error` 有特殊 throw 语义，而 SDK 是在 custom spawn 返回后才同步挂监听，这个 no-op 同时收容一个已经 reject 的 spawn 句柄（`src/engine-claude/process.ts:83-86`）。

## 7. 斜杠命令与技能注入

### 7.1 斜杠命令桥（`src/commands.ts`）

dsh 的 `commands` 服务会本地消费已注册命令——行不进模型。但 Claude Code 命令的真正处理在 CLI 内部，所以所有注册的 claude 命令 handler 只做一件事：把原始 `/<name> [args]` 行以普通用户消息 `followup` 回给 agent，由 CLI 原生展开（`src/commands.ts:64-72`）。注册的意义是让这些命令出现在 web 斜杠菜单里。

转发回来的行之所以能被 CLI 展开，靠的是驱动侧的斜杠命令步：`engineSlashPrompt` 让本步的 prompt 就是那一行（`src/engine-claude/agent.ts:531`）。CLI 的派发条件是 `T.startsWith("/")`（`rCb` 里 `F !== null && !G && F.startsWith("/")` → `processSlashCommand`），带 `<user>` 框架的转录永远不满足，`/status` 就成了给模型的散文。

- 内置 4 个：`help` / `compact` / `clear` / `review`（`src/commands.ts:88-93`）。这份清单是**实测**出来的：逐条真跑一次 SDK query，`/help`、`/compact`、`/clear`（回一条 `conversation_reset`）、`/review`（真跑一次 review 流程）都被 CLI 当命令处理，而 `/explain`、`/fix`、`/tests` 回 `Unknown command: /xxx`——所以后者已从清单删除。（注意 `/status` 在 SDK 环境回 `isn't available in this environment.`：多数本地命令只在交互 TUI 可用，这是**引擎自己的答复**，会作为 assistant 消息（`model: "<synthetic>"`）落进会话，驱动无需特判。）
- **用户级自定义命令**（`~/.claude/commands/*.md`）由 `discoverUserSlashCommands` 同步扫描注册：只收 `.md`、名字须过 dsh 命令名语法、与内置重名跳过；描述取 frontmatter `description`，否则取正文首个非空非标题行（>120 字符截断），都没有则跳过（`src/commands.ts:103-129`）。同步扫描是有意的——注册点没有 await 点，命令必须在 agent 发布前注册完（`src/commands.ts:95-102` 头注）。
- **项目级 `.claude/commands/` 故意不注册**：它们依赖 cwd，全局注册会跨项目冲突；未注册的 `/行` 本来就会当用户文本透传给 CLI，命中命令步后照常裸发。
- 注册时与 dsh 原生命令撞名：警告并跳过（`commands.register` 抛错就 warn 并继续），不让 agent 启动失败（`src/engine-surface.ts:84-91`）。

### 7.2 技能 provider（`src/skills.ts`）

`ClaudeCodeSkillProvider` 从三处发现技能（格式与 dsh 技能相同：YAML frontmatter + markdown）：

- `<git 根>/.claude/skills/`（rank 150，项目级，锚定 git 根）；
- `~/.claude/skills/`（rank 160，项目技能赢重名）；
- 项目根的 `CLAUDE.md`——**仅当它带技能 frontmatter**（`name` + `description`）才收，rank 150（`src/skills.ts:224-242`、`301-314`）。

两种布局都支持：`<name>/SKILL.md`（目录成为 resource base，`scripts/`、`references/` 相对它解析）和平铺的 `<name>.md`（resource base 是 skills 目录本身）。frontmatter 解析器是手写的 YAML 子集，支持 `>` / `|` 块标量（Claude Code 的 SKILL.md 大量用 folded `description: >`），认识 `disable-model-invocation` 与 `user-invocable` 两个开关（`src/skills.ts:84-200`）。Windows 技能安装器用 junction，`stat` 跟随链接来判断类型（`src/skills.ts:278-283`）。注意：rank 150 介于 project-dsh（100）与 custom（300）之间，即 claude 技能**压过**项目自带的 dsh 技能（`src/skills.ts:68-71`）。

### 7.3 技能注入（agent 侧）

进程内引擎的技能注入由 dsh-tool-skill 在 agent-preset 上下文链上完成，而 claude agent 的上下文不从那条链派生，所以 `preStep` 里复刻了一遍手势扫描（`src/engine-claude/agent.ts:282-291` 注释）：

- 只扫 `source.kind === 'user'` 的消息的 text block 里空白边界的 `/name` 手势（kebab-case），按首次出现去重（`src/driver-core/skill-inject.ts:84-97`）。
- 经 `skills.get(name, { signal, scope, cwd })` 加载；加载失败、未找到、`userInvocable === false` 都静默跳过。
- 命中的技能渲染成 `<skill_content>` XML（名称/路径/provider 转义）作为 `source: { kind: 'skill-invocation', form: 'instructions' }` 的用户消息**追加**到本步批次，随批次落 `user/message`（`src/engine-claude/agent.ts:302-328`）。
- 加载期间 step 被取消：整批注入丢弃（`src/engine-claude/agent.ts:321`）。

这条路径同时是技能内容进入模型的**唯一**通道——渲染结果随下次 query 的 prompt 序列化进 `<user>` 段。

## 8. 配置项一览

配置从 `cordis.yml` 的 composition entry 进来：`src/index.ts` 的 `Config` 是全引擎超集，`claudeCodeConfig` 只挑出 claude 的字段转发（`src/index.ts:217-225`），`ClaudeCodeLoop` 再用自己的 schemastery schema + `resolveConfig` 校验。schema 只在字段存在时校验、缺省落 `undefined`（`src/engine-claude/loop.ts:54-60` 与 `src/index.ts:111-121` 注释），所以 `resolveConfig` 里仍保留 `??` 兜底——测试里有"不经插件 schema 直接构造"的路径。

| 配置项 | 类型 / 默认 | 生效位置 |
|---|---|---|
| `permissionMode` | 五选一，缺省 = 跟随会话旋钮 | 每个 query 的权限裁决，见第 5 节 |
| `env` | `Record<string,string>`，默认 `{}` | 叠加在 scrubbed 父环境之上传给 SDK（`src/engine-claude/sdk.ts:87-90`） |
| `model` | 缺省 = 原生模型 | **双重作用**：request header 的模型标签（`src/engine-claude/agent.ts:442-444`），且作为 SDK `model` override 传给 query（`src/engine-claude/agent.ts:505`、`src/engine-claude/sdk.ts:102`） |
| `disposeGraceMs` | 默认 3000，须为正有限数且 ≤ `MAX_TIMER_DELAY_MS` | 子进程树终止宽限（`src/engine-claude/process.ts:59`） |
| `maxTurns` | 正整数，缺省不限 | SDK `maxTurns`（`src/engine-claude/sdk.ts:103`） |

会话级输入（非配置项）：`sandbox/mode` 与 `approval/policy` 旋钮事件（第 5 节）、session 元数据里的 `cwd`（每个 query 的工作目录，缺失则 step 直接报错，`src/engine-claude/agent.ts:468-471`）。

## 9. 错误处理与已知边界

- **配置边界**：`disposeGraceMs` 非法在构造时抛（`src/engine-claude/loop.ts:64-72`）；schemastery 对非法枚举/类型在 compose 时拒绝。原则是无头部署的误配必须响亮失败。
- **query 失败**：SDK result 错误 → `LlmError`（`CLAUDE_CODE_*` 码）→ `turn/end` 记 `error` + `agent/error` 事件；空流 → `CLAUDE_CODE_NO_RESULT`；无 cwd → 普通 Error，错误码 `UNKNOWN`（`src/engine-claude/agent.ts:419-424`）。
- **静默降级**：技能加载失败/不存在/不可调用跳过；无 `approval` 服务时 ask 策略落 deny；无 `skills` 服务时手势不注入；无 `commands` 服务时斜杠菜单不注册。这些都有意不 fail-loud，因为可选宿主服务可能缺席（`src/index.ts:82-89`）。
- **已知边界**：
  - 图片不转录，以占位文本代替（`src/driver-core/prompt.ts:20-21`）；思维链不进 prompt（每次 query 重新思考，`src/driver-core/prompt.ts:34-37`）。
  - `redacted-thinking` 与未知内容块在 durable log 中不可恢复（`src/engine-claude/mapping.ts:100-102`）。
  - 无 SDK 会话持久化：每次 step 都是完整历史重放，长会话的 prompt 会线性增长——这是"session log 唯一事实源"设计的固有代价。
  - 引擎**按会话**选定：创建时由插件自己的每会话记录决定（该会话无记录时用它记录的 agent preset），之后可在会话打开且没有 turn 在飞时随时切到别的引擎（`src/router-loop.ts:281-314`、`:306-317`）；经 harness 的 preset 通道仍只有**空白**会话能换引擎，非空白会话只 warn 并保持原引擎（`src/router-loop.ts:577-602`）。插件装载期间 managed block 恒存在（不再有"in-process = 没有块"的形态）。**托管引擎之间的切换不需要重启、也不需要刷新**；**任一边是 in-process 时宿主会释放这条会话的 agent 并让页面自动重载一次**（重载后回到同一条会话，宿主按记录重建它——`dsh web` 进程不重启，`docs/per-session-engine.md` §5.2）。

## 10. 测试覆盖要点

claude 引擎的测试在 `tests/engine-claude/`（另有 `tests/commands.spec.ts`、`tests/skills.spec.ts` 覆盖入口层），统一手法是 `vi.mock('@anthropic-ai/claude-agent-sdk')` 替换 `query`，用内存 SDKMessage 流驱动真实 `ClaudeCodeLoop` + 真实 session store/subprocess 插件，断言落在 session log 上。per-engine spec 里的 `ClaudeCodeLoop` 经 `tests/helpers/agent-harness.ts:49` 的 `loopPluginFor` 挂载——helper 做路由器在生产里做的事：构造引擎、把 AgentFactory 槽位交给它、发布三个 systemPrompt 变量：

- `agent.spec.ts` — 工厂注册、turn/step/事件落盘、**一段一步的 step 轮转（`stepStructure` 辅助函数断言 `type@step` 序列）**、**query 总量 usage 只在未轮转时落盘**、流式 chunk 与其内嵌 `data.stream`／live `agent/assistant-stream` 帧（含 committed 收尾）、三种思维链兜底、工具调用/结果配对、SDK 错误码映射、request header 的 initial/resume、取消与 pre-step 拦截、会话权限旋钮折叠（ask 转发 / 无审批服务落 deny / 中途切 full access）、技能注入全部分支（含取消丢弃、无 cwd 提示）。
- `controls.spec.ts` — steer/inject 同批消费、cancel 清队列与 `keepInbox`、maintenance 的门闩唤醒、运行中取消后新 turn、防御性 guard（无 driver 的 turn、无 cwd、未来 subtype）、多步 continuation、resume header 落盘。
- `coverage-edges.spec.ts` — commit veto（`turn/start` / `turn/end` 落盘被拒）、空步完成、mid-turn 输入链接、disposed 后不门闩唤醒、工厂 ownership 竞速（setup 中途卸载回滚、非 Error abort 原因包装）、resume 取消与 preparation 释放、无 schema 构造的默认值、system-prompt 变量服务。
- `index.spec.ts` — 工厂槽位随 owner fiber dispose 清空、createAgent 的 seed/meta 透传、setup commit/失败/悬挂取消、resume 无持久化后端响亮失败、JSONL 后端真实 resume。
- `mapping.spec.ts` — 全部纯函数映射（含不可序列化工具输入占位、cache 计数省略、流事件全分支）和 `serializeHistory` 全分支。
- `permission.spec.ts`、`sdk.spec.ts` — 旋钮读取器与姿态折叠；`claudeQueryOptions` 各权限模式形状、无头交互应答与诊断、`claudeSpawnSpec` 墓碑/校验、`ManagedClaudeCodeProcess` 事件投影与 kill 幂等。

## 附：代码与注释/文档不一致之处

撰写本文时发现，供后续修正：

1. **`loop.ts:45` 的 `model` 配置 JSDoc 不完整**：注释说 "Model label for the logged request header; Claude Code native settings own the actual model"，但实现同时把 `config.model` 作为 SDK `model` override 传给每次 query（`src/engine-claude/agent.ts:505`、`src/engine-claude/sdk.ts:102`）。钉了 `model` 就是钉了实际推理模型，不只是日志标签。`sdk.ts:40` 对同一字段的注释（"Model override for the SDK"）才是准确的。
2. **`mapping.ts:137-152` JSDoc 重复**：`toolResultContent` 的 docblock 逐字出现了两遍。
3. **任务背景材料的偏差**（非源码问题）：driver-core 的 `context-files.ts` 不被 claude 引擎引用，它服务 codex/pi/kimi 的技能 provider；claude 的技能发现在 `src/skills.ts` 内自包含。
