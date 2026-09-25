# Kimi 引擎实现文档

**目标读者**：要修改 `src/engine-kimi/` 的工程师。本文讲清 Kimi 引擎的机制、数据流、设计约束与坑，所有论断均标注源码位置。

## 1. 引擎概述

Kimi 引擎把每个 dsh 会话挂到一个**常驻 `kimi acp` 子进程**上，通过 stdio 上的 JSON-RPC 2.0 说 ACP（Agent Client Protocol，agentclientprotocol.com 定义的客户端↔agent 协议）驱动 Kimi Code CLI（`src/engine-kimi/loop.ts:1-16`、`src/engine-kimi/acp/types.ts:1-15`）。

核心模型：

- **每步无状态**：每个 dsh step 都是一次独立的 `session/new` + `session/prompt`（`src/engine-kimi/agent.ts:563,554`）。Kimi 侧不保留跨步上下文——dsh 会话日志是模型上下文的唯一来源，prompt 是持久历史的纯序列化（`serializeHistory`，`src/driver-core/prompt.ts:150`），保证 "Model-visible ⟺ logged"；唯一例外是本步的最后一条消息就是一条斜杠命令时改发裸行（`engineSlashPrompt`，`src/driver-core/prompt.ts:122`，见 §7.1）。
- **子进程模型**：整个 `kimi acp` 子进程通过 dsh subprocess 接缝（`ctx.subprocess.spawn`）拉起——这是唯一可用的权限边界，沙箱姿态由 subprocess provider 按会话的持久权限旋钮解析（默认 read-only）（`src/engine-kimi/loop.ts:8-13`、`:80-87`）。`subprocess` 服务是构造时用 `ctx.get` **惰性**解析的（引擎是普通类，没有 `static inject` 可声明）：取不到就抛错让选中它的那个会话大声失败（`loop.ts:80-86`）。Kimi 没有 host 审批回调，ACP 反向 RPC `session/request_permission` 由会话的 dsh approval 旋钮回答（见第 6 节）。
- **方向辨析**：主仓自带 `@deepseek-ai/dsh-acp`（`../deepseek-harness/packages/acp/acp`）是 **ACP server**（把 dsh agent 暴露给外部 ACP 客户端）；本驱动是 **ACP client**（dsh 作客户端驱动 kimi CLI 这个 agent）。两者方向相反，不要混淆。
- **kimiBin 解析**：`kimiBinResolver`（`src/engine-kimi/process.ts:59-64`）三级回退——① 配置钉死的路径（`kimiBin` 配置项，空字符串视为未配置）；② 探测标准安装位 `<kimi home>/bin/kimi[.exe]`，其中 kimi home = `KIMI_CODE_HOME` 环境变量或 `~/.kimi-code`（`kimiHomeDir`，`process.ts:47-50`）；③ 回退裸命令 `'kimi'`，由 spawner 经 PATH 解析。

## 2. 模块组成与各文件职责

| 文件 | 职责 |
|---|---|
| `src/engine-kimi/loop.ts` | `KimiLoop`：`HostedEngineRuntime` 子类（普通类，不是 Cordis Service；实例仍挂在 ctx key `agentLoopKimi` 上）。Config schema、`subprocess` 服务的惰性解析、create/resume 的 prepare→setup→publish 事务、子进程 spawn capability 的构造 |
| `src/engine-kimi/agent.ts` | `KimiAgent`：Agent 接口实现。idle/maintenance/running 相位机、inbox、turn/step 边界落日志、每步驱动一次 ACP 查询、流式 update 映射、技能注入 |
| `src/engine-kimi/process.ts` | Kimi CLI 进程投影：bin 解析、`kimi acp` argv 构造、spawn spec → subprocess 接缝投影、subprocess handle → 传输层投影 |
| `src/engine-kimi/acp/client.ts` | `AcpClient`：`kimi acp` 子进程上的 JSON-RPC 客户端。帧切分、请求-响应关联、`session/update` 通知分发、反向 RPC（权限）应答 |
| `src/engine-kimi/acp/types.ts` | ACP 线格式类型 + 帧判定守卫。形状是对 kimi CLI 0.28.1 的实测记录（types.ts:11） |
| `src/engine-kimi/acp/mapping.ts` | 纯函数：`session/update` 分类、chunk delta 提取、工具调用身份/结果投影 |
| `src/engine-kimi/permission.ts` | 会话权限旋钮 → ACP 工具审批布尔值的折叠 |
| `src/engine-kimi/skills.ts` | `KimiSkillProvider`：AGENTS.md 上下文文件与 `.kimi-code` skills 目录 → dsh 技能候选 |
| `src/engine-kimi/commands.ts` | `KIMI_COMMANDS`：Kimi 内建斜杠命令的转发桥 |
| `src/engine-kimi/types.ts` | `ResolvedConfig`（仅类型，无运行时代码） |

共享基础设施（`src/driver-core/`）被引用的部分：`ownership.ts`（`FactoryOwnership`、`raceAbort`、`raceAbortCall`）、`prompt.ts`（`serializeHistory`、`engineSlashPrompt`）、`permission-knobs.ts`（`sessionApprovalPolicy`）、`skill-inject.ts`（手势扫描与 `<skill_content>` 渲染）、`context-files.ts`（cwd→git root 的目录链与文件读取）、`inbox.ts`（`DriverInbox`）、`assistant-stream.ts`（`DriverAssistantStream`）。

插件入口侧：`kimiConfig`（`src/index.ts:249-255`）把组合条目的 `model`/`env`/`kimiBin` 透传为 `KimiLoop` 的 `model`/`env`/`bin`。引擎实例由路由器在会话选中 kimi 时构造（`src/index.ts:564-565`、`src/router-loop.ts:158-164`）；它的斜杠命令与技能 provider 由 `registerEngineSurface` 在该 agent 创建时注册进 **agent 自己的 scope**（`src/engine-surface.ts:58-61`、`:77-96`）。

## 3. 引擎运行时与 Agent 生命周期

### 3.1 KimiLoop（引擎运行时）

