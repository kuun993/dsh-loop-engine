# Kimi 引擎实现文档

**目标读者**：要修改 `src/engine-kimi/` 的工程师。本文讲清 Kimi 引擎的机制、数据流、设计约束与坑，所有论断均标注源码位置。

## 1. 引擎概述

Kimi 引擎把每个 dsh 会话挂到一个**常驻 `kimi acp` 子进程**上，通过 stdio 上的 JSON-RPC 2.0 说 ACP（Agent Client Protocol，agentclientprotocol.com 定义的客户端↔agent 协议）驱动 Kimi Code CLI（`src/engine-kimi/loop.ts:1-16`、`src/engine-kimi/acp/types.ts:1-15`）。

核心模型：

- **每步无状态**：每个 dsh step 都是一次独立的 `session/new` + `session/prompt`（`src/engine-kimi/agent.ts:518,530`）。Kimi 侧不保留跨步上下文——dsh 会话日志是模型上下文的唯一来源，prompt 是持久历史的纯序列化（`serializeHistory`，`src/driver-core/prompt.ts:93-127`），保证 "Model-visible ⟺ logged"。
- **子进程模型**：整个 `kimi acp` 子进程通过 dsh subprocess 接缝（`ctx.subprocess.spawn`）拉起——这是唯一可用的权限边界，沙箱姿态由 subprocess provider 按会话的持久权限旋钮解析（默认 read-only）（`src/engine-kimi/loop.ts:8-13,113`）。Kimi 没有 host 审批回调，ACP 反向 RPC `session/request_permission` 由会话的 dsh approval 旋钮回答（见第 6 节）。
- **方向辨析**：主仓自带 `@deepseek-ai/dsh-acp`（`../deepseek-harness/packages/acp/acp`）是 **ACP server**（把 dsh agent 暴露给外部 ACP 客户端）；本驱动是 **ACP client**（dsh 作客户端驱动 kimi CLI 这个 agent）。两者方向相反，不要混淆。
- **kimiBin 解析**：`kimiBinResolver`（`src/engine-kimi/process.ts:59-64`）三级回退——① 配置钉死的路径（`kimiBin` 配置项，空字符串视为未配置）；② 探测标准安装位 `<kimi home>/bin/kimi[.exe]`，其中 kimi home = `KIMI_CODE_HOME` 环境变量或 `~/.kimi-code`（`kimiHomeDir`，`process.ts:47-50`）；③ 回退裸命令 `'kimi'`，由 spawner 经 PATH 解析。

## 2. 模块组成与各文件职责

| 文件 | 职责 |
|---|---|
| `src/engine-kimi/loop.ts` | `KimiLoop`：Service + AgentFactory 实现。Config schema、工厂注册（`ctx.agents.setFactory`）、create/resume 的 prepare→setup→publish 事务、子进程 spawn capability 的构造 |
| `src/engine-kimi/agent.ts` | `KimiAgent`：Agent 接口实现。idle/maintenance/running 相位机、inbox、turn/step 边界落日志、每步驱动一次 ACP 查询、流式 update 映射、技能注入 |
| `src/engine-kimi/process.ts` | Kimi CLI 进程投影：bin 解析、`kimi acp` argv 构造、spawn spec → subprocess 接缝投影、subprocess handle → 传输层投影 |
| `src/engine-kimi/acp/client.ts` | `AcpClient`：`kimi acp` 子进程上的 JSON-RPC 客户端。帧切分、请求-响应关联、`session/update` 通知分发、反向 RPC（权限）应答 |
| `src/engine-kimi/acp/types.ts` | ACP 线格式类型 + 帧判定守卫。形状是对 kimi CLI 0.28.1 的实测记录（types.ts:11） |
| `src/engine-kimi/acp/mapping.ts` | 纯函数：`session/update` 分类、chunk delta 提取、工具调用身份/结果投影 |
| `src/engine-kimi/permission.ts` | 会话权限旋钮 → ACP 工具审批布尔值的折叠 |
| `src/engine-kimi/skills.ts` | `KimiSkillProvider`：AGENTS.md 上下文文件与 `.kimi-code` skills 目录 → dsh 技能候选 |
| `src/engine-kimi/commands.ts` | `KIMI_COMMANDS`：Kimi 内建斜杠命令的转发桥 |
| `src/engine-kimi/types.ts` | `ResolvedConfig`（仅类型，无运行时代码） |

