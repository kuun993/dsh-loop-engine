# driver-core：托管引擎共享层实现说明

**目标读者**：要修改 `src/driver-core/`、`src/skills.ts`、`src/commands.ts` 的工程师。本文讲清每个共享模块解决什么问题、契约是什么、四个引擎各自怎么用、改它会波及谁。所有论断均标注源码位置，可逐条核实。

## 1. 共享层定位

dsh-loop-engine 的四个托管引擎驱动（`src/engine-claude`、`src/engine-codex`、`src/engine-pi`、`src/engine-kimi`）面向四种完全不同的外部进程：

- **claude**：Claude Agent SDK 的 `query()`，自带权限回调与技能目录；
- **codex**：Codex app-server JSON-RPC，权限是线程启动时声明的 `sandboxMode + approvalPolicy` 对；
- **pi**：`pi --mode rpc` 严格 LF JSONL，没有任何原生权限系统，整个子进程靠 dsh 沙箱包裹；
- **kimi**：`kimi acp` 子进程，权限以 ACP 反向 RPC `session/request_permission` 回调形式出现。

引擎之间的差异集中在**传输层、权限映射、上下文文件策略、技能 provider** 四件事上，这四件事都留在各引擎自己的目录里。而以下五件事四个引擎完全一致，被抽到 `src/driver-core/`：

| 模块 | 解决的问题 |
|---|---|
| `prompt.ts` | 把持久会话日志序列化成一次托管查询的 prompt 文本 |
| `permission-knobs.ts` | 从会话日志折叠出 dsh 的沙箱/审批旋钮 |
| `ownership.ts` | 工厂所有权、活体 agent 跟踪、setup 与中止信号的竞速 |
| `context-files.ts` | 从会话 cwd 向上走到 git root 的上下文文件发现与读取 |
| `skill-inject.ts` | 复刻 dsh `/name` 技能手势扫描与 `<skill_content>` 渲染 |

另外两个非 driver-core 文件也属于共享层：`src/skills.ts`（Claude Code 技能 provider + 被各引擎 provider 复用的 `parseSkillFile` 与类型镜像）和 `src/commands.ts`（斜杠命令转发桥 + 被 kimi 复用的命令类型）。

> **注意**：driver-core 各文件的头部注释大多仍写着 "Both the Claude Code and Codex drivers"——那是 kimi/pi 引擎加入前的旧表述，实际四个引擎都在用（详见文末"代码与注释不一致"一节）。

## 2. prompt.ts：每步 prompt 的组装契约

### 解决什么问题

托管引擎每次查询都是**无状态**的：外部 CLI 看不到 dsh 的会话历史，必须把历史塞进当次 prompt。同时 dsh 有一条硬约束——"模型可见 ⟺ 已落日志"（Model-visible ⟺ logged），所以 prompt 必须是会话日志的**精确投影**：同一份日志重放必须得到逐字节相同的 prompt（`src/driver-core/prompt.ts:1-9` 的模块头注，`serializeHistory` 是"日志前缀的纯函数"，`src/driver-core/prompt.ts:84-92`）。

### 契约

`serializeHistory(messages)`（`src/driver-core/prompt.ts:93`）接收 `Session.deriveMessages()` 在步进时刻派生的消息序列（最旧在前，最后一条是触发本步的用户请求），返回纯文本。序列化规则：

