# Codex 引擎实现文档

**目标读者**：要修改 `src/engine-codex/` 的工程师。本文通读 codex 引擎全部源码（含 `appserver/` 子目录、用到的 `driver-core/` 共享设施、`src/index.ts` 挂载点与全部 codex 测试），讲清机制、数据流、设计约束与坑。行号引用均为撰写时的实际位置。

## 1. 引擎概述

Codex 引擎让 dsh 会话由 OpenAI Codex CLI 驱动：每个 dsh step 通过 JSON-RPC over stdio 与一个常驻的 `codex app-server` 子进程通信，**每个 step 新建一个无状态 codex 线程（thread）**，模型上下文完全由 dsh 持久会话日志（session log）序列化而来，不复用 codex 侧的历史。

核心设计约束（与 claude-code 引擎同源）：

- **"Model-visible ⟺ logged"**：发给 codex 的 prompt 是 `Session.deriveMessages()` 的纯序列化（`src/engine-codex/agent.ts:455-456` + `src/driver-core/prompt.ts:93-127`），会话日志是模型上下文的唯一事实源。
- **无交互审批回调**：app-server 协议没有 approval 回调，权限只能以声明式的 `sandboxMode`/`approvalPolicy` 对折叠进每个线程的启动参数（`src/engine-codex/agent.ts:1-13`、`src/engine-codex/permission.ts:1-13`）。
- **不走 dsh subprocess 接缝**：与 pi 引擎不同，codex 子进程由驱动自己用 `node:child_process.spawn` 拉起（`src/engine-codex/appserver/client.ts:76`），不经 `dsh-subprocess` 服务，因此没有 harness 沙箱包装——整个子进程的权限边界就是 codex CLI 自己的 sandbox。
- **CLI 二进制来自 pinned 依赖**：入口解析自本包锁死的 `@openai/codex` 依赖（`package.json` 中 `@openai/codex: 0.149.1`），用当前 Node 解释器执行其 `bin/codex.js app-server`（`src/engine-codex/appserver/client.ts:34-36, 76-78`）。

## 2. 模块组成与各文件职责

```
src/engine-codex/
├── loop.ts              # CodexLoop：AgentFactory + cordis 服务（createAgent/resume、发布事务）
├── agent.ts             # CodexAgent：turn/step 状态机、流式折叠、技能注入、权限折叠
├── permission.ts        # dsh 权限旋钮 → codex 声明式权限对的纯函数折叠
├── skills.ts            # CodexSkillProvider：AGENTS.md 发现与合并为一个 agents-md 技能
├── types.ts             # CodexSandboxMode / CodexApprovalPolicy / ResolvedConfig（纯类型）
└── appserver/
    ├── client.ts        # AppServerClient：spawn + JSON-RPC 2.0 请求/响应/通知分发
    ├── thread.ts        # AppServerThread：一个线程的 turn 流式生成器（通知 → AppServerEvent）
    ├── mapping.ts       # 完成的 item / turn usage → dsh SessionEvent 载荷的纯映射
    └── types.ts         # app-server 协议类型的最小手写子集
```

- `loop.ts` 是**库而不是 cordis 插件入口**（`src/engine-codex/loop.ts:1-11`）；插件入口 `src/index.ts` 的 `mountCodex` 用 `ctx.plugin(CodexLoop, codexConfig(config))` 把它挂为子 fiber（`src/index.ts:371`）。
- `appserver/types.ts` 明确是 `codex app-server generate-ts` 生成类型的**最小手写子集**（`src/engine-codex/appserver/types.ts:1-7`），只覆盖驱动用到的 initialize / thread / turn / 通知形状，多数字段用 `[key: string]: unknown` 放行。
- 驱动复用的共享设施在 `src/driver-core/`：`prompt.ts`（历史序列化）、`permission-knobs.ts`（旋钮读取）、`skill-inject.ts`（`/name` 手势与 `<skill_content>` 渲染）、`ownership.ts`（工厂所有权与 abort race）、`context-files.ts`（AGENTS.md 收集与读取）。

## 3. Loop 工厂与 Agent 生命周期

### 3.1 CodexLoop（工厂）

`CodexLoop extends Service implements AgentFactory`（`src/engine-codex/loop.ts:112`），服务键 `agentLoopCodex`（`src/engine-codex/loop.ts:100-104`），`static inject = ['agents', 'sessions', 'systemPrompt']`（`src/engine-codex/loop.ts:114`）。构造函数（`src/engine-codex/loop.ts:122-138`）做三件事：

