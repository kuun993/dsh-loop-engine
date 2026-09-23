# Pi 引擎实现文档（engine-pi）

**目标读者**：要修改 dsh-loop-engine 的 pi 引擎的工程师。本文通读 `src/engine-pi/` 全部源码后写成，所有论断标注源码位置；与注释不一致之处单独列在文末。

## 1. 引擎概述

pi 引擎把每个 dsh 会话驱动到 `@earendil-works/pi-coding-agent` CLI 上：以 `pi --mode rpc` 启动一个子进程，通过 stdio 讲**严格 LF 的 JSONL** 协议（`src/engine-pi/rpc/client.ts:1-11`）。

两个核心设计动机：

- **Pi 没有权限系统**（"runs with the permissions of the user"），驱动无法让它做沙箱或审批回调。唯一可用的边界是进程环境：要么让整个子进程以 dsh 用户身份裸跑（full access），要么收缩它的 `--tools` 白名单（`src/engine-pi/permission.ts:1-16`、`src/engine-pi/types.ts:4-8`）。子进程一律经由 dsh subprocess seam 启动（`src/engine-pi/loop.ts:164-170`），获得独立进程树、环境清洗和树级终止——但注意 subprocess seam **没有 OS 级沙箱**（见第 6 节与文末"不一致"）。
- **无状态 step 模型**：dsh 会话日志是模型上下文的唯一来源（model-visible ⟺ logged）。每个 dsh step 发一个 `new_session` + 一条 `prompt`，prompt 是持久化历史的纯序列化（`src/engine-pi/agent.ts:584-587`、`src/driver-core/prompt.ts:150`）；**例外**是本步最后一条消息就是一条斜杠命令时改发裸行（`engineSlashPrompt`，`src/driver-core/prompt.ts:122`）——Pi 的输入展开只认以 `/` 开头的整条文本（extension command `text.startsWith("/")`、`/skill:name`、prompt template `^\/([^\s]+)(\s+[\s\S]*)?$`，见 `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` 与 `prompt-templates.js`），带 `<user>` 框架的转录一条都不命中。每个 step 都**重建一个 Pi RPC 子进程**：`pi --mode rpc` 的一个进程跑完一个 session（`agent_settled`）后不再接受/正确执行第二个 `new_session`+`prompt`（实测会挂起、随后退出——"pi RPC process exited unexpectedly"），所以驱动在每步结束 dispose 掉客户端、下一步用全新进程（`src/engine-pi/agent.ts:829-834`、step 的 finally）。每个 step 的 Pi 进程与会话都是全新的。

## 2. 模块组成

| 文件 | 职责 |
|---|---|
| `src/engine-pi/loop.ts` | `PiLoop`：`HostedEngineRuntime` 子类（普通类，不是 Cordis Service；实例仍挂在 ctx key `agentLoopPi` 上）。配置 schema、Pi CLI 入口解析、`subprocess` 服务的惰性解析、create/resume 发布事务 |
| `src/engine-pi/agent.ts` | `PiAgent`：相位机（idle/maintenance/running）、inbox、每 step 的 RPC 查询与事件→会话日志映射 |
| `src/engine-pi/permission.ts` | 把会话的 `sandbox/mode` / `approval/policy` 事件折叠成 Pi 运行时姿态（sandboxMode + `--tools`） |
| `src/engine-pi/skills.ts` | `PiSkillProvider`：把 pi 的上下文文件与 skills 目录暴露为 dsh 技能 |
| `src/engine-pi/probe.ts` | `pi --list-models` 探针：spawn 一次、合并 stdout+stderr、解析列对齐表格得到模型目录 |
| `src/engine-pi/types.ts` | `PiSandboxMode`、`ResolvedConfig`（纯类型） |
| `src/engine-pi/rpc/client.ts` | `PiRpcClient`：严格 LF JSONL 分帧、命令/响应关联、事件缓冲 |
| `src/engine-pi/rpc/types.ts` | `pi --mode rpc` 协议的最小子集类型（纯类型） |
| `src/engine-pi/rpc/mapping.ts` | usage / tool result / tool call → dsh 会话事件的映射函数 |

共享基础设施（`src/driver-core/`）：`ownership.ts`（FactoryOwnership、raceAbort）、`hosted-engine-runtime.ts`（`HostedEngineRuntime`：四个引擎共用的 create/resume 事务，§3.1/3.2）、`prompt.ts`（serializeHistory、engineSlashPrompt）、`permission-knobs.ts`（会话旋钮读取）、`context-files.ts`（上下文文件收集）、`skill-inject.ts`（`/name` 手势扫描与 `<skill_content>` 渲染）、`inbox.ts`（DriverInbox，会话收件箱投影）、`assistant-stream.ts`（DriverAssistantStream，live 帧与 compact stream）。

