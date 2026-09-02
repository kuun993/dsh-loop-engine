# claude-code 引擎实现文档

本文面向要修改 dsh-loop-engine 中 **claude-code 引擎**的工程师，讲清机制、数据流、设计约束和坑。所有论断均标注源码位置；行号以当前工作区版本为准，改动后请同步核对。

## 1. 引擎概述

claude-code 引擎用官方 **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`）驱动 dsh 会话。核心模型是：

- **每个 dsh step 一次无状态 query**（`src/engine-claude/loop.ts:2-6` 模块注释）。SDK 进程不保留任何会话状态：`persistSession: false`（`src/engine-claude/sdk.ts:96`），dsh 的持久化 session log 是模型上下文的唯一来源。
- **prompt 是 session log 的纯序列化**。每个 step 调用 `Session.deriveMessages()` 派生历史，经 `serializeHistory` 渲染成 `<user>...</user>` / `<assistant>...</assistant>` / `<tool-result>...</tool-result>` 标签文本作为整段 prompt（`src/engine-claude/agent.ts:467-468`、`src/driver-core/prompt.ts:93-127`）。这实现了 harness 的"model-visible ⟺ logged"约束：重放同一份 log 必然得到同一份 prompt。
- **Claude Code 拥有自己的 prompt、工具和权限**。SDK 子进程是真正的 agent 运行时（自带系统提示、内置工具、技能展开）；dsh 侧只做收件箱、turn/step 边界、事件落盘和审批转发（`src/engine-claude/agent.ts:1-8`）。
- **进程模型**：SDK 的 `query()` 内部 spawn 一个 `claude` CLI 子进程。引擎通过 SDK 的 `spawnClaudeCodeProcess` 钩子把 spawn 请求转交给 dsh 的 subprocess seam（`src/engine-claude/sdk.ts:145-148`），子进程树的生命周期（终止升级阶梯、grace）由 harness 统一管理，而不是 SDK 直接 `child_process.spawn`。

与 dsh 的关系：harness 只有一个 `AgentFactory` 槽位（主仓 `packages/core/agent/src/index.ts:374`，重复注册抛 `an agent factory is already registered`）。插件入口 `src/index.ts` 在 web 设置页选择 claude-code 时，通过 managed block 禁用 base bundle 的 `agent-loop` 行，并把 `ClaudeCodeLoop` 挂为 cordis 子 fiber（`src/index.ts:359`），由它占用该槽位。

## 2. 模块组成与各文件职责

`src/engine-claude/` 是一个**库**而不是 cordis 插件入口（`src/engine-claude/loop.ts:6`），由 `src/index.ts` 的 `mountClaude` 挂成子 fiber。

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
- `ownership.ts` — `FactoryOwnership`（工厂卸载时取消并等待所有存活 agent 的 teardown）、`raceAbort` / `raceAbortCall`（setup 等待与融合 abort 信号竞速）。
- `permission-knobs.ts` — 从 session log 读取最后一条 `sandbox/mode` / `approval/policy` 事件的引擎无关读取器。
- `skill-inject.ts` — `/name` 手势扫描、`isSkillName` 校验、`<skill_content>` XML 渲染与转义。
- `context-files.ts` — **claude 引擎不使用**。它是 codex/pi/kimi 的 AGENTS.md 收集器；claude 的技能发现在 `src/skills.ts` 自成一套（见第 7 节）。任务清单把它列入"被引用"是误列，改 claude 引擎时不用看它。

引擎外的两块 claude 专属代码在插件入口层：`src/commands.ts`（斜杠命令桥）与 `src/skills.ts`（`ClaudeCodeSkillProvider`），均由 `mountClaude` 注册（`src/index.ts:329-360`）。

## 3. Loop 工厂与 Agent 生命周期

### 3.1 工厂注册

`ClaudeCodeLoop` 是 cordis `Service`，`static inject = ['agents', 'sessions', 'systemPrompt', 'subprocess']`（`src/engine-claude/loop.ts:120`）。构造函数里：

- `resolveConfig` 在插件配置边界做校验（`src/engine-claude/loop.ts:86-103`）：`disposeGraceMs` 必须是正有限数且不超过 `MAX_TIMER_DELAY_MS`（超过 32 位定时器上限会静默溢出，所以硬拒绝）。
- `ctx.effect(() => ctx.agents.setFactory(this))` 占用 AgentFactory 槽位，fiber 卸载时 effect 反转、槽位自动清空（`src/engine-claude/loop.ts:137`）——这是运行时切换引擎能生效的关键。
- 注册 `provider` / `model` / `cwd` 三个 system-prompt 变量（`src/engine-claude/loop.ts:141-143`）。注意：claude 引擎**不用** dsh 的系统提示组装，这些变量只是镜像默认 loop 的注册，喂给下游可能读取它们的消费者。

### 3.2 创建与发布事务

`createAgent` / `resume` 都走同一个 `prepare → setup → publish` 事务（`src/engine-claude/loop.ts:153-258`）：

1. `prepare` 构造 `ClaudeCodeAgent` 和一个**备忘化**（memoized）的反向 teardown。teardown 在发布**之前**就注册进 `FactoryOwnership` 和 owner fiber 的 effect，因此 setup 中途工厂卸载或 owner 卸载都会整体回滚。
2. 三方取消信号融合：caller 的 `signal`、owner fiber 卸载、工厂 teardown，共同驱动一个 `AbortController`，`prepared.signal` 供 setup 等待竞速（`src/engine-claude/loop.ts:167-175`）。
3. `setupAndPublish` 里 `raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id)` 跑调用方的 setup，成功后 `commit()`，再 `publish`：进 `sessions` / `agents` 两个注册表 → `announce` → 发 `agent/session-start`（`src/engine-claude/loop.ts:237-248`）。失败路径 `await prepared.dispose()` 后重抛。
4. `resume` 额外要求 `sessionPersistence` 服务存在，否则响亮失败（`src/engine-claude/loop.ts:315-318`）；加载阶段同样与取消信号竞速，加载完成才被取消的 preparation 会被 `[Symbol.dispose]()` 释放（`src/engine-claude/loop.ts:341-346`、`361-363`）。

`dispose` 的顺序固定：abort 融合信号 → `machine.cancel({ kind: 'disposed' })` → `whenIdle()` 等驱动退出 → `scope.dispose()` → 摘注册 → 摘 owner 跟随（`src/engine-claude/loop.ts:182-205`）。`disposeGraceMs` 不在这一层生效——它是给 SDK 子进程树的终止宽限（见第 6 节），agent 级 dispose 不等它。

### 3.3 Agent 的 turn/step 驱动

`ClaudeCodeAgent` 的状态机是三态 `Phase`：`idle` / `maintenance` / `running`（`src/engine-claude/agent.ts:62-70`）。

- **收件箱**：`Inbox` 区分 `next-turn` 与 `next-step` 两个目标；`followup` 排 next-turn 并唤醒、`steer` 排 next-step 并唤醒、`inject` 排 next-step 不唤醒（`src/engine-claude/agent.ts:151-169`）。`cancel` 默认清空收件箱并 abort 当前 phase；`keepInbox` 保队列（`src/engine-claude/agent.ts:171-177`）。
- **唤醒**：`wakeDriver` 只在 idle 时开新 driver；非 idle 时若原因是 maintenance 或"abort 后唤醒"则 latch `wakeRequested`，driver 退出时若收件箱仍有消息会接力唤醒（`src/engine-claude/agent.ts:214-232`、`249-263`）。一个细节：abort 之后收到的 wakeup 会被 `send` 重分类为 `next-turn`（`src/engine-claude/agent.ts:141-143`），保证它开启新 turn 而不是混入已死的 step。
- **turn**：`turn/start` 落盘 → 循环 `preStep`（claim 消息 → `agent/pre-step` waterfall，可被拦截 reject → 技能注入）→ `step/start` → 每条用户消息落 `user/message` → `step()` → `step/end`。turn 结束原因在 `turn/end` 落盘：`completed` / `blocked` / `aborted` / `error`（`src/engine-claude/agent.ts:359-434`）。`agent/turn-stopping` serial 事件给拦截器最后一次注入输入的机会（`src/engine-claude/agent.ts:402-406`）。
- **request/header**：每个 loop 实例只在第一个 step 前落一次，`reason` 按 session 是否已有 baseline 区分 `initial` / `resume`（`src/engine-claude/agent.ts:442-453`）。header 的 model 标签是 `config.model ?? 'claude-code-native'`——**故意不镜像** web 会话的模型选择，因为那个选择从不驱动 query（`src/engine-claude/agent.ts:49-54`；背景见 `docs/proposals/model-selection-disable.md`）。

### 3.4 中断与销毁

step 内的取消路径：phase 信号 → 单次监听器转成 per-query `AbortController` 的 abort（`src/engine-claude/agent.ts:477-486`）→ SDK 中断 query、终止子进程。`turn` 的 catch 区分：信号已 abort → `turn/end` 记 `aborted`；否则记 `error` 并经 `throwError` 先派发 `agent/error` 再抛出，由 `kick` 的 driver 边界收容（`src/engine-claude/agent.ts:241-263`、`409-428`）。`finally` 里无条件 `controller.abort()` 并摘掉监听器（`src/engine-claude/agent.ts:625-628`）。

## 4. 事件/消息映射

映射分两个方向。**入方向**（dsh → SDK）只有一件产物：prompt 文本（第 1 节）。**出方向**（SDK → dsh）在 `agent.ts` 的 `for await (const message of query)` 循环里按 `message.type` 分派（`src/engine-claude/agent.ts:510-617`），翻译逻辑全部在 `mapping.ts`：

- **`stream_event`**（SDK 原始流事件，因 `includePartialMessages: true` 才有，`src/engine-claude/sdk.ts:91-95`）：`mapStreamEvent` 把 `content_block_start` / `content_block_delta` 翻成 dsh `StreamChunk`（`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta`），每条作为 `assistant/chunk` 落盘并记录 seq（`src/engine-claude/agent.ts:513-521`）。tool_use 的 call 身份（callId + name）在 `content_block_start` 时按 block index 记进 `toolCalls` Map，供后续 `input_json_delta` 命名；匹配不到时合成 `call-${index}`（`src/engine-claude/mapping.ts:221-223`、`236-243`）。`content_block_stop`、`message_*` 等传输事件不产出 chunk——durable 消息由完整 `assistant` 消息另行落盘，chunk 只驱动 web 端的实时 partial 投影。
- **`assistant`**：`mapAssistantMessage` 逐 block 翻译——text 原样、tool_use 同时产出 `tool-call` 内容块和一条 `tool/call` 事件（SDK 的 tool_use id 直接复用为 dsh `CallId` 以便结果配对）、thinking → `reasoning`、redacted-thinking 与未知块丢弃（`src/engine-claude/mapping.ts:72-114`）。usage 经 `mapUsage` 翻译，cache 计数为 null 时省略（`src/engine-claude/mapping.ts:180-187`）。
- **`user`**（query 内部只承载工具结果）：`mapToolResults` 提取 `tool_result` block 翻成 dsh `tool/result` 事件；字符串内容原样、block 数组只取 text、空内容补 `(no content)` 占位块以便关联（`src/engine-claude/mapping.ts:123-172`）。
- **`result`**：`success` 标记 `finished`；其余 subtype 抛 `LlmError`，错误码为 `CLAUDE_CODE_<SUBTYPE>`，未知 subtype 归一为 `CLAUDE_CODE_ERROR`（`src/engine-claude/agent.ts:79-89`、`604-610`）。流结束而未见 result 抛 `CLAUDE_CODE_NO_RESULT`（`src/engine-claude/agent.ts:618-623`）。
- **其余**（`system`/init/status/permission/control 等 SDK 传输消息）：直接跳过——durable log 只记模型可见的转录（`src/engine-claude/agent.ts:612-615`）。

**思维链的三种兜底**（`src/engine-claude/agent.ts:522-570`、`584-603`），这是映射里最容易踩坑的部分：

1. provider 把 thinking 拆成独立的 reasoning-only assistant 消息：按住不落盘，折进下一条消息（否则"最后一条 assistant 消息生效"的 step 投影会丢掉 thinking）；其 usage stash 到 `pendingUsage`。
2. provider 流式发了 thinking delta 但完整消息里没有 thinking block：用 chunk 累积的 reasoning 合成 block 补在内容前面；完整消息自带 thinking 时丢弃累积，防止重复。
3. step 以 reasoning-only 消息结束（`result` 到达时仍按着）：作为独立 durable 消息 flush，模型标签记 `claude-code-native`。

另外，`assistant/message` 落盘时带 `sourceEventSeqs` 链接到流式 chunk 的 seq，replay 可按原样重建 partial（`src/engine-claude/agent.ts:565-569`）。

## 5. 权限模型

权限裁决分两层，每个 query 独立折叠一次（中途切换预设即时生效）：

1. **部署钉死的 `permissionMode`** 无条件胜出（`src/engine-claude/agent.ts:335`）。
2. 否则读 session log 的 dsh 权限旋钮（`resolveSessionPermission`，`src/engine-claude/permission.ts:33-37`）：
   - `sandbox/mode = danger-full-access` → `bypassPermissions`（web 的 "full" 预设会同时钉 `never` 策略，full access 无条件胜出）；
   - `approval/policy = ask` → 若宿主有 `approval` 服务，`permissionMode: 'default'` + `onToolPermission` 把每个原生权限请求转发到 dsh 审批缝（`allowed-once` → `allow` 其余 → `deny`，理由文本带 200 字符上限的工具输入摘要，`src/engine-claude/agent.ts:338-353`、`src/engine-claude/permission.ts:39-53`）；没有审批服务时**落到 deny**；
   - 其他一切（含从未记录过旋钮的会话）→ `deny`，即 `dontAsk`。

落到 SDK `Options` 时（`src/engine-claude/sdk.ts:97-125`）：

- `bypassPermissions` → `allowDangerouslySkipPermissions: true`，**不装** `canUseTool` 钩子。
- 其余模式装 `canUseTool`：有 `onToolPermission` 转发则按裁决 allow/deny；没有则一律 deny 并报诊断。
- `disallowedTools` 恒定禁 `AskUserQuestion`，`plan` 模式追加 `ExitPlanMode`——无头驱动不能阻塞等人回答。
- 三类交互统一自动应答并产生一行诊断（经 `onUnattended` 上抛，agent 在 step 结束时不计顺序地 `logger.warn` 出去，`src/engine-claude/agent.ts:497`、`626-628`）：`canUseTool` 自动 deny、`onElicitation` 自动 decline（不收交互式 MCP 输入）、`onUserDialog` 自动 cancel；`supportedDialogKinds` 只声明 `refusal_fallback_prompt`（`src/engine-claude/sdk.ts:22-23`、`126-144`）。

可选模式全集是 SDK `PermissionMode` 的非交互子集：`dontAsk` / `acceptEdits` / `auto` / `plan` / `bypassPermissions`（`src/engine-claude/types.ts:10-15`、`src/engine-claude/loop.ts:34-40`）。`default` 不出现在配置里——它只在 ask 转发路径内部使用。

## 6. 进程与 SDK 管理

分工：`sdk.ts` 负责"一次 query 要什么"，`process.ts` 负责"SDK 的 spawn 请求怎么交给 dsh"。

**env 注入**（两层，注意别混）：

- `claudeQueryOptions` 给 SDK 的 `env` = `scrubbedParentEnv()` + 部署的 `config.env`（`src/engine-claude/sdk.ts:87-90`）。`scrubbedParentEnv` 是主仓 subprocess 包的公共定义：剔除所有 credential 形状的名字（`/KEY|PASSWORD|SECRET|TOKEN/i`）和全部 `DSH_*`（大小写不敏感），保留 `PATH`/`HOME`/locale/代理（主仓 `packages/subprocess/subprocess/src/index.ts:37-66`）。
- SDK 拿到这个 env 后会再做自己的增删，最后把**完整的子进程环境**放进 `SpawnOptions.env` 传给 spawn 钩子。`sdkEnvironmentOverlay` 把它转成 subprocess spec 的 overlay：SDK 删掉的、但 scrubbed 父环境里存在的名字要补 `undefined` 墓碑，否则它们会从 overlay 基座里复活（`src/engine-claude/process.ts:32-40`）。想显式传 credential（比如给 CLI 用的 token）只能走 `config.env`，它在 scrub 之后合并。

**spawn 桥接**：`claudeSpawnSpec` 把 SDK 的 `SpawnOptions` 翻成 `SubprocessSpawnSpec`：`argv = [command, ...args]`、`stdio` stdin/stdout pipe + stderr inherit、`graceMs = disposeGraceMs`（默认 3000，`src/engine-claude/sdk.ts:21`）、转发 SDK 的 `signal`；`cwd` 缺失直接抛（`src/engine-claude/process.ts:48-63`）。实际 spawn 走 `loopCtx.subprocess.spawn(spec)`（`src/engine-claude/agent.ts:496`），子进程树归 harness 的 subprocess 实现管。

**进程投影**：`ManagedClaudeCodeProcess` 实现 SDK 的 `SpawnedProcess`：透传 stdin/stdout，把 `child.done` 的 settle/reject 投影成 `exit`/`error` 事件；`kill()` 忽略 SDK 选的信号（注释：升级阶梯归共享 seam 所有），幂等地转调 `child.terminate()`，已退出或已请求过返回 `false`（`src/engine-claude/process.ts:69-133`）。构造函数里给 `error` 挂了 no-op 监听器——EventEmitter 对无监听器的 `error` 有特殊 throw 语义，而 SDK 是在 custom spawn 返回后才同步挂监听，这个 no-op 同时收容一个已经 reject 的 spawn 句柄（`src/engine-claude/process.ts:83-86`）。

## 7. 斜杠命令与技能注入

### 7.1 斜杠命令桥（`src/commands.ts`）

dsh 的 `commands` 服务会本地消费已注册命令——行不进模型。但 Claude Code 命令的真正处理在 CLI 内部，所以所有注册的 claude 命令 handler 只做一件事：把原始 `/<name> [args]` 行以普通用户消息 `followup` 回给 agent，由 CLI 原生展开（`src/commands.ts:64-72`）。注册的意义是让这些命令出现在 web 斜杠菜单里。

- 内置 7 个：`help` / `compact` / `clear` / `review` / `explain` / `fix` / `tests`（`src/commands.ts:80-88`）。
- **用户级自定义命令**（`~/.claude/commands/*.md`）由 `discoverUserSlashCommands` 同步扫描注册：只收 `.md`、名字须过 dsh 命令名语法、与内置重名跳过；描述取 frontmatter `description`，否则取正文首个非空非标题行（>120 字符截断），都没有则跳过（`src/commands.ts:98-163`）。同步扫描是有意的——挂载路径必须在引擎切换 commit 返回前完成注册。
- **项目级 `.claude/commands/` 故意不注册**：它们依赖 cwd，全局注册会跨项目冲突；未注册的 `/行` 本来就会当用户文本透传给 CLI（`src/commands.ts:16-18`）。
- 注册时与 dsh 原生命令撞名：警告并跳过，不让挂载失败（`src/index.ts:342-348`）。

### 7.2 技能 provider（`src/skills.ts`）

`ClaudeCodeSkillProvider` 从三处发现技能（格式与 dsh 技能相同：YAML frontmatter + markdown）：

- `<git 根>/.claude/skills/`（rank 150，项目级，锚定 git 根）；
- `~/.claude/skills/`（rank 160，项目技能赢重名）；
- 项目根的 `CLAUDE.md`——**仅当它带技能 frontmatter**（`name` + `description`）才收，rank 150（`src/skills.ts:224-242`、`301-314`）。

两种布局都支持：`<name>/SKILL.md`（目录成为 resource base，`scripts/`、`references/` 相对它解析）和平铺的 `<name>.md`（resource base 是 skills 目录本身）。frontmatter 解析器是手写的 YAML 子集，支持 `>` / `|` 块标量（Claude Code 的 SKILL.md 大量用 folded `description: >`），认识 `disable-model-invocation` 与 `user-invocable` 两个开关（`src/skills.ts:84-200`）。Windows 技能安装器用 junction，`stat` 跟随链接来判断类型（`src/skills.ts:278-283`）。注意：rank 150 介于 project-dsh（100）与 custom（300）之间，即 claude 技能**压过**项目自带的 dsh 技能（`src/skills.ts:68-71`）。

### 7.3 技能注入（agent 侧）

进程内引擎的技能注入由 dsh-tool-skill 在 agent-preset 上下文链上完成，而 claude agent 的上下文不从那条链派生，所以 `preStep` 里复刻了一遍手势扫描（`src/engine-claude/agent.ts:277-286` 注释）：

- 只扫 `source.kind === 'user'` 的消息的 text block 里空白边界的 `/name` 手势（kebab-case），按首次出现去重（`src/driver-core/skill-inject.ts:84-97`）。
- 经 `skills.get(name, { signal, scope, cwd })` 加载；加载失败、未找到、`userInvocable === false` 都静默跳过。
- 命中的技能渲染成 `<skill_content>` XML（名称/路径/provider 转义）作为 `source: { kind: 'skill-invocation', form: 'instructions' }` 的用户消息**追加**到本步批次，随批次落 `user/message`（`src/engine-claude/agent.ts:297-323`）。
- 加载期间 step 被取消：整批注入丢弃（`src/engine-claude/agent.ts:316`）。

这条路径同时是技能内容进入模型的**唯一**通道——渲染结果随下次 query 的 prompt 序列化进 `<user>` 段。

## 8. 配置项一览

配置从 `cordis.yml` 的 composition entry 进来：`src/index.ts` 的 `Config` 是全引擎超集，`claudeCodeConfig` 只挑出 claude 的字段转发（`src/index.ts:192-200`），`ClaudeCodeLoop` 再用自己的 schemastery schema + `resolveConfig` 校验。schema 只在字段存在时校验、缺省落 `undefined`（`src/engine-claude/loop.ts:66-72` 与 `src/index.ts:101-115` 注释），所以 `resolveConfig` 里仍保留 `??` 兜底——测试里有"不经插件 schema 直接构造"的路径。

| 配置项 | 类型 / 默认 | 生效位置 |
|---|---|---|
| `permissionMode` | 五选一，缺省 = 跟随会话旋钮 | 每个 query 的权限裁决，见第 5 节 |
| `env` | `Record<string,string>`，默认 `{}` | 叠加在 scrubbed 父环境之上传给 SDK（`src/engine-claude/sdk.ts:87-90`） |
| `model` | 缺省 = 原生模型 | **双重作用**：request header 的模型标签（`src/engine-claude/agent.ts:437-439`），且作为 SDK `model` override 传给 query（`src/engine-claude/agent.ts:494`、`src/engine-claude/sdk.ts:101`） |
| `disposeGraceMs` | 默认 3000，须为正有限数且 ≤ `MAX_TIMER_DELAY_MS` | 子进程树终止宽限（`src/engine-claude/process.ts:59`） |
| `maxTurns` | 正整数，缺省不限 | SDK `maxTurns`（`src/engine-claude/sdk.ts:102`） |

会话级输入（非配置项）：`sandbox/mode` 与 `approval/policy` 旋钮事件（第 5 节）、session 元数据里的 `cwd`（每个 query 的工作目录，缺失则 step 直接报错，`src/engine-claude/agent.ts:463-466`）。

## 9. 错误处理与已知边界

- **配置边界**：`disposeGraceMs` 非法在构造时抛（`src/engine-claude/loop.ts:88-95`）；schemastery 对非法枚举/类型在 compose 时拒绝。原则是无头部署的误配必须响亮失败。
- **query 失败**：SDK result 错误 → `LlmError`（`CLAUDE_CODE_*` 码）→ `turn/end` 记 `error` + `agent/error` 事件；空流 → `CLAUDE_CODE_NO_RESULT`；无 cwd → 普通 Error，错误码 `UNKNOWN`（`src/engine-claude/agent.ts:414-419`）。
- **静默降级**：技能加载失败/不存在/不可调用跳过；无 `approval` 服务时 ask 策略落 deny；无 `skills` 服务时手势不注入；无 `commands` 服务时斜杠菜单不注册。这些都有意不 fail-loud，因为可选宿主服务可能缺席（`src/index.ts:56-63`）。
- **已知边界**：
  - 图片不转录，以占位文本代替（`src/driver-core/prompt.ts:20-21`）；思维链不进 prompt（每次 query 重新思考，`src/driver-core/prompt.ts:34-37`）。
  - `redacted-thinking` 与未知内容块在 durable log 中不可恢复（`src/engine-claude/mapping.ts:100-102`）。
  - 无 SDK 会话持久化：每次 step 都是完整历史重放，长会话的 prompt 会线性增长——这是"session log 唯一事实源"设计的固有代价。
  - 运行时切换引擎靠挂载/卸载 fiber 实现；AgentFactory 槽位竞争有有界重试（40 次 × 50ms，`src/index.ts:66-67`、`316-324`），与 patch-layer reload 竞速，超出则报错需重启。

## 10. 测试覆盖要点

claude 引擎的测试在 `tests/engine-claude/`（另有 `tests/commands.spec.ts`、`tests/skills.spec.ts` 覆盖入口层），统一手法是 `vi.mock('@anthropic-ai/claude-agent-sdk')` 替换 `query`，用内存 SDKMessage 流驱动真实 `ClaudeCodeLoop` + 真实 session store/subprocess 插件，断言落在 session log 上：

- `agent.spec.ts` — 工厂注册、turn/step/事件落盘、流式 chunk 与 `sourceEventSeqs` 链接、三种思维链兜底、工具调用/结果配对、SDK 错误码映射、request header 的 initial/resume、取消与 pre-step 拦截、会话权限旋钮折叠（ask 转发 / 无审批服务落 deny / 中途切 full access）、技能注入全部分支（含取消丢弃、无 cwd 提示）。
- `controls.spec.ts` — steer/inject 同批消费、cancel 清队列与 `keepInbox`、maintenance 的门闩唤醒、运行中取消后新 turn、防御性 guard（无 driver 的 turn、无 cwd、未来 subtype）、多步 continuation。
- `coverage-edges.spec.ts` — commit veto（`turn/start` / `turn/end` 落盘被拒）、空步完成、mid-turn 输入链接、disposed 后不门闩唤醒、工厂 ownership 竞速（setup 中途卸载回滚、非 Error abort 原因包装）、resume 取消与 preparation 释放、无 schema 构造的默认值、system-prompt 变量服务。
- `index.spec.ts` — 工厂槽位随 owner fiber dispose 清空、createAgent 的 seed/meta 透传、setup commit/失败/悬挂取消、resume 无持久化后端响亮失败、JSONL 后端真实 resume。
- `mapping.spec.ts` — 全部纯函数映射（含不可序列化工具输入占位、cache 计数省略、流事件全分支）和 `serializeHistory` 全分支。
- `permission.spec.ts`、`sdk.spec.ts` — 旋钮读取器与姿态折叠；`claudeQueryOptions` 各权限模式形状、无头交互应答与诊断、`claudeSpawnSpec` 墓碑/校验、`ManagedClaudeCodeProcess` 事件投影与 kill 幂等。

## 附：代码与注释/文档不一致之处

撰写本文时发现，供后续修正：

1. **`loop.ts:57` 的 `model` 配置 JSDoc 不完整**：注释说 "Model label for the logged request header; Claude Code native settings own the actual model"，但实现同时把 `config.model` 作为 SDK `model` override 传给每次 query（`src/engine-claude/agent.ts:494`、`src/engine-claude/sdk.ts:101`）。钉了 `model` 就是钉了实际推理模型，不只是日志标签。`sdk.ts:40` 对同一字段的注释（"Model override for the SDK"）才是准确的。
2. **`mapping.ts:137-152` JSDoc 重复**：`toolResultContent` 的 docblock 逐字出现了两遍。
3. **`index.ts:306` 注释过时**："Cleanup claude-specific registrations on failure (a no-op for codex)"——现在命令/技能注册同样存在于 pi 和 kimi 引擎，"a no-op for codex" 已不准确（codex 也有技能注册）。
4. **任务背景材料的偏差**（非源码问题）：driver-core 的 `context-files.ts` 不被 claude 引擎引用，它服务 codex/pi/kimi 的技能 provider；claude 的技能发现在 `src/skills.ts` 内自包含。