1. `ctx.effect(() => () => this.ownership.dispose())`——fiber 卸载时停掉工厂所有权（含所有存活 agent 的反向拆解）；
2. `ctx.effect(() => ctx.agents.setFactory(this))`——注册到 harness **唯一的** AgentFactory 槽位；槽位被占时 `setFactory` 抛 `an agent factory is already registered`，由 `src/index.ts:316-324` 的有界重试（40 次 × 50ms）等基础 `agent-loop` 行被 patch 层禁用后腾出；
3. 注册 `provider`/`model`/`cwd` 三个 systemPrompt 变量（`src/engine-codex/loop.ts:135-137`）。注意：codex 拥有自己的 prompt，这些变量只喂给（本引擎用不到的）dsh 系统提示词的下游消费者，刻意与默认 loop 的注册保持一致。

### 3.2 创建/恢复事务（prepare → setup → publish）

`createAgent`（`src/engine-codex/loop.ts:284-300`）与 `resume`/`resumeWith`（`src/engine-codex/loop.ts:308-358`）共享同一个发布事务 `setupAndPublish`（`src/engine-codex/loop.ts:255-275`）：

1. **prepare**（`src/engine-codex/loop.ts:147-252`）：构造 `CodexAgent`，并把一个 memoized 的反向 `dispose()` **在发布前**注册到 `FactoryOwnership` 与 owner fiber——中途卸载会整体回滚。`signal` 融合三方取消源：调用方 signal、owner fiber 卸载、工厂 teardown（`src/engine-codex/loop.ts:160-169`）。
2. **setup**：`raceAbort(setup?.(agent.ctx), prepared.signal, id)` 跑调用方 setup 并取 commit（`src/engine-codex/loop.ts:268-269`）；失败则 `dispose()` 后重抛。
3. **publish**（`src/engine-codex/loop.ts:231-242`）：依次 `sessions.enter` → `agents.enter` → `sessions.announce` → `agents.announce` → `emitAgentEvent(..., 'agent/session-start', { source })`，每步之间 `assertLive()` 检查融合信号。

反向拆解顺序（`src/engine-codex/loop.ts:176-199`）：`machine.cancel({ kind: 'disposed' })` → `whenIdle()` → `scope.dispose()` → 注销 enter/announce → 从 ownership 摘除。resume 路径额外处理：无 `sessionPersistence` 服务时直接报错（`src/engine-codex/loop.ts:309-313`）；加载与 setup 全程用 `raceAbortCall` 竞争融合信号，被取消后晚到的 preparation 会被 `releaseAbandoned` 释放（`src/engine-codex/loop.ts:325-343`）。

### 3.3 CodexAgent（会话驱动）

`CodexAgent implements Agent`（`src/engine-codex/agent.ts:83`）复刻了默认 agent-loop 驱动的相位机（`Phase = idle | maintenance | running`，`src/engine-codex/agent.ts:59-67`）：

- **入口**：`followup`（下一轮）/`steer`（当前步、唤醒）/`inject`（当前步、不唤醒）→ `send` → Inbox（`src/engine-codex/agent.ts:146-175`）；`cancel` 默认清空 inbox 并 abort 相位（`src/engine-codex/agent.ts:177-183`）。
- **驱动**：`wakeDriver` 在 idle 相位开新 running 相位并经 `agents.withInitiator` 起 `kick()`（`src/engine-codex/agent.ts:220-238`）；`kick` 循环 `turn()` 直到无待办，异常在驱动边界收敛（`src/engine-codex/agent.ts:255-269`）。
- **turn**（`src/engine-codex/agent.ts:347-422`）：append `turn/start` → 循环 `preStep`（Inbox claim + `agent/pre-step` waterfall + 技能注入）→ append `user/message` → `step()` → append `step/end`；turn 结束原因覆盖 `completed`/`blocked`/`aborted`/`error`，finally 中必 append `turn/end`。
- **preStep 拦截链**（`src/engine-codex/agent.ts:271-292`）：`agent/pre-step` waterfall 可 reject（turn 记 `blocked`）或改写消息批次；通过后再做技能注入（见 §7）。

生命周期要点：`scope`（`createScope`）是 agent 级注册边界，其上注册的 effect 在 scope 拆解时释放 app-server 客户端（`src/engine-codex/agent.ts:116-122`）。

## 4. app-server RPC 客户端与线程管理

### 4.1 分工