- `KimiLoop extends HostedEngineRuntime<ResolvedConfig, KimiAgent>`（loop.ts:71）——**普通类，不是 Cordis Service，不声明 `static inject`，也不自己占用 AgentFactory 槽位**。host 面 ctx key 仍为 `agentLoopKimi`（loop.ts:58、`:60-64`）。
- 进程内唯一的 AgentFactory 是路由器 `RouterLoop`（`src/router-loop.ts:114`）：它按插件自己的每会话引擎记录分发（无记录时回退到会话记录的 agent preset），并在某个会话第一次选中 kimi 时构造 `KimiLoop`（`src/index.ts:564-565`，实例缓存于 `RouterLoop.runtimeOf`，`src/router-loop.ts:158-164`）。
- 构造时：`super(ctx, KIMI_ENGINE_LABEL, resolveConfig(config))`（loop.ts:79）解析配置（`resolveConfig`，loop.ts:49-55）并交给基类；基类建 `FactoryOwnership`（agent 拆除跟踪 + 工厂 teardown 信号，`src/driver-core/ownership.ts:40-85`，构造点 `hosted-engine-runtime.ts:103`）与所有权 effect（`hosted-engine-runtime.ts:115`），并把实例挂到 ctx key（`ctx.reflect.provide`，`hosted-engine-runtime.ts:109`）。子类自己只补 spawn capability：用 `ctx.get('subprocess')` **惰性**取服务（缺则抛错，loop.ts:80-86），固定走 subprocess 接缝并带 3000ms 进程树终止宽限（`KIMI_DISPOSE_GRACE_MS`，loop.ts:29、`:87`）。
- Kimi 原生拥有自己的 prompt，`provider`/`model`/`cwd` 三个 systemPrompt 变量只服务 dsh 系统提示词的下游消费者——它们与 `agent-loop` settings section 都由路由器继承的 harness `AgentLoop` 提供（`src/router-loop.ts:114-141`），不在引擎这一层。唯一的重写是 `buildAgent`（loop.ts:91-93）：`new KimiAgent(..., this.config, this.spawn, this.config.bin)`。

### 3.2 创建/恢复事务

> **这套事务已抽到 `src/driver-core/hosted-engine-runtime.ts`，四个引擎共用一份**（`docs/driver-core.md` §4 有完整说明）。下面条目里的行号除特别注明外都指该共享文件；路由器对每个会话调用的就是这两个入口（`src/router-loop.ts:203-212`、`:226-235`）。

`createAgent`/`resume` 共享同一条 prepare→setup→publish 事务（`hosted-engine-runtime.ts:132-246`、`:249-282`、`:375-456`）：

1. **prepare**：先验活（owner fiber 活跃、工厂接受中、调用方信号未中止，`hosted-engine-runtime.ts:133-143`），然后构造三重融合的 abort——调用方取消、owner fiber 卸载、工厂 teardown 任一触发即中止 setup（`hosted-engine-runtime.ts:148-156`）。拆除函数 `dispose` 在发布**之前**就注册进工厂跟踪集和 owner fiber effect，中途卸载会整体回滚（`hosted-engine-runtime.ts:194-201`）。
2. **setup**：`raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id)` 运行调用方 setup 并取其 commit（`hosted-engine-runtime.ts:272`）。
3. **publish**：依次 `sessions.enter` → `agents.enter` → `sessions.announce` → `agents.announce` → 发出 `agent/session-start` 事件，每步之间 `assertLive()`（`hosted-engine-runtime.ts:225-236`）。

`resume` 额外要求 `sessionPersistence` 服务在场，否则直接抛错（`hosted-engine-runtime.ts:377-378`）；加载阶段用 `raceAbortCall` 保证取消后被遗弃的 preparation 仍能 `[Symbol.dispose]()` 释放（`hosted-engine-runtime.ts:408-413`）。

### 3.3 KimiAgent（相位机）

相位定义在 agent.ts:75-83：`idle` / `maintenance` / `running`（带 abort、turn、step、wakeRequested）。`status` 只有 idle/running 两种对外形态（agent.ts:155-157），相位切换经 `setPhase` 发 `agent/status`（150-158）。

- **入口**：`followup`（next-turn + 唤醒）、`steer`（next-step + 唤醒）、`inject`（next-step 不唤醒）、`cancel`（agent.ts:169-206）。`send` 里有一个关键分类：abort 后再唤醒的消息会被重分类到 `next-turn`（agent.ts:170-171）。
- **驱动循环**：`wakeDriver` → `kick` → `while (await this.turn())`（agent.ts:243-296）。`kick` 的 finally 负责把 running 相位收回 idle 并按 latch 的 wake 重放。
- **turn**：`turn/start` → 循环 `preStep`（inbox claim + `agent/pre-step` waterfall + 技能注入）→ `step/start` → 落 `user/message` → `step()` → `step/end` → … → `turn/end`（agent.ts:359-440）。每个退出路径都保证写 `turn/end`（completed / blocked / aborted / error）。
- **step**：每个 step 重置块/工具累积器与产出台账（agent.ts:522-540）→ 校验 cwd（无 cwd 直接抛错，519-521）→ `deriveMessages`，再 `engineSlashPrompt(history) ?? serializeHistory(history)` 造 prompt（525-528，见 §7.1）→ 写一次 request/header（agent.ts:556，见下）→ 取/建 ACP 客户端 → 注册权限回调（540）→ `session/new`（541）→ 挂 `onUpdate`（549）→ `raceAbort(client.prompt(...))`，abort 时先发 `session/cancel`（553-556）→ 收尾：`flushSegment`（756）把尾段块与「公告了但从未给出输入」的调用合成一条消息并落 `tool/call`（567-571）→ 无产出则抛 `KIMI_NO_RESULT`（571）。
- **一次 prompt ≠ 一个 step**：`session/prompt` 跑完 Kimi 的整个内部 loop（实测一次 prompt 内可以连续 60+ 次工具调用），但 dsh 的 **step 是在流处理中途轮转的**——每个助手片段各自一个 step，见 §5「一段一步」。`beginSegment`（agent.ts:667-673）在片段边界补 `step/end` + `step/start` 并就地 `phase.step += 1`；`turn()` 的 finally 关的是 `phase.step`（当前真正打开的那个），不是本次迭代开头开的那个（agent.ts:409-415）。
  因此 `phase` 被当作「当前打开的 step」的载体：轮转就地改它，`agent/error` 上报和 `turn()` 的兜底关闭都读到正确的编号（`RunningPhase`，agent.ts:94）。
- **request/header**：每个 loop 实例只写一次，provider 恒为四个引擎**共用**的 `'external'`（`PROVIDER = HOSTED_ROUTE_LABEL`），model 标签为 `config.model ?? 'default'`（`HOSTED_DEFAULT_MODEL`，`src/agent-preset-ids.ts`）——header 是引擎自己的座位标签，**不镜像** web 会话的模型选择；会话选的真实模型是每步经 ACP `session/set_model` 下发的（§8），两者是两件事。这个 `'default'` 也正是本插件给共享占位 provider 路由**唯一**广告的模型条目（`{ provider: 'external', id: 'default', name: 'default' }`，`src/provider-route.ts`）：菜单按 `model.id` 解析会话的 `(provider, model)`，两边同串才能让那一格显示成「default」，而不是拼出一个没有任何适配器能服务的 `external/...`。已有 baseline 时 reason 记为 `'resume'`，否则 `'initial'`。该共享标签由插件**常驻**注册为**一条**占位 provider 路由（`src/index.ts` 的 `mountProviderRoutes`、`src/provider-route.ts`；见 `docs/architecture.md` §3.6），否则宿主按 header 推导的会话模型选择会让第二轮 prompt 被 `model-unavailable` 拒绝。早期版本写下的 `'kimi'` 标签不再注册，但仍被 `isHostedProviderRoute` 判为托管路由以便重置老会话。