## 3. 引擎运行时与 Agent 生命周期

### 3.1 PiLoop（引擎运行时）

`PiLoop extends HostedEngineRuntime<ResolvedConfig, PiAgent>`（`src/engine-pi/loop.ts:148`）——一个**普通类**，不是 Cordis Service，也不自己抢 AgentFactory 槽位。进程内唯一的 AgentFactory 是路由器 `RouterLoop`（`src/router-loop.ts:114`）：它按插件自己的每会话引擎记录分发（无记录时回退到会话记录的 agent preset），并在某个会话第一次选中 pi 时构造 `PiLoop`（`src/index.ts:562-563` 的 `buildEngine`，实例缓存于 `RouterLoop.runtimeOf`，`src/router-loop.ts:158-164`）。构造函数做四件事（`loop.ts:156-181`）：

1. `resolveConfig` 在插件配置边界定稿配置（`loop.ts:71-79`）；
2. `piCliEntrypoint()` 解析 Pi CLI 的 bin 路径——包是 ESM-only，所以用 `import.meta.resolve` 拿到入口、回退两级到包根、读 `package.json` 的 `bin` 字段（`loop.ts:82-96`）；
3. `spawn` 投影：`piSubprocessSpec` 把 `PiSpawnSpec` 包成 `SubprocessSpawnSpec`，在 argv 前加 `process.execPath`（即用当前 node 跑 pi 的 JS 入口），stdio 全 pipe，`graceMs = 3000`（`PI_DISPOSE_GRACE_MS`，`loop.ts:36、99-108`）；`fromSubprocess` 再把 dsh 的 `SubprocessHandle` 投影回协议传输所需的 `PiProcess`（`loop.ts:111-132`）；
4. 唯一的重写 `buildAgent`（`loop.ts:184-189`）：`new PiAgent(..., this.config, this.spawn, this.bin, this.catalog)`——引擎特有的 spawn/bin/模型目录都在这三行里交给驱动。

`subprocess` 服务不再靠 `static inject` 保证——引擎是 `new` 出来的普通类，没有 Cordis 的注入列表可声明：构造函数用 `ctx.get('subprocess')` **惰性**取，取不到直接抛（`loop.ts:164-167`）。晚构造的引擎只让选中它的那个会话大声失败，而不是让整个插件启动失败。基类在构造时只做两件事：`ctx.reflect.provide(label, this)` 把实例挂到 `ctx.agentLoopPi`（`hosted-engine-runtime.ts:109`，**这是内省面，不是 setFactory**）与注册工厂所有权 effect（`hosted-engine-runtime.ts:115`）。**AgentFactory 槽位与 `provider`/`model`/`cwd` 三个 systemPrompt 变量都不在这一层**：槽位归路由器，三个变量与 `agent-loop` settings section 由路由器继承的 harness `AgentLoop` 提供（`src/router-loop.ts:114-141`）。

> **这套事务已抽到 `src/driver-core/hosted-engine-runtime.ts`，四个引擎共用一份**（`docs/driver-core.md` §4 有完整说明）。

路由器对每个会话调用的两个入口就是这套事务（`src/router-loop.ts:203-212`、`:226-235`）：`createAgent`/`resume` 走同一套"准备 → setup → 发布"（`hosted-engine-runtime.ts:132-246`、`:249-282`、`:384-456`）：`prepare` 在发布**之前**把一次性 memoized 反向拆除注册进 `FactoryOwnership` 和 owner fiber，setup 中途卸载会整体回滚；中止信号融合三方（调用方 signal、owner fiber 卸载、工厂拆除）（`hosted-engine-runtime.ts:148-156`）。`publish` 依次进入两个注册表、announce、发 `agent/session-start`（`hosted-engine-runtime.ts:225-236`）。`resume` 要求 `sessionPersistence` 服务存在，否则直接抛错（`hosted-engine-runtime.ts:377-378`）。

### 3.2 PiAgent（驱动）

相位机与 Codex 驱动同构（`agent.ts:74-83`）：`idle` / `maintenance` / `running(turn, step)`。`wakeDriver` 从 idle 起一个 driver 跑 `kick()`，kick 循环 `turn()` 直到排空 inbox（`agent.ts:244-293`）。`send/followup/steer/inject/cancel/runMaintenance` 是对外控制面（`agent.ts:170-234`）。

