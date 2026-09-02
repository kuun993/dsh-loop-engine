# Pi 引擎实现文档（engine-pi）

**目标读者**：要修改 dsh-loop-engine 的 pi 引擎的工程师。本文通读 `src/engine-pi/` 全部源码后写成，所有论断标注源码位置；与注释不一致之处单独列在文末。

## 1. 引擎概述

pi 引擎把每个 dsh 会话驱动到 `@earendil-works/pi-coding-agent` CLI 上：以 `pi --mode rpc` 启动一个子进程，通过 stdio 讲**严格 LF 的 JSONL** 协议（`src/engine-pi/rpc/client.ts:1-11`）。

两个核心设计动机：

- **Pi 没有权限系统**（"runs with the permissions of the user"），驱动无法让它做沙箱或审批回调。唯一可用的边界是进程环境：要么让整个子进程以 dsh 用户身份裸跑（full access），要么收缩它的 `--tools` 白名单（`src/engine-pi/permission.ts:1-16`、`src/engine-pi/types.ts:4-8`）。子进程一律经由 dsh subprocess seam 启动（`src/engine-pi/loop.ts:183`），获得独立进程树、环境清洗和树级终止——但注意 subprocess seam **没有 OS 级沙箱**（见第 6 节与文末"不一致"）。
- **无状态 step 模型**：dsh 会话日志是模型上下文的唯一来源（model-visible ⟺ logged）。每个 dsh step 发一个 `new_session` + 一条 `prompt`，prompt 是持久化历史的纯序列化（`src/engine-pi/agent.ts:495-516`、`src/driver-core/prompt.ts:93-127`）。Pi 子进程跨 step 存活、客户端复用，但每个 step 的 Pi 会话是全新的。

## 2. 模块组成

| 文件 | 职责 |
|---|---|
| `src/engine-pi/loop.ts` | `PiLoop`：Cordis Service + AgentFactory。配置 schema、Pi CLI 入口解析、subprocess 投影、create/resume 发布事务 |
| `src/engine-pi/agent.ts` | `PiAgent`：相位机（idle/maintenance/running）、inbox、每 step 的 RPC 查询与事件→会话日志映射 |
| `src/engine-pi/permission.ts` | 把会话的 `sandbox/mode` / `approval/policy` 事件折叠成 Pi 运行时姿态（sandboxMode + `--tools`） |
| `src/engine-pi/skills.ts` | `PiSkillProvider`：把 pi 的上下文文件与 skills 目录暴露为 dsh 技能 |
| `src/engine-pi/types.ts` | `PiSandboxMode`、`ResolvedConfig`（纯类型） |
| `src/engine-pi/rpc/client.ts` | `PiRpcClient`：严格 LF JSONL 分帧、命令/响应关联、事件缓冲 |
| `src/engine-pi/rpc/types.ts` | `pi --mode rpc` 协议的最小子集类型（纯类型） |
| `src/engine-pi/rpc/mapping.ts` | usage / tool result / tool call → dsh 会话事件的映射函数 |

共享基础设施（`src/driver-core/`）：`ownership.ts`（FactoryOwnership、raceAbort）、`prompt.ts`（serializeHistory）、`permission-knobs.ts`（会话旋钮读取）、`context-files.ts`（上下文文件收集）、`skill-inject.ts`（`/name` 手势扫描与 `<skill_content>` 渲染）。

## 3. Loop 工厂与 Agent 生命周期

### 3.1 PiLoop（工厂）

`PiLoop extends Service implements AgentFactory`（`src/engine-pi/loop.ts:160`），`inject = ['agents', 'sessions', 'systemPrompt', 'subprocess']`（`loop.ts:162`）。构造函数做四件事（`loop.ts:174-192`）：

1. `resolveConfig` 在插件配置边界定稿配置（`loop.ts:90-98`）；
2. `piCliEntrypoint()` 解析 Pi CLI 的 bin 路径——包是 ESM-only，所以用 `import.meta.resolve` 拿到入口、回退两级到包根、读 `package.json` 的 `bin` 字段（`loop.ts:101-115`）；
3. `spawn` 投影：`piSubprocessSpec` 把 `PiSpawnSpec` 包成 `SubprocessSpawnSpec`，在 argv 前加 `process.execPath`（即用当前 node 跑 pi 的 JS 入口），stdio 全 pipe，`graceMs = 3000`（`PI_DISPOSE_GRACE_MS`，`loop.ts:47、118-127`）；`fromSubprocess` 再把 dsh 的 `SubprocessHandle` 投影回协议传输所需的 `PiProcess`（`loop.ts:130-145`）；
4. 注册副作用：所有权跟踪、`ctx.agents.setFactory(this)`（占用 harness 唯一 AgentFactory 槽位）、三个 systemPrompt 变量（`loop.ts:184-191`）。注意 Pi 原生拥有自己的 prompt，这些变量只喂给 dsh 系统提示词装配的下游消费者（`loop.ts:186-188` 注释）。