- 每条消息用 `<role>...</role>` 框架包裹（`frame`，`src/driver-core/prompt.ts:29`），段落间以 `\n\n` 连接；
- **assistant**：text 块逐字输出；tool-call 块压缩成一行 `[tool call: name(args)]`（`src/driver-core/prompt.ts:49`）；image 块替换为占位文本 `OMITTED_IMAGE_TEXT`（`src/driver-core/prompt.ts:20-21`）；**reasoning 块不转写**——每个引擎在每次全新查询里自己重新推导思考（`src/driver-core/prompt.ts:54-56`）；
- **user（source.kind 为 'tool'）**：走 `renderToolResult`（`src/driver-core/prompt.ts:68`），失败调用标为 `<tool-result-error>`，成功为 `<tool-result>`（`src/driver-core/prompt.ts:80`）；正文为空时输出 `(no content)`（`src/driver-core/prompt.ts:81`）；
- **user（其他 source）**：text 逐字、image 替换占位文本，空正文同样兜底 `(no content)`（`src/driver-core/prompt.ts:107-118`）；
- **system 角色**：不进派生会话面，直接跳过（`src/driver-core/prompt.ts:121-123`）；
- assistant 正文为空的整条消息不进 transcript（`src/driver-core/prompt.ts:99`）。

### 哪些引擎怎么用

四个 agent 的调用方式逐字一致——先取 `this.session.deriveMessages()`，再 `serializeHistory(history)`，空 prompt 抛错（v8-ignore 的兜底分支）：

- `src/engine-claude/agent.ts:467-472`
- `src/engine-codex/agent.ts:456`
- `src/engine-pi/agent.ts:516`
- `src/engine-kimi/agent.ts:504-509`

kimi 额外把 prompt 发送本身包进 `raceAbort`（`src/engine-kimi/agent.ts:530`），因为 ACP prompt 是一个需要等响应帧的 RPC。

### 改它会波及谁

这是共享层里**爆炸半径最大**的模块：序列化格式的任何改动（标签名、tool-call 行格式、占位文本、空正文兜底）都会同时改变四个引擎发给模型的每一段 prompt。修改前必须先想清楚：外部 CLI 对同一份历史是否有自己的展开逻辑（例如 Claude Code CLI 对 `/name` 的原生展开与这里的 skill 注入文本是否会叠加）。测试上它由 `tests/engine-claude/mapping.spec.ts` 直接 import（`tests/engine-claude/mapping.spec.ts:17`），并间接被四个 `tests/engine-*/agent.spec.ts` 的步进路径覆盖。

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
| codex | `src/engine-codex/permission.ts:39-46` | `danger-full-access` + `never` | `workspace-write` + `on-request` | `read-only` + `never`（`DEFAULT_CODEX_PERMISSION`，`:26-29`） |
| pi | `src/engine-pi/permission.ts:63-75` | 不剪 `--tools`，不包沙箱 | **降级为 read-only 拒绝**（pi 无审批回调） | `read-only` + 只读工具集（`:32-35`） |
| kimi | `src/engine-kimi/permission.ts:30-31` | 不查 sandbox 旋钮 | `ask` → 拒绝 | 其他（`never`/无旋钮）→ 自动批准 |

claude 还有一个**部署级覆盖**：`cordis.yml` 里钉死的 `config.permissionMode` 直接赢过会话旋钮（`src/engine-claude/agent.ts:335`）。kimi 不读 sandbox 旋钮是刻意的——Kimi 自己的工具策略约束工具能做什么，ACP 审批是宿主侧闸门，只由 `approval/policy` 信号驱动（`src/engine-kimi/permission.ts:22-27` 的头注）。

### 改它会波及谁

改读取逻辑（比如换成"取第一条"或放宽枚举校验）会同时改变四个引擎每一次查询的权限立场——这是安全相关代码，"无旋钮时失败闭合"是所有引擎共同的底线，任何让它变得宽松的改动都需要逐引擎重新论证。新增旋钮（比如第三种 sandbox mode）要同步改 `SANDBOX_MODES` 常量（`src/driver-core/permission-knobs.ts:25`）并审查四个 permission 模块的 switch 是否出现静默落空。

## 4. ownership.ts：所有权 / 归属判定

### 解决什么问题

dsh 里**恰好只有一个工厂**能占住 `AgentFactory` 槽位，而引擎可以在线热切换：用户切引擎时旧工厂的 fiber 被卸载。这带来三个并发问题：