共享基础设施（`src/driver-core/`）被引用的部分：`ownership.ts`（`FactoryOwnership`、`raceAbort`、`raceAbortCall`）、`prompt.ts`（`serializeHistory`）、`permission-knobs.ts`（`sessionApprovalPolicy`）、`skill-inject.ts`（手势扫描与 `<skill_content>` 渲染）、`context-files.ts`（cwd→git root 的目录链与文件读取）。

插件入口侧：`src/index.ts` 的 `mountKimi`（index.ts:388-414）注册斜杠命令与技能 provider 后以子 fiber 挂载 `KimiLoop`；`kimiConfig`（index.ts:224-230）把组合条目的 `model`/`env`/`kimiBin` 透传为 `KimiLoop` 的 `model`/`env`/`bin`。

## 3. Loop 工厂与 Agent 生命周期

### 3.1 KimiLoop（工厂）

- `static inject = ['agents', 'sessions', 'systemPrompt', 'subprocess']`（loop.ts:95）；host 面 ctx key 为 `agentLoopKimi`（loop.ts:81-85）。
- 构造时：解析配置（`resolveConfig`，loop.ts:72-78）；建 `FactoryOwnership`（agent 拆除跟踪 + 工厂 teardown 信号，`src/driver-core/ownership.ts:25-70`）；spawn capability 固定走 subprocess 接缝并带 3000ms 进程树终止宽限（`KIMI_DISPOSE_GRACE_MS`，loop.ts:41,113）；`ctx.agents.setFactory(this)` 抢占唯一 AgentFactory 槽位（loop.ts:115）。
- Kimi 原生拥有自己的 prompt，所以 `provider`/`model`/`cwd` 三个 systemPrompt 变量只服务 dsh 系统提示词的下游消费者，镜像默认 loop 的注册（loop.ts:116-121）。

### 3.2 创建/恢复事务

`createAgent`/`resume` 共享同一条 prepare→setup→publish 事务（loop.ts:124-236）：

1. **prepare**：先验活（owner fiber 活跃、工厂接受中、调用方信号未中止），然后构造三重融合的 abort——调用方取消、owner fiber 卸载、工厂 teardown 任一触发即中止 setup（loop.ts:143-153）。拆除函数 `dispose` 在发布**之前**就注册进工厂跟踪集和 owner fiber effect，中途卸载会整体回滚（loop.ts:160-199）。
2. **setup**：`raceAbort(setup?.(agent.ctx), fusedSignal, id)` 运行调用方 setup 并取其 commit（loop.ts:252-253）。
3. **publish**：依次 `sessions.enter` → `agents.enter` → `sessions.announce` → `agents.announce` → 发出 `agent/session-start` 事件，每步之间 `assertLive()`（loop.ts:215-226）。

`resume` 额外要求 `sessionPersistence` 服务在场，否则直接抛错（loop.ts:292-298）；加载阶段用 `raceAbortCall` 保证取消后被遗弃的 preparation 仍能 `[Symbol.dispose]()` 释放（loop.ts:319-324）。

### 3.3 KimiAgent（相位机）

相位定义在 agent.ts:71-79：`idle` / `maintenance` / `running`（带 abort、turn、step、wakeRequested）。`status` 只有 idle/running 两种对外形态（agent.ts:142-144），相位切换经 `setPhase` 发 `agent/status`（147-154）。

- **入口**：`followup`（next-turn + 唤醒）、`steer`（next-step + 唤醒）、`inject`（next-step 不唤醒）、`cancel`（agent.ts:156-193）。`send` 里有一个关键分类：abort 后再唤醒的消息会被重分类到 `next-turn`（agent.ts:157-158）。
- **驱动循环**：`wakeDriver` → `kick` → `while (await this.turn())`（agent.ts:230-283）。`kick` 的 finally 负责把 running 相位收回 idle 并按 latch 的 wake 重放。
- **turn**：`turn/start` → 循环 `preStep`（inbox claim + `agent/pre-step` waterfall + 技能注入）→ `step/start` → 落 `user/message` → `step()` → `step/end` → … → `turn/end`（agent.ts:346-427）。每个退出路径都保证写 `turn/end`（completed / blocked / aborted / error）。
- **step**：每个 step 重置块/工具累积器（agent.ts:496-498）→ 校验 cwd（无 cwd 直接抛错，500-503）→ `deriveMessages` + `serializeHistory` 造 prompt（504-505）→ 写一次 request/header（见下）→ 取/建 ACP 客户端 → 注册权限回调 → `session/new` → 挂 `onUpdate` → `raceAbort(client.prompt(...))`，abort 时先发 `session/cancel`（514-533）→ `flushAssistant` 落 `assistant/message`（535）。
- **request/header**：每个 loop 实例只写一次，provider 恒为 `'kimi'`，model 标签为 `config.model ?? 'kimi-native'`——未钉模型时刻意不把 web 会话的建议模型选择镜像进 header（它从不驱动查询）（agent.ts:62-68,430-446）。已有 baseline 时 reason 记为 `'resume'`，否则 `'initial'`（agent.ts:440-444）。provider 标签 `'kimi'` 在引擎挂载期间由插件注册为占位 provider 路由（见 `docs/architecture.md` §3.6），否则宿主按 header 推导的会话模型选择会让第二轮 prompt 被 `model-unavailable` 拒绝。