### 3.4 ACP 客户端缓存

`AcpClient` 按 **agent 实例**缓存、跨 step 复用（agent.ts:117-120）；`acpClient(cwd)` 在 spec（argv/cwd/env）变化或进程已关闭时 dispose 旧客户端并重 spawn（agent.ts:473-489）。`initialize` 失败会清缓存、dispose 并抛错（471-478）。agent scope 拆除时释放客户端（139-143）。

## 4. ACP 客户端与进程管理

### 4.1 进程投影（process.ts）

- `kimiAcpArgv(bin)` 只产出 `[bin, 'acp']`（process.ts:74-76）：prompt 走请求体而非 argv 位置参数，因此**没有命令行长度上限，也没有模型旗标**（模型由 Kimi 原生配置持有）。
- `kimiSubprocessSpec` 把 spawn 请求投影到 subprocess 接缝：复制 argv、cwd、三路 pipe stdio、`graceMs`、env，有 signal 才透传（process.ts:79-88）。
- `fromSubprocess` 把接缝 handle 投影成 `KimiProcess` 传输层（stdin/stdout/stderr/done/terminate），缺任一路 pipe 即视为接线错误抛异常（process.ts:91-106）。

### 4.2 JSON-RPC 客户端（acp/client.ts）

- **帧切分**：裸 `\n` 分行，`StringDecoder('utf8')` 跨 chunk 拼字节，容忍行尾单个 `\r`；空行与非 JSON 行直接忽略（client.ts:228-250）。
- **请求-响应关联**：自增数字 id，`pending` map 结算；响应帧带 `error` 时 reject（无 message 时回退 `'kimi acp request failed'`），无匹配 id 的响应丢弃（client.ts:159-166,275-285）。
- **通知分发**：`session/update` 通知同时走 `onUpdate` 回调、内部 buffer 和 `updates()` 异步生成器三路（client.ts:262-268,205-215）。agent 实际只用 `onUpdate` 回调路径（agent.ts:568），生成器是保留接口。
- **反向 RPC**：`session/request_permission` 交给注册的 handler 取布尔裁决，再由 `permissionResponse(approved, options)` 编码成 **ACP `RequestPermissionResponse`**——批准选中 `kind === 'allow_once'` 的那条 option 回填 `optionId`，拒绝选中 `reject_once`（client.ts:31-63,287-294）。**候选不唯一（0 条或多条）时答 `{ outcome: { outcome: 'cancelled' } }`**，因为无头运行时没有人类能在多选里挑一个：Kimi 把 question 桥（`q0_opt_*`）和 plan_review 桥都塞进这同一个 RPC，默认批准会替用户答题，默认拒绝才是 fail-closed（client.ts:40-55 注释）。**未注册 handler 时同样 fail-closed 走拒绝**（client.ts:292）。未知反向 RPC 回 `-32601 Method not found`，防止对端悬挂（client.ts:270-272）。
- **协议握手**：`initialize` 发 `protocolVersion: 1.0`、`clientInfo: { name: 'dsh-loop-engine', version: '1.0.0' }`（client.ts:175-177；版本号是硬编码字符串，与包版本无关）。
- **会话操作**：`newSession` 校验返回里的 `sessionId` 非空字符串（client.ts:180-187）；`setModel` 发 `session/set_model { sessionId, modelId }`，走同一条 `request`，所以引擎用错误帧拒绝模型时该 Promise 直接 reject（client.ts:189-199）；`prompt` 体为 `{ sessionId, prompt: [{ type: 'text', text }] }`；`cancel` 是 fire-and-forget，吞掉 rejection。
- **生命周期**：`dispose()` 封口、请求进程树终止、以 `'kimi acp client is sealed'` 拒掉所有 pending（218-226）；子进程 `done` 正常落定（exit）时以 `'kimi acp process exited unexpectedly'` 拒掉 pending 并封口（124-129）。**注意 done 以 rejection 落定的分支只封口、不拒 pending**（130-133）——此时在飞的 prompt 永不结算（测试 `client.spec.ts:413-427` 显式覆盖了该行为，改这里要先想清楚语义）。
- `AcpClient.create(spec, spawn?)`：给了 spawn capability 就用它（生产路径，subprocess 接缝）；没给就退回 `node:child_process` 裸 spawn（client.ts:73-80,143-146）——后者只在无接缝环境（测试）出现。

## 5. 事件映射（ACP update ↔ dsh SessionEvent）

映射分两层：`acp/mapping.ts` 是纯分类/提取，`agent.ts` 的 `applyUpdate`（agent.ts:676-755）负责落日志——每个 delta 都交给当前段的 `DriverAssistantStream`（`currentStream`，agent.ts:760-782）出 live 帧，块内容则累积进 `blocks`、拿到输入的工具调用累积进 `segmentCalls`，到段收尾（第一个 settled 结果）由 `flushSegment`（agent.ts:784-795）→ `flushAssistant`（agent.ts:808-846）合成**一条** durable 消息。

| ACP update | dsh 事件 | 说明 |
|---|---|---|
| `agent_thought_chunk` | live `agent/assistant-stream` 帧（block-start/reasoning-delta）+ `assistant/message` 的 reasoning 块 | 空 delta 忽略，不开块（agent.ts:677-685）；到达前先 `beginSegment` 视情况轮转 step |
| `agent_message_chunk` | 同上，text 块 | agent.ts:688-696 |
| `tool_call` | 仅登记（不落日志） | `callId` 取 `toolCallId`、`name` 取 `title`，存进 `pendingCalls` 等参数（agent.ts:699-707）。空 id、已登记或已落日志的 id 忽略。**公告本身不带 `rawInput`**，所以此刻还写不出 `tool/call` |
| `tool_call_update` | 落 `tool/call` + `tool/result` | 参数取 `rawInput`（JSON 序列化，`toolRawInput`，mapping.ts:71-77）——Kimi 只在 update 上给参数（实测 0.28.x：执行开始那条 `status: 'in_progress'`）。拿到参数的 update 只把该调用**登记进 `segmentCalls`**（不落日志），段内**第一个** settled 结果触发 `flushSegment`：把本段累积的所有调用合成**一条** `assistant/message`（reasoning/text + 全部 `tool-call` 块），再逐个落 `tool/call`，最后补本条的 `tool/result`（agent.ts:709-753）。若一直没等到参数，则在 settled 时以 `'{}'` 落日志，保证不丢调用。文本按 `{ type: 'content', content: { type: 'text', text } }` 嵌套提取，**但语义是快照不是增量**（mapping.ts:89-107）：每条 update 重发该调用的完整内容，所以只取**最后一条**（`toolContentText` 返回 `string \| undefined`，`undefined` = 这条 update 未带 content 字段，保留上一条）。登记期收到的快照同样保留（`pendingCalls` 的 `content` 字段），否则「先给输出后给输入」的帧序会丢掉结果文本。status 离开 `pending/queued/running/in_progress` 即视为 settled（mapping.ts:79-82），`failed/error/denied` 记 `isError`（mapping.ts:84-87）；空结果文本回退 `'(no content)'`（mapping.ts:108-115）。未 announce 过的 callId 的 update 被忽略 |
| 其他（`available_commands_update`、`config_option_update`、`plan`…） | 无 | 不属于忠实模型上下文投影，直接跳过（agent.ts:754-755） |