RPC 客户端**懒创建、按 step 重建**：`rpcClient(cwd)` 每次先算 `spawnSpec`，若当前客户端已 disposed（或规格变化）则 dispose 旧客户端重新 spawn（`agent.ts:146-154、64-72`）；由于 Pi 进程单 session，`step()` 在 finally 里 dispose 掉本次客户端（`agent.ts` step 末尾），下一步自然换新进程。agent scope 拆除时亦释放客户端（`agent.ts:143-146`）。

`turn()` 负责会话日志边界：`turn/start` → 循环 `preStep` + `step/start` + `step()` + `step/end` → `turn/end`（`agent.ts:372-449`）。`preStep` 走 `agent/pre-step` waterfall，之后追加技能注入（见第 7 节）。

每 step 的查询在 `step()`（`agent.ts:547-836`）：要求会话带 cwd（否则抛错，`agent.ts:554-557`）→ `session.deriveMessages()` + `serializeHistory` 得到 prompt → 每生命周期补一次 `request/header`（`assertRequestHeader`，`agent.ts:457-468`）→ `newSession()` + `clearEvents()` + `prompt(prompt)`（`agent.ts:606-608`）→ 消费事件流直到 settle。

dsh 系统提示词装配**故意不跑**：Pi 原生拥有自己的系统提示词，dsh 那套装配会拉 dsh 工具 schema，对托管引擎无意义（`agent.ts:538-546` 注释）。

## 4. JSONL RPC 客户端

### 4.1 严格 LF 的原因

协议是 strict LF JSONL：记录之间只用裸 `\n` 分隔，容忍行尾 `\r`，而 U+2028/U+2029 在 JSON 字符串里是普通字符——通用行读取器若把它们当换行就不合规（`src/engine-pi/rpc/types.ts:8-12`）。因此客户端自己实现分帧：`StringDecoder('utf8')` 做字节→文本解码（处理多字节字符跨 chunk），`indexOf('\n')` 切行、剥尾部 `\r`（`client.ts:212-226`）。非 JSON 行静默忽略（`client.ts:234-236`），空行跳过（`client.ts:230`）。

### 4.2 命令/响应与事件流

- 命令写入 `JSON.stringify(command) + '\n'`；`request()` 在命令无 `id` 时分配自增 id，响应按 `id` 关联到 pending map，`success: false` 时 reject（`client.ts:164-181、237-246`）。
- 非响应行一律进事件缓冲并唤醒 `events()` 生成器（`client.ts:248-251`）。`events()` 是无限生成器——缓冲空就挂起等唤醒，只有 `disposed` 才返回（`client.ts:188-198`）。**这就是 step 必须靠 settle 信号 break 的原因**（见第 5 节）。
- stderr 只排空不记录，防止话多的子进程堵满管道（`client.ts:92-96、254-257`）。
- 子进程退出：置 `disposed`，所有 pending 以 `'pi RPC process exited unexpectedly'` reject，唤醒事件流（`client.ts:107-113`）。`dispose()` 幂等，先置标志再 `terminate()` 进程树（`client.ts:201-209`）。

### 4.3 无状态 step 模型

客户端提供的命令只有四个：`new_session` / `prompt` / `abort` / `get_session_stats`（`client.ts:140-161`）。驱动每 step 只用前两个半：

```
await client.newSession()   // 全新 Pi 会话（配合 --no-session 不落盘）
client.clearEvents()        // 丢弃上一 step 残留事件（client.ts:135-137）
await client.prompt(prompt) // 整条序列化历史作为一条 prompt
```

prompt 由 `serializeHistory`（`src/driver-core/prompt.ts:93-127`）生成：`<user>` / `<assistant>` / `<tool-result>` 标签帧起来的转录文本；reasoning 块不进转录（每个引擎每次查询自己重新推导，`prompt.ts:36-37`）；图片块用占位文本 `OMITTED_IMAGE_TEXT`（`prompt.ts:20-21`）。因为输出是日志前缀的纯函数，同一日志重放得到同一 prompt。

`abort` 在取消路径上 fire-and-forget 发送（见第 9 节）；`get_session_stats` 已定义但驱动目前不调用。

## 5. 事件映射（RPC 事件 → dsh SessionEvent）

`step()` 内的事件循环（`agent.ts:729-834`）是全驱动最密的部分，按事件类型分四类：