### 3.4 ACP 客户端缓存

`AcpClient` 按 **agent 实例**缓存、跨 step 复用（agent.ts:112-114）；`acpClient(cwd)` 在 spec（argv/cwd/env）变化或进程已关闭时 dispose 旧客户端并重 spawn（agent.ts:449-476）。`initialize` 失败会清缓存、dispose 并抛错（467-475）。agent scope 拆除时释放客户端（136-139）。

## 4. ACP 客户端与进程管理

### 4.1 进程投影（process.ts）

- `kimiAcpArgv(bin)` 只产出 `[bin, 'acp']`（process.ts:74-76）：prompt 走请求体而非 argv 位置参数，因此**没有命令行长度上限，也没有模型旗标**（模型由 Kimi 原生配置持有）。
- `kimiSubprocessSpec` 把 spawn 请求投影到 subprocess 接缝：复制 argv、cwd、三路 pipe stdio、`graceMs`、env，有 signal 才透传（process.ts:79-88）。
- `fromSubprocess` 把接缝 handle 投影成 `KimiProcess` 传输层（stdin/stdout/stderr/done/terminate），缺任一路 pipe 即视为接线错误抛异常（process.ts:91-106）。

### 4.2 JSON-RPC 客户端（acp/client.ts）

- **帧切分**：裸 `\n` 分行，`StringDecoder('utf8')` 跨 chunk 拼字节，容忍行尾单个 `\r`；空行与非 JSON 行直接忽略（client.ts:183-205）。
- **请求-响应关联**：自增数字 id，`pending` map 结算；响应帧带 `error` 时 reject（无 message 时回退 `'kimi acp request failed'`），无匹配 id 的响应丢弃（client.ts:114-121,230-240）。
- **通知分发**：`session/update` 通知同时走 `onUpdate` 回调、内部 buffer 和 `updates()` 异步生成器三路（client.ts:217-223,160-170）。agent 实际只用 `onUpdate` 回调路径（agent.ts:525），生成器是保留接口。
- **反向 RPC**：`session/request_permission` 交给注册的 handler 应答；**未注册 handler 时 fail-closed 答 `approved: false`**（client.ts:242-245）。未知反向 RPC 回 `-32601 Method not found`，防止对端悬挂（client.ts:225-227）。
- **协议握手**：`initialize` 发 `protocolVersion: 1.0`、`clientInfo: { name: 'dsh-loop-engine', version: '1.0.0' }`（client.ts:130-132；版本号是硬编码字符串，与包版本无关）。
- **会话操作**：`newSession` 校验返回里的 `sessionId` 非空字符串（client.ts:135-142）；`prompt` 体为 `{ sessionId, prompt: [{ type: 'text', text }] }`（145-147）；`cancel` 是 fire-and-forget，吞掉 rejection（150-152）。
- **生命周期**：`dispose()` 封口、请求进程树终止、以 `'kimi acp client is sealed'` 拒掉所有 pending（173-181）；子进程 `done` 正常落定（exit）时以 `'kimi acp process exited unexpectedly'` 拒掉 pending 并封口（79-84）。**注意 done 以 rejection 落定的分支只封口、不拒 pending**（85-88）——此时在飞的 prompt 永不结算（测试 `client.spec.ts:346-360` 显式覆盖了该行为，改这里要先想清楚语义）。
- `AcpClient.create(spec, spawn?)`：给了 spawn capability 就用它（生产路径，subprocess 接缝）；没给就退回 `node:child_process` 裸 spawn（client.ts:28-35,98-101）——后者只在无接缝环境（测试）出现。