落日志的几个不变量：

- **块序**：reasoning/text 块按首次出现顺序分配连续 index（agent.ts:642-653）；每段结束 `flushAssistant` 把该段的块合成一条 `assistant/message`，并把这批块对应的 compact stream 内嵌成 `data.stream`（agent.ts:808-846）。
- **一段一步，工具调用是段的结尾**：一个助手片段（文本/思考 + 它请求的工具调用）合成**一条** `assistant/message`，并用**独立的 attempt**（各自的 `start`…`end` 帧）settle。拿到输入的调用先进 `segmentCalls` 累积（不落日志），段内第一个 settled 结果触发 `flushSegment`（agent.ts:784-795）——先 `flushAssistant` 把 reasoning/text + **全部** tool-call 块合成一条消息，再逐个写 `tool/call`——所以持久日志里恒为 `assistant/message` → `tool/call`…`tool/call` → `tool/result`；该段收尾（`tool/result` 落盘）后，下一条助手内容到达时 `beginSegment` 轮转 step（agent.ts:667-673），于是**每个片段各自一个 step**。
- **为什么必须拆成 step（不能只拆成消息）**：chat 的助手节点按 `${turn}:${step}` 建键（`packages/client/ui-chat/src/client/conversation-nodes/assistant.ts`），同一 step 内的多条 `assistant/message` 会落到**同一个**节点，而 `settleMessage` 是**整体替换** blocks——即一个 step 里发 N 条消息，最终只渲染**最后一条**。而节点排序只按 `anchorSeq`（= 消息的 seq），没有「step 的助手节点排在它的工具行之前」这种规则。所以在一个 step 内，工具行的 seq 夹在中间、唯一那条消息只能落在最后，**任何消息排列都无法交错**。in-process 引擎之所以正常，正是因为它 **一个 step 恰好一条消息、且该消息在工具执行之前落盘**（`packages/core/agent-loop`），于是消息的 seq 小于它自己的工具行。拆成 step 就是复刻这个形状。
  宿主客户端还按「一条持久消息 ↔ 一个 attempt 的 `end` 帧」配对（`packages/api/session-controller/src/client/sessions/assistant-stream.ts`）：一条消息一个 attempt，且 attempt 未结束前收到第二个 `start` 会触发整页 rebaseline。所以**不能**让多条消息共用一个 attempt。
- **纯工具段**：一个只有工具调用、没有文本的片段也会发一条 `assistant/message`，其内容就是该调用的 `tool-call` 块（此时没有 open attempt，`data.stream` 落空数组）。这条消息是 `tool/call` + `tool/result` 的父消息，也是重放到 in-process 引擎时 `tool_calls` 的来源。
- **同一模型轮次的多个调用共用一个 step、且共用一条消息**：轮转的判据是「本 step 已有 settled 的 `tool/result`」而非「有调用被公告」（`stepSettledTools`，agent.ts:622-629）。模型一次请求多个工具时 Kimi 会在任何结果之前把调用全部公告出来，此时 `stepSettledTools` 仍为 0，不轮转——这些调用属于同一个模型轮次，本就该在同一个 step 里；它们各自的 `rawInput` 到达后都累积进 `segmentCalls`，由第一个 settled 结果一次性 flush 成**一条** `assistant/message`（含全部 `tool-call` 块）。若某个调用的 `rawInput` 迟到到前一结果之后，`applyUpdate` 里会先 `beginSegment` 再入 `segmentCalls`（agent.ts:729-730），于是它落到下一个 step。
- **孤儿调用**：公告了却始终没有 update 的调用（工具被中止、会话中断）在 step 收尾时以 `'{}'` 补进 `segmentCalls` 并随尾段 flush，只落 `tool/call` 不落 `tool/result`（agent.ts:586-594）。
- **空步报错**：prompt 返回后整轮没有任何助手产出（既无块也无工具调用），抛 `LlmError`，code `'KIMI_NO_RESULT'`（agent.ts:596-601）——防止模型静默空转。产出与否由 `producedOutput` 台账记录，而不是「step 结束时 `blocks` 是否为空」：块在每段落盘时就被清空，用后者会把有文本的步误判成空步。
- **轮转的 step 不重跑 `preStep`**：只有 `turn()` 开口的第一个 step 走 inbox claim + `agent/pre-step` waterfall + 技能注入。轮转出来的 step 没有新的用户消息（ACP prompt 已是原子的，中途也无法投递 steer/inject），所以不跑 waterfall。这与 in-process 引擎的续接 step 有差异，是刻意取舍。

时序保证：`session/prompt` 的响应帧在该轮全部 update 之后派发，因此每个 update 都在 prompt resolve 前应用完毕，无 EOF/"finished" 竞态；ACP 子进程跨 step 存活，其流不会自行结束（agent.ts:564-565 注释）。

## 6. 权限模型

Kimi 没有 host 审批回调，ACP 的 `session/request_permission` 由会话的持久 approval 旋钮回答：

- `resolveToolApproval(events)` = `sessionApprovalPolicy(events) !== 'ask'`（permission.ts:30-32）。即：**`ask` 策略降级为拒绝**（无人值守运行时唯一安全的答案，fail-closed）；`never` 或无旋钮一律自动批准。
- **沙箱姿态不参与该折叠**（permission.ts:24-27 JSDoc）：Kimi 自己的工具策略约束工具能做什么，ACP 审批是 host 的闸门，信号只取 `approval/policy` 旋钮。沙箱姿态另由 subprocess 接缝在进程层生效。
- `sessionApprovalPolicy` 从后往前取最后一条合法 `approval/policy` 事件（`src/driver-core/permission-knobs.ts:40-47`）。
- 权限回调在每个 step 重新挂载：`client.onPermission(() => resolveToolApproval(this.session.snapshotEvents()))`（agent.ts:559），读的是**应答时刻**的会话日志，所以运行中切换策略即刻生效。
- 双保险：即使 agent 没挂 handler，client 未注册 handler 时默认拒绝（client.ts:292）。
- **裁决 ≠ 应答**：布尔裁决只是驱动侧的决定，线上必须编码成 ACP 的 `RequestPermissionResponse`（选中 agent 广告的某条 option 回填 `optionId`，见 §4.2）。Kimi 侧只读 `response.outcome.optionId`（其 `permissionResponseToApprovalResponse` 对 `cancelled` 之外的任何未知/缺失 optionId 一律返回 `decision: 'rejected'`，而请求本身失败时 catch 分支同样回落 `'rejected'`）——所以**答成非 ACP 形状（例如自造的 `{ approved: true }`）会被 Kimi 一律当作用户拒绝**，表现为 `Tool "…" was not run because the user rejected the approval request`，且与 dsh 侧选了什么权限预设无关。这意味着改这里的线格式必须对着 Kimi CLI 内嵌的 `@agentclientprotocol/sdk` 的 zod schema 核，不能只看本地 mock。