- **忽略**：`agent_start`、`compaction_*`、`auto_retry_*`、`queue_update`、`bash_execution_update`、`extension_ui_request`、`tool_execution_update`、`text_start`/`thinking_start`、`toolcall_start`/`toolcall_delta`、`text_end`/`thinking_end`（`agent.ts:732-740、752-754、764-767、771-773`；`message_start` 是例外——它清空该条 assistant 消息的累积器，`agent.ts:741-747`）。
- **流式增量 → live 帧 + 消息内嵌 stream**：`text_delta` / `thinking_delta` 首次出现某 contentIndex 时先补一个 `block-start`，再发 `text-delta` / `reasoning-delta`，都交给本次尝试的 `DriverAssistantStream`（`src/driver-core/assistant-stream.ts:32`、`agent.ts:650-672、755-763`）。它把 chunk 压进 compact stream 并发 `agent/assistant-stream` 的 `chunk` 帧，随后由 `flushHeld` 内嵌进 durable `assistant/message` 的 `data.stream`，使重放能精确重建 live partial（`agent.ts:626-645`）。
- **工具 → `tool/call` / `tool/result`**：`toolcall_end` 与 `tool_execution_start` 都会**登记**调用（不去重就重），用 `emittedToolCalls` 按 callId 去重；登记时同时把 tool-call block 推进 `pendingToolCalls`、把调用本身推进 `pendingCallLog`。`tool/call` **不在登记时落盘**——要等它所属的 assistant message 落盘之后才发（见下「段内顺序」）。`tool_execution_end` 先 `ensureToolCallOwner()` 保证 durable surface 里该 result 之前已经有一条携带对应 tool-call block 的 assistant message，再发 `tool/result`（经 `mapToolResult`）；`turn_end.toolResults` 兜底再发一轮。
- **段内顺序（修过，2026-09-18）**：`tool/call` 曾经在 `toolcall_end` 就落盘，而助手消息要到 `message_end` 才 flush——于是工具行的 seq 小于它自己那条消息，chat 按 `anchorSeq` 排序后文字显示在它描述的动作**之后**。现在把 `tool/call` 推迟到「折叠了它那块 tool-call block 的那次 flush」之后：`contentOf` 折入 `pendingToolCalls` 时同步把 `pendingCallLog` 移进 `callsToLog`，`flushHeld` 写完消息后按序发出这些 `tool/call` 并清空（`ensureToolCallOwner` 走合成消息那条路径时同样搬移）。日志因此恒为 `assistant/message` → `tool/call` → `tool/result`。
- **一段一步（step 轮转）**：一次 pi prompt 跑完模型的整个 agentic loop，一个 step 里会有多条 assistant 消息（实测一条 turn 里 6 条）。这必须拆开——chat 的助手节点按 `${turn}:${step}` 建键（`packages/client/ui-chat/src/client/conversation-nodes/assistant.ts`），同一 step 的多条消息落到**同一个**节点，而 `settleMessage` 是**整体替换** blocks，N 条只渲染最后一条。所以 `message_start`（assistant）时调 `beginSegment`：本 step 已有 settled 的 `tool/result` 就补 `step/end` + `step/start` 并就地 `phase.step += 1`。判据是「已有 settled 结果」而非「有调用被公告」，这样同一模型轮次里连续公告的多个调用仍留在同一个 step。
- **收尾 → `assistant/message` + usage**：`message_end`（assistant）用权威消息内容 flush 一条 durable assistant message；`turn_end` 兜底未 flush 的消息；`agent_end` / `agent_settled` 最终 flush（`agent.ts:777-785、801-816、817-828`）。usage 取最新快照（`message_update.usage` / `message.usage`），经 `mapUsage` 折叠到最后一条 message 上（`rpc/mapping.ts:19-26`：缺省补 0，cache 字段为 0 或缺省时不写）。

**tool-call 配对（切回 in-process 的关键）**：durable `assistant/message` 的 content 必须携带 `tool-call` block，`tool/result` 才能在主仓推导消息时配对到前一条 assistant `tool_calls`。Pi 的权威消息 content 只有 text/thinking，所以 `contentOf` 在返回前把 `pendingToolCalls` 折进该 assistant 消息并清空（`agent.ts:721-724`）；`ensureToolCallOwner` 覆盖引擎未流式给出 assistant 消息、直接执行工具的情况，先补一条只含 tool-call block 的 assistant message（`agent.ts:684-690`）。这保证会话之后切回 in-process 引擎时，不会出现 `role: 'tool'` 前面没有 `tool_calls` 的 400。