## 5. 事件映射（ACP update ↔ dsh SessionEvent）

映射分两层：`acp/mapping.ts` 是纯分类/提取，`agent.ts` 的 `applyUpdate`（agent.ts:566-614）负责落日志。

| ACP update | dsh 事件 | 说明 |
|---|---|---|
| `agent_thought_chunk` | `assistant/chunk`（block-start/reasoning-delta）+ `assistant/message` 的 reasoning 块 | 空 delta 忽略，不开块（agent.ts:567-575） |
| `agent_message_chunk` | 同上，text 块 | agent.ts:577-585 |
| `tool_call` | `tool/call` | `callId` 取 `toolCallId`，`name` 取 `title`；**arguments 恒为 `'{}'`**——ACP 公告不携带真实参数（agent.ts:587-594）。空 id 或重复 id 忽略 |
| `tool_call_update` | `tool/result`（settled 时） | 文本按 `{ type: 'content', content: { type: 'text', text } }` 嵌套累积（mapping.ts:67-71）；status 离开 `pending/queued/running/in_progress` 即视为 settled（mapping.ts:58-60），`failed/error/denied` 记 `isError`（mapping.ts:63-65）；空结果文本回退 `'(no content)'`（mapping.ts:77）。未announce过的 callId 的 update 被忽略（agent.ts:598） |
| 其他（`available_commands_update`、`config_option_update`、`plan`…） | 无 | 不属于忠实模型上下文投影，直接跳过（agent.ts:612-614） |

落日志的两个不变量：

- **块序**：reasoning/text 块按首次出现顺序分配连续 index（agent.ts:554-563）；每步结束 `flushAssistant` 把所有块合成一条 `assistant/message`，`sourceEventSeqs` 引用该步全部 chunk 的持久 seq（agent.ts:622-648）。
- **工具专属步**：一个只有工具活动、没有文本的 step 也会发一条（可能空的）`assistant/message`，让 `tool/call` + `tool/result` 有父消息可配对（agent.ts:622-626 注释）。
- **空步报错**：prompt 返回后既无块也无工具调用，抛 `LlmError`，code `'KIMI_NO_RESULT'`（agent.ts:536-541）——防止模型静默空转。

时序保证：`session/prompt` 的响应帧在该轮全部 update 之后派发，因此每个 update 都在 prompt resolve 前应用完毕，无 EOF/"finished" 竞态；ACP 子进程跨 step 存活，其流不会自行结束（agent.ts:520-525 注释）。

## 6. 权限模型

Kimi 没有 host 审批回调，ACP 的 `session/request_permission` 由会话的持久 approval 旋钮回答：

- `resolveToolApproval(events)` = `sessionApprovalPolicy(events) !== 'ask'`（permission.ts:30-32）。即：**`ask` 策略降级为拒绝**（无人值守运行时唯一安全的答案，fail-closed）；`never` 或无旋钮一律自动批准。
- **沙箱姿态不参与该折叠**（permission.ts:24-27 JSDoc）：Kimi 自己的工具策略约束工具能做什么，ACP 审批是 host 的闸门，信号只取 `approval/policy` 旋钮。沙箱姿态另由 subprocess 接缝在进程层生效。
- `sessionApprovalPolicy` 从后往前取最后一条合法 `approval/policy` 事件（`src/driver-core/permission-knobs.ts:40-47`）。
- 权限回调在每个 step 重新挂载：`client.onPermission(() => resolveToolApproval(this.session.snapshotEvents()))`（agent.ts:517），读的是**应答时刻**的会话日志，所以运行中切换策略即刻生效。
- 双保险：即使 agent 没挂 handler，client 未注册 handler 时默认拒绝（client.ts:243）。

## 7. 斜杠命令桥接与技能注入

### 7.1 斜杠命令（commands.ts）

dsh `commands` 运行时本地执行注册命令，命令行不会到达模型；真实处理在 Kimi 引擎内的命令必须**转发原文行**给 agent：`forwardKimiCommand` 把 `/<name><rawInput>` 作为普通 user 消息 `followup` 给接收 agent（commands.ts:33-41）。