- **`client.ts`（传输层）**：负责进程生命周期与 JSON-RPC 2.0 帧。`AppServerClient.create()` spawn 子进程（`src/engine-codex/appserver/client.ts:75-82`）、立即发 `initialize` 握手（`clientInfo.name = 'dsh-loop-engine'`，`capabilities.experimentalApi = true`，`src/engine-codex/appserver/client.ts:95-105`）。请求用自增 id 记入 `pending` Map，stdout 按行解析：带 `id` 的是响应（按 id 撮合 resolve/reject），带 `method` 的是通知（转给当前 notification handler），非 JSON 行直接忽略（`src/engine-codex/appserver/client.ts:150-174`）。
- **`thread.ts`（会话层）**：`AppServerThread.create` 发 `thread/start` 拿 threadId（`src/engine-codex/appserver/thread.ts:49-52`）；`turn()` 是异步生成器，把 app-server 通知翻译成封闭的 `AppServerEvent` 联合类型（`src/engine-codex/appserver/thread.ts:25-35`）供 agent 消费。

### 4.2 客户端生命周期

- 每个 `CodexAgent` **懒建一个** `AppServerClient` 并跨 step 复用；进程已死（`closed`）时下次取用会重建（`src/engine-codex/agent.ts:126-130`）。agent scope 拆解时 `dispose()`：关 readline、`stdin.end()`、`kill()`（`src/engine-codex/appserver/client.ts:128-134`）。
- 子进程 `exit` 时把所有 pending 请求统一 reject 为 `codex app-server process exited unexpectedly`（`src/engine-codex/appserver/client.ts:64-71`）；dispose 后的请求立即 reject `app-server client is disposed`（`src/engine-codex/appserver/client.ts:138-140`）。
- stderr 行可通过 `onStderr` 订阅（`src/engine-codex/appserver/client.ts:58-63`），但 agent 没有注册 handler——目前 stderr 日志被丢弃。

### 4.3 turn 流式生成的三个关键机制

1. **先订阅后请求**：通知 handler 在 `turn/start` 请求**之前**挂上，因为服务端可能在 JSON-RPC 响应到达前就开始推 delta（`src/engine-codex/appserver/thread.ts:152-154`）。拿到 turnId 之前的通知先缓冲到 `earlyNotifications`，turnId 确定后重放（`src/engine-codex/appserver/thread.ts:64-79, 166-168`）。
2. **双重过滤**：所有通知按 `threadId` 过滤（其他线程的直接丢弃），item 级通知再按 `turnId` 过滤（`src/engine-codex/appserver/thread.ts:74-141`）。由于客户端在 agent 内共享且通知 handler 是单槽（`onNotification` 覆盖式赋值），**同一时刻只能有一个活跃 turn**——这由 agent 相位机天然保证（running 相位内串行）。
3. **队列 + 唤醒**：handler 把事件推入 `queue` 并 `resolve?.()` 唤醒生成器；生成器在 `queue` 空且未 done 时挂起等待（`src/engine-codex/appserver/thread.ts:186-197`）。`turn/completed` 与 `error` 通知都置 `done`；`error` 同时记 `turnError`，流排空后抛出（`src/engine-codex/appserver/thread.ts:119-141, 198`）。

### 4.4 取消传播

`turn()` 收到 abort 信号时：置 done、以 signal.reason 为 `turnError`（保留 `AgentCancelCause` 而不是泛化错误）、并发 `turn/interrupt` 尽力中断服务端 turn（错误吞掉）（`src/engine-codex/appserver/thread.ts:173-184`）。agent 侧把相位 signal 桥接到一个 per-step 的 `AbortController`（`src/engine-codex/agent.ts:465-474`），step 结束（含异常）时在 finally 里摘监听并 abort 该 controller（`src/engine-codex/agent.ts:662-665`）。

### 4.5 线程模型与已知边界

- **每 step 一个新线程**：`threadParams = { cwd, sandbox, approvalPolicy, model? }`（`src/engine-codex/agent.ts:478-484`），随后 `thread.turn([{ type: 'text', text: prompt }], { signal, params })`（`src/engine-codex/agent.ts:485-492`）。codex 侧不积累历史——全部上下文在序列化后的 prompt 文本里。
- 线程从不显式关闭/归档；它们随 app-server 进程在 agent 拆解时被杀而消亡。
- `client.threadResume`（`src/engine-codex/appserver/client.ts:113-115`）在整个 `src/` 中**没有调用方**——dsh 的 resume 语义由会话日志恢复实现，不用 codex 的 thread/resume。它是当前未用的 API 表面。
- `thread.ts` 会产出 `token-usage` 事件（`thread/tokenUsage/updated`），但 `agent.ts` 的事件 switch 不处理它（落进 default 忽略）；turn 用量只取自 `turn/completed` 的 `turn.usage`。同理 `ErrorNotification.willRetry` 被携带但无人消费。