**settle 语义（关键坑）**：`finished` 在任何"终态-ish"事件（含 mid-run 的 `turn_end`）置位，但 `settled` 只在 `agent_settled` 或 `willRetry` 为假的 `agent_end` 置位；只有 `settled` 才 break 事件循环（`agent.ts:607-620、820-827、833`）。因为子进程跨 step 存活、`events()` 永不自行结束，少了这个 break，`step()` 会在回复流完后挂死。循环结束若 `!finished`（子进程死了/流断了），抛 `LlmError('... ended without an agent settle', 'PI_NO_RESULT')`（`agent.ts:835-840`）。

**thinking 折叠**：权威消息的 content 里没有 reasoning 块、但流式阶段收到过 thinking delta 时（某些 provider 只发 delta），把累积的 thinking 按 contentIndex 排序后折到文本块之前，与默认 loop 的"先推理后回答"顺序一致（`agent.ts:712-718`）。

## 6. 权限 / 沙箱模型

### 6.1 姿态折叠

`resolveSessionPermission`（`permission.ts:63-76`）从会话日志最后一条 `sandbox/mode` / `approval/policy` 事件（`src/driver-core/permission-knobs.ts:29-47`）折叠出运行时姿态：

| 会话旋钮 | Pi 姿态 |
|---|---|
| `sandbox/mode = danger-full-access` | 不裁剪工具（`--tools` 不下发，Pi 用原生工具集） |
| `approval/policy = ask` | **降级为 read-only 拒绝**——Pi 没有审批回调，交互式批准只能变成拒绝，即使会话同时要 workspace-write（`permission.ts:68-71`） |
| `sandbox/mode = workspace-write` | 写能力（但无 shell）工具集 `['read','write','edit']`（`permission.ts:43-44`） |
| 其他/缺省 | fail-closed：`read-only` + `['read']`（`DEFAULT_PI_PERMISSION`，`permission.ts:32-40`） |

部署钉死优先：`queryPermission` 里 `config.sandboxMode` 存在时直接用 `toolsForSandbox(config.sandboxMode)`，不再读会话旋钮；未钉死则每个 query 重新折叠，使会话中途切换 preset 在下一 step 生效（`agent.ts:366-373`）。`--tools` 仅在非空时下发（`agent.ts:524-525`）。

### 6.2 "沙箱"的实际边界（重要）

源码多处注释称整个子进程"wrapped in the dsh subprocess sandbox"（`types.ts:7-8`、`loop.ts:6-8、43-44`、`agent.ts:8`、`rpc/client.ts:5`；`permission.ts` 的模块头与 `PiPermission.sandboxMode` 已在修复幽灵工具名时一并改正）。**经核实本仓引擎实际走的那条接缝不含任何 sandbox 机制**——主仓 `packages/subprocess/subprocess/src` 与 provider `packages/subprocess/subprocess-local/src` 里 `grep -ri sandbox` 零命中，唯一命中 `sandbox` 字样的是同组的 `win32-process` 受限令牌辅助库与 README 措辞（`sandbox` 是另一个接缝：主仓里由 shell 工具族 `bash-sandbox` / `pwsh-sandbox` 注入消费，见 `packages/shell/bash-sandbox/src/index.ts:46` 的 `inject = ['subprocess', 'sandbox', 'sandboxPolicy']`；`ctx.subprocess.spawn` 这条路径不经过它），`SubprocessSpawnSpec` 也没有沙箱字段（`../deepseek-harness/packages/subprocess/subprocess/src/types.ts:75-106`），`piSubprocessSpec` 自然也不传任何沙箱参数（`loop.ts:99-108`）。

实际生效的边界是三层，**没有 OS 级文件系统/网络隔离**：

1. **进程树隔离与终止**：detached 进程组（POSIX）/ `taskkill /T /F`（Windows），SIGTERM → graceMs → SIGKILL 升级（`subprocess/src/types.ts:160-195`、`subprocess-local/src/spawn.ts:550-562`）；
2. **环境清洗**：子进程基础环境是 `scrubbedParentEnv()` 的结果，配置里的 `env` 显式叠加在其上（`subprocess-local/src/spawn.ts:47`、`subprocess/src/types.ts:97-103`、`types.ts:27`）；
3. **`--tools` 工具白名单**：这是 `sandboxMode` 唯一真正的执行点——`read-only`/`workspace-write` 只是不给子进程写/执行类工具，而不是强制它不能写。