`KIMI_COMMANDS`（commands.ts:56-65）注册了 9 个对 ACP prompt 面有意义的内建命令：`help`、`status`、`compact`、`clear`、`plan`、`auto`、`usage`、`version`、`goal`。纯 TUI 控制类命令（`/login`、`/settings`、`/sessions` 等）不注册——ACP prompt 面不会像交互 TUI 那样展开它们（commands.ts:13-15）。`skill:` 类命令已由 dsh 技能注入接缝承载，不重复注册。

两个刻意的缺席/保留（commands.ts:17-24 模块注释）：

- **`/model` 不桥接**：web 客户端自己占着 `/model` 贡献（`ui-model-selection`），host 侧同名命令会让 `ui-commands` 把整个 command 菜单源判死——表现为菜单里所有命令消失、只剩技能。这是真实踩过的坑，不是未雨绸缪。
- **`/goal` 保留**：managed block 对托管引擎禁用了 dsh 的 `command-goal` 行（见 architecture.md §3.5），槽位空出，Kimi 自己的 goal 模式接管。注意运行时（不重启）从 in-process 切过来时 `command-goal` 仍在，本次 `/goal` 会被撞名跳过，重启后归位。

`mountKimi` 注册这些命令时与 dsh 原生命令撞名则告警跳过，不让挂载失败（index.ts:504-530）。

### 7.2 技能 provider（skills.ts）

`KimiSkillProvider` 把 Kimi 的两类磁盘内容暴露为 dsh 技能：

- **`agents-md`（rank 140）**：cwd→git root 链上每个目录的 `AGENTS.md`（`KIMI_CONTEXT_POLICY` 只认 AGENTS.md，skills.ts:49-51），合并为一个候选，body 是各文件按就近优先拼接（`readSources`，`src/driver-core/context-files.ts:126-133`）；全为空文件则不产生候选。
- **SKILL.md 条目**：项目级 `<dir>/.kimi-code/skills/`（rank 150，沿目录链每层都查）与用户级 `$KIMI_CODE_HOME/skills/`（默认 `~/.kimi-code/skills/`，rank 160）（skills.ts:43-47,90-104）。两种布局都收：子目录 `SKILL.md` 和根下扁平 `<name>.md`（skills.ts:157-186）；目录条目经 `stat` 跟随链接（Windows junction 的 Dirent 两者都不是，skills.ts:166-172 注释）。重名时项目文件因 rank 更低而胜出。

约束与留白：

- 通用 `~/.agents/skills/`、`.agents/skills/` 根**刻意不扫**（skills.ts:14-16）——in-process 下它们由 web profile 的 `skill-filesystem` provider 覆盖；而托管引擎下 `skill-filesystem` 行已被 hosted preset 剥掉（见 architecture.md §3.5），这些根在 kimi 会话里就不出现，这正是"引擎接管技能面"的语义。
- 复用共享 `parseSkillFile`（agents-skill frontmatter：`name`/`description`/`whenToUse`/`disable-model-invocation`）；Kimi 自己的 `disableModelInvocation`/`type` 字段**不翻译**，`type: flow` 技能会被当作 model-invocable 暴露（skills.ts:19-23）。
- Kimi CLI 内建技能没有稳定磁盘位置，不在本 provider 范围（skills.ts:16-18）。

### 7.3 技能注入（agent 侧）

进程内引擎的技能注入由 agent-preset 链上的 dsh-tool-skill handler 完成，Kimi agent 的 context 不从该链派生，所以在 `preStep` 里自行复刻（agent.ts:296-306 注释）：

- `invokedSkillNames` 扫直接用户消息里空白边界的 `/name` kebab-case 手势（`src/driver-core/skill-inject.ts:84-96`）。
- 逐个 `skills.get(name, { signal, scope: this, cwd })`；加载失败、未找到、非 user-invocable 一律静默跳过（agent.ts:329-335）。
- 注入的消息以 `source: { kind: 'skill-invocation', name, form: 'instructions' }` 落 `user/message`（agent.ts:337-340），正文是 `renderSkillContent` 的 `<skill_content>` 块（skill-inject.ts:67-81）。
- 加载期间 step 被取消，整批注入丢弃（agent.ts:336）；`skills` 服务缺席时原样放行（agent.ts:320-321）。

## 8. 配置项一览

组合条目层（`src/index.ts` 的 `Config`，index.ts:70-87,101-115）中 Kimi 相关字段，经 `kimiConfig`（index.ts:224-230）透传：