1. 卸载开始的瞬间，还在进行中的 `create/resume` setup 必须立刻被中止；
2. 已发布的活体 agent 必须全部 teardown 完毕后，工厂 dispose 才能返回；
3. setup 中途 fiber 状态已变（UNLOADING/DISPOSED/FAILED）时，新的创建请求必须被拒绝。

`FactoryOwnership`（`src/driver-core/ownership.ts:25`）就是这三件事的统一答案，`raceAbort` / `raceAbortCall` 处理"setup await 与融合中止信号竞速"。

### 契约

- `INACTIVE_STATES`（`src/driver-core/ownership.ts:18-22`）：`UNLOADING | DISPOSED | FAILED` 三种 fiber 状态不能拥有或服务新生命周期；
- `isActive()`（`:39-41`）：`accepting` 标志与 fiber 状态双判；
- `signal`（`:35-37`）：工厂级中止信号，`dispose()` 一开始就以 `agent loop is not active` 错误 abort（`:61-69`）；各 loop 用它做融合中止的一路输入（如 `src/engine-claude/loop.ts:173-175`）；
- `track(dispose)`（`:44-47`）：登记一个活体 agent 的 teardown，返回反注册函数；
- `trackStartup(job)`（`:50-54`）/ `trackWrapper(job)`（`:57-59`）：把 agent 尚未存在前的配置启动工作、以及 create/resume 的发布延续挂进工厂，dispose 会等它们全部 settle；
- `dispose()`（`:61-69`）：先关门（`accepting = false` + abort），再并发等待所有活体 agent teardown 与启动任务；
- `raceAbort(operation, signal, id)`（`:73-89`）：operation 与 signal 竞速，abort 时抛出 signal 的 reason（非 Error 时包装成 `agent "<id>" creation aborted`）；
- `raceAbortCall(..., releaseAbandoned)`（`:91-112`）：额外处理"operation 在取消后才产出值"的孤儿资源——取消后仍 then 一次 `releaseAbandoned` 释放它（典型场景：子进程/连接在取消后恰好建好了）。

### 哪些引擎怎么用

四个 loop 的使用方式逐字镜像（jscpd 注释里明说这套机制镜像默认 agent-loop 工厂，且禁止依赖 agent-loop 包——`src/engine-claude/loop.ts:152`）：

| 调用点 | claude | codex | pi | kimi |
|---|---|---|---|---|
| 构造 `FactoryOwnership` | loop.ts:134 | loop.ts:128 | loop.ts:180 | loop.ts:111 |
| fiber effect 里 dispose | loop.ts:136 | loop.ts:130 | loop.ts:184 | loop.ts:114 |
| prepare 入口 `isActive()` 守门 | loop.ts:157 | loop.ts:151 | loop.ts:205 | loop.ts:135 |
| `track(dispose)` | loop.ts:206 | loop.ts:200 | loop.ts:254 | loop.ts:184 |
| `trackWrapper(published)` | loop.ts:304 | loop.ts:298 | loop.ts:352 | loop.ts:282 |
| setup `raceAbort` | loop.ts:274 | loop.ts:268 | loop.ts:322 | loop.ts:252 |
| prepare `raceAbortCall` | loop.ts:341 | loop.ts:335 | loop.ts:389 | loop.ts:319 |

kimi agent 在步进路径上还单独用了一次 `raceAbort` 等 ACP prompt 响应（`src/engine-kimi/agent.ts:530`）。

### 改它会波及谁

四个引擎的生命周期正确性全部压在这 112 行上。这里任何一个判定时序的变化（比如 `dispose()` 里 abort 与等待的顺序、`isActive()` 的双判条件）都是四份 loop 代码的共同行为；改完必须跑全部四个 `tests/engine-*/loop.spec.ts`。注意 `dispose()` 里的错误文案 `agent loop is not active` 同时被各 loop 的守门分支复用（如 `src/engine-codex/loop.ts:345`），改文案要全局搜。

## 5. context-files.ts：上下文文件的发现与加载

### 解决什么问题