⚠️ **白名单里的名字必须是 pi 真实存在的工具**。pi 的内建工具只有 `read`/`bash`/`edit`/`write`（Pi RPC 进程的 argv 只带这三个：`--tools read,write,edit`），且 `--tools` 里的未知名字**静默无效**——pi 既不报错也不提示（`--tools` 同时作用于内建、扩展与自定义工具，见 `pi --help`）。2026-09 之前 `DEFAULT_PI_PERMISSION` 里的 `grep`/`find`/`ls` 就是这种幽灵条目：`read-only` 实际只剩 `read`，`workspace-write` 的 `grep/find/ls` 也从未生效。**给这个列表加名字前，先确认 pi 或其已装扩展真的提供该工具。**

改这里时不要把 `sandboxMode` 当成安全边界来推理；它实质是"工具面收缩"。

## 7. 技能注入

两条互补路径：

**Provider 侧**——`PiSkillProvider extends AgentsMdSkillProvider`（`skills.ts:83-87`，算法在 `src/driver-core/agents-md-skill-provider.ts`，见 `docs/driver-core.md` §7.2.1）由 `registerEngineSurface` 在 **agent 创建时**注册进该 agent 自己的 scope（pi 条目 `src/engine-surface.ts:55-57`，注册逻辑 `:93-96`；调用点 `src/router-loop.ts:171`），发现两类候选：

- `agents-md`（合并技能）：会话 cwd 到 git root 的每目录上下文文件，策略是 `AGENTS.override.md` 优先、否则 `AGENTS.md` → `CLAUDE.md`（`PI_CONTEXT_POLICY`，`skills.ts:43-46`；收集逻辑在 `src/driver-core/context-files.ts:52-72`），外加用户级 `<piAgentDir>/AGENTS.md`（spec 的 `userContext`，`skills.ts:66`）。`piAgentDir()` 读 `PI_CODING_AGENT_DIR`，缺省 `~/.pi/agent`（`skills.ts:53-58`）。项目集 rank 140，用户集 rank 160——项目文件赢同名冲突（`skills.ts:35-41`）。
- `SKILL.md` 目录项：项目各级 `.pi/skills/`（rank 150）与用户 `~/.pi/agent/skills/`（rank 170），支持 `<name>/SKILL.md` 目录型与 `<name>.md` 扁平型两种布局；用 `stat` 而非 Dirent 判定类型，因为 Windows 的 junction 两者都不是（`skills.ts:162-191`）。解析复用 `src/skills.ts` 的 `parseSkillFile`。

不扫 `.agents/skills`（dsh 自己的 `skill-filesystem` provider 已覆盖）；pi 设置/CLI/包级技能需要跑 `pi --mode rpc` 探针才能发现，组合期不做，文件系统子集即权威（`skills.ts:15-20` 注释）。

**注入侧**——Pi agent 的 context 不挂在 agent-preset 链上，dsh-tool-skill 的 `/name` 手势注入够不着它，所以 `preStep` 里复制了这套手势扫描（`agent.ts:306-316、327-353`）：扫本 step 用户消息里的 `/name`（`invokedSkillNames`，`skill-inject.ts:84-97`）→ `skills.get` 加载（失败静默跳过）→ 仅 `userInvocable` 的注入 → 渲染成 `<skill_content>` 块、以 `source: { kind: 'skill-invocation', name, form: 'instructions' }` 的 user message 追加进本批消息。注入发生在 step 的用户消息落日志之前，因此技能内容同样进持久化日志、可重放。

## 8. 配置项一览

组合入口（`src/index.ts` 的 `Config`）里的 pi 字段经 `piConfig` 透传（`src/index.ts:238-246`）：

| 组合入口字段 | PiLoop Config | 去向 |
|---|---|---|
| `piProvider` | `provider` | `--provider <值>`（`agent.ts:516`） |
| `model`（与 claude/codex 共用） | `model` | `--model`，见下 |
| `piThinking` | `thinkingLevel` | 拼进 `--model`，见下 |
| `env`（共用） | `env` | 显式叠加到子进程环境（`loop.ts:55、106`） |
| `sandboxMode`（与 codex 共用同一键） | `sandboxMode` | 钉死姿态，见第 6 节 |

> 注：`config.model` 在 `spawnSpec` 里是**回退值**——它优先读会话日志最新 `model/selection` 事件的 `model`（用户经 `/model` 选择），仅在无该事件时回退到部署配置（见下）。Pi 模型目录（`pi --list-models` 探针结果）经内部 `piCatalogHolder` 注入，而非本表所列的用户配置项，详见 §8.1。

`--model` 拼接规则（`agent.ts:517-523`）：

- `model` + `thinkingLevel` → `--model <model>:<thinkingLevel>`
- 仅 `model` → `--model <model>`
- 仅 `thinkingLevel` → `--model :<thinkingLevel>`（空 model 段，由 Pi 原生模型 + 指定思考档）