| 组合字段 | KimiLoop 字段 | 含义 |
|---|---|---|
| `model` | `model?: string` | **只作 request/header 与消息 provenance 的模型标签**（agent.ts:430-432,644）。不进 argv——`kimiAcpArgv` 无模型旗标（process.ts:74-76），模型由 Kimi 原生配置持有。⚠️ `Config` 与 `ResolvedConfig` 的 JSDoc 仍写着"传给子进程的 `-m`/`--model`"（loop.ts:45、types.ts:17），与实际行为不符，见第 9 节 |
| `env` | `env?: Record<string,string>`（默认 `{}`） | 显式传给 `kimi` 子进程的环境条目（loop.ts:47,56；spawn spec 原样带，agent.ts:479-485） |
| `kimiBin` | `bin?: string` | Kimi CLI 可执行文件；未钉时按第 1 节三级回退解析（loop.ts:49-50,76） |

环境变量：

- `KIMI_CODE_HOME`：影响 bin 探测的 kimi home（process.ts:47-50）与用户级 skills 目录（skills.ts:71-75，两处各自独立读取，注意是**进程环境**而非 `env` 配置项）。

固定常量：`KIMI_DISPOSE_GRACE_MS = 3000`（loop.ts:41）。

## 9. 错误处理与已知边界

### 错误处理路径

- **无 cwd**：step 开头抛 `no working directory`（agent.ts:500-503），turn 以 `error` 收场；ACP 客户端尚未创建。
- **initialize 失败**：客户端 dispose、缓存清空，错误沿 step 上抛（agent.ts:467-475）。
- **取消**：abort 信号触发 `session/cancel`（fire-and-forget），`raceAbort` 以中止原因拒掉 prompt await（agent.ts:527-533）；turn 以 `aborted` 收场。
- **子进程意外退出**：pending 请求全部以 `kimi acp process exited unexpectedly` 拒绝（client.ts:79-84），客户端 closed，下一步 `acpClient` 会重 spawn。
- **commit veto**：`turn/start`/`turn/end` 落日志被 veto 时经 `throwError` 上报 `agent/error` 并在驱动边界收容，inbox 不丢（agent.ts:258-267,358-362,414-420；测试 agent.spec.ts:771-831）。
- **step 无产出**：`KIMI_NO_RESULT`（agent.ts:536-541）。

### 已知边界与坑

- **arguments 恒为 `'{}'`**：`tool/call` 没有真实参数可记（ACP `tool_call` 公告不含参数，agent.ts:592）。下游若依赖工具参数回放会拿不到。
- **每步全新 ACP 会话**：`session/new` 每步一次（agent.ts:518），Kimi 侧无跨步记忆；prompt 体积随会话历史线性增长，长会话的每步成本会升高——这是 "log ⟺ model-visible" 不变量的代价，与 claude/codex 驱动一致。
- **done-rejection 分支不拒 pending**：`done` 以 rejection 落定时在飞请求永不结算（client.ts:85-88），见 4.2。
- **`config.model` 不进子进程**：想真正钉模型只能靠 Kimi 自己的配置；插件的 `model` 只是日志标签。
- **撞名命令被跳过**：见 7.1。

### 代码与注释不一致之处（改动前先核对）

1. **`process.ts` 模块头过时**（process.ts:2-8）：描述的是"`kimi -p --output-format stream-json`、每步一个一次性子进程"，实际实现是常驻 `kimi acp` + JSON-RPC。`KimiSpawnSpec` 的 JSDoc（process.ts:19"one `kimi -p` child"）同样过时。
2. **`types.ts` 模块头过时**（types.ts:4-10）：仍在讲 `-p` 面自动批准、无 `--tools` 旗标，与 ACP 驱动模型不符。
3. **模型旗标 JSDoc 失实**：`Config.model`（loop.ts:45"(`-m`)"）与 `ResolvedConfig.model`（types.ts:17"(`--model`)"）声称模型会传给子进程，实际 argv 无任何模型旗标，`model` 只作日志标签。
4. **客户端生命周期注释**：client.ts:11 说子进程"long-lived (one per factory)"，实际客户端按 **agent** 缓存（agent.ts:112-114），一个工厂下多个会话各有自己的子进程。client.ts:54"once per driver scope"才是准确说法。
5. **块序注释内部张力**：agent.ts:557-558 先说"Reasoning leads the assistant message; text follows"，又接"Indexes stay contiguous in the order blocks first appear"——代码实现的是后者（按首次出现排序），若 text 先到则 text 在前，前一句不是保证。
6. **permission.ts 模块头易误导**（permission.ts:9-13）：大段谈论 full-access/workspace-write 沙箱如何自动批准，但函数根本不读沙箱旋钮（permission.ts:24-27 的函数 JSDoc 才是准的）。