codex / pi / kimi 都读"从会话 cwd 向上走到 git root，每目录一个指令文件"这套约定（AGENTS.md 系），但每个引擎接受的文件名与覆盖规则不同。这个模块把**目录链行走**与**每目录选文件策略**分开：前者共享，后者由各引擎以 `ContextFilePolicy` 声明。

### 契约

- `ContextFilePolicy`（`src/driver-core/context-files.ts:20-25`）：`override`（可选，存在即顶替）+ `primary`（按序尝试直到命中）；**每个目录最多贡献一个文件**（`dirContextFile`，`:62-72`）；
- `projectAncestors(cwd)`（`:34-43`）：目录链从 cwd 到 git root、**最近的在前**；git root 判定复用 `src/skills.ts` 的 `findProjectRoot`（向上找 `.git`，找不到回退为入参 cwd 本身，`src/skills.ts:340-353`）——没有仓库时链上只有 cwd，保证行走有界；
- `collectProjectContextFiles(cwd, policy)`（`:52-59`）：沿链收集存在的上下文文件，最近目录优先；
- 正文加载助手（`:89-132`）：`readOptionalFile`（读不到返回 `undefined`，不抛）；`anySourceNonEmpty` / `fileNonEmpty`（存在且 trim 后非空白）；`readSources`（按序拼接所有非空正文，`\n\n` 分隔，全部读不到返回 `undefined`）。

### 各引擎的策略

| 引擎 | 策略声明 | 用户级补充 |
|---|---|---|
| codex | `{ primary: ['AGENTS.md'] }`，无 override（`src/engine-codex/skills.ts:33`） | `~/.codex/AGENTS.md` 单独成候选（`src/engine-codex/skills.ts:58-59`） |
| pi | `{ override: 'AGENTS.override.md', primary: ['AGENTS.md', 'CLAUDE.md'] }`（`src/engine-pi/skills.ts:50-53`） | `PI_CODING_AGENT_DIR` 或 `~/.pi/agent` 下的 `AGENTS.md`（`src/engine-pi/skills.ts:73-77`、`:103-105`） |
| kimi | `{ primary: ['AGENTS.md'] }`（`src/engine-kimi/skills.ts:49-51`） | **没有用户级上下文文件**——kimi 的 `list()` 只用项目链（`src/engine-kimi/skills.ts:90-104`） |

claude **不用**这个模块：CLAUDE.md 由 `ClaudeCodeSkillProvider` 按"带 frontmatter 才算技能"的另一套逻辑处理（见下节）。

### 改它会波及谁

- 改 `projectAncestors` / `collectProjectContextFiles` 的行走语义 → 影响 codex、pi、kimi 三个 provider 的项目级发现范围；
- 改 `readSources` 的拼接分隔符或空文件过滤 → 影响三个引擎 `agents-md` 技能的最终正文（会被 `renderSkillContent` 包进 prompt）；
- `ContextFilePolicy` 加字段是安全的（各引擎用 `satisfies` 声明），但改 `dirContextFile` 的"每目录一个文件"上限是结构性变化，要同时审三个 provider 的 candidate 构造；
- 注意它 import 了 `src/skills.ts` 的 `findProjectRoot`（`src/driver-core/context-files.ts:17`），两个文件存在**反向依赖**：改 `findProjectRoot` 的回退行为同时影响 claude 技能锚定和三个引擎的目录链。

## 6. skill-inject.ts + skills.ts + commands.ts：技能与斜杠命令接缝

### 6.1 skill-inject.ts：为什么托管引擎要自己复刻 `/name`

进程内引擎的技能注入由 dsh-tool-skill 的 handler 完成，但它挂在 agent-preset 上下文链上，而托管引擎 agent 的上下文**不从那条链派生**（`src/driver-core/skill-inject.ts:1-8` 头注；claude agent 里也有同样的注释，`src/engine-claude/agent.ts:277-280`）。所以四个 agent 各自复制同一段注入流程，共享部分抽在这里：