## 5. 事件映射（RPC 事件 ↔ dsh SessionEvent）

映射分两层：**token 级 delta 在 `agent.ts` 的 step 循环里内联折叠**（流式即时绘制），**item 终态与 usage 在 `appserver/mapping.ts` 里纯函数映射**（`src/engine-codex/appserver/mapping.ts:1-9` 的模块注释明确了这条分工）。

### 5.1 流式 delta → `assistant/chunk`

step 循环（`src/engine-codex/agent.ts:547-651`）维护一套折叠状态：`pendingReasoning`（推理文本累积）、`held`（组装中的 assistant 消息）、`textSeqs`/`pendingReasoningSeqs`（已流出 chunk 的 seq 引用）、block-start 标志位。

- `agent-delta`（来自 `item/agentMessage/delta`）：首个 delta 先 emit `{ type: 'block-start', index, blockType: 'text' }`，之后每个 delta emit `text-delta`（`src/engine-codex/agent.ts:560-568`）。
- `reasoning-summary-delta` / `reasoning-text-delta` / `plan-delta`：三类**都折叠为 reasoning 块**——首个 emit `block-start`（`blockType: 'reasoning'`），之后 emit `reasoning-delta`（`src/engine-codex/agent.ts:569-580`）。注意 plan delta 也进推理流，不单独成块。
- `item-started`：只用于重置 text 块状态，并把 text 块 index 置为当前已累积推理块数（`src/engine-codex/agent.ts:552-559`）——块 index 语义是"消息内第几个内容块"。

每个 chunk 通过 `this.session.append('assistant/chunk', ...)` 立即落日志并返回 seq（`src/engine-codex/agent.ts:511-512`），因此 web 端可见逐 token 的实时渲染。

### 5.2 item 终态 → 持久消息

`item-completed` 按 `item.type` 分派（`src/engine-codex/agent.ts:581-631`）：

- `reasoning`：取 `summary.join('\n') ?? content.join('\n') ?? ''` 累积进 `pendingReasoning`（`src/engine-codex/agent.ts:583-589`）。
- `agentMessage`：把累积推理 + 正文合成**一条** assistant message 暂存（reasoning 块在前、text 块在后），`refs` 记录全部相关 chunk seq（`src/engine-codex/agent.ts:590-604`）。
- `commandExecution` / `fileChange` / `mcpToolCall`：先 `flushReasoning()` + `flushHeld()`（保证工具事件之前的文本/推理先落），再经 mapping 生成 `tool/call` + `tool/result` 事件（`src/engine-codex/agent.ts:605-629`）。**tool/call 是惰性的**——没有 item-started 也会在终态补记（`tests/engine-codex/agent.spec.ts:615` 验证）。
- 未知 item 类型（如 `webSearch`）直接忽略，不产生任何日志事件（`tests/engine-codex/agent.spec.ts:546-570` 验证）。

`flushHeld`（`src/engine-codex/agent.ts:515-532`）落 `assistant/message` 时带 `surfaceOp: 'append'` 和 `sourceEventSeqs: held.refs`——后者把持久消息链接到流出它的 chunk 序列，replay 可精确重建当时的 partial 显示。消息 `source` 固定为 `{ provider: 'codex', model: modelLabel() }`。

### 5.3 turn 完成与 usage

`turn-completed` 时 `mapUsage` 把 `cachedInputTokens → cacheReadTokens`、`reasoningOutputTokens → reasoningTokens`（`src/engine-codex/appserver/mapping.ts:15-22`）。**usage 挂在 step 的最后一条持久消息上**：若 turn 以推理收尾（`pendingReasoning` 非空），先 `flushReasoning(usage)` 让尾随推理独占一条消息并携带 usage；否则挂到最后一条 held agent 消息（`src/engine-codex/agent.ts:632-643`）。`turn/completed` 无 usage 字段则消息不带 usage（`tests/engine-codex/agent.spec.ts:522-544` 验证）。

### 5.4 工具项映射细节（mapping.ts）

- `commandExecution` → `name: 'command_execution'`，arguments 为 `{"command": ...}`，`isError = exitCode !== 0 || status === 'failed'`（`src/engine-codex/appserver/mapping.ts:25-38`）。
- `fileChange` → `name: 'apply_patch'`，result 文本为 `patch <status>`，`isError = status === 'failed'`（`src/engine-codex/appserver/mapping.ts:41-54`）。
- `mcpToolCall` → `name: '<server>/<tool>'`（缺任一则 `mcp_tool_call`），`isError = error != null`（`src/engine-codex/appserver/mapping.ts:57-76`）。
- 三者的 `callId` 都是 `ToolCallId(item.id)`，跨 item 类型不做去重。