## 7. 斜杠命令桥接与技能注入

### 7.1 斜杠命令（commands.ts）

dsh `commands` 运行时本地执行注册命令，命令行不会到达模型；真实处理在 Kimi 引擎内的命令必须**转发原文行**给 agent：`forwardKimiCommand` 把 `/<name><rawInput>` 作为普通 user 消息 `followup` 给接收 agent（commands.ts:44-52）。

转发只是把行送回给自己——**真正让它生效的是驱动侧的斜杠命令步**：该 user 消息成为本步最后一条消息时，`engineSlashPrompt` 让它以裸行形式发出（`src/driver-core/prompt.ts:122`、`src/engine-kimi/agent.ts:550`）。若仍走 `<user>...</user>` 框架，ACP 适配器的 `detectLeadingSlashIntent` 只看首个 block 的首字符，`/status` 会被当散文交给模型（实测：模型开始猜"用户是不是打了斜杠命令"）。所以"注册"负责菜单可见与本地消费，"裸行"负责引擎真正展开，两者缺一不可。

`KIMI_COMMANDS`（commands.ts:60-67）注册的正是 **`kimi acp` 命令面实测实现的那 6 条**：`compact`、`status`、`usage`、`mcp`、`tasks`、`help`（实测方式：直连 `kimi acp` 逐条发 `session/prompt`，0.28.1；子进程自己发布的 `available_commands_update` 也给出同一份内建列表 + Kimi 自己的技能）。其余 TUI 控制类命令（`/login`、`/provider`、`/settings`、`/sessions`、`/clear`、`/plan`、`/auto`、`/version`、`/goal`）ACP 面一律回 `Unknown ACP command: /name. Use /help to see available commands.`，因此都不注册——注册一条不存在的命令只会让菜单骗人。`skill:` 类命令已由 dsh 技能注入接缝承载（用户打 `/skill:xxx` 时手势扫描不命中，裸行会落到 ACP 的技能解析），不重复注册。

两个刻意的缺席（commands.ts:21-28 模块注释）：

- **`/model` 不桥接**：web 客户端自己占着 `/model` 贡献（`ui-model-selection`），host 侧同名命令会让 `ui-commands` 把整个 command 菜单源判死——表现为菜单里所有命令消失、只剩技能。这是真实踩过的坑，不是未雨绸缪。
- **`/goal` 不桥接**：托管会话的 dsh 原生命令面由**该会话的 hosted preset** 决定，不再由 managed block 按引擎全局禁用决定。插件从 `standard` 剥掉的就是 `STRIPPED_ROWS`（`src/preset.ts:75`，生成点 `:198`）那一批 dsh 原生行，其中**包含 `command-goal`**——理由正是"人类命令注册在 preset 层"：主仓 `packages/preset/agent-presets/presets/standard/agent.cordis.yml:95` 自带一行 `command-goal`，而 profile patch 里禁 host 层的那一行够不到它（主仓 `packages/bundle/web-app/cordis.patch.yml:411-412` 本来就已禁），所以要摘只能在 preset 层摘（`src/preset.ts:63-69`）。**托管会话里因此不存在 dsh 的 `/goal`**，也就没有可被引擎自有 `/goal` 撞名的对象；Kimi 侧同样没有注册 `/goal`——`kimi acp` 的命令面不实现它（会回 `Unknown ACP command`），所以 `KIMI_COMMANDS` 里没有这一条，注册只会换来一句 unknown-command（`src/engine-kimi/commands.ts:24-28`）。

`registerEngineSurface` 注册这些命令时与 dsh 原生命令撞名则告警跳过（`commands.register` 抛错就 warn 并继续），不让 agent 启动失败（`src/engine-surface.ts:84-91`）。

### 7.2 技能 provider（skills.ts）

`KimiSkillProvider` 把 Kimi 的两类磁盘内容暴露为 dsh 技能：

- **`agents-md`（rank 140）**：cwd→git root 链上每个目录的 `AGENTS.md`（`KIMI_CONTEXT_POLICY` 只认 AGENTS.md，skills.ts:46-48），合并为一个候选，body 是各文件按就近优先拼接（`readSources`，`src/driver-core/context-files.ts:126-132`）；全为空文件则不产生候选。
- **SKILL.md 条目**：项目级 `<dir>/.kimi-code/skills/`（rank 150，沿目录链每层都查）与用户级 `$KIMI_CODE_HOME/skills/`（默认 `~/.kimi-code/skills/`，rank 160）（skills.ts:40-45、`src/driver-core/agents-md-skill-provider.ts:115`）。两种布局都收：子目录 `SKILL.md` 和根下扁平 `<name>.md`（`agents-md-skill-provider.ts:186-197`）；目录条目经 `stat` 跟随链接（Windows junction 的 Dirent 两者都不是，`agents-md-skill-provider.ts:179-185` 注释）。重名时项目文件因 rank 更低而胜出。

约束与留白：

- 通用 `~/.agents/skills/`、`.agents/skills/` 根**刻意不扫**（skills.ts:17-19）——in-process 下它们由 web profile 的 `skill-filesystem` provider 覆盖；而托管引擎下 `skill-filesystem` 行已被 hosted preset 剥掉（见 architecture.md §3.5），这些根在 kimi 会话里就不出现，这正是"引擎接管技能面"的语义。
- 复用共享 `parseSkillFile`（agents-skill frontmatter：`name`/`description`/`whenToUse`/`disable-model-invocation`）；Kimi 自己的 `disableModelInvocation`/`type` 字段**不翻译**，`type: flow` 技能会被当作 model-invocable 暴露（skills.ts:21-25）。
- Kimi CLI 内建技能没有稳定磁盘位置，不在本 provider 范围（skills.ts:19-21）。

### 7.3 技能注入（agent 侧）

进程内引擎的技能注入由 agent-preset 链上的 dsh-tool-skill handler 完成，Kimi agent 的 context 不从该链派生，所以在 `preStep` 里自行复刻（agent.ts:305-315 注释）：