> 新增：`spawnSpec` 计算 `--model` 时，先取本会话日志最新 `model/selection` 事件的 `model`（用户经 `/model` 选择），其次才回退到部署配置的 `model`。**选中的值还要过一遍探针目录**：只有当它确实是 pi 已发现的模型（`model` 相等，或 `provider/model` 全名相等）才采用，否则丢弃、让子进程落回 pi 原生默认，避免把别的 provider 的模型名（例如 `anyai-v1`）喂进去导致子进程以 "Model ... not found" 退出；目录为空（探针未完成）时跳过这条校验（`agent.ts:501-511`）。`model/selection` 为空或缺失时用配置值。

固定 argv 前缀：`[bin, '--mode', 'rpc', '--no-session', ...]`（`agent.ts:527-532`）——`--no-session` 让 Pi 会话不落盘，与无状态 step 模型配套。

模型标签：部署钉了 `model` 则用该值记入 `request/header` 与 assistant message 的 `source.model`；未钉则记 `'pi-native'`——web 会话的建议性模型选择**故意不**镜像进 header，因为它从不驱动查询（`agent.ts:55-60、456-458`）。provider 标签恒为 `'pi'`（`agent.ts:54`），由插件**常驻**注册为占位 provider 路由——四个托管标签（`claude-code`/`codex`/`pi`/`kimi`）同时在场，因为任何会话都可能选中任一引擎（`src/index.ts:362-389` 的 `mountProviderRoutes`、`src/provider-route.ts:27-33`；见 `docs/architecture.md` §3.6），否则宿主按 header 推导的会话模型选择会让第二轮 prompt 被 `model-unavailable` 拒绝。

## 8.1 模型探针（pi --list-models）

PiLoop **构造时**（也就是第一个选中 pi 的会话被创建时）用 `probePiModels`（`src/engine-pi/probe.ts:84-104`，调用点 `src/engine-pi/loop.ts:175-180`）spawn 一次 `pi --mode rpc --list-models`（无会话），并把 stdout 与 **stderr** 一起收集——pi 把模型表打在 STDERR 上、stdout 留给 JSONL RPC 协议（`probe.ts:20-51` 的 `collectOutput` 注释）——再解析列对齐表格前两列（`provider` / `model`，`parsePiModelList`，`probe.ts:60`）得到模型清单，写入插件 `apply` 作用域共享的 `piCatalogHolder.entries`（经 `Config.piCatalogHolder` 传入）。provider 路由占位 adapter 的 `listModels` 据此把模型目录暴露给 dsh 的 `/model` 弹层：条目的 `id` 是 `provider/model` 全名（即选择后提交、并回灌子进程 `--model` 的值），`name` 是**裸模型名**，所以选择器里顶层显示的就是模型本身；`provider` 字段为 `'pi'`。探针失败：目录为空、引擎照常工作。`ResolvedConfig` 不承载模型目录（PiLoop 从不读取它），如此避免死字段。

## 9. 错误处理与已知边界

- **子进程意外退出**：所有 pending 命令 reject `'pi RPC process exited unexpectedly'`，事件流唤醒后结束（`client.ts:107-113`）；step 侧表现为 `PI_NO_RESULT` 或命令错误。
- **取消**：phase signal 触发时向子进程发 `abort` 命令——fire-and-forget，rejection 被吞掉（子进程可能已在拆除，`PiRpcClient.dispose()` 会 reject 在途的 `abort`；不吞会以 "pi RPC client is disposed" 未处理拒绝打崩进程）（`agent.ts:568-582`）。
- **配置校验失败大声报错**：`Config` schema（`loop.ts:61-68`）在组合边界验证；`sandboxMode` 非法值直接组合失败。
- **cwd 缺失**：会话无 cwd 元数据时 step 抛错，要求带 cwd 启动会话（`agent.ts:554-557`）。
- **resume 依赖**：无 `sessionPersistence` 服务时 `resume` 抛错（`hosted-engine-runtime.ts:375-381`）。
- **静默降级**：非 JSON 行忽略（`client.ts:234-236`）；技能加载失败静默跳过（`agent.ts:346-348`）；skills 目录不可读当空处理（`agents-md-skill-provider.ts:174-176`）。
- **已知功能边界**：
  - 图片不转写，统一替换为占位文本（`prompt.ts:20-21`）；
  - `extension_ui_request`（select/confirm/input 等交互请求）被忽略，没有应答路径——依赖交互扩展的 pi 配置在 dsh 下会卡住或无响应（`agent.ts:724`、`rpc/types.ts:153-162`）；
  - `get_session_stats` 客户端方法已实现但驱动未调用，usage 完全依赖事件流携带（`client.ts:158-161`）；
  - `rpc/mapping.ts` 的 `mapToolCall` 驱动未使用（agent 内联了 `emitToolCall`），仅测试引用——属冗余导出。