### 5.5 request/header

每个 loop 实例在首个 step 记一次 `request/header`：无既有 header 记 `reason: 'initial'`，有则记 `'resume'`（`src/engine-codex/agent.ts:430-441`）。`provider` 恒为 `'codex'`（`src/engine-codex/agent.ts:50`）；未钉 `model` 时 model 标签为 `'codex-native'`（`src/engine-codex/agent.ts:52-56`）——**web 会话的建议性模型选择刻意不镜像进 header**，因为它从不驱动查询（与 `docs/proposals/model-selection-disable.md` 对 claude 引擎的论述同理）。该 provider 标签在引擎挂载期间由插件注册为占位 provider 路由（见 `docs/architecture.md` §3.6），否则宿主按 header 推导的会话模型选择会让第二轮 prompt 被 `model-unavailable` 拒绝。

## 6. 权限模型

### 6.1 折叠规则（permission.ts）

Codex 没有交互审批，权限 = 线程启动时的 `sandboxMode` + `approvalPolicy` 对。`resolveSessionPermission`（`src/engine-codex/permission.ts:39-47`）从会话日志折叠：

| 会话旋钮状态 | codex sandboxMode | codex approvalPolicy |
|---|---|---|
| `sandbox/mode = danger-full-access`（无视 policy） | `danger-full-access` | `never` |
| `approval/policy = ask`（且非 full access） | `workspace-write` | `on-request` |
| 其他任何情况（含无任何旋钮记录） | `read-only` | `never`（`DEFAULT_CODEX_PERMISSION`，`src/engine-codex/permission.ts:26-29`） |

设计取舍（`src/engine-codex/permission.ts:1-13`）：`on-request` 在无人值守的 dsh 运行时里，CLI 自己的交互提示会**退化为拒绝**——所以 `ask` 只是"允许 CLI 在 workspace-write 沙箱内自行判断"，并不真的弹审批。`workspace-write` 沙箱模式本身**不**直接映射：只有配合 `ask` 才升到 workspace-write，否则 fail-closed 到 read-only。

### 6.2 旋钮来源与回退优先级

- 会话旋钮由 `driver-core/permission-knobs.ts` 读取：**最后一个** `sandbox/mode` / `approval/policy` 事件生效（倒序扫描，`src/driver-core/permission-knobs.ts:29-48`）；事件值不在合法枚举内按"无记录"处理。类型是内联镜像的，避免对 `dsh-sandbox-policy`/`dsh-user-approval` 的 peer 依赖（`src/driver-core/permission-knobs.ts:19-26`）。
- 每个 step 查询时**重新折叠**（`queryPermission`，`src/engine-codex/agent.ts:338-344`），所以会话中途切换权限预设对下一个 step 立即生效（`tests/engine-codex/agent.spec.ts:899-933` 验证三次切换）。
- **部署钉值逐字段优先**：`config.sandboxMode ?? fold.sandboxMode`、`config.approvalPolicy ?? fold.approvalPolicy`——钉一个不妨碍另一个跟随会话（`tests/engine-codex/agent.spec.ts:935-954` 验证）。

### 6.3 权限落到哪两个 RPC 参数

- **sandbox 只在线程级**：`thread/start` 的 `sandbox` 字段（`src/engine-codex/agent.ts:480`）；`turn/start` 的 params 只带 `approvalPolicy`（+可选 `model`），**不带 `sandboxPolicy`**（`src/engine-codex/agent.ts:486-492`，`tests/engine-codex/agent.spec.ts:251-252` 断言 `not.toHaveProperty('sandboxPolicy')`）。要改每步沙箱粒度，需要引入 `appserver/types.ts:52-62` 已定义但未用的 `SandboxPolicy` 联合类型。
- `approvalPolicy` 同时出现在 `thread/start` 和 `turn/start` 两处（`src/engine-codex/agent.ts:481, 489`）。

## 7. AGENTS.md 技能注入

### 7.1 为什么 agent 里要重做一遍注入

进程内引擎的 `/name` 技能注入由 dsh-tool-skill 的 handler 完成，但它挂在 agent-preset 上下文链上，**CodexAgent 的上下文不从那条链继承**（`src/engine-codex/agent.ts:283-287` 注释）。所以 `preStep` 在 waterfall 之后自己跑 `injectSkills`（`src/engine-codex/agent.ts:287-291`）：