- `invokedSkillNames` 扫直接用户消息里空白边界的 `/name` kebab-case 手势（`src/driver-core/skill-inject.ts:84-96`）。
- 逐个 `skills.get(name, { signal, scope: this, cwd })`；加载失败、未找到、非 user-invocable 一律静默跳过（agent.ts:342-348）。
- 注入的消息以 `source: { kind: 'skill-invocation', name, form: 'instructions' }` 落 `user/message`（agent.ts:350-353），正文是 `renderSkillContent` 的 `<skill_content>` 块（skill-inject.ts:67-81）。
- 加载期间 step 被取消，整批注入丢弃（agent.ts:349）；`skills` 服务缺席时原样放行（agent.ts:333-334）。

## 8. 配置项一览

组合条目层（`src/index.ts` 的 `Config`，`src/index.ts:92-109`、schema 注释 `:111-121`）中 Kimi 相关字段，经 `kimiConfig`（`src/index.ts:249-255`）透传：

| 组合字段 | KimiLoop 字段 | 含义 |
|---|---|---|
| `model` | `model?: string` | **两个去向**：(1) request/header 与消息 provenance 的模型标签（agent.ts:476-477、857），未钉时为 `'default'`（`HOSTED_DEFAULT_MODEL`，`src/agent-preset-ids.ts:71`）；(2) 作为**回落值**经 ACP `session/set_model` 下发——每个 step 取 `sessionModelOverrideOf(ctx, session)?.model ?? config.model`（`src/driver-core/session-model.ts`），会话选的真实 dsh 模型优先，`config.model` 是会话没选时的回落。仍**不进 argv**（`kimiAcpArgv` 无模型旗标，process.ts:74-76）：`kimi acp` 只有 `--login`/`--region`，模型只能走 ACP。JSDoc（loop.ts:33、types.ts:17）写着"`-m`/`--model`"仍不准确——现在传的是 `session/set_model`，见第 9 节 |
| （会话选真实 dsh 模型时）端点与凭据 | 非配置项 | 每个 step 解析一次（`resolveModelHandover`，`src/driver-core/model-handover.ts`，调用点 `src/engine-kimi/agent.ts:574`），结果经 `kimiModelEnv`（`src/engine-kimi/model-handover.ts`）叠进**子进程 env**：`KIMI_MODEL_NAME` = model、`KIMI_MODEL_API_KEY` = 凭据、`KIMI_MODEL_BASE_URL` = `baseURL`、`KIMI_MODEL_PROVIDER_TYPE`（`anthropic-messages`→`anthropic`，`openai-completions`/`openai-responses`→`openai`，`api` 为 `undefined` 或其余值**省略**——端点照旧交出去）。这是 Kimi 自己的 env-model 通路（`applyEnvModelConfig`，内嵌于 `kimi` 二进制），定义 provider + 一个 model alias 并把 `defaultModel` 指向它，所以**不碰** `~/.kimi-code/config.toml`；端点变了就换一个子进程 env（`handoverEnv` 按内容 memo，`agent.ts:550-556`，未变则复用同一对象、不重启子进程）。**有端点注入时跳过 `session/set_model`**（`agent.ts:623`）：env model 已是默认，而 `set_model` 要的是 kimi 侧的 model **alias**，不是 dsh 的裸 id。选 `external/default` 或没有选择、或**端点/凭据**解析不到时**不注入**（后者 warn 一次），退回原来的 `session/set_model` |
| `env` | `env?: Record<string,string>`（默认 `{}`） | 显式传给 `kimi` 子进程的环境条目（loop.ts:36、52；spawn spec 原样带，agent.ts:496） |
| `kimiBin` | `bin?: string` | Kimi CLI 可执行文件；未钉时按第 1 节三级回退解析（loop.ts:37-38、53） |

环境变量：

- `KIMI_CODE_HOME`：影响 bin 探测的 kimi home（process.ts:47-50）与用户级 skills 目录（skills.ts:55-60，两处各自独立读取，注意是**进程环境**而非 `env` 配置项）。

固定常量：`KIMI_DISPOSE_GRACE_MS = 3000`（loop.ts:29）。

## 9. 错误处理与已知边界

### 错误处理路径

- **无 cwd**：step 开头抛 `no working directory`（agent.ts:541-544），turn 以 `error` 收场；ACP 客户端尚未创建。
- **initialize 失败**：客户端 dispose、缓存清空，错误沿 step 上抛（agent.ts:480-487）。
- **取消**：abort 信号触发 `session/cancel`（fire-and-forget），`raceAbort` 以中止原因拒掉 prompt await（agent.ts:570-580）；turn 以 `aborted` 收场。
- **子进程意外退出**：pending 请求全部以 `kimi acp process exited unexpectedly` 拒绝（client.ts:79-84），客户端 closed，下一步 `acpClient` 会重 spawn。
- **commit veto**：`turn/start`/`turn/end` 落日志被 veto 时经 `throwError` 上报 `agent/error` 并在驱动边界收容，inbox 不丢（agent.ts:271-280,362-366,418-424；测试 agent.spec.ts:787-847）。
- **step 无产出**：`KIMI_NO_RESULT`（agent.ts:596-601）。

### 已知边界与坑

- **~~`tool/call` 的参数恒为 `'{}'`~~**：已修（2026-09-18）。旧实现把 arguments 硬编码成 `'{}'`，理由是「ACP 公告不携带真实参数」——前半句对，结论错。实测（`kimi acp` 直连抓帧，Read/Write/Bash 三类工具）证实：`tool_call` 公告的键是 `sessionUpdate/toolCallId/title/kind/status/content`，**确实没有** `rawInput`；但紧接着的 `status: 'in_progress'` 那条 `tool_call_update` 带 `rawInput`（如 `{"command":"echo probe-done"}`），完成帧另带 `rawOutput`。协议侧 `zToolCall`/`zToolCallUpdate` 都声明了 `rawInput: unknown().optional()`。
  现在的做法是：公告只登记进 `pendingCalls`，拿到 `rawInput` 的 update 把该调用登记进 `segmentCalls`（真参数），段内第一个 settled 结果触发 `flushSegment` 一次性落 `assistant/message` + 全部 `tool/call`，一直没等到参数则在 settled 时以 `'{}'` 落，保证调用不丢（agent.ts:709-753）。**代价**：工具行出现在执行开始而非被请求的瞬间（差一条 update）。教训：ACP 的「公告帧」和「执行帧」字段可以不同，别拿公告的字段集当整个调用的字段集——抓帧要抓到 settled，否则会像旧实现一样把「公告没给」误判成「协议没有」。