create/resume 走同一套"准备 → setup → 发布"事务（`loop.ts:201-329`）：`prepare` 在发布**之前**把一次性 memoized 反向拆除注册进 `FactoryOwnership` 和 owner fiber，setup 中途卸载会整体回滚；中止信号融合三方（调用方 signal、owner fiber 卸载、工厂拆除）（`loop.ts:213-223`）。`publish` 依次进入两个注册表、announce、发 `agent/session-start`（`loop.ts:285-296`）。`resume` 要求 `sessionPersistence` 服务存在，否则直接抛错（`loop.ts:362-367`）。

### 3.2 PiAgent（驱动）

相位机与 Codex 驱动同构（`agent.ts:74-83`）：`idle` / `maintenance` / `running(turn, step)`。`wakeDriver` 从 idle 起一个 driver 跑 `kick()`，kick 循环 `turn()` 直到排空 inbox（`agent.ts:244-293`）。`send/followup/steer/inject/cancel/runMaintenance` 是对外控制面（`agent.ts:170-234`）。

RPC 客户端**懒创建、跨 step 复用**：`rpcClient(cwd)` 每次先算 `spawnSpec`，与缓存的 `lastSpec` 用 `specsEqual` 逐字段比较（cwd、env 引用、argv 逐项），不同则 dispose 旧客户端重新 spawn（`agent.ts:146-154、64-72`）。agent scope 拆除时释放客户端（`agent.ts:139-142`）。

`turn()` 负责会话日志边界：`turn/start` → 循环 `preStep` + `step/start` + `step()` + `step/end` → `turn/end`（`agent.ts:372-449`）。`preStep` 走 `agent/pre-step` waterfall，之后追加技能注入（见第 7 节）。

每 step 的查询在 `step()`（`agent.ts:504-773`）：要求会话带 cwd（否则抛错，`agent.ts:511-514`）→ `session.deriveMessages()` + `serializeHistory` 得到 prompt → 每生命周期补一次 `request/header`（`assertRequestHeader`，`agent.ts:457-468`）→ `newSession()` + `clearEvents()` + `prompt(prompt)`（`agent.ts:542-546`）→ 消费事件流直到 settle。

dsh 系统提示词装配**故意不跑**：Pi 原生拥有自己的系统提示词，dsh 那套装配会拉 dsh 工具 schema，对托管引擎无意义（`agent.ts:495-503` 注释）。

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

`step()` 内的事件循环（`agent.ts:656-760`）是全驱动最密的部分，按事件类型分四类：

- **忽略**：`agent_start`、`compaction_*`、`auto_retry_*`、`queue_update`、`bash_execution_update`、`extension_ui_request`、`tool_execution_update`、各 `*_start`/`text_end`/`thinking_end`/`toolcall_delta`（`agent.ts:660-668、681-683、693-696、700-702、720-721`）。
- **流式增量 → `assistant/chunk`**：`text_delta` / `thinking_delta` 首次出现某 contentIndex 时先补一个 `block-start` chunk，再发 `text-delta` / `reasoning-delta`（`agent.ts:603-615、684-692`）。chunk 的 durable seq 记入 `chunkSeqs`，供后面 `sourceEventSeqs` 回填，使重放能精确重建 live partial（`agent.ts:577-581、595-599`）。
- **工具 → `tool/call` / `tool/result`**：`toolcall_end` 与 `tool_execution_start` 都会发 `tool/call`，用 `emittedToolCalls` 按 callId 去重（`agent.ts:617-625、697-699、717-719`）；`tool_execution_end` 发 `tool/result`（经 `mapToolResult`），`turn_end.toolResults` 兜底再发一轮（`agent.ts:722-729、736-738`）。
- **收尾 → `assistant/message` + usage**：`message_end`（assistant）用权威消息内容 flush 一条 durable assistant message；`turn_end` 兜底未 flush 的消息；`agent_end` / `agent_settled` 最终 flush（`agent.ts:706-754`）。usage 取最新快照（`message_update.usage` / `message.usage`），经 `mapUsage` 折叠到最后一条 message 上（`rpc/mapping.ts:19-26`：缺省补 0，cache 字段为 0 或缺省时不写）。