1. `invokedSkillNames` 扫描本步 user 消息里的 `/name` 手势（只扫 `source.kind === 'user'` 的 text 块，正则 `SKILL_GESTURE`，首次出现顺序去重）（`src/driver-core/skill-inject.ts:18, 84-96`）；
2. 经 `loopCtx.get('skills')` 逐个 `skills.get(name, { signal, scope: this, cwd? })` 加载；加载抛错、未找到、非 userInvocable 都静默跳过（`src/engine-codex/agent.ts:315-321`）；
3. 命中的技能渲染为 `<skill_content>` 块（`renderSkillContent`，`src/driver-core/skill-inject.ts:67-81`），包装成 `source: { kind: 'skill-invocation', name, form: 'instructions' }` 的 user message **追加**到消息批次末尾；
4. 加载期间信号中止则整个注入作废、返回原批次（`src/engine-codex/agent.ts:322`）。

注入消息随后与正常消息一起 append 为 `user/message` 事件，并经由 `serializeHistory` 进入发给 codex 的 prompt 文本。

### 7.2 CodexSkillProvider：AGENTS.md 即技能

`CodexSkillProvider`（`src/engine-codex/skills.ts:46-98`）把 codex CLI 的指令文件体系暴露为 dsh 技能：

- **发现**（`list`，`src/engine-codex/skills.ts:51-62`）：项目侧从会话 cwd 逐级向上走到 git 根（`collectProjectContextFiles` + `CODEX_CONTEXT_POLICY = { primary: ['AGENTS.md'] }`，无 override 文件，`src/engine-codex/skills.ts:33`、`src/driver-core/context-files.ts:34-59`），任一文件非空则产出一个**合并的** `agents-md` 候选（rank 140，介于 project-dsh 100 与 custom 300 之间）；用户侧 `~/.codex/AGENTS.md` 非空则产出第二个候选（rank 160）。同名时项目候选 rank 更低（优先）。无 cwd 时只列用户级。
- **加载**（`get`，`src/engine-codex/skills.ts:64-80`）：`readSources` 把 locator 里的全部路径**按"最近目录优先"顺序拼接**（`\n\n` 连接），`resourceBase` 取最近的文件（`{ kind: 'file', path: first }`）。
- 候选固定 `invocation: { modelInvocable: true, userInvocable: true }`、`source: 'custom'`、`name: 'agents-md'`（`src/engine-codex/skills.ts:83-97`）。

### 7.3 注册点

`mountCodex` 在挂载工厂 fiber 之前注册 provider（`src/index.ts:362-372`）：`skills.registerProvider(control => new CodexSkillProvider(control))`，disposer 存 `skillDisposer`，引擎卸载/切换时由 `cleanupEngineRegistrations` 注销（`src/index.ts:277-286, 424-435`）。codex 引擎**不注册任何 slash command**（与 claude/kimi 不同）。`skills` 服务可选，缺席时跳过注册（`ctx.get` 返回 undefined）。

## 8. 配置项一览

组合条目（`src/index.ts` 的 `Config`）是所有引擎旋钮的超集；codex 只消费以下字段，经 `codexConfig` 转发（`src/index.ts:203-210`）：

| 组合字段 | codex Config 字段 | 校验（`src/engine-codex/loop.ts:71-76`） | 默认 | 语义 |
|---|---|---|---|---|
| `sandboxMode` | `sandboxMode` | `'read-only' \| 'workspace-write' \| 'danger-full-access'`（`loop.ts:34-38`） | 无（跟随会话旋钮） | 钉死每个线程的沙箱模式 |
| `approvalPolicy` | `approvalPolicy` | `'never' \| 'on-request' \| 'on-failure' \| 'untrusted'`（`loop.ts:41-46`） | 无（跟随会话旋钮） | 钉死每个线程的审批策略 |
| `env` | `env` | `z.dict(z.string()).default({})` | `{}` | **当前未被消费**（见 §9.4） |
| `model` | `model` | `z.string()` | 无 | 透传给 `thread/start` 与 `turn/start` 的 `model`，并作为 header/消息 source 的模型标签；缺省时标签为 `codex-native`，模型由 codex 原生设置决定 |