> 复现这次实测的最小手段：`kimi acp` 起子进程，按 ACP 顺序发 `initialize` → `session/new` → `session/prompt`，把每条 `session/update` 原样打印；`session/request_permission` 要回一条选中 `allow_once` 的 `{ outcome: { outcome: 'selected', optionId } }`，否则工具不执行、`rawInput` 也不会出现。
- **~~一轮的工具行全堆在最后、中间的思考和文字看不见~~**：已修（2026-09-18）。旧实现每个 step 只在 prompt 返回后写一条 `assistant/message`，而 Kimi 把整个内部 loop 塞进一次 `session/prompt`，于是一次 step 的工具行全部先落、文字最后才出（实测：一个 kimi step 里 61 个 tool call 挤在 step 1，而 in-process 引擎平均 1.3 个/step）。
  **中间走过一次弯路值得记下来**：第一版修法只把消息拆成「一段一条」，没拆 step。结果更糟——chat 的助手节点按 `${turn}:${step}` 建键且 `settleMessage` 整体替换 blocks，一个 step 里 N 条消息只渲染最后一条，于是屏幕上只剩最后一段的 `思考`，前面的全被覆盖。正确做法是连同 step 一起拆（`beginSegment`，agent.ts:667-673），复刻 in-process 的「一步一消息、消息在工具之前」形状。教训：**判断渲染问题的根因必须同时看日志形状和 UI 的节点建键/替换规则**，只盯日志顺序会得出错的方向。
  **同一个坑的第二形态（2026-09-19 修）**：拆 step 之后，同一模型轮次里**并行公告的多个工具调用**仍会在同一个 step 内各发一条 `assistant/message`（每条消息只带一个 `tool-call` 块），于是 chat 节点仍按 `${turn}:${step}` 替换 blocks——最后一条裸 `tool-call` 消息把前面的 reasoning/text 和其余工具头全盖掉，屏幕上只剩「冷冷清清的工具调用」。修复：拿到 `rawInput` 的调用不再立即落日志，而是累积进 `segmentCalls`，段内第一个 settled 结果才由 `flushSegment` 把 reasoning/text + 全部 `tool-call` 块合成**一条**消息再逐个落 `tool/call`（agent.ts:729-753,753-764）。教训与上面同一条：**日志里一个 step 多条消息 = UI 只渲染最后一条**，修渲染必须保证「一步一消息」。
- **ACP 会话的粒度是「一次 prompt / 一个 turn-loop 迭代」，不是轮转后的 step**：`session/new` 每次调用 `step()` 一次（agent.ts:560），而 `beginSegment` 轮转出来的 step 共用同一次 ACP prompt 与同一个 ACP 会话——轮转只发生在 dsh 的持久日志层，不重开子进程侧的会话。
- **每步全新 ACP 会话**：`session/new` 每步一次，Kimi 侧无跨步记忆；prompt 体积随会话历史线性增长，长会话的每步成本会升高——这是 "log ⟺ model-visible" 不变量代价，与 claude/codex 驱动一致。
- **每步按需 `session/set_model`（dsh 端点注入时跳过）**：`session/new` 之后、`prompt` 之前，若本步解析出的模型（会话选择 ?? `config.model`）非空就发一次 `session/set_model { sessionId, modelId }`（agent.ts）。模型由 Kimi 用错误帧拒绝时 `request` reject，那一步直接失败、prompt 不会跑——错误浮上来，不静默退回原生默认。粒度是每个 step（每步新会话），所以中途 `/model` 下一步生效。**例外**：dsh 端点被交给这条子进程时（§8 那条），模型已经由 `KIMI_MODEL_NAME` 定义成 kimi 的默认，且它需要的是 kimi 侧的 model **alias**而不是裸 id，所以这一步**不发** `set_model`；端点变化会自动换一个子进程 env。
- **done-rejection 分支不拒 pending**：`done` 以 rejection 落定时在飞请求永不结算（client.ts:130-133），见 4.2。
- **撞名命令被跳过**：见 7.1。
- **~~审批被拒的 `tool/result` 文本会被 Kimi 的输入回显撑爆~~**：已修（2026-09-18）。`tool_call_update.content` 是**累计快照**而非增量，旧实现逐条追加（`toolText` accumulator），一次被拒的 Bash 调用会留下 6.6KB 的 `{{"command{"command"...` 嵌套垃圾并被喂回模型上下文。现在改为一律**替换**最新快照（见 §5 表与 `mapping.ts:95-113`）。教训：Kimi 的 chunk 类字段（`agent_message_chunk`/`agent_thought_chunk`）是增量，工具卡字段是快照——两类字段不能按同一套假设折叠。
- **Kimi 的 question / plan_review 桥未被利用**：Kimi 把 `AskUserQuestion` 和 plan_review 也塞进 `session/request_permission`（选项 id 形如 `q0_opt_*`、`plan_*`）。当前实现只按 `kind` 找唯一的 `allow_once`/`reject_once`，多候选一律 `cancelled`（fail-closed、诚实但不作答）。dsh 有 `ctx.userQuestions`（codex 驱动已接，见 `docs/engine-codex.md` §6.4），理论上可把这类请求转过去真答；需要先把 ACP 选项 id 空间映射回问题/选项，属于**新功能**而非修 bug。

- **Kimi 的 ACP 不上报 token 用量（会话统计里少几项的根因）**：`session/prompt` 的响应只有 `{"stopReason":"end_turn"}`，**没有** ACP 规范里那个可选的 `usage`；`session/update` 实测只出现四种——`available_commands_update`、`session_info_update`、`agent_thought_chunk`、`agent_message_chunk`，**没有任何用量更新**，全帧里唯一带 "usage" 字样的只是它把自己 TUI 的 `/usage` 命令列进 `availableCommands`（给人敲的，不是数据）。复测手法与本节上面那条完全相同（`initialize` → `session/new` → `session/prompt` 直连抓帧，2026-09-25，`bin/kimi.exe`）。
  所以 `flushAssistant()` 不写 `assistant/message.usage` **不是漏读，是线上没有这个数据**。后果：dsh 的会话统计弹窗里「Token 用量」（含缓存命中）与「输出速度（TPS）」都由用量投影算出，Kimi 会话**无源可取**，只剩按墙钟算的三行——模型用时 / 工具调用用时 / TTFT（这三项来自驱动发布的 `assistant-stream` 帧，不依赖用量），composer 底部那排内联读数（tok/s、token 数、缓存命中%）同样不出现。对比：claude-code / codex / pi **都**把引擎的用量映射进 `assistant/message`（`...usage === undefined ? {} : { usage }`），所以那三个引擎有这些读数。
  **将来 Kimi 若开始发 `PromptResponse.usage`，修法是一处**：在 `acp/types.ts` 补字段声明，再在 `flushAssistant()` 的 `data` 里加 `usage`（照 codex/pi 的 `mapUsage` 写法）。**兜底**：Kimi 自己的 `/usage` 命令已由插件透出（§7.1 的六条之一），敲它可看引擎侧的文本用量。



### 代码与注释不一致之处（改动前先核对）