## 10. 测试覆盖要点

`tests/engine-pi/` 下 9 个 spec、178 个用例，本次运行全部通过（`pnpm vitest run tests/engine-pi`）：

- `rpc/client.spec.ts`（24）：响应 id 关联、严格 LF 分帧（含 `\r` 容忍、多字节跨 chunk）、生命周期/dispose 幂等、send/缓冲、默认 spawn 与 `fromChildProcess`；
- `rpc/mapping.spec.ts`（13）：`mapUsage` 缺省/零值规则、`mapToolResult` 错误标记与 `(no content)` 兜底、`resultText` 各 payload 形态、`mapToolCall` 序列化；
- `permission.spec.ts`（5）：`resolveSessionPermission` 四种折叠路径 + `toolsForSandbox`；
- `skills.spec.ts`（20）：`piAgentDir` 环境覆盖、上下文文件/技能目录列举（含 junction、两种布局）、`get` 的 locator 双分支；
- `loop.spec.ts`（8）：spawn 投影（`process.execPath` 前缀、stdio、graceMs），以及**构造时 ctx 上没有 `subprocess` 服务就大声失败**（`/needs the dsh subprocess service/`）；
- `agent.spec.ts`（49）：工厂注册、turn 事件映射、**一段一步的 step 轮转与段内顺序（`stepStructure` 辅助函数断言 `type@step` 序列；含无流式 assistant 消息时合成 owner 的路径）**、取消与 pre-step 拦截、会话权限折叠、部署钉死、防御性守卫、技能注入、边缘映射；
- `controls.spec.ts`（22）：steer/inject、maintenance、turn 中取消、commit veto、空 step 完成、turn 中输入链接、配置校验；
- `index.spec.ts`（26）：经 `tests/helpers/agent-harness.ts:49` 的 `loopPluginFor` 挂载引擎（helper 做路由器在生产里做的事：构造引擎、交出 AgentFactory 槽位、发布三个 systemPrompt 变量）后的 HMR 安全拆除、createAgent 选项、resume；
- `probe.spec.ts`（11）：`pi --list-models` 探针——`parsePiModelList` 的 `provider`/`model` 两列解析（跳表头、空行与缺两空格分隔的行）、`probePiModels` 从 STDERR/stdout 收集并合并、非零退出/空输出/`spawn` 抛错时降级为空目录。

注意 `agent.ts` / `loop.ts` 大量分支带 `/* v8 ignore */` 注释（防御性 backstop），覆盖率门槛是 `src/**` 逐文件 100%（`src/client` 除外）——改动这两个文件时新增分支要么测到、要么按既有惯例标注 ignore 理由。

## 附：代码与注释不一致之处

1. **"subprocess sandbox" 措辞**：`types.ts:7-8`、`loop.ts:6-8、43-44`、`agent.ts:8`、`rpc/client.ts:5` 均称子进程被 subprocess seam "沙箱化/包裹"，但主仓 seam 无任何 OS 级沙箱机制（见第 6.2 节）。实际边界 = 进程树隔离 + 环境清洗 + `--tools` 裁剪。（`permission.ts` 的模块头与 `PiPermission.sandboxMode` 已在修幽灵工具名时改正，不再是反例。）
2. **`agents-md` 可调用性**：`skills.ts:10-11` 头注释称 agents-md 是 "user-invocable" 技能，而 `agentsCandidate` 实际设 `{ modelInvocable: true, userInvocable: true }`（`agents-md-skill-provider.ts:159`）。措辞含糊（"user-invocable" 不排斥 model-invocable），但与 §7 的"斜杠菜单可见性"叙述并列时容易误读。
3. **`mapToolCall` 死导出**：`rpc/mapping.ts:1-9` 的模块注释说本模块投影 tool call，但驱动并不调用它（`agent.ts` 只 import `mapToolResult`/`mapUsage`，`agent.ts:43`），仅测试使用。
4. **容器级 AGENTS.md 与代码一致**："每 step 一个无状态 new_session + prompt"、"严格 LF JSONL"、"无权限系统→整体沙箱"三条背景陈述均在代码中核实成立（第 3、4 条中的"沙箱"按第 1 条修正理解）。