## 10. 测试覆盖要点

Kimi 相关 spec 共 9 个文件（约 2500 行），仓库覆盖门槛为 `src/**` 逐文件 100%（`src/client` 除外），所以源码里大量 `v8 ignore` 注释标记的是防御性 backstop，不是可删代码。

- `tests/engine-kimi/agent.spec.ts`（852 行）：核心。mock `AcpClient` 喂 `session/update` 流，覆盖——流式 text/thought → 单条 assistant/message；tool_call/tool_call_update → tool/call + tool/result（含工具专属步的空父消息）；未知 update 跳过；`KIMI_NO_RESULT`；权限回调（auto 批准 / ask 拒绝）；abort → `session/cancel`；客户端跨步复用（`created` 仅 1 次）；initialize 失败清理；无 cwd 报错；技能注入全部分支（注入、无服务、加载失败/undefined/非 user-invocable 跳过、加载中取消丢弃、无 cwd 时仍注入再失败）；steer/inject/maintenance/keepInbox；turn 链式（mid-turn followup/steer/disposed 不重放）；空 step 与 reject 的 turn 收场；commit veto；resume request header。
- `tests/engine-kimi/index.spec.ts`（465 行）：工厂注册与 HMR 安全拆除（fiber dispose 后槽位清空）；create 的 seed/meta 透传、预中止信号（Error 与非 Error reason）、setup commit/失败回滚/挂起中止、owner fiber 中途卸载回滚（含 scope minting 竞态）；resume 全路径（无 persistence 报错、JSONL 后端恢复、预中止、取消加载时释放遗弃 preparation、加载后工厂失活、prepare 失败传播、取消后迟到失败吞掉）。
- `tests/engine-kimi/loop.spec.ts`（231 行）：spawn 管线——bin 解析优先级、spawn spec → 接缝投影（argv/stdio/graceMs/env/signal）、handle → 传输层 round-trip、stderr 排空；systemPrompt 变量在无 agent 时为 undefined。
- `tests/engine-kimi/process.spec.ts`（125 行）：`kimiHomeDir`/`kimiBinResolver`（mock `existsSync` 与 homedir）、`kimiAcpArgv`、`kimiSubprocessSpec`（argv 复制、signal 透传）、`fromSubprocess`（缺 pipe 抛错）。
- `tests/engine-kimi/acp/client.spec.ts`（372 行）：假 `KimiProcess` 上的全协议行为——请求关联（result/error/无 message 回退/孤儿响应）、session 生命周期（newSession 无 id 抛错、prompt 体形、cancel 吞 rejection）、update 缓冲与生成器、反向 RPC（批准/拒绝/未知 method → -32601/无 handler fail-closed）、`create` 的注入 spawn 与裸 spawn 回退、notify、帧健壮性（`\r\n`、空行、非 JSON、string chunk、method 非字符串）、封口后行为、子进程退出拒 pending、done rejection 只封口。
- `tests/engine-kimi/acp/mapping.spec.ts`（110 行）：分类谓词、chunkDelta 边界（image/缺 content）、status 分类（settled/error）、嵌套 content 拼接、`toolResult` 投影与 `(no content)` 回退。
- `tests/engine-kimi/permission.spec.ts`（30 行）：`resolveToolApproval` 折叠——never/沙箱/无旋钮批准，ask 拒绝且压过 full-access。
- `tests/engine-kimi/skills.spec.ts`（254 行）：`kimiAgentDir` 覆盖；AGENTS.md 发现/空文件忽略/cwd→git root 合并；项目与用户 SKILL.md 发现（含 `KIMI_CODE_HOME` 覆盖、扁平 .md、垃圾条目跳过、目录缺 SKILL.md、abort 返回空）；get 的内容加载与文件消失 → undefined。
- `tests/engine-kimi/commands.spec.ts`（50 行）：转发 handler 的原文行拼装（带/不带参数）与 `KIMI_COMMANDS` 每条都有转发 handler。

另：`tests/index.spec.ts` 覆盖插件入口层（含 `mountKimi` 的命令/技能注册与工厂挂载路径），改 `src/index.ts` 的 kimi 部分时一并跑。