`resolveConfig`（`src/engine-codex/loop.ts:90-97`）只做缺省补齐，产物为 `ResolvedConfig`（`src/engine-codex/types.ts:14-21`）。注意 schema 是"出现才校验"风格——缺省构造 `new CodexLoop(ctx, {})` 时 `env` 也会是 `{}`（`resolveConfig` 里的 `?? {}`），其余字段为 `undefined`（`tests/engine-codex/controls.spec.ts:574-588` 验证）。

无关字段不报错：`disposeGraceMs`/`maxTurns`（claude 用）、`piProvider` 等与 codex 并存但不被读取；`tests/index.spec.ts:632` 专门验证 codex 的配置边界不再校验 `disposeGraceMs`。

## 9. 错误处理与已知边界

### 9.1 错误分类与落日志

- **RPC/协议错误**：JSON-RPC error 响应 reject 为 `Error(error.message)`（`client.ts:163-164`）；`error` 通知或 turn 失败在 agent 侧抛 `LlmError(message, 'CODEX_ERROR')`（`src/engine-codex/agent.ts:644-647`）；事件流结束时没有 `turn-completed` 抛 `LlmError(..., 'CODEX_NO_RESULT')`（`src/engine-codex/agent.ts:655-660`）。
- **turn 级归因**：`turn()` 的 catch 把 `LlmError` 的 failure 记入 `turn/end` 的 `{ kind: 'error' }`，其余错误包成 `{ message: errorChain(error), code: 'UNKNOWN' }`，并先发 `agent/error` 再抛出由驱动边界收敛（`src/engine-codex/agent.ts:397-408`、`248-253`）。**已流出的部分转录（chunk、held 消息、工具事件）在错误抛出前先 flush 落日志**——失败不丢已生成内容（`tests/engine-codex/agent.spec.ts:694-723, 746-769` 验证）。
- **子进程死亡**：所有 pending 请求 reject；下一次 `appServerClient()` 发现 `closed` 会重建客户端（`src/engine-codex/agent.ts:126-130`）——但**进行中的 step 会失败**，重建只惠及后续 step。
- **缺 cwd**：step 直接抛 `no working directory`（`src/engine-codex/agent.ts:451-454`），turn 记 `code: 'UNKNOWN'` 的 error（`tests/engine-codex/controls.spec.ts:308-326` 验证）；技能注入发生在 preStep，先于该失败。

### 9.2 结构性边界

- **无沙箱包装**：子进程不经 `dsh-subprocess` 接缝，harness 的 Landlock/超时等包装对本引擎不适用；权限边界完全依赖 codex CLI 自身 sandbox。
- **单槽通知 handler**：`AppServerClient.onNotification` 是覆盖赋值，叠加订阅会互相顶掉；当前依赖"一个 agent 同一时刻至多一个活跃 turn"成立。
- **stderr 丢弃**：`onStderr` 无人订阅，app-server 的日志不可见，排查协议问题时只能自己临时挂 handler。
- **图片不进 prompt**：序列化把 image 块替换为 `[image omitted: ...]` 占位文本（`src/driver-core/prompt.ts:20-21`）；reasoning 块不进转录（各引擎每次查询自行重新推理，`src/driver-core/prompt.ts:33-37`）。
- **推理摘要 vs 正文**：reasoning item 终态优先取 `summary` 数组，没有才取 `content`，两者皆无记空串——流式 delta 与最终落盘文本可能不一致（delta 来自 summary/text/plan 三路，落盘只认 item 终态字段）。

### 9.3 注释与实现不一致（撰写时发现）

1. **`loop.ts:1-11` 模块注释过时**：称驱动"through the OpenAI Codex SDK"、"The Codex SDK spawns its own CLI binary (no spawn injection seam)"。实际代码没有任何 Codex SDK 依赖——驱动自己用 `node:child_process.spawn` 拉起 `codex app-server`（`appserver/client.ts:9, 76`），走的是手写 JSON-RPC。注释大概沿袭自早期 SDK 方案，"不经 subprocess 接缝"的结论仍然成立，但措辞误导。
2. **`env` 配置是死旋钮**：`Config.env` 注释称"layered over the credential-scrubbed parent environment"（`loop.ts:64-65`），`codexConfig` 也转发它（`src/index.ts:207`），但整个 `src/engine-codex/` 没有任何代码读取 `config.env`——`AppServerClient.create()` 的 spawn 不传 env（`appserver/client.ts:76-78`）。子进程永远继承 dsh 进程环境（也不存在注释所说的"credential-scrubbed"）。要么实现它，要么删掉该字段。
3. **`clientInfo.version` 已对齐**：initialize 报 `'1.0.0-rc8'`（`appserver/client.ts:100`），随本次发布与 `package.json` 同步到 `1.0.0-rc8`。
4. **`threadResume` 无调用方**（`appserver/client.ts:113-115`）：保留的协议面，dsh resume 不走 codex thread/resume。改 resume 语义时注意别误以为它在用。
5. `turn()` 的 `token-usage` 事件与 `ErrorNotification.willRetry` 被产生/携带但无人消费；若将来要中途展示 token 用量或区分可重试错误，这两个钩子已经现成。