**settle 语义（关键坑）**：`finished` 在任何"终态-ish"事件（含 mid-run 的 `turn_end`）置位，但 `settled` 只在 `agent_settled` 或 `willRetry` 为假的 `agent_end` 置位；只有 `settled` 才 break 事件循环（`agent.ts:548-558、743-759`）。因为子进程跨 step 存活、`events()` 永不自行结束，少了这个 break，`step()` 会在回复流完后挂死。循环结束若 `!finished`（子进程死了/流断了），抛 `LlmError('... ended without an agent settle', 'PI_NO_RESULT')`（`agent.ts:762-767`）。

**thinking 折叠**：权威消息的 content 里没有 reasoning 块、但流式阶段收到过 thinking delta 时（某些 provider 只发 delta），把累积的 thinking 按 contentIndex 排序后折到文本块之前，与默认 loop 的"先推理后回答"顺序一致（`agent.ts:627-654`）。

## 6. 权限 / 沙箱模型

### 6.1 姿态折叠

`resolveSessionPermission`（`permission.ts:63-76`）从会话日志最后一条 `sandbox/mode` / `approval/policy` 事件（`src/driver-core/permission-knobs.ts:29-47`）折叠出运行时姿态：

| 会话旋钮 | Pi 姿态 |
|---|---|
| `sandbox/mode = danger-full-access` | 不裁剪工具（`--tools` 不下发，Pi 用原生工具集） |
| `approval/policy = ask` | **降级为 read-only 拒绝**——Pi 没有审批回调，交互式批准只能变成拒绝，即使会话同时要 workspace-write（`permission.ts:68-71`） |
| `sandbox/mode = workspace-write` | 写能力工具集 `['read','grep','find','ls','write','edit']`（`permission.ts:38`） |
| 其他/缺省 | fail-closed：`read-only` + `['read','grep','find','ls']`（`DEFAULT_PI_PERMISSION`，`permission.ts:32-35`） |

部署钉死优先：`queryPermission` 里 `config.sandboxMode` 存在时直接用 `toolsForSandbox(config.sandboxMode)`，不再读会话旋钮；未钉死则每个 query 重新折叠，使会话中途切换 preset 在下一 step 生效（`agent.ts:356-369`）。`--tools` 仅在非空时下发（`agent.ts:481-482`）。

### 6.2 "沙箱"的实际边界（重要）

源码多处注释称整个子进程"wrapped in the dsh subprocess sandbox"（`permission.ts:6-11`、`types.ts:7-8`、`loop.ts:169`、`agent.ts:8`、`rpc/client.ts:5`）。**经核实主仓 `packages/subprocess/` 全部源码不含任何 sandbox 机制**（全目录 grep `sandbox` 无匹配），`SubprocessSpawnSpec` 也没有沙箱字段（`../deepseek-harness/packages/subprocess/subprocess/src/types.ts:75-104`），`piSubprocessSpec` 自然也不传任何沙箱参数（`loop.ts:118-127`）。

实际生效的边界是三层，**没有 OS 级文件系统/网络隔离**：

1. **进程树隔离与终止**：detached 进程组（POSIX）/ `taskkill /T /F`（Windows），SIGTERM → graceMs → SIGKILL 升级（`subprocess/src/types.ts:160-195`、`subprocess-local/src/spawn.ts:358-360`）；
2. **环境清洗**：子进程基础环境是 `scrubbedParentEnv()` 的结果，配置里的 `env` 显式叠加在其上（`subprocess-local/src/spawn.ts:38`、`subprocess/src/types.ts:97-103`、`types.ts:27`）；
3. **`--tools` 工具白名单**：这是 `sandboxMode` 唯一真正的执行点——`read-only`/`workspace-write` 只是不给子进程写/执行类工具，而不是强制它不能写。

改这里时不要把 `sandboxMode` 当成安全边界来推理；它实质是"工具面收缩"。

## 7. 技能注入

两条互补路径：