- `SKILL_GESTURE`（`:18`）：空白边界的 `/name` 手势正则，name 必须 kebab-case（`SKILL_NAME_RE`，`:15`）；
- `invokedSkillNames(messages)`（`:84-97`）：只扫 `source.kind === 'user'` 的消息文本块，按首次出现顺序去重——**tool 结果、技能注入消息自身不会被递归扫描**；
- `renderSkillContent(skill)`（`:67-81`）：渲染 `<skill_content>` XML；`resourceBase.kind === 'directory'` 时写明基目录让模型自行解析相对路径，否则声明资源由 provider 管理；`escapeText` / `escapeAttr`（`:57-64`）防注入；
- `SkillInvocationSource`（`:38-42`）+ `MessageSourceMap` 模块增强（`:44-49`）：注入的消息带持久 source `{ kind: 'skill-invocation', name, form: 'instructions' }`，镜像 dsh-skill 的线上形状，保证重放时能被识别。

四个 agent 的 `injectSkills` 逐字一致（claude `src/engine-claude/agent.ts:297-323`；codex `:304` 起；pi `:328` 起；kimi `src/engine-kimi/agent.ts:317-343`）：从 `loopCtx` 取 `skills` 服务（`SkillsService` 最小形状，`:52-54`），逐个 `skills.get(name, { cwd, signal, scope: this })`，加载失败静默跳过、`userInvocable === false` 跳过、中途 abort 整批放弃返回原消息，最后把注入消息**追加**到本步消息批末尾。

### 6.2 skills.ts：ClaudeCodeSkillProvider 与各引擎 provider 的共性

`src/skills.ts` 有三重身份：

1. **类型镜像源头**：`SkillCandidate` / `SkillDefinition` / `SkillProvider` / `SkillProviderControl` 等接口（`src/skills.ts:16-62`），刻意不引 `@deepseek-ai/dsh-skill` peer；codex/pi/kimi 的 provider 全部从这里 import 类型（如 `src/engine-codex/skills.ts:24`）；
2. **frontmatter 解析器**：`parseSkillFile`（`:163-182`）+ `parseFrontmatter`（`:84-124`）——一个 YAML 子集解析器，支持平量、`>`/`|` 块标量（`:108-120`）、成对引号剥离（`unquote`，`:127-136`）、`true/yes/false/no` 布尔（`booleanField`，`:194-200`）；pi 和 kimi 的 provider 直接复用它解析各自 `SKILL.md`（`src/engine-pi/skills.ts:36`、`:213`；`src/engine-kimi/skills.ts:37`、`:208`）；
3. **Claude Code 技能 provider**：`ClaudeCodeSkillProvider`（`:219-265`）。

ClaudeCodeSkillProvider 的发现规则：项目侧锚定 git root（`findProjectRoot`，`:340-353`）扫 `<root>/.claude/skills/` 与项目根 `CLAUDE.md`（仅当带技能 frontmatter，`collectClaudeMd`，`:302-314`），用户侧扫 `~/.claude/skills/`；同一目录兼容两种布局——`<name>/SKILL.md`（目录本身成为 resourceBase）与扁平 `<name>.md`（resourceBase 是整个 skills 目录），见 `collectSkillsDir`（`:268-299`）。rank 刻意插在 project-dsh (100) 与 custom (300) 之间：项目 150、用户 160（`:69-71`）。`list()` 结束时检查 abort，已中止则返回空目录（`:239`）。

各引擎 provider 的共性与差异：

| provider | 文件 | 上下文文件 | 技能目录 | rank 布局 |
|---|---|---|---|---|
| claude-code | `src/skills.ts:219` | 项目根 `CLAUDE.md`（需 frontmatter） | 项目/用户 `.claude/skills/` | 150 / 160 |
| codex | `src/engine-codex/skills.ts:46` | `AGENTS.md` 链 + `~/.codex/AGENTS.md`，合并为一个 `agents-md` 技能 | 无 | 140 / 160 |
| pi | `src/engine-pi/skills.ts:87` | `AGENTS.md`/`CLAUDE.md` 链（override 优先）+ pi 配置目录 `AGENTS.md` | 项目 `.pi/skills/`（沿目录链每级都查）+ 用户 `skills/` | 140 / 150 / 160 / 170 |
| kimi | `src/engine-kimi/skills.ts:85` | `AGENTS.md` 链 | 项目 `.kimi-code/skills/` + `$KIMI_CODE_HOME/skills/` | 140 / 150 / 160 |