1. **`process.ts` 模块头过时**（process.ts:2-8）：描述的是"`kimi -p --output-format stream-json`、每步一个一次性子进程"，实际实现是常驻 `kimi acp` + JSON-RPC。`KimiSpawnSpec` 的 JSDoc（process.ts:19"one `kimi -p` child"）同样过时。
2. **`types.ts` 模块头过时**（types.ts:4-10）：仍在讲 `-p` 面自动批准、无 `--tools` 旗标，与 ACP 驱动模型不符。
3. **模型旗标 JSDoc 失实**：`Config.model`（loop.ts:33"(`-m`)"）与 `ResolvedConfig.model`（types.ts:17"(`--model`)"）声称模型会经命令行旗标传给子进程，实际 argv 无任何模型旗标——现在模型经 ACP `session/set_model` 下发（§8、§9 上一条）。
4. **客户端生命周期注释**：client.ts:11 说子进程"long-lived (one per factory)"，实际客户端按 **agent** 缓存（agent.ts:117-120），一个工厂下多个会话各有自己的子进程。client.ts:53"once per driver scope"才是准确说法。
5. **块序注释内部张力**：agent.ts:649-650 先说"Reasoning leads the assistant message; text follows"，又接"Indexes stay contiguous in the order blocks first appear"——代码实现的是后者（按首次出现排序），若 text 先到则 text 在前，前一句不是保证。
6. **permission.ts 模块头易误导**（permission.ts:9-13）：大段谈论 full-access/workspace-write 沙箱如何自动批准，但函数根本不读沙箱旋钮（permission.ts:24-27 的函数 JSDoc 才是准的）。

## 10. 测试覆盖要点

Kimi 相关 spec 共 9 个文件（约 3100 行），仓库覆盖门槛为 `src/**` 逐文件 100%（`src/client` 除外），所以源码里大量 `v8 ignore` 注释标记的是防御性 backstop，不是可删代码。

- `tests/engine-kimi/agent.spec.ts`（1170 行）：核心。mock `AcpClient` 喂 `session/update` 流，覆盖——流式 text/thought → 单条 assistant/message；tool_call/tool_call_update → tool/call + tool/result（含**落日志时序：assistant/message 先于其 tool/call、tool/call 先于其 tool/result**；**真参数来自 update 的 `rawInput`**；**settle 时仍无参数则回退 `'{}'`**；**纯工具段仍发父消息**；**公告后无 update 的孤儿调用在收尾补记且不配 tool/result**；**连续增长的快照只留最后一条**；**先给输出后给输入的帧序不丢结果**；settle 帧不带 content 时沿用上一条快照；空 id 与未公告 id 的 update 被忽略）；**step 轮转（`stepStructure` 辅助函数读 `type@step` 序列）：两段各自的 assistant/message + tool/call + tool/result 落在连续的两个 step，尾段自成第三个 step；任何结果之前公告的多个调用留在同一个 step 且合成同一条 assistant/message；结果后才给输入的调用轮转到下一个 step**；未知 update 跳过；`KIMI_NO_RESULT`；权限回调（auto 批准 / ask 拒绝）；abort → `session/cancel`；客户端跨步复用（`created` 仅 1 次）；initialize 失败清理；无 cwd 报错；技能注入全部分支（注入、无服务、加载失败/undefined/非 user-invocable 跳过、加载中取消丢弃、无 cwd 时仍注入再失败）；steer/inject/maintenance/keepInbox；turn 链式（mid-turn followup/steer/disposed 不重放）；空 step 与 reject 的 turn 收场；commit veto；resume request header。
- `tests/engine-kimi/index.spec.ts`（689 行）：工厂注册与 HMR 安全拆除（fiber dispose 后槽位清空）；create 的 seed/meta 透传、预中止信号（Error 与非 Error reason）、setup commit/失败回滚/挂起中止、owner fiber 中途卸载回滚（含 scope minting 竞态）；resume 全路径（无 persistence 报错、JSONL 后端恢复、预中止、取消加载时释放遗弃 preparation、加载后工厂失活、prepare 失败传播、取消后迟到失败吞掉）。
- `tests/engine-kimi/loop.spec.ts`（242 行）：spawn 管线——bin 解析优先级、spawn spec → 接缝投影（argv/stdio/graceMs/env/signal）、handle → 传输层 round-trip、stderr 排空；**构造时 ctx 上没有 `subprocess` 服务就大声失败**（`/needs the dsh subprocess service/`）；systemPrompt 变量在无 agent 时为 undefined（变量由挂载包装提供，见 §3.1）。
- `tests/engine-kimi/process.spec.ts`（125 行）：`kimiHomeDir`/`kimiBinResolver`（mock `existsSync` 与 homedir）、`kimiAcpArgv`、`kimiSubprocessSpec`（argv 复制、signal 透传）、`fromSubprocess`（缺 pipe 抛错）。
- `tests/engine-kimi/acp/client.spec.ts`（439 行）：假 `KimiProcess` 上的全协议行为——请求关联（result/error/无 message 回退/孤儿响应）、session 生命周期（newSession 无 id 抛错、prompt 体形、cancel 吞 rejection）、update 缓冲与生成器、反向 RPC（按 `CANONICAL_OPTIONS` 批准→`approve_once` / 拒绝→`reject`、多候选与无 option 词汇→`cancelled`、畸形 option 条目被丢弃、未知 method → -32601、无 handler fail-closed）、`create` 的注入 spawn 与裸 spawn 回退、notify、帧健壮性（`\r\n`、空行、非 JSON、string chunk、method 非字符串）、封口后行为、子进程退出拒 pending、done rejection 只封口。
- `tests/engine-kimi/acp/mapping.spec.ts`（136 行）：分类谓词、chunkDelta 边界（image/缺 content）、status 分类（settled/error）、嵌套 content 拼接、**无 content 字段 → `undefined`（区别于空 content → `''`）**、**`toolRawInput`（对象序列化 / 字符串原样透传 / 字段缺失 → `undefined`）**、`toolResult` 投影与 `(no content)` 回退。
- `tests/engine-kimi/permission.spec.ts`（30 行）：`resolveToolApproval` 折叠——never/沙箱/无旋钮批准，ask 拒绝且压过 full-access。
- `tests/engine-kimi/skills.spec.ts`（254 行）：`kimiAgentDir` 覆盖；AGENTS.md 发现/空文件忽略/cwd→git root 合并；项目与用户 SKILL.md 发现（含 `KIMI_CODE_HOME` 覆盖、扁平 .md、垃圾条目跳过、目录缺 SKILL.md、abort 返回空）；get 的内容加载与文件消失 → undefined。
- `tests/engine-kimi/commands.spec.ts`（50 行）：转发 handler 的原文行拼装（带/不带参数）与 `KIMI_COMMANDS` 每条都有转发 handler。

另：`tests/index.spec.ts` 覆盖插件入口层（managed block 的写入/legacy 迁移、per-engine preset 的 authoring、共享 provider 占位路由、settings 的 default-engine 转向），改 `src/index.ts` 的 kimi 部分时一并跑；引擎自己的命令/技能注册由 `src/engine-surface.ts` 承载，见 §7.1 与 `tests/engine-kimi/index.spec.ts`。