**Provider 侧**——`PiSkillProvider`（`skills.ts:87-218`）由 `mountPi` 注册到宿主 `skills` 服务（`src/index.ts:375-384`），发现两类候选：

- `agents-md`（合并技能）：会话 cwd 到 git root 的每目录上下文文件，策略是 `AGENTS.override.md` 优先、否则 `AGENTS.md` → `CLAUDE.md`（`PI_CONTEXT_POLICY`，`skills.ts:50-53`；收集逻辑在 `src/driver-core/context-files.ts:52-72`），外加用户级 `<piAgentDir>/AGENTS.md`。`piAgentDir()` 读 `PI_CODING_AGENT_DIR`，缺省 `~/.pi/agent`（`skills.ts:73-77`）。项目集 rank 140，用户集 rank 160——项目文件赢同名冲突（`skills.ts:42-48`）。
- `SKILL.md` 目录项：项目各级 `.pi/skills/`（rank 150）与用户 `~/.pi/agent/skills/`（rank 170），支持 `<name>/SKILL.md` 目录型与 `<name>.md` 扁平型两种布局；用 `stat` 而非 Dirent 判定类型，因为 Windows 的 junction 两者都不是（`skills.ts:162-191`）。解析复用 `src/skills.ts` 的 `parseSkillFile`。

不扫 `.agents/skills`（dsh 自己的 `skill-filesystem` provider 已覆盖）；pi 设置/CLI/包级技能需要跑 `pi --mode rpc` 探针才能发现，组合期不做，文件系统子集即权威（`skills.ts:15-20` 注释）。

**注入侧**——Pi agent 的 context 不挂在 agent-preset 链上，dsh-tool-skill 的 `/name` 手势注入够不着它，所以 `preStep` 里复制了这套手势扫描（`agent.ts:306-316、327-353`）：扫本 step 用户消息里的 `/name`（`invokedSkillNames`，`skill-inject.ts:84-97`）→ `skills.get` 加载（失败静默跳过）→ 仅 `userInvocable` 的注入 → 渲染成 `<skill_content>` 块、以 `source: { kind: 'skill-invocation', name, form: 'instructions' }` 的 user message 追加进本批消息。注入发生在 step 的用户消息落日志之前，因此技能内容同样进持久化日志、可重放。

## 8. 配置项一览

组合入口（`src/index.ts` 的 `Config`）里的 pi 字段经 `piConfig` 透传（`src/index.ts:213-221`）：

| 组合入口字段 | PiLoop Config | 去向 |
|---|---|---|
| `piProvider` | `provider` | `--provider <值>`（`agent.ts:473`） |
| `model`（与 claude/codex 共用） | `model` | `--model`，见下 |
| `piThinking` | `thinkingLevel` | 拼进 `--model`，见下 |
| `env`（共用） | `env` | 显式叠加到子进程环境（`loop.ts:66、125`） |
| `sandboxMode`（与 codex 共用同一键） | `sandboxMode` | 钉死姿态，见第 6 节 |

`--model` 拼接规则（`agent.ts:474-480`）：

- `model` + `thinkingLevel` → `--model <model>:<thinkingLevel>`
- 仅 `model` → `--model <model>`
- 仅 `thinkingLevel` → `--model :<thinkingLevel>`（空 model 段，由 Pi 原生模型 + 指定思考档）

固定 argv 前缀：`[bin, '--mode', 'rpc', '--no-session', ...]`（`agent.ts:484-489`）——`--no-session` 让 Pi 会话不落盘，与无状态 step 模型配套。

模型标签：部署钉了 `model` 则用该值记入 `request/header` 与 assistant message 的 `source.model`；未钉则记 `'pi-native'`——web 会话的建议性模型选择**故意不**镜像进 header，因为它从不驱动查询（`agent.ts:53-58、452-454`）。provider 标签恒为 `'pi'`（`agent.ts:52`）。

## 9. 错误处理与已知边界