另有一处仅测试侧的出入：`tests/engine-codex/agent.spec.ts:59` 与 `controls.spec.ts:53` 给 mock 的 `AppServerThread` 加了 `async dispose() {}`，真实类没有该方法——无害，但说明 mock 形状与真实类已轻微漂移。

## 10. 测试覆盖要点

全部 codex 测试位于 `tests/engine-codex/`（agent / controls / index / permission / skills + `appserver/` client / thread / mapping），共享同一手法：`vi.mock` 掉 `appserver/client.ts` 与 `appserver/thread.ts`，用 `mock.runStreamed` 喂 `AppServerEvent` 序列，断言**会话日志**（这是唯一事实源，也是最好的断言面）。`CodexLoop` 经本地 `loopPlugin` 包装挂载（因为引擎模块是库不是插件）。

- **`agent.spec.ts`**（约 1221 行，核心）：turn/step/user-message/assistant-message/turn-end 全链路；流式 chunk 序列与 `sourceEventSeqs` 链接；推理折叠进后续 agent 消息、尾随推理独占消息并携带 usage、多消息 usage 只挂末条；多 delta 不重复 block-start；空 reasoning/空 text/无 usage 的容错；三类工具 item 的 tool/call + tool/result 与惰性 call；未知 item 忽略；`CODEX_ERROR`/`CODEX_NO_RESULT` 下部分转录保留；request/header 的 initial/resume 语义；取消（aborted turn）、`agent/pre-step` reject（blocked turn）；权限旋钮每查询重折叠与部署钉值逐字段优先；`model` 透传 thread params 与 header；技能注入（转义、跳过不可用户调用/加载失败/未找到、无 skills 服务、非 user source 与 reasoning 块不触发、加载中取消整批作废、无 cwd 时不带 cwd 提示）。
- **`controls.spec.ts`**：steer/inject 合批、cancel 清 inbox 与 `keepInbox`、maintenance 门闩唤醒、运行中取消后接新 turn、防御性 guard（无驱动预约直接 turn、无 cwd）、turn/start 与 turn/end 的 commit veto、空 step 完成、turn-stopping 注入续 step、followup/steer 的 turn/step 链式衔接、配置 schema 常量与解析、systemPrompt 变量装配。
- **`index.spec.ts`**：工厂注册与 HMR 卸载后 `no agent factory registered`；seed/meta 透传；创建信号预中止（Error 与字符串 reason）；setup commit、setup 抛错回滚、悬挂 setup 中止；owner fiber 中途卸载回滚（含 scope mint 竞态）；resume 全套（无持久化报错、JSONL 后端恢复、预中止、加载取消释放 abandoned preparation、晚到失败吞掉、loop 失活拒绝）。
- **`permission.spec.ts`**：三条折叠规则与 fail-closed 默认的纯函数断言。
- **`skills.spec.ts`**：临时目录 + mock homedir 验证项目/用户 AGENTS.md 发现、空文件忽略、cwd→git 根合并顺序、无 cwd 只列用户级、abort 返回空、get 拼接内容与文件消失返回 undefined。
- **`appserver/client.spec.ts`**：mock `node:child_process` 的假进程验证 spawn 参数、initialize/thread/turn 请求-响应、通知分发、进程 exit reject pending、dispose 幂等与 dispose 后拒绝、error 响应、非 JSON 行忽略、stderr 行分发。
- **`appserver/thread.spec.ts`**：纯 fake client 验证事件流转、turn/start 响应前的早期通知缓冲重放、turn/start 失败清 handler、threadId/turnId 双重过滤（含全类型）、error 通知抛出、abort 触发 `turn/interrupt` 且传播 reason、done 后通知忽略。
- **`appserver/mapping.spec.ts`**：四个映射函数的字段级与边界（null/缺字段/失败态）断言。

改引擎行为时的对应义务：本仓要求 `src/**` 行级 100% 覆盖（`pnpm run test:coverage`，client UI 除外），codex 目录里的 `v8 ignore` 注释标的是经过论证的不可达分支——**新增分支要么测试覆盖，要么给出同等论证**，否则覆盖率门禁会红。