共性：合并型上下文候选统一叫 `agents-md`、`modelInvocable + userInvocable` 双开、locator 记录路径集留待 `get()` 时用 `readSources` 拼正文（codex `src/engine-codex/skills.ts:64-80`；pi/kimi 同构）。pi 与 kimi 都**刻意不扫** `.agents/skills/`——dsh 自己的 skill-filesystem provider 已在 web profile 里覆盖了它（`src/engine-pi/skills.ts:16-21`、`src/engine-kimi/skills.ts:15-18` 头注）。

### 6.3 commands.ts：斜杠命令转发桥

dsh 的 `commands` 运行时**本地执行**已注册命令——这一行被消费、永远到不了模型（`src/commands.ts:1-13` 头注）。而 Claude Code 的命令真正展开发生在 CLI 内部，所以桥的语义是**转发**：handler 把原始行 `/<name> [args]` 作为普通 user 消息 `followup` 回给接收 agent，CLI 再原生展开（`forwardClaudeCodeCommand`，`src/commands.ts:64-72`）。注册内建命令（`CLAUDE_CODE_COMMANDS` 七条，`:80-88`）的意义是让 dsh web 斜杠菜单看得见命令面；未注册的 `/行` 也能透传为普通文本，但菜单会隐藏引擎的命令能力。

`discoverUserSlashCommands()`（`:98-124`）同步扫描 `~/.claude/commands/*.md`：名字须过 dsh 命令文法（`COMMAND_NAME`，`:54`）、不得与内建重名、必须能产出描述——描述取 frontmatter `description` 字段，否则取正文首个非空非标题行，超 120 字符截断（`commandDescription`，`:138-162`）。同步扫描是为了在引擎选择 commit 返回前完成注册。**项目级 `.claude/commands/` 刻意不注册**：它随 cwd 变化，全局注册会跨项目串扰（`:16-18`）。

kimi 有自己的命令桥 `src/engine-kimi/commands.ts`，复用这里的 `CommandDefinition` / `CommandInvocation` / `CommandResult` 类型（`src/engine-kimi/commands.ts:23`），转发模式相同（`forwardKimiCommand`，`:33-40`），但只注册 ACP prompt 面有意义的子集（TUI 控制类命令不注册，`skill:` 已由技能缝承载——`:12-17` 头注）。

### 6.4 注册点

所有 provider 与命令都在 `src/index.ts` 按引擎挂载：claude 命令 + provider（`src/index.ts:335-356`）、codex provider（`:366-368`）、pi provider（`:379-381`）、kimi 命令 + provider（`:389-410`）。宿主 `commands` / `skills` 服务都以最小形状结构取（`ctx.get`），缺失时静默跳过。

## 7. 改动影响矩阵

| 改动点 | 直接受影响 | 必须跑的测试 |
|---|---|---|
| `prompt.ts` 序列化格式 | 四个引擎的全部 prompt | `tests/engine-claude/mapping.spec.ts` + 四个 `tests/engine-*/agent.spec.ts` |
| `permission-knobs.ts` 读取/枚举 | 四个引擎每次查询的权限立场 | 四个 `tests/engine-*/permission.spec.ts`（claude 侧直接 import 读者，`tests/engine-claude/permission.spec.ts:8`） |
| `ownership.ts` 生命周期/竞速 | 四个 loop 的创建/卸载正确性 | 四个 `tests/engine-*/loop.spec.ts` |
| `context-files.ts` 行走/加载 | codex、pi、kimi 的 `agents-md` 技能 | `tests/driver-core/context-files.spec.ts` + 三个 `tests/engine-*/skills.spec.ts` |
| `skill-inject.ts` 手势/渲染 | 四个引擎的技能注入文本 | 四个 `tests/engine-*/agent.spec.ts` |
| `skills.ts` `parseSkillFile` | claude + pi + kimi 三个 provider 的技能解析 | `tests/skills.spec.ts`、`tests/engine-pi/skills.spec.ts`、`tests/engine-kimi/skills.spec.ts` |
| `skills.ts` `findProjectRoot` | claude 技能锚定 + codex/pi/kimi 目录链（context-files 反向依赖） | 全部 skills 相关 spec |
| `commands.ts` 类型/转发 | claude 命令面 + kimi 命令桥（类型复用） | `tests/commands.spec.ts`、`tests/engine-kimi/commands.spec.ts`、`tests/index.spec.ts` |