- **子进程意外退出**：所有 pending 命令 reject `'pi RPC process exited unexpectedly'`，事件流唤醒后结束（`client.ts:107-113`）；step 侧表现为 `PI_NO_RESULT` 或命令错误。
- **取消**：phase signal 触发时向子进程发 `abort` 命令——fire-and-forget，rejection 被吞掉（子进程可能已在拆除，`PiRpcClient.dispose()` 会 reject 在途的 `abort`；不吞会以 "pi RPC client is disposed" 未处理拒绝打崩进程）（`agent.ts:526-539`）。
- **配置校验失败大声报错**：`Config` schema（`loop.ts:70-76`）在组合边界验证；`sandboxMode` 非法值直接组合失败。
- **cwd 缺失**：会话无 cwd 元数据时 step 抛错，要求带 cwd 启动会话（`agent.ts:511-514`）。
- **resume 依赖**：无 `sessionPersistence` 服务时 `resume` 抛错（`loop.ts:363-366`）。
- **静默降级**：非 JSON 行忽略（`client.ts:234-236`）；技能加载失败静默跳过（`agent.ts:342-344`）；skills 目录不可读当空处理（`skills.ts:166-168`）。
- **已知功能边界**：
  - 图片不转写，统一替换为占位文本（`prompt.ts:20-21`）；
  - `extension_ui_request`（select/confirm/input 等交互请求）被忽略，没有应答路径——依赖交互扩展的 pi 配置在 dsh 下会卡住或无响应（`agent.ts:666-667`、`rpc/types.ts:153-162`）；
  - `get_session_stats` 客户端方法已实现但驱动未调用，usage 完全依赖事件流携带（`client.ts:158-161`）；
  - `rpc/mapping.ts` 的 `mapToolCall` 驱动未使用（agent 内联了 `emitToolCall`），仅测试引用——属冗余导出。

## 10. 测试覆盖要点

`tests/engine-pi/` 下 8 个 spec、145 个用例，本次运行全部通过（`pnpm vitest run tests/engine-pi`，3.6s）：

- `rpc/client.spec.ts`（24）：响应 id 关联、严格 LF 分帧（含 `\r` 容忍、多字节跨 chunk）、生命周期/dispose 幂等、send/缓冲、默认 spawn 与 `fromChildProcess`；
- `rpc/mapping.spec.ts`（13）：`mapUsage` 缺省/零值规则、`mapToolResult` 错误标记与 `(no content)` 兜底、`resultText` 各 payload 形态、`mapToolCall` 序列化；
- `permission.spec.ts`（5）：`resolveSessionPermission` 四种折叠路径 + `toolsForSandbox`；
- `skills.spec.ts`（20）：`piAgentDir` 环境覆盖、上下文文件/技能目录列举（含 junction、两种布局）、`get` 的 locator 双分支；
- `loop.spec.ts`（4）：spawn 投影（`process.execPath` 前缀、stdio、graceMs）；
- `agent.spec.ts`（40）：工厂注册、turn 事件映射、取消与 pre-step 拦截、会话权限折叠、部署钉死、防御性守卫、技能注入、边缘映射；
- `controls.spec.ts`（22）：steer/inject、maintenance、turn 中取消、commit veto、空 step 完成、turn 中输入链接、配置校验；
- `index.spec.ts`（17）：经 `src/index.ts` 的挂载/HMR 安全拆除、createAgent 选项、resume。

注意 `agent.ts` / `loop.ts` 大量分支带 `/* v8 ignore */` 注释（防御性 backstop），覆盖率门槛是 `src/**` 逐文件 100%（`src/client` 除外）——改动这两个文件时新增分支要么测到、要么按既有惯例标注 ignore 理由。

## 附：代码与注释不一致之处

1. **"subprocess sandbox" 措辞**：`permission.ts:6-11`、`types.ts:7-8`、`loop.ts:169`、`agent.ts:8`、`rpc/client.ts:5` 均称子进程被 subprocess seam "沙箱化/包裹"，但主仓 seam 无任何 OS 级沙箱机制（见第 6.2 节）。实际边界 = 进程树隔离 + 环境清洗 + `--tools` 裁剪。
2. **`agents-md` 可调用性**：`skills.ts:10-13` 头注释称 agents-md 是 "user-invocable" 技能，而 `agentsCandidate` 实际设 `{ modelInvocable: true, userInvocable: true }`（`skills.ts:151`）。
3. **`mapToolCall` 死导出**：`rpc/mapping.ts:63-69` 的模块注释说本模块投影 tool call，但驱动并不调用它（`agent.ts` 只 import `mapToolResult`/`mapUsage`，`agent.ts:41`），仅测试使用。
4. **容器级 AGENTS.md 与代码一致**："每 step 一个无状态 new_session + prompt"、"严格 LF JSONL"、"无权限系统→整体沙箱"三条背景陈述均在代码中核实成立（第 3、4 条中的"沙箱"按第 1 条修正理解）。