## 8. 测试覆盖要点

- **唯一直接的 driver-core spec** 是 `tests/driver-core/context-files.spec.ts`：目录链行走（有/无 git root）、override 优先于 primary、每目录一个文件、四个正文助手的空/缺失/拼接语义。改 context-files 先改这里。
- `prompt.ts` 由 `tests/engine-claude/mapping.spec.ts` 直接 import（`serializeHistory`、`OMITTED_IMAGE_TEXT`）；没有独立的 prompt spec，新增序列化分支时应在这里补用例。
- `permission-knobs.ts` 没有独立 spec，靠四个 permission spec 的行为断言间接覆盖；改折叠逻辑时四个 spec 都要看。
- `ownership.ts` 由四个 loop spec 的卸载/竞速场景覆盖，源码里大量 `v8 ignore` 注释标出了理论上不可达的兜底分支——改动时不要用"删分支"来凑覆盖率，这些注释本身就是设计文档。
- `skill-inject.ts` 由四个 agent spec 的 `/name` 步进场景覆盖。
- `tests/commands.spec.ts` 用 hoisted 的 homedir mock + 临时目录覆盖转发、frontmatter 描述回退、120 字符截断、内建冲突、悬空 frontmatter 等边界；`tests/skills.spec.ts` 覆盖两种布局、rank、CLAUDE.md 三态（有 frontmatter / 无 / 是目录）、frontmatter 解析全部边界。
- 四个 `tests/engine-*/skills.spec.ts` 覆盖各 provider 的目录策略与环境变量覆盖（`PI_CODING_AGENT_DIR`、`KIMI_CODE_HOME`）。
- 全仓覆盖率门槛是 per-file 100%（`pnpm run test:coverage`，`src/client` 除外），共享层任何新分支都必须有用例或显式 `v8 ignore` 理由。

## 附：代码与注释不一致之处（本文撰写时核实）

以下模块头注仍是 kimi/pi 引擎加入前的旧表述，与真实使用方不符，修改这些文件时建议顺手订正：

1. `src/driver-core/ownership.ts:2-4`："Both the Claude Code and Codex loop drivers run the same lifecycle"——实际四个 loop（claude/codex/pi/kimi）逐字共用。
2. `src/driver-core/prompt.ts:2-4`："Both the Claude Code and Codex drivers build their per-step input"——实际四个 agent 都用 `serializeHistory`。
3. `src/driver-core/permission-knobs.ts:2-5`："Both the Claude Code and Codex drivers fold the same events"——pi 两个读者都用，kimi 用 `sessionApprovalPolicy`。
4. `src/driver-core/skill-inject.ts:2-5`："Both the Claude Code and Codex agents replicate the dsh `/name` skill gesture scan"——实际四个 agent 都复刻。
5. `src/driver-core/context-files.ts:4-6`："Codex and Pi read per-directory instruction files"——kimi 也通过本模块读 `AGENTS.md` 链；同段 "feed both providers' list/get paths"（`:9-10`）同样漏了 kimi。
6. `tests/driver-core/context-files.spec.ts:2-3`："used by the codex and pi skill providers"——kimi provider 同样是消费方。
