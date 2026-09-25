# dsh-loop-engine 总体架构与插件核心

面向要修改本插件的工程师。本文只覆盖**插件核心**（单槽路由、managed block、per-session 引擎记录、settings 接缝、client 注入、构建）；各引擎驱动（`engine-claude/`、`engine-codex/`、`engine-pi/`、`engine-kimi/`）与共享驱动基础设施（`driver-core/`）是另一层主题，见 `docs/driver-core.md` 与各 `engine-*.md`，本文只在接缝处提及。

文中 `src/index.ts:264` 格式的引用均相对本仓库根；主仓文件相对 `../deepseek-harness/`。

**用户可见行为**（怎么让会话 A 跑 Codex、会话 B 跑 Kimi，什么时候能换引擎，默认引擎怎么设）见 `docs/per-session-engine.md`；本文讲的是同一套行为的实现。

## 1. 插件定位与核心约束：单 AgentFactory 槽位

harness 进程内**只允许一个** `AgentFactory`：`AgentRegistry.setFactory` 在第二次注册时抛 `an agent factory is already registered`（主仓 `packages/core/agent/src/index.ts:355-364`，抛点在 `:357`）。默认由基础包的 `agent-loop` 行占住（主仓 `packages/bundle/base/cordis.patch.yml:472-473`），那一行也就是"in-process"引擎（主仓 `packages/core/agent-loop/src/index.ts:359`）。

本插件要在**不改主仓一行代码**的前提下支持四种外部引擎。约束直接推出唯一可行的形态：

- 进程里只能有一个工厂，所以"会话 A 用 Codex、会话 B 用 Kimi、并发跑"**不可能**靠"挂两个工厂"或"换工厂"实现；
- 但 `AgentFactory` 的入口只有 `createAgent` / `resume` 两个方法，**分发本身可以放进这一个工厂里**。

因此本插件的形态是：**用一个会路由的工厂独占槽位**——`src/router-loop.ts` 的 `RouterLoop`，按会话把 create/resume 转给对应引擎的运行时，`in-process` 则转给它自己的 `super`。这与早期版本"选中某个引擎就去抢占槽位"的方向相反：**槽位从头到尾属于路由器**，引擎是路由器内部的实现细节，`in-process` 不再意味着"插件什么都不做"。

由此还推出两条贯穿全文的性质：

1. managed block 在插件装载期间**恒存在**（§2）——路由器也服务 `in-process` 会话，基础 `agent-loop` 行不能回来。
2. 引擎选择是**按会话**的，所以它不可能写进进程级配置文件；而"运行中的会话换引擎"在 harness 侧没有通道（preset 通道在会话开始后直接拒绝，§3.7），因此插件把这条事实记在自己的侧车文件里（§3.9），agent preset 只作为**没有记录时的兜底**与 agent-plane 组合（§3.3）。这条事实为什么不进会话日志，见 §3.10。

## 2. managed block：常量块与 legacy 迁移

早期版本的块携带引擎 id、随切换改写。现在的块**与引擎无关**，只做一件事：把唯一槽位让给路由器。

### 2.1 常量块的格式与作用

插件在用户的 profile patch 文件里拥有一段由 begin/end 标记界定的连续区间，`renderManagedBlock()` 是**无参**的（`src/patch-manager.ts:63-72`），两个标记都是常量（`src/patch-manager.ts:48`、`:57`）：

```yaml
# -- dsh-loop-engine managed block --
- id: agent-loop
  disabled: true
- id: command-goal
  disabled: true
# -- /dsh-loop-engine managed block --
```

- `agent-loop` 让出槽位（§1）。块体只做**禁用**，不插入任何新行：引擎工厂由本插件的 composition 行托管，不需要出现在 patch 文件里。
- `command-goal` 禁的是 **host 面**那一行。dsh 的人类 `/goal` 命令其实注册在 **preset 层**：`standard` 组合自己带一行 `command-goal`（主仓 `packages/preset/agent-presets/presets/standard/agent.cordis.yml:95`），所以 profile patch 里禁用 host 面那一行**够不到**由这份组合出来的会话；真正把 `/goal` 从托管会话里拿掉的是托管 preset 自己剥掉该行（§3.5，`src/preset.ts:79`，理由注释 `:63-78`）。这里再禁一次是为了不依赖 `web-app` overlay（它本来就禁了同一行，主仓 `packages/bundle/web-app/cordis.patch.yml:411-412`）：只装 base 的最小 profile 同样生效。其余 dsh 原生命令（`/export`、`/feedback`、`/permission`）是引擎无关的会话/设置控制，在托管引擎下仍然真实生效，保留。
- **块里没有引擎 id**，因为引擎是 per-session 决策（§3.3），写进进程级配置文件没有意义；块的唯一职责是让槽位。
- 因此**没有"in-process = 没有块"这种形态**：`apply()` 每次启动按「有 legacy 块 **或** 没有当前块」决定是否写盘（`src/index.ts:272-285`），且没有任何代码路径会移除块。`syncManagedBlock(path)` 是同一判定的导出封装，供测试与外部调用（`src/index.ts:192-204`）。

### 2.2 legacy 块与升级迁移

旧格式把 profile 钉死的那个引擎写进 begin 标记：`# -- dsh-loop-engine managed block: claude-code --`（前缀常量 `LEGACY_MANAGED_BLOCK_BEGIN`，`src/patch-manager.ts:54`）。

- `hasLegacyManagedBlock(text)` 只做前缀匹配（`src/patch-manager.ts:78-80`）；`hasManagedBlock(text)` 匹配两种形态（`src/patch-manager.ts:86-88`）。
- `legacyBlockEngineOf(text)` 用 `^# -- dsh-loop-engine managed block: (\S+) --$`（`src/patch-manager.ts:91`）读出旧块里的引擎 id，且**只在本版本认识该 id 时**返回它；新块、无块、以及尚未认识的 id 一律 `undefined`（`src/patch-manager.ts:99-104`）。
- `apply()` 在启动时先读这个 id 作为 settings 段的初始 seed（`src/index.ts:271`、`:531`），因此**升级后默认引擎不丢**；随后把旧块重写为常量块（`:272-285`）。写失败记 error 而不是抛出：没有块时基础行继续占槽，路由器的注册会被拒，每个会话都会 loud 失败，所以这一条按 error 级别上报（`:276-284`）。

`src/invariant.ts` 把这条关系登记为运行时不变量：任意引擎的 legacy 块都必须仍读回该引擎、且迁移后的文本与"同一层从未有过块"逐字节相同（`src/invariant.ts:57-69`）；当前块不得读成 legacy pin（`:56`）。

### 2.3 `applyManagedBlock` 的语义

`applyManagedBlock(text)` 是纯字符串变换、单参（`src/patch-manager.ts:162-171`），文件 I/O 全部在插件侧。规则：

- **块不存在**：追加块；空文本直接返回块本身，非空则先补一个空行分隔（`src/patch-manager.ts:165-168`）。
- **块存在**（含 legacy 形态）：原位替换，保留 begin 标记前的空行（`src/patch-manager.ts:170`、`managedSpan` 的 `blankBefore` 记账 `:107-127`）。旧格式的 begin 标记只是更长的一行首，真正界定区间的是 end 标记（`:113-116`）。
- **无 end 标记的块**被视为延伸到文件末尾（`:116`）。用户若手删了 end 标记，块尾之后的自有内容会在下次重写时被吞掉——改这里要慎重。
- 块外字节逐一保留。往返（重写后再重写）是不动点，且 legacy 迁移与"无块 + 追加"得到同一结果（`src/invariant.ts:52-53`、`:66-68`）。

### 2.4 YAML 可加载性修复

managed block 本身是**根级 block sequence**，这带来一个真实踩过的坑（注释在 `src/patch-manager.ts:134-144`）：新 profile 的种子模板是孤零零一行根级 `[]`，若在其后追加块，文件里就有**两个根级集合**，js-yaml 直接拒绝（"end of the stream or a document separator is expected"），web 无法启动。`dropSeedPlaceholder` 在加块时删掉整行的根级 `[]`，并锚定列 0，条目配置里缩进的 `options: []` 不受影响（`src/patch-manager.ts:145-149`）。

### 2.5 写入：同步 + 原子

写盘固定为"同目录临时文件 + rename"（`writePatchFile` / `writePatchFileSync`，`src/index.ts:165-182`），保证读者永远看到完整的新或旧内容。同步变体存在的理由写在它的 docstring 里（`src/index.ts:172-179`）：settings 的 `onChange` 是**无 await 的同步钩子**，而用户可能在提交后立刻重启 `dsh web`——写入必须在提交返回前落盘。同目录 rename 也为 Windows 上的目录项一致性留了余地（测试清理在 `tests/index.spec.ts:206-214` 有对应的重试）。

**同步原子写现在只有一份实现**：`writePatchFileSync` 只是转发 `src/session-engine-store.ts:109-114` 的 `writeFileAtomicSync`，侧车记录（§3.9）与 patch 文件共用它——两处的 durability 语义因此不可能漂移。异步的 `writePatchFile` 仍自带一份 async 版本（`src/index.ts:165-170`）。

## 3. 单槽路由器：按会话分发

### 3.1 启动：`apply()` 的顺序

`apply(ctx, config)`（`src/index.ts:264`）依次做（第 4–6 步是后面三个挂载共用的准备，不是挂载本身）：

1. `resolvePatchPath` 解析 patch 文件路径：`patchPath` 显式指定优先，否则 `$DSH_HOME/profiles/<profile>/<patchFilename>`，默认 `web/cordis.patch.yml`；空字符串视为未指定（`src/index.ts:139-147`）。composition 条目是**引擎无关的超集**：四个引擎的旋钮全在这一层，因为任何会话都可能选中任何引擎（`src/index.ts:111-121`）。
2. **同步**读文件；非 ENOENT 的读失败直接抛出，不让插件带未知状态启动（`:266`、`:207-214`）。
3. 从文件里取 legacy 引擎作为 settings seed，并按 §2.2 重写为常量块（seed 的落点 `:531`，写入 `:272-285`）。
4. `const pluginWarn`（`:538`）是本插件**唯一的诊断出口**：侧车记录的降级（§3.9）、路由器的跳过与释放失败、Remote 的读取失败，全部从这一个 sink 发声，部署在宿主日志里只看到一种声音。
5. `const engineRecords = new SessionEngineStore(resolveEngineRecordPath(), pluginWarn)`（`:546`）：侧车记录的读写门面（§3.9）。构造不碰磁盘，文件在第一次查询时才读，所以从不换引擎的部署一次都不会碰到那个文件。
6. `const routerHolder: RouterSurfaceHolder = { current: undefined }`（`:554`）：Remote 的**两个**端点从哪里找到路由器（§4.6）。路由器是异步挂载的（第 7 步），在它挂上之前这里必须是 `undefined`——指向一个已经拆掉的 fiber 的持有者会报一条没人驱动的会话，也会释放没人重建的 agent。
7. `mountRouter()`（`:588-615`，调用点在 `:616`）：`ctx.inject(ROUTER_SERVICES, …)` → **构造 `RouterLoop`**（`:591-596`），把第 5 步的记录与第 4 步的诊断出口交给它，并把第 6 步持有者的 `current` 指向**路由器本身**（`:597`——它同时提供 `reportEngine` 与 `selectEngine`）；这一次尝试失败就把 `current` 清回 `undefined`（`:601`）。走 inject gate 是因为它的构造同步触碰 `ctx.agents.setFactory` / `ctx.systemPrompt.variable` / `ctx.sessionProjections.register`（见 §3.2），插件的 `apply` 不能假设这些服务已经就绪。路由器的 effects 属于这个 inject fiber，**卸载插件即拆掉全部引擎**。
   槽位仍被基础 loop 占着时**有界重试**（常量 `:299-300`，判定与重挂 `:605-609`，语义与测试见 §3.8）：受管理块是插件在本次 `apply()` 里才写下的，要到**下一次** composition 才被读到，所以全新安装的第一次启动里基础 `agent-loop` 行还在，`agentLoop` 这个名字也还被它占着——路由器注册的正是这个名字，于是撞出来的是 duplicate service、而不是 factory 错误。判定条件是结构性的（`ctx.get('agentLoop') !== undefined`）；**其他**失败不重试，只 loud 记一条 error，插件其余部分继续活着。每次重试都换一个**新的 inject fiber**（`:607-609`）：失败那次的构造已经占住了 `agentLoop` 名字并挂上了自己的 effects，复用同一个 fiber 只会一直撞自己。窗口（40 × 50ms）耗尽同样 loud 报错。
   插件的 `inject` 本身是空数组（`src/index.ts:89`），可选宿主服务一律 `ctx.get` 惰性读取。
8. `mountEngineRemote()`（`:638-646`）：构造本插件自己的 Remote（实现 `src/engine-remote.ts`），把**两个**端点一起注册——`loopEngine/engine`（报一条会话**实际**跑哪个引擎，外加它记下但还没采用的引擎）与 `loopEngine/select`（把一条会话换到另一个引擎），并把后备读 `engineOfSession(ctx, sessionId, engineRecords)`（`:641`）与第 6 步的持有者交给它（§4.6）。无条件注册：`TypertRemoteService` 只是注册一个带可见 `typertRemote` 绑定的 Cordis 服务，网关是在**调用时**才反射发现的，所以没有网关的 profile 一点代价都不付，卸载插件即随 fiber 撤下。
9. `mountProviderRoutes()`：把唯一的共享 provider 标签（`external`）注册为占位路由（见 §3.6）。
10. `authorEnginePresets()`：把四个寄宿引擎的 preset 写进用户 preset 根（`:649`，实现 `:435-454`，见 §3.5）。启动时就写而不是等第一次选中：插件在整个生命周期里持有槽位，任何会话随时可能要求任何引擎，而 roster 是从**磁盘**读 preset 的（`USER_PRESET_DIR` 的镜像常量在 `src/preset.ts:49-50`）。
11. 注册清理 effect：置位 `disposed`、清掉各重试 timer、回收 provider 路由（`:650-657`）。
12. `ctx.inject(['settings'], …)` 关掉自动生成的设置页（`settings.configure({ auto: false }, ctx.fiber)`），并注册 `ctx.on('settings/document-updated', …)` 监听；boot 时以 `legacyEngine ?? config.engine.get()` 做首次 roster steering。引擎与 composer 开关是插件**自己条目**的两个 `.volatile()` Config 字段（见 §4.1、§4.2）。

注意第 3 步之后**文件不再参与任何决策**：磁盘上的块是常量，`apply()` 不再从它读"当前引擎"。这是与旧模型最大的结构差异——不再有"持久平面与运行时平面必须一致"的对偶。

### 3.2 为什么 `RouterLoop` 继承 `AgentLoop`

`RouterLoop extends AgentLoop`（`src/router-loop.ts`，`AgentLoop` 是主仓 `@deepseek-ai/dsh-agent-loop` 的默认导出），构造时 `super(ctx, { agents: [], maxParallelToolCalls: { get: () => DEFAULT_MAX_PARALLEL_TOOL_CALLS } })`——`0.1.7-rc.1` 起该字段是必填的 `Volatile<number>`，而 `super()` 绕过 schema transform，所以路由器自己提供引用（钉在 harness 默认值上）。继承而不是自己实现 `AgentFactory`，是为了**原样拿到 in-process 的全套语义**：

| 被继承的东西 | 出处 |
|---|---|
| `turnBoundary` 投影（路由器与主仓 preset 切换都读它，见 §3.7） | 主仓 `packages/core/agent-loop/src/index.ts:416`，定义 `:56-94` |
| 三个 prompt 变量 `provider` / `model` / `cwd` | 主仓 `packages/core/agent-loop/src/index.ts:421-423` |
| `agent-loop` settings 段（`maxParallelToolCalls`） | 主仓 `packages/core/agent-loop/src/index.ts:401`，namespace 常量 `:300` |
| 工厂槽位注册（`ctx.agents.setFactory`） | 主仓 `packages/core/agent-loop/src/index.ts:420` |
| in-process 的 create/resume 全文 | `src/router-loop.ts:289`、`:323` 的 `super.…` 调用 |

自己写一个"普通" factory 的话，这几样都得复制一遍，in-process 会话就会跑在一个与部署自带 loop 细节不同的实现上。继承让 router 只覆写两个入口点：`createAgent`（`src/router-loop.ts:284-292`）与 `resume`（`:316-324`），其余全部是主仓语义。两个入口都是**先读插件自己的记录**、再谈 preset（§3.3）。

代价与边界：

- 主仓 `agent-loop` 行的 `agents:` / `maxParallelToolCalls` **config** 随该行一起被禁用，路由器按 `{ agents: [] }` 构造（`:197`）——见 §7。
- 引擎运行时是**普通类**，不是 cordis Service：`HostedEngineRuntime<TConfig, TAgent>`（`src/driver-core/hosted-engine-runtime.ts:132`，旧名 `HostedLoopFactory` 已不存在）实现 `AgentFactory` 的 create/resume 事务机制，但**不注册工厂、不注册投影、不注册 prompt 变量**。它仍在构造时 `ctx.reflect.provide(label, this)`（`:155`），所以 `ctx.agentLoopKimi` / `agentLoopCodex` / `agentLoopPi` / `agentLoopClaudeCode` 依旧可用（标签常量 `KIMI_ENGINE_LABEL`，`src/engine-kimi/loop.ts:58`，其余三个引擎同款），但那只是自省面，不是槽位。
- 引擎运行时按**首次使用**构造并记忆化：`runtimeOf(engine)`（`src/router-loop.ts:226-232`），构造器由 `src/index.ts:549-560` 的 `buildEngine` 提供（把 composition 条目的旋钮转发给对应引擎）。四个引擎并发服务不同会话靠的正是这一点：agent、子进程、scope 都是按会话的，每个 runtime 只持有自己的 live agent。

`RouterLoop` 内部状态只有两个 Map（`src/router-loop.ts:175-176`）：`engines`（引擎 id → runtime）与 `live`（sessionId → `LiveSession`，`:153-165`：`{ engine, agent, dispose, handover?, recipe }`）。`recipe`（`:131-140`）是"这条会话的 agent 是怎么建起来的"——`ownerCtx` / `agentOptions` / `setup` / `parentAgent`，原地换手时原样重放给继任者；`handover`（`:146-151`，只有托管引擎有）是"怎么把会话交出去"——`lifetime` + `retire`，来自 `HostedAgentHandle`（`src/driver-core/hosted-engine-runtime.ts:81-92`）。`adopt()` 每次发布后记账（`:245-264`），包一层 `dispose` 以便**先 forget 再释放**，保证陈旧句柄永远不会去拆掉重建后的 agent（`:257-263`、`:267-269`）。

### 3.3 引擎判定：唯一读取点与优先级

一条会话跑哪个引擎由**插件自己**回答，判定顺序只有一个：`engineOfSession(ctx, sessionId, records)`（`src/engine-of-session.ts:77-91`）。它读两条事实，先到先得：

| 优先级 | 事实 | 载体 | 什么时候是它 |
|---|---|---|---|
| 1 | 插件自己的逐会话记录 | `$DSH_HOME/.loop-engine/engines.json`（§3.9） | 这条会话被换过引擎——无论空白期还是跑起来之后 |
| 2 | 落盘的 `agentPreset` 投影 | harness 的 `agentPreset` 投影（会话 header 折上每一条已提交的 `agent-preset/selected`） | 这条会话**没有插件记录**——所有老会话、所有从没换过引擎的会话 |

- 命中 1 时**连日志都不看**（`src/engine-of-session.ts:82-83`）：记录就是答案，所以持久化不可用时会话的引擎照样答得出来。
- 命中 2 时才走 `ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })`（`:86`）——harness 自己在选择要挂哪份 composition 之前读的也是这条缝（主仓 `packages/api/session-controller/src/agent.ts`）。那是一次**只读租约**：`using` 立即释放、不取写句柄、不占写锁。deployment 没有组合 `sessionQuery` 时答 `unset`、路由落 in-process（`src/engine-of-session.ts:84-85`）。
- 会话 header 记的是**创建时**的 preset，不是后来换过的那个，所以它单独从来不能回答"这条会话跑什么"；`ResumeAgentOptions` 也没有任何元数据（主仓 `packages/core/agent/src/index.ts:125-144`）。

**这是唯一的读取点**：路由器（`createAgent` 的父继承与 `resume`）与插件自己的 Remote（§4.6）调用的都是这个函数，所以"这条会话被哪个引擎驱动"与"这条会话被显示成跑哪个引擎"在构造上不可能不一致——它们是同一个返回值。

**报告在它之上多一层「活 agent」**（`engineReportOfSession`，`src/engine-of-session.ts:128-141`）：一条**有活 agent** 的会话，它的引擎是路由器自己账上的那个（`RouterLoop.live`），因为那才是"此刻真正在跑什么"；记录只在这条会话**没有**活 agent 时充当"它跑什么"的答案，而且**永远不会**在这条会话有活 agent 且记录不同的时候被当成 `engine`——那种情况下记录以 `pending` 单独返回（形状 `SessionEngineReport`，`src/agent-preset-ids.ts:158-168`；§4.6 与 `docs/per-session-engine.md` §1.3 讲用户可见的一面）。有活 agent 时这条路**不读日志**（记录已经够回答那个字段，`src/engine-of-session.ts:137-140`）。这个组合在正常路径上不再出现（原地换手让两者一起变、释放之后没有活 agent），只剩"释放没成功"这一种来源。

**preset 只在没有记录时说话**，映射仍是纯函数，定义在零导入的 `src/agent-preset-ids.ts`（node 侧与浏览器侧共用，理由 §4.1）：

| preset id | 引擎 |
|---|---|
| `loop-engine-codex` | codex |
| `loop-engine-kimi` | kimi |
| `loop-engine-claude-code` | claude-code |
| `loop-engine-pi` | pi |
| `loop-engine`（旧版单 preset id，只出现在旧会话里） | in-process（`super`，见下） |
| 其他（含部署自有的 `standard`） | in-process（`super`） |

- `enginePresetId(engine)`：in-process → `standard`（本插件不为 harness loop 造 preset），其余 → `loop-engine-<engine>`（`src/agent-preset-ids.ts:97-98`）。
- `engineOfPreset(presetId)`：只有本插件 own 的 id 才返回引擎，任何部署作者的 preset（含 `standard`）返回 `undefined`（`src/agent-preset-ids.ts:119-125`）。
- `HOSTED_PRESET_PREFIX`（`:41`）与 `HOSTED_PRESET_IDS`（`src/preset.ts:59-60`）是这两条规则的常量面；单一 id 的 `HOSTED_PRESET_ID` 已不存在（每个引擎一份 preset，见 §3.5）。客户端读**同一个函数**（`sessionEngineOf`，`src/agent-preset-ids.ts:297`）来回答"这条会话在跑什么"（§4.3）。
- `LEGACY_HOSTED_PRESET_ID = 'loop-engine'`（`src/agent-preset-ids.ts:88`）是**只读的历史**，不是路由输入：旧版本给所有托管引擎共用这一个 preset，所以它既不是本插件的一个引擎 id（`engineOfPreset` 读作 `undefined`，路由按 in-process 跑），也没法说出当时用的是哪个引擎。因此路由表里它落在 in-process 一行，而浏览器侧单独把它标成"旧版托管引擎"（§4.3）——两边都对，说的是两件事。

**两个入口的 precedence**（这正是"路由与 Remote 报同一个答案"的落脚点）：

- `createAgent`（`src/router-loop.ts:284-292`）：**先读记录**（`this.records.engineOf(options.sessionId)`，`:286`），只有没有记录时才看调用方带来的 `meta.agentPreset` 与父继承（`:287`）。docstring 里写明了理由：已有记录的会话必须按记录里的引擎构建，否则路由与 Remote 会对同一条会话给出不同的答案。
- `resume`（`:303-314`）：读 `engineOfSession`（`:305-307`），没有则按父继承（`:308`）。这是"关掉浏览器明天再来"不会把引擎悄悄变回 in-process 的原因。
- 父继承本身在 `engineFor`（`:206-217`）：preset 不属于本插件、且有活父 agent 时，读父会话的 `engineOfSession` 来**继承**引擎（`:212-215`），这样被委派的子会话不会悄悄换引擎；都没有 → `in-process`。
- `createAgent` 只拿到 `CreateAgentOptions`，其中唯一"每会话一条"且会到达工厂的字段就是 `meta.agentPreset`（主仓 `packages/core/agent/src/index.ts:84`）；它由 API Session 的 `composeAgent` 解析后填入（主仓 `packages/api/session-controller/src/agent.ts:374-390`，写入点 `:484`）。这是 preset 仍然决定引擎的**唯一**路径：新会话（还没有插件记录）。

### 3.4 命令/技能面按 agent scope 隔离

"引擎自己拥有会话的命令菜单与技能目录"这件事，现在是**在 agent 创建时按 agent 注册**的：`registerEngineSurface(agent, engine, warn)`（`src/engine-surface.ts:77-97`），由 `RouterLoop.adopt` 对寄宿引擎调用（`src/router-loop.ts:246`，in-process 不调）。

关键在于**用 `agent.ctx` 注册就足够了**：

- `commands.register` 与 `skills.registerProvider` 把条目写进**调用方 context 所在 scope 的 layer**（主仓 `packages/interaction/commands/src/index.ts:280-287`、`packages/skill/skill/src/index.ts:392-424`，两者都走 `layers.effect(this.ctx, …)`）。
- 服务方法里的 `this.ctx` 并不是服务自己的 ctx，而是**访问方 context**：cordis 的 tracker/shadow 机制会把服务实例的 `ctx` 属性重绑到读取它的那个 context（`vendor/cordis/src/utils.ts:183-211` 的 `createShadow`）。所以 `agent.ctx.commands.register(…)` 落进的就是 **agent 的 scope**。
- layer 键来自 `scopeOf(ctx)`（`packages/core/scope/src/store.ts:226-232`），而 agent 的 scope key 就是 agent 自己：`createScope(loopCtx, this)`（主仓 `packages/core/agent-loop/src/agent.ts:104`；寄宿驱动同理，如 `src/engine-kimi/agent.ts:156-157`）。

结论：两个会话各跑不同引擎时**互不可见**，整套 surface 随 agent scope 回收——不需要插件侧的注销记账，也不存在"引擎切换后残留菜单"的泄漏路径。

各引擎贡献的面（`SURFACES`，`src/engine-surface.ts:47-62`）：

| 引擎 | 斜杠命令 | 技能 Provider |
|---|---|---|
| claude-code | 内置 4 条 + 发现 `~/.claude/commands/*.md`（`src/engine-surface.ts:49`，handler `src/commands.ts:72-79`，发现函数 `src/commands.ts:103`） | `ClaudeCodeSkillProvider`（`src/skills.ts:215-216`） |
| codex | 无 | `CodexSkillProvider`（`src/engine-codex/skills.ts:46`） |
| pi | 无 | `PiSkillProvider`（`src/engine-pi/skills.ts:83`） |
| kimi | `KIMI_COMMANDS`（`src/engine-kimi/commands.ts:60`，handler `:44`） | `KimiSkillProvider`（`src/engine-kimi/skills.ts:84`） |

几条不变的语义：

- **命令的 handler 是转发**：dsh 的 `commands` 运行时会在本地消费已注册命令（不会到达模型），而真正展开命令的是引擎自己的 CLI/ACP 面，所以 handler 把原始 `/name args` 行作为普通用户消息回投给接收 agent（`src/commands.ts:72-79`）。注册的意义是让命令出现在 web 斜杠菜单里。转发只解决"行回到 agent"；真正让它生效的是驱动侧的裸命令行步（`engineSlashPrompt`，`src/driver-core/prompt.ts:122`）。
- **命令清单按懒求值**：claude 的 `discoverUserSlashCommands()` 每次调用都重新扫 `~/.claude/commands/`，所以会话中途新增的文件会落进该引擎下一次构建的 agent（`src/engine-surface.ts:41-46`）。项目级 `.claude/commands/` 有意不注册——它按 cwd 生效，注册进 agent scope 也会跨项目冲突（`src/commands.ts:16-17`）。
- **撞名时 warn 跳过而不是让 agent 起不来**（`src/engine-surface.ts:88-90`）：引擎自己会展开裸 `/name` 行，菜单少一条好过 agent 拒绝启动。
- **命名禁区**：宿主命令与 client 侧贡献撞名会让 `ui-commands` 把整个 command 菜单源判死（主仓 `packages/client/ui-commands/src/client/service.ts:214-215` 抛错），表现是斜杠菜单全消失、只剩技能。Kimi 的 `/model` 因此刻意不桥接（`src/engine-kimi/commands.ts:21-24`）。
- 技能 provider 的具体扫描根与文件格式，见各 `engine-*.md`；`src/skills.ts` 还内嵌一个 YAML frontmatter 子集解析器（Claude 的 SKILL.md 大量用折叠 `description`），类型全是本地镜像，刻意不对 `dsh-skill` / `dsh-commands` 增加 peer 依赖。

### 3.5 每引擎一份 preset 与 roster 默认值 steering

preset 现在只承担一件事：**agent-plane 组合**——剥掉 dsh 原生命令/技能行（这些面交给引擎），并且只在**没有插件记录的会话**上决定引擎（§3.3）。运行中的会话换引擎不经过它（§3.7）。

`ensureEnginePresets(dshHome, source)`（`src/preset.ts:200-210`）为四个引擎各写一份 `$DSH_HOME/.agent-presets/loop-engine-<engine>/`（`USER_PRESET_DIR` = `.agent-presets`，`src/preset.ts:50`）：

- `agent.cordis.yml` = roster 的 `standard` 组合（经 `agentPresets.read`，`:201`）剥掉 `STRIPPED_ROWS` 后加 managed header（header 常量 `src/preset.ts:82-86`，组装 `:202`）。剥离的行是 `skill-filesystem`、`tool-skill`、`tool-goal`、`command-goal`、`planning`、`compaction`（`:79`，理由注释 `:63-78`）：这些行在引擎接管下只会重复或误导——dsh `/plan` 是外部引擎从不组装的一段提示文本，dsh `/compact` 缩不了引擎子进程里的上下文，dsh 技能会与引擎自己的目录并排；而 `command-goal` 必须在**这里**剥，因为 dsh 的人类 `/goal` 命令正是由 preset 层那一行注册的（`standard` 自带 `command-goal`，见 §2.1），profile patch 里禁 host 面那一行到不了托管会话。`stripPresetRows` 是纯行变换：按列 0 的 `- id:` 切顶层行，连同该行的节注释一起删，其余字节逐一保留；行首不是 `- id:` 的条目保守保留（`:123-169`）。
- `preset.yml` 是人读元数据：`Claude Code` / `Codex` / `Pi` / `Kimi Code`（文本 `src/preset.ts:89-92`，名字表 `:95-100`，写盘 `:207`）。这些名字就是 harness 会话头 preset 标签显示的文字（主仓 `packages/client/ui-agent-preset/src/client/AgentPresetLabel.tsx:46-62`）。**注意它显示的是 preset，不是引擎**：换过引擎的会话，preset 仍然是创建时那一份（§7）。
- **每次启动都从当时的 `standard` 重新生成**：磁盘文本永远不是权威，harness 升级改了 `standard` 就自然流过；`writeIfDifferent`（`src/preset.ts:171-183`）让内容一致的目录不动盘，避免 standing mount 的 file-stamp 被骗。

**默认引擎 = roster 的默认 preset**。`steerPresetDefault(engine)`（`src/index.ts:496-520`）把 `agent-presets` settings 命名空间的 `default` 字段指向 `enginePresetId(engine)`：

- 用 settings 层（`settings.mutate(ns, [op])`，`:472`，经 `mutatePresetDefault` `:457-483`）而不是 patch `agent-presets` 行的 config：patch 的 config 覆盖是**整体替换**语义，会顺带抹掉部署方在同行配置的 `roots`；settings 层天然叠在 config 之上、可 unset 还原。
- roster 的 `defaultId` 是**每次调用现读**（主仓 `packages/preset/agent-presets/src/index.ts:240-242`），所以改默认只影响之后新建的会话，正在跑的会话保持自己 join 的 preset。
- `in-process` 把被替换的部署默认值 set 回去（`savedPresetDefault`，声明 `src/index.ts:486`，还原 `:498-504`）；只有在当前默认不是本插件的 id 时才记下来（`:517`），所以托管引擎之间互切不会用受管 id 覆盖部署值。
- **authoring 失败就不导默认值**：preset 不在磁盘上时把默认指过去会让每个新会话 loud 失败，所以 steering 等 `settled` 成功（`:508-511`）。记忆化与重试见 §3.8。

### 3.6 provider 路由占位：一条共享的 external 标签

四个寄宿引擎都把**同一个** provider 标签写进会话的 `request/header`。宿主侧从**最新一条 header** 推导会话的模型选择（主仓 `packages/api/session-controller/src/agent.ts:290`），并在 `session.prompt` 起点拒绝"没有任何 adapter 服务的 provider"（主仓 `packages/api/session-controller/src/commands.ts:323-328`，判定 `routeServed` 在 `:653-655`，读 `ctx.llm.listProviders()`）。两个事实叠加：首轮 prompt 时空会话回落到部署默认模型（有 adapter，放行）并落一条 header；**第二轮**读到的会话选择就变成了引擎自己的标签——必被拒（`session/model-unavailable`）。这就是"第一次对话正常、第二次报错"的根因。

插件的应对是注册**一条**共享占位路由（`HOSTED_ROUTE_LABEL = 'external'`，`src/agent-preset-ids.ts`；`mountProviderRoutes`，`src/index.ts`）。**为什么不是四个**：浏览器模型目录是整个 Host **代际**共享、不按会话区分的事实（主仓 `packages/api/session-controller/src/catalog.ts:16` "Build the browser model catalog without requiring a Session"，函数体 `:17-46` 遍历 `ctx.llm.listProviders()`），所以任何一条会话的菜单都能一次列出全部 provider 组——四个引擎各占一个标签时用户会看到**四条一模一样的 `default`**。折叠成一条后，托管引擎在菜单里只占**一个**分组。

- **一条路由，广告恰好一条目录条目**：`HostedEngineRouteAdapter.listModels`（`src/provider-route.ts`）返回 `[{ provider: 'external', id: 'default', name: 'default' }]`，`default` 就是 `HOSTED_DEFAULT_MODEL`（`src/agent-preset-ids.ts`）——**也是四个驱动写进 `request/header` 的模型标签**（各自的 `PROVIDER` 常量都等于 `HOSTED_ROUTE_LABEL`，如 `src/engine-claude/agent.ts:61`、`src/engine-codex/agent.ts:70`、`src/engine-kimi/agent.ts:69`、`src/engine-pi/agent.ts:57`；claude 那条 reasoning-only 兜底消息同值）。id 与标签必须**逐字相同**：选择器拿目录条目的 `model.id` 与宿主推导出的 `(provider, model)` 比对（主仓 `packages/client/ui-model-selection/src/client/ModelSelect.tsx` 的 `choices`/`selectedIndex`），不一致就回落渲染 `${provider}/${model}` 原样串——用户看到的"不存在的模型" `kimi/kimi-native` 就是这么来的。id 对齐之后，模型座显示引擎自己的词 **`default`**，那一条也是菜单里高亮的那一条。
- **id 与显示名是同一个 ASCII 串 `external`**：`external` 会写进每条会话的 `request/header`、进选择、参与比较，并且 `providerInfo().id` 必须等于注册时的 provider（主仓 `packages/llm/llm/src/index.ts:431-434` 的结构校验），所以用 ASCII。显示名走 `providerInfo().name`（主仓 `:206-208`），被折进目录的 `group.name`（主仓 `packages/api/session-controller/src/catalog.ts` `group: { id: provider.id, name: provider.name, ... }`）——picker 原样渲染、**没有 i18n 钩子**，所以每个语言看到的都是同一个固定串，这里就取与 id 相同的 `external`，不给它再起一个会随语言漂移的名字。模型条目的 `LlmModelInfo.name` 同样如此，固定为 `default`，含义由插件自己的界面文案解释（§4.5 / `src/client/locales.ts:115`）。
- **旧标签仍被"认出是托管路由"**：`isHostedProviderRoute`（`src/provider-route.ts`）的判据是"本插件服务过的标签"，包含当前注册的 `external` **与**早期逐引擎写下的四个标签（`claude-code` / `codex` / `pi` / `kimi`）。注册的只有 `external` 一条；旧四家只是为了判定与重置而保留——一条 header 仍是 `kimi/default` 的老会话，切回 `in-process` 时必须能被 `ModelSelectionReset` 重置成部署默认，否则 `kimi` 现在没有任何 adapter 服务，宿主 `routeServed` 会直接拒掉那一轮（`model-unavailable`）。
- `stream` 被调到即 loud 抛 `HOSTED_ENGINE_ROUTE`：寄宿引擎的模型来自引擎自己的原生配置、或这条会话交给它的那个 dsh 模型（连同端点与凭据，见下一条），**不是**这个路由，真有查询路由到这里就是接线 bug。
- **会话选的真实 dsh 模型会被连同它的端点与凭据一起交给引擎**（0.1.5-rc5 起）：四个驱动的每一个 step 都重读这条会话当前的选择（`sessionModelOverrideOf`，`src/driver-core/session-model.ts`：宿主读法——投影 `modelSelection.pending` 优先，否则最新 `request/header` 的 config——套一个判据 `sessionModelOverride`），选择指着一条**真实 dsh 模型**（provider 既不是注册的 `external`，也不是旧四家 `kimi` / `claude-code` / `codex` / `pi`）时，再把这条模型的**端点 / 协议 / 凭据**解析出来并注入引擎入口（`resolveModelHandover`，`src/driver-core/model-handover.ts`）。**解析规则**：provider → 设置地址的映射**取自 llm 注册表自己的"可配置 provider 目录"**（`ctx.llm.listConfigurableProviders()`，主仓 `packages/llm/llm/src/types.ts` 的 `LlmConfigurableProvider`：`llm-pi-ai` 把一条路由映射到 `['providers', 路由名]`，`llm-deepseek` 把唯一一条路由映射到整个 `llm-deepseek` 段），不是本插件硬编的 namespace；从那个段里读 `baseURL` / `api` / `apiKeyEnv`（`settings.get` 会套 schema 默认值，所以只写 `models`/`baseURL` 的 `llm-deepseek` 段仍能读出 `apiKeyEnv` 的默认值），凭据走 `ctx.credentials.resolve(apiKeyEnv)`（key 的值不在 process.env 里，主仓 `packages/bundle/base/cordis.patch.yml`:83-93），seam 缺席才回落 `process.env[apiKeyEnv]`。**读的是别的插件的私有段**，所以全程防御式：形状不符一律**不注入**、只 warn 一次（不抛、不猜一个端点）——但**准入只看 `baseURL` 与凭据**：`api` 缺失**不是**拒绝理由（拒绝会让引擎拿 dsh 的模型名去打**它自己**的端点，那是个像鉴权问题的假象，真机实例见 `docs/optimization-backlog.md` BL-19），此时 `DshModelHandover.api` 为 `undefined`、由各引擎自己降级；对 adapter 自己拥有 wire 的 shipped 路由用一行表补协议（`shipped` 表 `SHIPPED_ROUTE_APIS`：`deepseek-official → openai-completions`，依据是该 adapter 自己就 POST `{baseURL}/chat/completions`），profile 写了 `api` 则以它为准。**逐引擎入口**：pi 的自建 agent 目录（`PI_CODING_AGENT_DIR` + `models.json` + `--provider` / `--model` / `--api-key`）、claude-code 的 `Options.env`（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`）+ `Options.model`、codex 的 `codex app-server -c model_provider=… -c model_providers.…={name,base_url,wire_api,env_key}` + env（端点变了就重启 app-server）、kimi 的子进程 env `KIMI_MODEL_*`。**协议按 dsh 的 `api` 翻译**（`anthropic-messages` / `openai-completions` / `openai-responses` → 各引擎自己的词）；引擎不支持那个协议时不假装支持——codex 无等价 `wire_api` 时用它自己的默认 wire 去请求并**报错**，kimi 无等价 provider type 时省略该变量、退回默认并**报错**，pi 则因它自己的 provider 声明要求 `api` 存在而不接收这样的 handover。**能不能用取决于引擎**，错误由引擎抛出，插件不吞。选择是 `external/default`（菜单里那条 `default`，即"交回引擎自己决定"）或日志里没有任何选择时，**端点与凭据都不注入、一个模型参数也不下发**，用引擎原生默认或部署 composition 里钉住的 `config.model`（**会话选择优先，pin 只是回落**）；选了真实模型但**端点或凭据解析不到**时同样不注入（只 warn 一次），模型名照旧下发。粒度是**每个驱动 step**（一次 query / 一个新 thread / 一次 `session/new`），所以会话中途换模型、换 provider 下一步生效。凭据只进子进程 env / pi 自建 `0600` 目录 / argv，**不进会话日志、不进 `request/header`、不进任何 warn**——把 key 放进子进程 env 是"让这台机器上的第三方 CLI 用 dsh 端点"的固有代价，该 CLI 进程能看到它。
- **冲突识别结构性优先**：部署方自己的 adapter 已占 `external` 时，llm registry 抛 `LlmError`，code 为 `DUPLICATE_ADAPTER`（主仓 `packages/llm/llm/src/index.ts`），据此 warn 跳过且不回收别人的路由；`already registered` 的消息匹配只是无 code registry 的兜底（`src/index.ts` `mountProviderRoutes`）。
- **生命周期跟随插件而不是引擎**：注册在 `mountProviderRoutes`，回收在 `releaseRoutes`（`:385-390`，由清理 effect 调用 `:643-650`）。
- ⚠️ 0.1.5 的 `routeServed` 无条件读 `ctx.llm.listProviders()`：完全没有 llm 服务的极简 composition 也谈不上"拒绝"，因此注册是 best-effort，llm 缺席时只做有界重试（§3.8）。
- **标签只是补偿，座位由插件跟着引擎写**：占位路由让宿主**不拒绝**这些标签，但它并不是一个模型端点——真有请求路由过来就 loud 抛 `HOSTED_ENGINE_ROUTE`；而一条曾经跑过托管引擎的会话，它的模型选择**就是**引擎标签（宿主的 `selectionFor` 取最新 `request/header` 的 config）。所以插件把这条**座位**写进日志，两个时刻都追加 harness 自己的 `model/selection` 事件（`ModelSelectionReset`，`src/model-selection-reset.ts`）：**换引擎时**（`resetFor`，`:171-174`）与**正在被构建时**（`guardFor`，`:191-193`，经 `src/router-loop.ts:355-378` 包裹的 `setup`，在宿主装选择之前落盘）。写什么由**目标引擎**定：托管引擎就是共享的 `external/default`（= 它自己写进 header 的那个词，`HOSTED_DEFAULT_MODEL`），harness loop 就是 `ctx.agentDefaultModel.currentSelection()`——宿主给新会话用的就是它（主仓 `packages/core/agent-default-model/src/index.ts:90-92`，消费点 `packages/api/session-controller/src/agent.ts:490-493`）。事件的形状与宿主自己的模型选择器写下的完全一致（声明 `packages/api/session-controller/src/types.ts:34-42` 与 `:86-90`，折进 `packages/api/session-controller/src/model-selection-projection.ts:39-43` 的那一格），所以宿主下一次为这条会话装选择时读到的就是它。会话日志里已经是一条**真实 dsh 模型**时（provider 不是托管路由标签——既不是 `external` 也不是旧四家）一条都不写——那是用户的显式选择；换引擎而日志里一条选择都没有时也不写（没有座位可改写）。默认值本身**就是**托管标签时（模型菜单把选中的 `default` 存成了部署默认，见 `docs/per-session-engine.md` §5.2）它不写这个值，改取部署 composition 自己声明的默认模型（`configuredDefault`，`:347-354`，读 settings 描述符的 `base` 层）并如实报一次 warn。触发点、三条判据见 §3.7，用户可见语义见 `docs/per-session-engine.md` §5.2。

### 3.7 会话中途换引擎：原地换手、延后生效、以及剩下的 release

"引擎在会话创建/空白期确定，之后锁定"这条旧边界已经不存在。搬动一条会话的入口是插件自己的 Remote 端点 `loopEngine/select`（§4.6），它把请求交给 `RouterLoop.selectEngine(sessionId, engine)`（`src/router-loop.ts:430-468`）。这正是 preset 通道**表达不了**的那一半——harness 自己的 `AgentPresets.select` → `swap()` 在会话开始后直接拒绝（主仓 `packages/preset/agent-presets/src/index.ts:709-726`，判定 `:713-721`，见 §7）。

**0.1.5-rc3 起，换引擎不再拆会话——涉及 in-process 时改为"释放 + 页面重载"。** 一条会话与另一个**托管**引擎之间是**原地换手**：`Session` 对象、store 条目、写句柄全部保留，只有 agent 被换掉。与 in-process 之间的两个方向做不到原地换手（harness 的硬边界，取证见 `docs/per-session-engine.md` §5.4），所以走另一条路：**写记录 → 模型座位跟着换 → 释放这条会话的 agent（会话变冷）→ 回包 `reload: true` → 客户端重载页面并自动回到这条会话 → 宿主按记录构建它**。**进程不重启**，而"释放"这件事之所以现在可以做，正是因为紧接着的那次重载会清掉 `session/disposed` 在客户端留下的状态（`api-session/removed` → 会话行被删、当前会话清空、`removed` 标记无复位路径；完整链路见 `docs/per-session-engine.md` §5.2/§5.4）。**客户端在发这一类的请求之前会先弹确认框**（它自己就能判出哪些切换会重载：目标引擎与报告里的实际引擎恰好一边是 `in-process`，`switchNeedsReload`，`src/client/session-engine.ts:250-253`），托管引擎之间不弹（§4.4）。

`selectEngine` 的骨架 = 一张拒绝清单 + 一次记账 + 一次模型座位写入 + 一次接管。**拒绝一律是数据**，由 `refuse(code, reason)` 造（`:713-715`）——一个**原因码**加一句宿主自己的英文原话，不是抛出的错误，因为每一种都是可预期的会话状态。码的枚举在 `src/agent-preset-ids.ts:198-223`（`LoopEngineRefusalCode`），客户端按码给本地化文案、把原话留作详情（`docs/per-session-engine.md` §4.2/§5.3）：

| 拒绝 | code | 判定点 | 原文（`reason`） |
|---|---|---|---|
| 会话没打开（没有活 agent） | `session-closed` | `:431-434` | `session "…" is not open; open it first, then switch its engine` |
| 有回合在飞 | `turn-running` | `:438-440` | `session "…" is running; switch its engine after this turn ends` |
| subagent 会话 | `subagent-session` | `:443-445` | `session "…" is a subagent session; its agent belongs to subagent routing` |
| 路由器没有它的活记录 | `not-driven` | `:446-452` | `session "…" is not driven by this plugin's loop router` |
| 记录写不进去 | `record-failed` | `:453-457` | `could not record the engine of session "…": <原始错误>` |
| 旧机器退场了、继任者没建起来 | `rebuild-failed` | `:555-569`（`hotSwap` 的 catch） | `could not rebuild session "…" on <引擎>: <原始错误>` |

- **有回合在飞就不换**：一个回合的输出属于产生它的那个引擎，引擎子进程持有的上下文也不是插件能在回合中途交接的，所以这里不做抢占（`:435-437` 的注释就是这条）。原地换手沿用同一条门——这也正是"旧机器必须先完全退场再发布继任者"的前提：退场时要 `cancel({kind:'disposed'})` + `whenIdle()`，一个跑着回合的机器会在那里被中断。
- **subagent 会话不换**：它的 agent 属于创建它的那次委派，在这里丢掉会把父会话的子任务晾在中间（`:441-445`）。
- **"路由器没有它的活记录"是重试窗口**：基础 loop 还占着槽位、插件的路由器还在重试挂载时，agent 存在，但它不是路由器能重建的那个（§3.1 第 7 步）。**`router-unmounted`**（`src/engine-remote.ts:246-252`）是它在端点上的兄弟：`loopEngine/select` 在路由器还没挂上时就回这条码，两者对用户是同一件事，所以客户端共用一句文案。
- **`rebuild-failed` 是唯一"半途失败"的码**：记录已经写下、旧机器已经退场，继任者没建起来，于是这条会话被放冷并按记录重建（§3.7 下面那段）；它的文案必须说清这一点，不能只说"失败了"。

通过的路径，顺序是**载荷**（`:452-467`）：

1. **先写记录**（`this.records.record(sessionId, engine)`，`:454`）——记录是路由器、Remote、宿主的下一次 resolve 共同读的那个答案，写不进去就按拒绝回答（`record-failed`），记录与 agent 都保持原样（`:452-456`）；
2. **模型座位跟着换**（`this.moveModelSelection(entry, engine)`，`:465` → `:691-693`）——按**目标引擎**定值：托管引擎写 `<新引擎>/default`，`in-process` 写部署默认；会话日志里已经是**真实 dsh 模型**时不动（那是用户的显式选择），**一条选择都没有**时也不写（`resetFor` 的第一条判据，`src/model-selection-reset.ts:171-173`）。它必须在换手**之前**：宿主读的是日志，而继任者那次构建（原地 swap 的 `setup`、或重载之后那次 resume）紧接着就读它。写入形状、三条判据与跳过条件在 `src/model-selection-reset.ts:143-386`，这一处与下面 preset 那条路径共用同一个方法；
3. **活 agent 的引擎没变就直接返回**（`:466`）——这条比较用的是**活 agent 的引擎**而不是记录：释放失败时记录和活 agent 会不一致（见下），而此时"这条会话跑什么"的答案是活 agent；用记录做这个判断会让"重新选中当前实际运行的引擎"变成一次把同一个 agent 拆掉重建的空转。已经跑在目标引擎上的会话**只记账、不重建**：记录是用户的显式选择，而替换一个没变的 agent 只会让这条会话白白重启一次。**这条也是"撤回一次记录"的实现**：在释放失败留下的那个窗口里选中当前实际运行的引擎，记录就跟着活 agent 改回去；
4. 变了就交给私有 `move`（`:467` → `:504-511`）：**两边都是托管引擎**时走 `hotSwap`（`:535-570`），**任一边是 in-process** 时 `await release(entry)`（`:602-604`）并返回 `{ ok: true, engine, reload: true }`（为什么是"释放 + 重载"见 §3.7 下面）。

#### 原地换手（`hotSwap`）

顺序是硬要求，`src/router-loop.ts:535-570`：

1. **旧机器退场**（`handover.retire()`，`src/driver-core/hosted-engine-runtime.ts:274-279`）：`cancel({kind:'disposed'})` → `whenIdle()` → `scope.dispose()`，然后**只从 `ctx.agents` 摘掉自己**（`:239` 的 `detachAgent?.()`）。
2. **会话的两个资源留在原地**：store 条目与写句柄都在 `SessionLifetime` 里（`src/driver-core/session-lifetime.ts:35-78`），随会话交给继任者；`handedOver` 标志让旧机器的 teardown 跳过 `closeHandle()` 与 `leaveStore()`（`:236`、`:242`），所以**不发出 `session/disposed`**。
3. **继任者就地发布**（`runtime.swap(...)`，`src/driver-core/hosted-engine-runtime.ts:468-483`）：用**同一个 `Session` 对象**构造新 agent、跑调用方给的 composition 回调，然后只做 agent 那一半发布——`publish` 里 `joining = lifetime.entered`（`:294`）为真时不再调 `sessions.enter` / `sessions.announce`（`sessions.enter` 对已活的 id 直接抛 `already exists`，主仓 `packages/core/session/src/index.ts:1033`；`announce` 对已 announce 的 entry 也抛，`:1085-1087`）。
4. 路由器把 `live` 记账换成新 agent（`adopt`，`:245-264`），`live` 条目同时带上**重建配方**（`BuildRecipe`，`:131-140`：`ownerCtx` / `agentOptions` / `setup` / `parentAgent`）与**交接句柄**（`Handover`，`:146-151`：`lifetime` + `retire`），供下一次换手使用。

为什么"先退旧、再上新"：一个 sessionId 只能有一个 agent（`agents.enter` 对重复 id 抛 `already registered`，主仓 `packages/core/agent/src/index.ts:466`），而两个机器同时挂在一个会话上会**互相 splice 同一个收件箱**（各自的 `DriverInbox` 折的是同一条日志的 `agent/inbox/spliced`），所以旧机器必须在任何输入能到达继任者之前完全 settle。

**继任者的 composition 来自调用方**：`BuildRecipe.setup` 是上一次 create/resume 时 API 层交进来的那个 `composeAgent` 回调（安装 model selection + mount agent preset，主仓 `packages/api/session-controller/src/agent.ts:374-390`），换手时原样重放。插件不自己组装 composition——那会把 API 层的策略抄一份在这里并且早晚漂移。传一个**已经存在**的 `Session` 给四个引擎的 agent 是安全的：它们的构造函数只读日志（`DriverInbox` 折 `ownEvents()`、`lastTurn` 折 `turn/start`），不写事件、不注册 session 监听、不碰 `ctx.sessions`、也不需要写句柄（`docs/per-session-engine.md` §5.4）。⚠️ 继任者拿到的 `agentOptions` 也是配方里那一份（`hotSwap` 原样传给 `swap()`）——没有任何引擎读它，真正被宿主读到的座位是第 2 步写进日志的那条。

**换手失败**（`:555-569`）：旧机器已经退场、继任者没发布，这时没有任何东西驱动这条会话。插件把 `SessionLifetime` 释放掉——`closeHandle()`（失败只 warn，`:562-566`）+ `leaveStore()`（`:567`）——会话变回冷会话，下一次打开按记录（就是刚写下的新引擎）重建，返回 `could not rebuild session "…" on <engine>: <原始错误>`。**退场本身失败**（`retire()` 抛）则相反：留在 registry 的摘除是它 teardown 的最后一步，所以机器**已经**不在 `ctx.agents` 里了，插件报一条 warn 后继续换手（`:537-545`）——此时拒绝只会留下一条活着却没人驱动的会话。

#### 与 in-process 之间：释放这条会话 + 让页面重载

`move` 在"任一边是 in-process"时**不换手**，而是**释放**这条会话的 agent（`await release(entry)`，`:504-511` → `:602-604`）并返回 `{ ok: true, engine, reload: true }`。为什么这条路能成立、每一环负责什么：

- **释放就是"把它放冷"**：`entry.dispose()` 走完 `cancel → whenIdle → scope.dispose → handle.close() → detachAgent() → detachSession()`，会话离开 `ctx.sessions`、记录留在侧车里。**记录就是它下一次构建要用的引擎**，所以下一个 resolve 自然落在新引擎上（`:316-324` 的 resume 路径，读记录优先）。
- **`reload: true` 是这条路的关键一半**：`detachSession()` 会发出 `session/disposed`，宿主把它转成 `api-session/removed`，浏览器那半据此删掉会话行、清空当前会话，并在那个 `Session` 实例上写下**没有复位路径**的 `removed` 标记（完整链路与取证见 `docs/per-session-engine.md` §5.2/§5.4）。所以客户端半收到这个标志就：把 id 存进本标签页的 `sessionStorage`（`src/client/reload.ts:95-107`）→ `window.location.reload()`（`src/client/session-engine.ts:799-800`）→ 重载后的页面用这个 id 调 `sessions.open(id)` 回到这条会话（`src/client/reload.ts:164-206`，接线 `src/client/index.ts:91`）。**重载是"清掉被标记的那份页面状态"的最小动作**，宿主重建 agent 靠的是重开之后那次 `resume`，不是重载本身。
- **为什么不能只"释放 + 让用户自己点回来"**：`session/disposed` 之后那个页面上的这条会话是**不可用**的（输入框与模型座被锁），用户点回一条被标记的会话不会恢复它——这正是更早两版把会话弄丢的原因（`docs/per-session-engine.md` §5.4 第一段）。
- **`await` 的含义**：`release` 返回 teardown 的 promise，`move` 等它结束才回包——回包在告诉客户端"这条会话已经是冷的了"，那必须是真话（测试断言 `ctx.agents.get(id)` 在 `select` 返回时已是 `undefined`，`tests/engine-remote.spec.ts`）。teardown 失败只 warn（`:602-604`）并按 `reload: true` 照常回包：记录已经写下，页面重载后宿主的 resolve 会照记录重建。
- **客户端的可见代价**：这一页的临时状态（滚动位置、未提交的草稿）会丢；会话记录一字不少。客户端在重载前弹一句 `switchReloadTitle` / `switchReloadBody`（§4.4、`docs/per-session-engine.md` §5.2「丢了什么」）。

**模型座位与这次释放同时落盘**（0.1.5-rc3 起；0.1.5-rc4 起两个方向都写）：这条会话的模型座位**在切换那一刻就写**——`selectEngine` 写完记录后立刻按**目标引擎**写一条 `model/selection`（`:465` → `:691-693`）。为什么必须是这一刻：宿主读的是日志，而这次换手（原地 swap 的 `setup`，或重载之后那次构建）紧接着就会读它；为什么必须写：进程内的 harness loop 会**真的**调模型，而会话此刻的选择还是引擎标签（§3.6），那个标签只有本插件的占位路由服务、真有请求过来 loud 抛 `HOSTED_ENGINE_ROUTE`——用户实测到的"托管引擎之间怎么切都正常、切回 harness 默认就每轮报错"就是这条。写进去的是宿主自己的事件、读回它的是宿主自己的选择逻辑（`selectionFor` 优先投影的 `pending`，否则取最新 `request/header`），所以下一次构建装出来的 agent 拿到的就是它。
- **写什么由目标引擎定**：托管引擎 → 共享的 `external/default`（§3.6 的那个词）；in-process → 部署默认模型；
- **幂等**：会话当前选择已经是写入值（provider + model 相同）时不追加，反复切同一个引擎不会往日志里堆事件（判据 `src/model-selection-reset.ts`：先读 `sessionProjections` 的 `modelSelection.pending`，没有就读会话自己最新的 `request/header`）。托管引擎之间互切因此通常**不写**第二条座位——四个引擎写的是同一个 `external/default`；
- **真实 dsh 模型不动**：会话当前的选择 provider 不是托管路由标签（`external` 或旧四家）时一条都不写——那是一次显式选择，换引擎没有理由把它删掉（而且它会被四个驱动透传给引擎当模型用，见 §3.6）；
- **日志里一条选择都没有时也不写**：没有座位可改写，会话的第一条座位由"构建时"那条通道负责（`src/model-selection-reset.ts:171-173`）；
- **拿不到默认值就跳过**：composition 里没有 `agentDefaultModel` 服务、或它的 `currentSelection()` 抛错/答不出 provider+model → 只报**一次** warn、不写事件，切换本身照常成功（`src/model-selection-reset.ts:284-297` 的读取与 `:369-376` 的一次性告警）；
- **默认值本身是托管标签时，改取部署 composition 声明的默认模型**：模型菜单把选中的那条 `default` 存成了部署默认（`session.selectModel` → `AgentDefaultModelConfig.saveSelection`，见 `docs/per-session-engine.md` §5.2），拿它去服务进程内会话必炸，所以 `configuredDefault`（`src/model-selection-reset.ts:347-354`）读 settings 描述符的 `base` 层——那是 `packages/bundle/base/cordis.patch.yml` 给 `agent-default-model` 行配的真实模型——写入它并如实报**一次** warn；连 composition 都给不出可用模型时只 warn、不写；
- **同一条语义也走 preset 通道与"构建时"通道**：harness 自己那个"换 preset"路径上，`rebuildOnEngineChange` 在释放 agent 之前做同一件事（`src/router-loop.ts:660`，见下）；而**一条被构建**的会话（`createAgent` 的两个分支 `:289`/`:291`，`resume` 的 in-process 分支 `:323`）走 `guardFor`——路由器的 `engineOptions`（`:355-378`）把 `setup` 包一层，在宿主装选择之前先写（为什么必须在这个时刻，见 `docs/per-session-engine.md` §5.2）。托管引擎那一路同时把 `agentOptions` 换成同一个座位（`engineRouteOptions`，`:708-710`）；in-process 那一路保持调用方给的值，因为对 harness loop 来说那不是座位、**就是**请求路由。

**报告只有一种情况会同时带两个事实**：`RouterLoop.reportEngine(sessionId)`（`:385-392`）在**有活 agent** 且它驱动的引擎与记录不同时，把 `engine`（实际）与 `pending`（记录）分开报——而正常路径上二者不可能不同（原地换手一起改、释放之后没有活 agent，冷会话直接答记录）。它剩下的唯一来源是**释放没成功**（teardown 抛错、或有人手改了侧车文件）：会话仍由旧引擎驱动，chip / composer 写「正在跑的那个 · 切到 X · 尚未接管」（§4.3、§4.6、`docs/per-session-engine.md` §1.3），用户再选一次目标引擎即可重试。这是"显示≠实际"这一族问题的最后一道防线。

**没有 `force` 之类的破坏性选项，也不该有**：破坏性 teardown 就是上面那条 `release`，而它已经由**服务端**在需要时自动执行；给它加一个客户端可选的开关只会多一个"用户点下去，会话被拆"的入口。客户端能做、且现在正在做的就是两件事：**重载页面**与**用 `sessions.open(id)` 重新打开那条会话**（取证：客户端没有 `reopen`/`resync` 这类动作，宿主的 `resolve` 见到活 agent 就直接返回它——所以"重开以应用切换"只有在 agent 真的已经被释放之后才成立，这正是这条路的前提。逐条证据在 `docs/per-session-engine.md` §5.4）。

判据为什么是"任一边是 in-process"而不是"两边都是 in-process"：harness 自带的 loop 在这件事上**两头都做不到**，逐条证据见 `docs/per-session-engine.md` §5.4（`AgentLoop.prepare` 把会话条目与写句柄放在私有闭包里、发布时无条件 `sessions.enter`、`create`/`resume` 都会重新 `sessions.prepare`；`AgentRegistry` 没有公开的按 id 移除；`ReactLoopAgent` 不从包里导出）。**这两个方向想做到原地换手，需要 harness 出一个 seam**，设计记为提案 `docs/proposals/harness-agent-handover.md`。

#### 仍然走 release 的那一条路径

`RouterLoop.release(entry)`（`:602-604`）先 `forget`（`:267-269`——只在 `live` 里那条记录还指向同一个 agent 时才删，所以陈旧的句柄永远不会去拆重建后的 agent），再 fire-and-forget 地 `dispose`，失败经 `pluginWarn` 报出来。它现在只剩一个调用点：harness 自己在**空白会话**上的 preset 切换 `rebuildOnEngineChange`（`:637-663`）监听无 scope 事件 `agent-preset/selected(sessionId, preset)`（`:638`）。该事件类型在 `:84-96` **本地声明**，而不是从 `@deepseek-ai/dsh-agent-presets` 导入：插件消费这个通知，但不对 roster 建立构建期依赖（最小 profile 可能根本不组合它）。事件由 roster 在日志提交点转发（主仓 `packages/preset/agent-presets/src/index.ts:228-230`）。harness 那次切换只是重组合活 agent 的 scope 并把选择记进日志，**不重建 agent**，所以引擎会停在创建时那个；丢掉 agent 让宿主的下一次 resolve 落到 `resume`（主仓 `packages/api/session-controller/src/agent.ts:183-199`），按日志里记录的 preset 用正确的引擎重建。

**为什么它不改成原地换手**：新 agent 要用**新 preset 的** composition，而 composition 只有 API 层的 `composeAgent` 会组装（主仓 `packages/api/session-controller/src/agent.ts:374-390`）；插件手里的 `BuildRecipe.setup` 是"引擎选择器那条路径"的回调（对应会话当前的 preset），拿不到"某个 preset 的回调"。所以这条路径继续"释放 + 下次 resolve 重建"。代价可控：它只对**空白**会话生效（跑过一轮的会话到不了这里，harness 的 roster 会用 `agent-preset/locked` 拒绝，见 §7）。这条差别也写进了用户文档（`docs/per-session-engine.md` §5.1 末条）。

`rebuildOnEngineChange` 的三条判定（`:639-647`）：只处理路由器记账过的会话（`:639-640`）；只在新 preset 映射到**别的**引擎时动手（`:641-642`）；空白判定读 `sessionProjections.stateOf(session, 'turnBoundary')`（结构性类型见 `src/driver-core/host-servers.ts:73-78`），`openTurnStartSeq === null && lastTurn === 0` 算空白、投影 `undefined` 也算空白，**非空白只 warn 不换**（`:643-647`）——与主仓自己的空白判定同一套事实（主仓 `packages/preset/agent-presets/src/index.ts:713-719`）。它紧接着做同一件模型座位的事（`this.moveModelSelection(entry, next)`，`:660` → `:691-693`），而且必须在 `release` **之前**（`:661`）——release 正是把 agent 从这条会话上摘掉的那一步，事件得先落进日志。这与引擎选择器那条是同一个方法，只是入口换成了 preset 通道；引擎选择器那条见 §3.7。

**最后一次用户动作胜出**（`:648-654`）：会话**已有插件记录**时，harness 的选择器也是一次引擎选择，所以记录先跟着新 preset 走，再释放 agent。没有记录就不进记录——只有显式选择才值得记下来，没记录的会话继续按 preset 映射回答。少了这一步，两个入口会互相打脸：选择器按 preset 重建，而下一次 resume 又按记录把它搬回去。

注意 `release` 的前提是记账只由路由器自己写（`adopt`，`:245-264`）：宿主或其他 factory 建的 agent 不在 `live` 里，路由器不会去动它。

### 3.8 幂等与有界重试

挂载期有几条路径都会碰到"对端还没就绪"的时序问题，处理方式统一为**结构性探测优先 + 有界重试 + 幂等**：

- **preset authoring 是记忆化的**：`authoring ??= ensureEnginePresets(...)`（`src/index.ts:438`，声明 `:457`）。两条路径都要 preset——启动时的 authoring 与 steering 路径（`:513`）——让它们各自走一遍同样的 8 个文件会竞争写入：Windows 上落败的 `rename` 报 EPERM，部署默认值就永远没被 steer（回归测试 `tests/index.spec.ts:610-638`，注释 `:634-636`）。失败**不**被当成已完成的记忆值：catch 里把 `authoring` 置回 `undefined` 并记 error（`src/index.ts:438-444`），所以下一次切换会重试 authoring（`tests/index.spec.ts:656-685`）。
- **roster settings namespace 的 attach 竞争**：settings provider 能枚举 namespace 时，先 `describe()` 判断 roster 的 `agent-presets` 段是否已注册（主仓 `packages/settings/settings/src/index.ts:505`），不在就只调度重试而**根本不尝试写入**；provider 没有 `describe` 才退回"写入 + 匹配 `not registered` 文案"的老路径；其他错误一律 loud 一次、不重试（`src/index.ts:457-483`）。窗口是 30 × 100ms（常量 `:264-266`，`PRESET_DEFAULT_ATTEMPTS` / `PRESET_DEFAULT_RETRY_MS`）。
- **roster 服务本身的 attach 竞争**：`ctx.get('agentPresets')` 为 undefined 时同样 30 × 100ms 重试（`src/index.ts:431-437`）。
- **llm 服务的 attach 竞争**：`ROUTE_ATTEMPTS` / `ROUTE_RETRY_MS` = 30 × 100ms（`:293-294`、`:366-370`）。web profile 里 llm 更靠前，但 fiber 启动顺序不是契约。
- **基础 loop 占着 `agentLoop` 名字**——唯一一条等的不是服务、而是**服务名释放**的路径：受管理块要到下一次 composition 才生效（§3.1 第 3、7 步），所以全新安装的第一次启动必须先等 harness 的 live patch reload 摘掉基础行。窗口是 40 × 50ms（常量 `:299-300`，`ROUTER_ATTEMPTS` / `ROUTER_RETRY_MS`），判定用结构性的 `ctx.get('agentLoop') !== undefined` 而不是匹配报错文案，并且**每次重试都先 dispose 上一次的 fiber 再 `mountRouter()`**（`:604-608`）——失败那次的构造已经占住了名字、挂上了自己的 effects，同一个 fiber 重试只会一直撞自己。回归测试在 `tests/router-mount.spec.ts:196` 起：窗口内释放后成功挂载、永不释放则 loud 放弃、卸载中途停止重试、非冲突错误不重试。
- **重试 timer 必须能被 dispose 挡掉**：全部经 `retryLater` 挂载，它在触发前检查 `disposed`（`:326-327`），清理 effect 置位并清掉各待决 handle（`:650-657`）。两者都需要：清理只能清**已挂上**的 timer，而从异步续体（如一条 mutation 的 rejection）里**新挂**的 timer 只能靠 `disposed` 挡掉（回归测试 `tests/index.spec.ts:1082` 起）。
- **幂等的具体表现**：patch 文件已含当前块且无 legacy 块时 `syncManagedBlock` 报告"未写"（`src/index.ts:199-201`）；preset 目录内容一致时不动盘（`src/preset.ts:171-183`）；重复进入 `mountProviderRoutes` 由 registry 的重复注册错误兜住。

### 3.9 插件自己的记录：`$DSH_HOME/.loop-engine/engines.json`

引擎这条事实在插件这边的载体是一个**侧车文件**，不是会话日志（为什么，见 §3.10）：

- **路径**：`resolveEngineRecordPath()`（`src/session-engine-store.ts:65-67`）= `$DSH_HOME/.loop-engine/engines.json`（目录常量 `ENGINE_RECORD_DIR` `:53`、文件名 `:56`，由 `resolveDshHome()` 拼出）。
- **形状**：一份很小的 JSON 文档 `{ version: 1, engines: { "<sessionId>": "<engine>" } }`（版本常量 `:59`，序列化 `:224-226`）。版本不匹配按"没有记录"处理；单个条目的值不是本版本认识的引擎 id 就丢掉那一条、不影响其余（`:132-136`）。
- **写**：`SessionEngineStore.record(sessionId, engine)`（`:177-182`）先复制出新表，用 `writeFileAtomicSync`（`:109-114`：同目录 temp 文件 + rename；temp 名带 `randomUUID`，所以两个写者不会撞名；目录按需创建）整份替换，**写成功之后才推进内存视图**（`:181`）。因此写失败时文件与视图都保持原样，调用者看到拒绝就等于"记录仍是它之前回答的那个"。
- **读**：文件**每个进程懒读一次**（`load` 的 `this.entries ??= this.read()`，`:185-188`），之后每次 `engineOf`（`:164-166`）都是内存查表，路由因此永远不为记录付文件 I/O。
- **降级**：文件不存在是正常首次状态、什么也不报（`:197`）；读不了或认不出（JSON 坏了、版本不认识）就当作"没有记录"，并且**只 warn 一次**（`read` `:191-202`、`degrade` `:213-216`——读是记忆化的，所以一次降级服务之后所有查询）。这条降级是刻意的：**坏的侧车绝不能让路由失败**，最坏情况是一条会话丢掉"记住的引擎"，然后照常回退到自己的 preset。
- **只增不删**：条目按 sessionId 累积，插件不做 GC（`:38-40` 的注释）。一个 sessionId 一行，量级可以忽略；被删掉的会话遗留下来的那一行永远不会被问到，也不会被回报给任何界面。
- **两个接口面向两类调用者**：`EngineRecordSource`（`:75-82`，只读，`engineOfSession` 收的就是它，因此测试可以直接塞一组记录给路由器）与 `EngineRecordStore`（`:88-95`，读 + 写，路由器拿的是它）。同一个 `writeFileAtomicSync` 也被 `src/index.ts` 的 `writePatchFileSync` 复用（§2.5）。

### 3.10 为什么这条事实不进会话日志

这是本插件最该被追问的设计决定，所以把证据写全。

**会话日志本来才是这条事实的正确归宿**，也是 harness 唯一承认的持久平面（"model-visible ⟺ logged"）：任何进入请求的内容都必须能从日志重建。而插件自有的旁路存储是**第二份真相来源**——对每一个日志读者（会话列表、fork、压缩、会话日志上传）都不可见，还自带迁移与垃圾回收问题。插件仍然选了旁路存储，因为日志这条路今天走不通：

1. **插件不能追加一个自己定义的事件类型。** `Session.append` 的签名是

   ```ts
   append<T extends SessionEventType>(
     type: T,
     data: SessionEventMap[T],
     ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
   ): SessionEvent<T>
   ```

   （主仓 `packages/core/session/src/index.ts:703-707`）。包络由 `append` 自己组装（`:725-731`），硬编码 `type` / `seq` / `time` / `data` 并按条件合并 surface 元数据，**没有 `ignorable` 这一项**；唯一能传的 options 是 `SurfaceIntent`，而它只携带 `surfaceOp` / `sourceEventSeqs`。对 log-only 类型，options 元组就是字面量 `[]`——调用方连一个 option 对象都传不进去，更不用说设那个标记。
2. **持久化读路径恰好拒绝 `append` 能产出的那个事件。** `validateStoredEvents`（主仓 `packages/session/session-persistence/src/storage-contract.ts:74-79`）对存储里任何不在生成集合 `KNOWN_SESSION_EVENT_TYPES` 内、且包络没有 `ignorable: true` 的类型抛 `SessionFormatUnsupportedError`；两个调用点都在**读**路径上（主仓 `packages/session/session-persistence-jsonl/src/index.ts:627`、`:758`）。那份集合由 `scripts/gen-persistence-catalog.ts` 生成到主仓 `packages/core/session/src/known-event-types.ts`，它的模块注释（`:7-21`）明确写了为什么"事件名注册"这条路被否掉（它不区分"省略是否安全"，还会让读取依赖 composition）；承载这条决定的 Agent Note 是 `deepseek-harness/.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`。
3. **后果是"每换一次引擎毁掉一条会话"，而且是延迟发作**：`Session.append('loop-engine/engine-selected', …)` 在内存里成功，持久化写盘也成功、不报任何错，**下一次冷读**才失败——

   ```
   SessionFormatUnsupportedError: session "…" contains event type "loop-engine/engine-selected" (seq 3) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness
   ```

   整条日志被拒绝解释，也就是那条会话再也打不开。

所以插件把这条事实放在自己的文件里（§3.9），并向上游提了让它能搬回日志的那半个接缝：`docs/proposals/append-ignorable-events.md`。提案若落地，`SessionEngineStore` 可以改成"先写日志事件、文件保留为改动前那些会话的兜底"。

## 4. settings 段与 web UI

### 4.1 零导入模块：namespace 常量与引擎映射

设置字面量 `'loop-engine'` 放在**零运行时导入**的 `src/namespace.ts`，引擎↔preset-id 映射放在同样零导入的 `src/agent-preset-ids.ts`。原因（`src/settings.ts` 的模块注释）：浏览器 bundle 也要引用这些字面量与这条纯映射，而它们原本的同居文件都是宿主侧的——`schemastery`（`src/settings.ts`）、`node:fs/promises`（`src/preset.ts`）；若同文件，client bundle 会把整个宿主包拖进浏览器产物。`src/settings.ts` 与 `src/preset.ts` 只是把映射转出去（import 路径与名字不变），浏览器半自己引 `src/agent-preset-ids.ts`。产物侧可验证：`lib/client.js` 里没有任何 `dsh-settings` / `node:fs` 的 require（§6）。

**`0.1.7-rc.1` 起，设置的命名空间就是本插件 profile 条目的 id**（harness 把设置重写为"profile 条目-backed 活配置"，见根 `docs/deepseek-harness-0.1.7-rc.1-变更总结.md` §2）：`cordis.patch.yml` 把本条目插成 `loop-engine`，所以 `src/namespace.ts` 的字面量也是 `'loop-engine'`，两者必须一致。旧的 `loopEngineSettingsNamespace()` 品牌断言随旧的 `SettingsProvider` 注册表一起删除。

### 4.2 段的语义：两个活 Config 字段

引擎与 composer 开关是插件**自己条目的 `Config`** 上两个 `.volatile()` 字段（`src/settings.ts` 的 `LOOP_ENGINE_ENGINE_SCHEMA` / `LOOP_ENGINE_SHOW_IN_COMPOSER_SCHEMA`，装配进 `src/index.ts` 的 `Config`）：`engine` 五选一并默认 `in-process`，`showInComposer` 默认 `true`。宿主把它们投影成该条目的设置表单，客户端用 `ctx.configForms.get('loop-engine')` 读写；运行时它们是 `Volatile<T>`，插件读 `config.engine.get()`。**`engine` 的含义依旧是"新会话的默认引擎"**（不是任何进程内开关）：它的实现是 §3.5 的 roster 默认值 steering。因此：

- 改它**不影响**任何已存在的会话（每条会话的引擎由插件自己的记录决定，没有记录的才由它的 preset 决定，§3.3）。
- 改它**不需要**重启 `dsh web`，也**不需要**刷新页面（§4.4）。
- 它只在新会话创建时起作用：宿主在那个时刻解析 default preset 并把 id 写进 `meta.agentPreset`（主仓 `packages/api/session-controller/src/agent.ts`）。

变更通知是 `ctx.on('settings/document-updated', …)`：插件记下 boot 时的 `config.engine.get()`，只有该值真的变化才重指 roster 默认（`src/index.ts`）。boot 时以 `legacyEngine ?? config.engine.get()` 做首次 steering。插件同时用 `settings.configure({ auto: false }, ctx.fiber)` 关掉 harness 自动生成的设置页——它自带 §4.3 那个页面。

### 4.3 client bundle 的四个露面点

`src/client/index.ts`（`inject = ['slots', 'locale', 'configForms']`）注册了三处槽位 UI 与一份样式表：设置页 section 读写插件条目里的**默认引擎**（`settings.section` 槽，`order: 30`，注册包在 `ctx.configForms.whileServed(['loop-engine'], …)` 里——宿主服务了该命名空间才出现），会话头 chip 与 composer 选择器读**这条会话**的引擎（前者 `conversation.session.header.actions` 槽、`order: -20`；后者 `conversation.input.right` 槽，受 `showInComposer` 控制）。后两处通过 `ctx.inject(['slots', 'conversation'], …)` 注册，确保 ui-conversation 先声明了目标槽位。文案走 `ctx.locale` 的 `settings.loop-engine` 词典，中英双语（`src/client/locales.ts`）。第四处不是槽位：`installTurnStatusStyles(ctx)`（实现 `src/client/turn-status.ts`）往 `<head>` 注入一份样式表，给对话页的 turn-status 行（"深度求索中…"）加上引擎专属的配色与字形。那一行由 harness 的 ChatView 渲染、文本归 ui-chat 所有（不是 slot，也没有第二个 `locale.register` 的口子），所以插件只能改它的样式：它按**每一代的两个稳定挂点**各出一份规则——0.1.5 线是类名后缀 `[class$="_turnStatus"]`（前缀哈希不稳定、后缀稳定），0.1.7 线那行被重做成了 `button[data-turn-process]`、文字在类名后缀 `[class$="_label"]` 的 `<span>` 里（`.label` 这种字面类名不存在，CSS Modules 是 `[hash]_[local]`），命中的一份生效、另一份 inert——再按 `<html>` 上的两个属性为各引擎设一组变量与字符：`data-loop-engine`（在屏会话跑哪个引擎）与 `data-loop-engine-running`（这一轮是否还在跑，见下文）。

会话侧的读与写集中在 `src/client/session-engine.ts`，而**读的那一半不再来自客户端**：

- **引擎的报告来自插件自己的 Remote**：`createSessionEngineCache`（`src/client/session-engine.ts:719-736`）在客户端半 mount 一份手写的 contribution（`LOOP_ENGINE_REMOTE_CONTRIBUTION`，`:462-477`）拿到 `remote.loopEngine`，再由 `SessionEngineCache`（`:517-735`）按 sessionId 缓存报告并通知组件；`useEngineOfSession`（`src/client/use-session-engine.ts:79`）是组件侧的订阅钩子，**同时是 turn-status 行唯一的驱动者**（§4.3 的 turn-status 那段）。**第一次答案到达之前缓存里没有值**（`read` 返回 undefined），chip 因此不渲染、composer 显示「读取中…」**并禁用（置灰、打不开菜单）**——不显示默认值，也不显示任何旧值。禁用这一半由 `engineSwitchReady`（`src/client/session-engine.ts:205`）判定，它同时是类型收窄，所以"引擎未知"这一状态既不会走到重载确认、也不会被提交成一次切换（§4.4）。
  - **缓存的是整份报告**（`SessionEngineReport`：`engine` + 可选 `pending`，`src/agent-preset-ids.ts:158-168`），因为三处露面读的不是同一份：chip 与 composer 的名字、composer 的选中项都用 `engine`（实际引擎），`pending` 只在 chip / composer 里作一句「切到 X · 尚未接管」的标注（composer 的菜单里被标注的那一行也带同样的后缀，§4.4），而 turn-status 行**只看 `engine`**（`hostedEngineOf(report.engine)`）。把两者在缓存里合并就等于抹掉这个区别，所以缓存原样保留、由各处自己取用。这个组合在正常路径上不出现（原地换手让两者一起变、释放之后没有活 agent），只剩"释放没成功"那一种来源（§3.7）。
  - **一条会话的报告在它的界面出现时重新取一次**（`watch` 的第一个 watcher → `refresh`，`src/client/session-engine.ts:575-610`）：这与"怎么让切换落地"无关（切换由宿主执行：原地换手，或释放这条会话并让页面重载，§3.7），它解决的是**答案可能过时**：另一个窗口、别处的一次原地换手、或一次插件重载都能让这条会话换了引擎，而这个页面手上的还是早先那份。重挂载时重取一次正是为了不留这种陈旧答案。持续渲染不重取（hook 的 effect 以 sessionId 为依赖，`src/client/use-session-engine.ts:81-84`），同一会话的两个界面同时出现也只发一次请求（只有第一个 watcher 触发重取，第二个并进同一次读取）；而 `invalidate`（换引擎成功回调）仍然是"这份答案肯定错了"的那条路径。
  - 为什么不能用客户端会话列表：`SessionSummary.projectionValues` 是宿主 `projectionsFor()` 算出的 `SessionProjectionHints`，自己写明 "partial: missing cells and cache rows are never materialized here"；而 `agentPreset` 在**空白期换过引擎**的会话上表示的是"创建时的 preset"，不是"实际跑的引擎"。历史上 chip 读的正是它，于是出现过"实际跑 pi、chip 显示 Claude Code"的生产事故。现在客户端**不再读** `projectionValues.agentPreset`。
  - contribution 是手写的普通 JSON：typert 协议没有 schema registry，第三方插件拿不到主仓生成的 `typert.remote-client.d.ts`，也不需要它。服务端侧由 `src/engine-remote.ts` 提供同名绑定（§3.1 第 8 步、§4.6）。
- `sessionEngineOf`（现在在**零导入**的 `src/agent-preset-ids.ts:297`，类型 `SessionEngine` 在 `:103`）是唯一的三态判定，**路由与 Remote 共用**：`loop-engine-<engine>` → `{ kind: 'engine', engine }`；`LEGACY_HOSTED_PRESET_ID` → `{ kind: 'legacy' }`（当时确实是托管引擎，只是没记录哪个，绝不当成 in-process）；没有 preset（或非字符串）→ `{ kind: 'unset' }`；其余 preset（含部署自有的 `standard`）→ `{ kind: 'engine', engine: 'in-process' }`。**没有"未知即 in-process"这个入口**：两个会话级渲染点（chip 与 composer）各自决定怎么呈现 `legacy` / `unset`（§4.3 与 §4.4）。喂给它的 preset id 只有一个来源：`engineOfSession`（`src/engine-of-session.ts:78`）——有插件记录时来自记录，没有记录时才来自那条持久化投影（§3.3、§7）。**报告**（`engineReportOfSession`，`src/engine-of-session.ts:128-141`）在此之上多一层「活 agent 优先」：有活 agent 时 `legacy` 不会出现在 `engine` 里（那条会话此刻跑的就是 harness loop），所以上面那句"绝不把它说成进程内"的边界是**没有活 agent 时**的回答（§3.3）。
- `sessionEngineSwitcher`（`src/client/session-engine.ts:760-803`）把选中的引擎换成 `remote.loopEngine.select({ sessionId, engine })`（`:770`），拒绝一律折成可渲染的结果：调用本身被拒（网关拒了一个畸形请求、连接断了）取 `result.error.message`（`:780`），调用被服务但插件拒绝了这次搬迁则带上宿主给的 `code` 与那句原话（`:786-789`，`code` 是界面本地化文案的依据、原话是详情）。namespace 从 `ctx.get('remote.loopEngine')` 现取（`:766`），取不到就报 `unavailable`（`:767`）——不把它写进 inject 门，一个缺失的可选能力不该让整个选择器不注册。**换成功后它回调通知调用方**（`onSwitched`，`:793`），由 `src/client/index.ts:148` 作废该会话的缓存并重新取值：显示不能靠"宿主投影变了会通知我"，那正是旧实现里"换完还显示旧引擎"的来源。**涉及 in-process 的那次回包带 `reload: true`，这个函数自己把收尾做完**（`:794-801`）：`armReloadReturn` 存下会话 id（`src/client/reload.ts:95-107`），再 `page.reload()`（默认就是 `window.location.reload()`，`src/client/reload.ts:72-84`），返回 `{ ok: true, reload: true }`；页面回来时由 `installReloadReturn`（`src/client/index.ts:91`）装上的一半读到这个 id 并调 `sessions.open(id)`（`src/client/reload.ts:164-206`）——重载必须由**这个函数**（而不是组件）负责，因为它是唯一同时知道"宿主释放了 agent"与"页面必须换一份状态"的地方。

`LoopEngineStore`（`src/client/store.ts:33`）仍是设置页、composer 的可见性开关与**没有会话时** composer 显示的默认值的传输：`decodeLoopEngine` 收窄线上值（非法 id 读为 undefined → 落默认；`showInComposer` 缺失视为 true，`src/client/store.ts:21-30`）。`setEngine`/`setShowInComposer` 的成败判定不是看 promise 是否拒绝，而是**写完后对照 scope 留下的快照**（`src/client/store.ts:60-77`）——被拒绝的写在恢复后会报 `unavailable`。它**不再驱动 turn-status 行**（那曾是"这一行永远跟默认引擎走"的来源）。

turn-status 行**跟的是当前会话的引擎**，与 chip / composer 同源，而且**只由在屏会话驱动**——它挂在 document 级属性 `<html data-loop-engine>` 上，写这个属性的唯一入口是 chip 与 composer 共用的那个 hook：`useEngineOfSession`（`src/client/use-session-engine.ts:79`）的 effect 先声明焦点（`focusTurnStatusSession`，`src/client/turn-status.ts:357`），再用同一个会话 id 反射**报告里的实际引擎**（`hostedEngineOf(report.engine)`，`reflectTurnStatusEngine`，`:333`，守卫在函数第一行），卸载时撤下焦点（`blurTurnStatusSession`，`:373`）。`legacy` / `unset` / 宿主还没答出来 / 换引擎时缓存被作废，这四种都反射 `undefined`，也就是删掉属性、恢复 harness 原样（"不知道是哪个引擎"不能拿任何一个冒充）；**带 `pending` 的报告画的是实际引擎**——一次还没落地的切换不该改这行动画。样式表按这个属性给四种引擎各上一套变量与字符，属性不在时一张规则都不生效。**整张表还同时挂在 `data-loop-engine-running` 上**（`src/client/turn-status.ts:94`），因为 0.1.7 那行**在对话结束后仍然在屏**——它变成"用时 4 秒"那种折叠摘要，只按引擎门控的话，字形与扫光会留在一条已经收尾的行上（实测问题："对话结束之后动画还在"）。这个门是**界面自己答的**（`session.running`，每个会话级槽都拿得到的 `SessionStandardProps.useSession`，`src/client/session-engine.ts` 的 `SessionSeat` 只声明 `sessionId` 与 `useSession?` 两项、只读 `running` 这一个字段），由 chip 与 composer 在调 hook 时一并传入（`src/client/LoopEngineBadge.tsx`、`src/client/LoopEngineComposerSelect.tsx` 顶层无条件调用 `useSession`，在各自的 early return 之前），也进了 hook effect 的依赖（`[sessionId, engine, running]`），所以轮次开始时写入、结束时撤下；**答不出来的界面不传**（`undefined`），门保持上一个能答的界面留下的样子，而不是替它猜。样式表在卸载时会连两个属性一起清掉。

**document 级属性只能有一个写者，而"最后写的人"不是它**：`SessionEngineCache.publish`（`src/client/session-engine.ts:704-706`）**不再碰 document**，它每发布一个会话的权威报告只通知该会话的 watcher。旧实现正是在 `publish` 里无条件反射，而 publish 的**发布者不止一个**——chip 与 composer 会给每个渲染过的会话登记 watcher，切换会话时旧会话那次**迟到的取值**落地时照样 publish——于是不在屏上的会话（或刚被离开的那条会话）能把属性改成自己的引擎：屏上跑 Pi、那一行却画出 Kimi 的月亮，走的就是这条路径。现在反射必须报出自己的会话 id，且只有**焦点会话**的反射生效，非焦点会话的反射是**无操作**。两条补充语义：焦点只在"仍属于自己"时才撤下（React 不保证离开组件的清理与到达组件的 effect 谁先跑，无条件的撤下会把刚接过屏的那条会话的焦点抹掉）；属性本身**不在卸载时清除**（同一会话的另一个界面还在用它，残留属性在没有这一行的页面上无害），清除只发生在"焦点会话自己反射 `undefined`"这一种情况。

### 4.4 提交语义：默认值 vs 本会话

设置页的选择先**暂存**、经 Modal 确认才提交（`src/client/LoopEngineSection.tsx:171-180`）；composer 的选择**除"会重载页面"那一类之外选中即提交**（`src/client/LoopEngineComposerSelect.tsx:432-453`——这条会话此刻能不能换由宿主判定，客户端不预读会话列表里的空闲提示，被拒时只按码说本地化文案）。**会重载的那一类要用户先确认**，判据是"目标引擎与报告里的实际引擎恰好一边是 `in-process`"（`switchNeedsReload`，`src/client/session-engine.ts:250-253`）：这一类的切换会释放会话并重新载入页面（代价是这一页的滚动位置与未提交草稿），所以 composer 先弹一个两按钮确认框（`:505-518`），用户确认才发请求；**这条判定只对有会话、且引擎已知时做**——有会话而报告还没到，整个选择器是禁用的（`engineSwitchReady`，`src/client/session-engine.ts:205`），所以既不会误弹确认，也不会静默重载把草稿带走；**托管引擎之间不弹任何东西**（原地换手没有代价可确认），弹窗的两种用途也分得很开——确认框是提交前的两个按钮，错误提示是事后报告的一个"关闭"。差别在提交走哪条路：

- **设置页 / 没有会话的 composer**：`controller.setEngine(value)`——只改新会话的默认值，屏幕上什么都不用变，也不重载任何东西（`src/client/LoopEngineSection.tsx:171-180`）。文案只说新会话：`switchNotice` / `confirmBody`（`src/client/locales.ts:108`、`:111`，英文 `:153`、`:156`），section 的 `description` 也限定为新会话（`:97` / `:142`）。
- **composer 有会话**：`switchEngine(sessionId, value)`（`src/client/LoopEngineComposerSelect.tsx:395`，`value` 直接就是 `LoopEngineId`，不再折成 preset id），**显示上绝不回退到设置默认值，也绝不把记录里的引擎当成正在跑的那个**：名字与图标、以及菜单高亮的那一项都来自报告的 `engine`（`legacy` 显示"旧版托管引擎"、`unset` 显示"未记录"、宿主还没答出来时显示「读取中…」**且整个选择器禁用**——`src/client/LoopEngineComposerSelect.tsx:152` 的 `READING`、`:169-175` 折成显示面、`:361` 的 `disabled` 把 `engineSwitchReady` 也算进去），报告里多出来的那一半只追加一句标注（`:365-375`），并且**那个引擎自己在菜单里也带后缀**（`:474`，文案 `engineMenuPendingSuffix`）。`legacy` / `unset` 这两种回答都不高亮任何菜单项、也不画引擎图标；读取中同样两样都不画，但它连用都不能用——等的是一个还没到的答案，而不是一个没有引擎名的答案。三种结局：
  1. 会话已打开且空闲 → 插件**记下引擎**，再按两边引擎决定怎么接管：**托管引擎之间原地换手**（会话不重建、不释放，下一条输入自然落到继任者），**任一边是 `in-process` 时释放这条会话的 agent 并回包 `reload: true`**（§3.7），composer 弹一句 `switchReloadTitle` / `switchReloadBody`（`src/client/LoopEngineComposerSelect.tsx:420-423`）——而客户端半在拿到这个标志时**已经把页面重载掉了**：id 存进 `sessionStorage`、`window.location.reload()`（`src/client/session-engine.ts:799-800`、`src/client/reload.ts:95-107`），重载后的页面用这个 id 调 `sessions.open(id)` 回到这条会话（`src/client/reload.ts:164-206`，接线在 `src/client/index.ts:91`）。切换成功的那一刻选择器**主动作废该会话的缓存并向宿主重新取值**（`src/client/session-engine.ts:793` → `src/client/index.ts:148`），所以显示立刻跟上，而不是等某个投影推送。
  2. 宿主拒绝（会话没打开 / 有回合在飞 / subagent / 记录写不进去）→ 拒绝**不改**这条会话的引擎：记录没写、agent 没释放，缓存因此本来就正确（**选择器保持在会话实际运行的引擎上**），只读的错误提示按**原因码**给出本地化文案（`switchFailedTitle` + `refusalFace`，`src/client/LoopEngineComposerSelect.tsx:407-415`、`src/client/locales.ts:299-301`），两个带底层错误的码把宿主原话以小字附在下面（`:304-309` 的样式、`:527` 渲染），码不认识时正文就是宿主那句话——原话不再是正文。
  3. 页面拿不到本插件自己的 Remote → 提示说本插件自己的话 `switchUnavailable`（`src/client/locales.ts:136` / `:181`）。
  composer 的弹窗因此有三种用途：重载前的**确认框**（两个按钮，`:505-518`）、拒绝的**错误提示**（一个"关闭"按钮）、重载时的**说明**（`switchReloadTitle` / `switchReloadBody`，`src/client/LoopEngineComposerSelect.tsx:420-423`）。台词是"托管引擎之间选中即生效；涉及进程内时先确认、再重载一次并回到这条会话"；会话记录（对话历史）不受影响（`composerHint`，`src/client/locales.ts:123` / `:168`）。

**任一托管引擎**作为当前（或默认）引擎时额外显示一句模型说明（`hostedEngineModelNotice`，判据 `isHostedEngine`：`src/client/LoopEngineSection.tsx:213`、`src/client/LoopEngineComposerSelect.tsx:375-376`，文案 `src/client/locales.ts:115` / `:160`）——它说明默认由引擎自己决定模型、**在菜单里选一条 dsh 模型会把它交给该引擎使用**（引擎不接受就报错），以及菜单里那个共享的 `external` 分组名下那条 `default` 的含义（§3.6）。背景与"为什么不是每个引擎一条真目录"见 `docs/proposals/per-session-model-for-hosted-engines.md`，本插件侧的取舍见 `docs/per-session-engine.md` §5.2。

### 4.5 标准座位是怎么读到的（artifact-plane 的类型缺口）

chip 与 composer 要读的标准座位成员——session scope 的 `sessionId`——是 harness 用声明合并塞进 `SessionStandardProps` 的（主仓 `packages/client/ui-session/src/client/index.ts:104-121` 的 `declare module '@deepseek-ai/dsh-client-ui-slots'`）。**产物面拿不到这份合并**：发布出来的 `.d.ts` 把承载它的 `import type {}` 抹掉了（对比 `packages/client/ui-conversation/lib/types/client/apply.d.ts` 与源码里的 `apply.ts:11`），而本仓库的声明构建用空 `paths` 把 `@deepseek-ai/*` 钉在产物面（§6）。所以 `src/client/session-engine.ts:95-102` 按 harness 的声明形状把这个成员**结构化地重述**了一遍（`SessionSeat`），两个组件从自己的 slot props 上断言它。

全局的 `useSessions` 已经**不再需要**：引擎不再从会话列表的投影 hint 里读（§4.3），承载它的那份合并也就无需重述。剩下的结构化声明属于另一类原因——Remote 的客户端类型（`SessionEngineRemote`、`EngineRemoteHost`、`RemoteContribution`，`src/client/session-engine.ts:132-304`）和标准座位一样拿不到主仓的生成物：typert 的 codegen 只服务于主仓内的包，第三方插件的 contribution 是普通 JSON，两边形状是否一致由协议本身决定（§4.6、§7「Remote 的线协议」）。

这不是"顺手抄一份类型"：运行期这个成员对每个 slot 组件都在（`ui-session` 的 `apply` 用 `ctx.slots.provideRoot` 提供 `sessions` 钩子，session scope 由 `installScope` 提供 `sessionId`），harness 自己的 `AgentPresetLabel` 正是从同样的 props 上直接解构使用。

### 4.6 插件自己的 Remote：两个端点

`src/engine-remote.ts` 是"报引擎"与"换引擎"这两种操作唯一的线上出口——服务名与 wire 命名空间都是 `loopEngine`（`src/engine-remote.ts:64`），两个方法名是常量（`:67`、`:70`）：

| 端点 | 做什么 | 结果 |
|---|---|---|
| `loopEngine/engine`（`:193-207`） | 报一条会话**实际**跑哪个引擎，以及它自己的记录写了什么 | 纯 JSON 的 `SessionEngineReport`（`src/agent-preset-ids.ts:158-168`）：`engine` 是三态 `SessionEngine`，`pending?: LoopEngineId` 只在"活 agent 的引擎 ≠ 侧车记录"时出现（正常路径不出现，见 §3.7）。有路由器时由 `RouterLoop.reportEngine` 供货、没有时退回记录/日志（`:198-202`）；读不出来时答 `{ engine: { kind: 'unset' } }` 并把失败经 `pluginWarn` 报一次，而不是把渲染它的页面弄崩 |
| `loopEngine/select`（`:233-255`） | 把一条会话换到另一个引擎 | `LoopEngineSelectResult`（`src/agent-preset-ids.ts:234-276`）：`{ ok: true, engine }`（托管引擎之间原地换手时只有这两项）或 `{ ok: true, engine, reload: true }`（涉及 `in-process`：agent 已被释放，客户端要重载页面，见 §3.7），或 `{ ok: false, code, reason }`——**拒绝是数据，不是抛出的错误**，`code`（`LoopEngineRefusalCode`，`src/agent-preset-ids.ts:198-223`）是客户端本地化文案的依据、`reason` 是详情 |

- **两个端点各收一个普通对象参数，名字都叫 `request`**（`LoopEngineRequest` `:73-76`、`LoopEngineSelectRequest` `:83-88`）：typert 会把名为 `agent` / `session` 的参数解析成**活的**对象，而这两个端点要为任何**已持久化**的会话作答——包括没有任何进程加载过的那些，所以它们只收字符串。
- **"实际"由路由器供货，记录只是后备**：端点自己不判定引擎——它把 `RouterSurfaceHolder`（`:132-135`）里的路由器交给调用，`RouterLoop.reportEngine` 用 `live` 记账回答"现在跑什么"（§3.3、§3.7）；`SessionEngineResolver`（`:99`）那条"记录 → 日志"的路只在**没有路由器**时用（全新安装的第一次启动正处在挂载重试窗口，那时没有会话由本插件驱动，两条路给出的答案一致）。
- **只有畸形的请求才是 `RemoteError`**：非字符串或空的 `sessionId`、以及不在 `LOOP_ENGINE_IDS` 里的 `engine`，都按 typert 的惯例抛 `gateway/bad-request`（`:195-197`、`:234-245`）。可预期的"不行"（会话没打开、有回合在飞、subagent、记录写不进去、旧机器退场后新引擎没建起来）是数据——一个原因码加宿主原话——由调用面渲染（§4.4）。
- **`select` 自己没有策略**：它只做边界校验，然后把请求交给**持有者** `RouterSurfaceHolder` 里的路由器（`:132-135`，结构面 `RouterSurface` `:115-120`，实例在 `src/index.ts:546`）。`current` 就是已挂载的路由器（`src/index.ts:589`）；路由器还没挂上（§3.1 第 7 步）时 `current === undefined`，端点回一条 `{ ok: false, code: 'router-unmounted', reason: 'this process cannot switch engines yet: the loop router is not mounted' }`（`:247-253`）——对一个无从得知这件事的调用者，用话拒绝比抛错好，而这个码让客户端能说本地化的话（§4.4）。真正判定能不能搬、怎么搬的是路由器（`RouterLoop.selectEngine`，§3.7）：只有它知道这条会话有没有活 agent、有没有回合在飞、要不要拆 agent。
- **线协议靠形参名**：`loopEngine/*` 没有主仓 codegen 生成的 strict descriptor，所以网关走 SRC 路径——用 `Function.prototype.toString` 读活方法的形参表当参数名（主仓 `packages/api/gateway/src/index.ts` 的 `methodParameterNames`）。因此 `request` 这个名字就是线字段名，不能改名、不能解构、不能带默认值；`tests/engine-remote.spec.ts` 的最后一条测试读源码文本把这件事钉死。浏览器半那份手写 descriptor（`src/client/session-engine.ts:462-477`）声明的是同一个 wire 名，并且两个端点各有一个 **strict** 请求 codec（`:468`、`:475`）与 strict 结果 codec（`:473` 的 `parseSessionEngineReport`、`:475` 的 `parseSelectResult`）——两侧的校验因此对同一批畸形输入给出同样的判定（`pending` 不是已安装引擎时在两边都是"这不是一个答案"；`reload` 不是字面量 `true` 时也是；**`code` 不是本 build 认识的码时被规范化成"没有码"**，于是 `reason` 仍然是可读的那句话）。
- **生命周期跟着插件**：`TypertRemoteService` 在构造时注册服务与可见的 `typertRemote` 绑定，网关是**调用时**才反射发现的，所以没有网关的 profile 一点代价都不付，卸载插件即随 fiber 撤下（`src/index.ts:630-638`）。

## 5. invariant 入口

`src/invariant.ts` 是独立的 companion 插件（`loop-engine-invariant`，`inject = ['invariants']`，`src/invariant.ts:31-33`），向 harness 的 invariant 注册表登记本包拥有的不变量——patch-manager 的写-读往返与 legacy 迁移：

- `applyManagedBlock` 必须是不动点（`src/invariant.ts:52-53`）。
- 渲染出的块必须被 `hasManagedBlock` 认出来，且必须禁用基础 `agent-loop` 行（`:54-55`）。
- 当前块不得读成 legacy pin（`:56`）。
- 任意引擎的 legacy 块都必须仍读回该引擎（含本版本不认识的 id，标记里仍有它），且迁移结果与"同一层从未有过块"的变换结果逐字节相同（`:57-69`）。
- 纯注释文件必须被修复为带块的可加载顶层数组（`:70-72`）。

它单独占一个 `./invariant` 出口（`package.json` 的 `exports`，`package.json:17-20`），由部署侧按需 compose 进 invariant 检查通道；检查本身是对纯变换的再断言，失败通过 `fail` 上报并挂在包名下（`src/invariant.ts:42-73`）。价值在于：写方与读方的互逆关系被绑定在同一次注册里，任一侧回归都会在部署的 invariant 轮里立刻炸出来。

## 6. 构建产物与外部化策略

`build.mjs` 是两段式（`build.mjs:1-13`）：

1. `tsc -p tsconfig.build.json` 产出 `lib/types/**` 声明（同时产出的 JS 运行时不使用）。
2. esbuild 打三个 bundle：
   - `lib/index.js`、`lib/invariant.js`：ESM、node 平台，只内联相对导入的 `./src` 模块（`build.mjs:85-96`）。
   - `lib/client.js`：CJS 闭包包进 `window.__ModuleLoader__.load({ id: 'dsh-loop-engine', factory })` 的 client-module 工厂（`build.mjs:99-115`），harness 的 web 模块加载器按此约定装载。没有 CSS loader，所以 section 组件用 token 内联样式而非 CSS module（`src/client/LoopEngineSection.tsx:8-12`）。

**为什么所有 `@deepseek-ai/*` 保持 external**（`build.mjs:32-65`）：harness 包必须全程只存在**一份实例**——出现两份会让 cordis 实例一分为二，插件里的 `Context`/`Service` 与宿主不是同一个运行时，注册全部对不上。这一点在 0.1.5 基线上比早期更强：本仓库的 harness 依赖按 `package.json` 的 peer 版本解析到**已安装的 npm 产物**（锁文件里没有任何指向主仓源码的 link/file 依赖），声明构建的 `tsconfig.build.json` 还用空 `paths` 把 `@deepseek-ai/*` 钉在产物面。

`@deepseek-ai/dsh-agent-loop` 现在**必须是 peer 且必须保持 external**，且比别的包更硬：`RouterLoop extends AgentLoop`（§3.2），把该包内联进 bundle 会得到**两份 `AgentLoop` 类身份**——宿主 context 上被注册的那个服务与路由器继承的基类不再是同一个类（`Service` 身份一分为二，`AgentLoop` 自己构造时又会 `super(ctx, 'agentLoop')` 注册一遍服务），而那份副本的 `ctx.effect(() => ctx.agents.setFactory(this), …)`（主仓 `packages/core/agent-loop/src/index.ts:420`）会在启动期撞上唯一槽位、抛 `an agent factory is already registered`。`build.mjs:47-48` 的注释就是这条约束的落点。对应地，它同时出现在 `package.json` 的 `peerDependencies` 与 `devDependencies` 里（`package.json:72`、`:83`）。

浏览器侧同理：`react`、`dsh-client-*` 等由宿主的模块表提供，列入 `BROWSER_EXTERNALS`（`build.mjs:69-80`），与 `package.json` 的 `dsh.client.external` 声明对应（`package.json:53-59`）。**自检方式**：`pnpm run build` 后 `grep -o 'require("[^"]*")' lib/client.js | sort -u` 应当只有 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`——出现任何 `node:*`、`dsh-settings`、`dsh-agent-presets` 就说明宿主包被拖进了浏览器产物（§4.1 的零导入拆分正是为此）。

**浏览器半没有新增模块依赖**：会话级切换与引擎读取都走插件自己 mount 的那一个 contribution（`ctx.get('remote')` 的 `$mount`，`src/client/session-engine.ts:719-736`、`:760-803`），承载者（`@deepseek-ai/dsh-api-remotes` 客户端行）本来就在 `dsh.client.inject` 里（`package.json:47-50`）。Remote 的客户端类型是本仓库自己结构化声明的（§4.5），所以 `dsh.client.inject` / `dsh.client.external` / `BROWSER_EXTERNALS` 这次都没有变，`lib/client.js` 里也**不出现** `@deepseek-ai/dsh-typert-protocol`。

**node 半新增了一个 external**：`src/engine-remote.ts` 从 `@deepseek-ai/dsh-typert-protocol` 取 `TypertRemoteService` / `@Remote` / `RemoteError`，所以该包进了 `NODE_EXTERNALS`（`build.mjs:55-58`）与 `package.json` 的 `peerDependencies` / `devDependencies`（版本对齐其它 peer 的 `0.1.7-rc.1`）。必须 external 的理由与 `dsh-agent-loop` 同类：协议包用 `Object.defineProperty` 在**原型**上写 `@Remote` 的标记、并由网关用同一个包里的 `remoteMethods()` 读回来，内联一份副本就等于让写标记的那份与读标记的那份不是同一个实现。自检：`grep -n 'typert-protocol' lib/index.js` 必须看到一条 `import … from "@deepseek-ai/dsh-typert-protocol"`，且 `lib/client.js` 里一处都没有。

`package.json` 的 `dsh` 字段是插件与 harness 的装配契约：

- `dsh.bundle.patch: ./cordis.patch.yml`（`package.json:43-45`）：作为 bundle 安装时把本插件的 patch 层并入 profile。该文件只有三行（`cordis.patch.yml`）：`insert` 一行 `loop-engine` composition 条目——这是引擎工厂的宿主行，引擎选择本身不碰它。
- `dsh.client.inject` / `dsh.client.external` / `dsh.client.platform: web`（`package.json:46-61`）：声明浏览器产物的模块表依赖与不可内联清单。

发布文件集由 `files` 钉死（`package.json:28-34`）：三个 bundle + 类型 + `cordis.patch.yml`。

## 7. 已知约束与坑

- **手改 patch 文件不改变任何引擎选择**：文件只在 `apply()` 启动时被插件读一次，且读的只是"要不要迁移 legacy 块"；块本身是常量、里面没有引擎 id。harness 自己会 live reload 这层 patch——正是它把基础 `agent-loop` 行摘掉，让全新安装的第一次启动不必再重启第二次（§3.1 第 7 步、§3.8）。
- **主仓 `agent-loop` 行的 config 随该行一起失效**：路由器按 `super(ctx, { agents: [], maxParallelToolCalls: { get: () => DEFAULT_MAX_PARALLEL_TOOL_CALLS } })` 构造（`src/router-loop.ts`），所以 `agents:` 声明式启动列表与 `maxParallelToolCalls` 的 **yml config** 都到不了 loop——路由器自己钉在 harness 默认值上。`agent-loop` settings 段仍然在 harness 的设置体系里生效（新模型下它是 `agent-loop` 条目自己的活 Config，用户改的并行度落在 profile patch，主仓 `packages/settings/settings/src/index.ts`）。
- **引擎不再在会话创建时锁定**：任何**已打开且空闲**的会话都能换引擎（§3.7），这是本次改动的核心。harness 自己那条"preset 在会话开始后固定"的边界仍然在，插件为此保有自己的记录。测试里 `describe('the blank-session engine switch')`（`tests/router-loop.spec.ts:568` 起）仍钉住 harness 那条路径的每条分支，包括"投影完全缺失也算空白"（`:630`）。
- **换引擎需要一个打开且空闲的会话**：会话没打开（没有活 agent）、有回合在飞、或它是 subagent 会话时，`selectEngine` 一律拒绝并把原因作为**数据**返回（§3.7 的清单：一个原因码加宿主原话）；一个回合的输出属于产生它的引擎，绝不被打断、绝不被抢走（`src/router-loop.ts:431-445`）。
- **托管引擎之间：原地换手，会话不重建**。记录与**模型座位**先落盘（`<旧>/default` → `<新>/default`），然后旧 agent 退场、新引擎的 agent 用**同一个 `Session` 对象**就地发布（§3.7）——会话的 store 条目与写句柄都保留，所以浏览器那半看不到任何生命周期边，"会话不可用"与"退回主页"这两条线上现象从根上不再产生。这条会话的下一条输入自然落到新 agent 上（宿主每轮按 sessionId 现取 agent）。
- **与 in-process 之间：写记录 → 模型座位写回真实模型 → 释放这条会话的 agent → 回包 `reload: true`，客户端重载页面并回到同一条会话，宿主按记录重建它。进程不重启。** harness 自带的 loop 既不交出活会话、也不接受不是它自己创建的会话（逐条证据见 `docs/per-session-engine.md` §5.4），所以这两个方向无法原地换手；插件改为**释放**这条会话（`src/router-loop.ts:504-511` 的 `move` → `:602-604` 的 `release`），会话因此变冷，而记录就是它下一次构建要用的引擎。这次释放会发 `session/disposed`，所以回包里带 `reload: true`，客户端半据此把 id 存进 `sessionStorage` 并 `window.location.reload()`（`src/client/session-engine.ts:799-800`、`src/client/reload.ts`），重载后的页面用这个 id 调 `sessions.open(id)` 回到这条会话（`src/client/reload.ts:164-206`，接线 `src/client/index.ts:91`）——宿主随后 `resume` 它（§3.3）。**为什么必须重载**：`api-session/removed` 会把会话行从列表里删掉、把当前会话清空，并在那个 `Session` 实例上写下没有复位路径的 `removed` 标记（`docs/per-session-engine.md` §5.2/§5.4）；重载是清掉这份页面状态的最小动作。这段窗口里报告一般没有第二个事实（释放之后没有活 agent，记录直接就是答案）；只有**释放没成功**时才会有：`engine` 是仍在驱动的旧引擎、`pending` 是记录（§3.3、§4.6），此时 chip / composer 写「正在跑的那个 · 切到 X · 尚未接管」并提示再选一次重试——**没有任何一处显示与实际不一致**。
- **subagent 会话不能换**：它的 agent 属于创建它的那次委派，在这里丢掉会把父会话的子任务晾在中间（`src/router-loop.ts:443-445`）。
- **侧车文件是第二份真相来源，而且刻意在会话日志之外**：`$DSH_HOME/.loop-engine/engines.json`（§3.9）对每一个日志读者（会话列表、fork、压缩、会话日志上传）都不可见，也自带迁移与垃圾回收问题。这是本插件为绕开 harness 的缺口付的代价；向上游要的那半个接缝写在 `docs/proposals/append-ignorable-events.md`，完整证据见 §3.10。
- **preset 与引擎现在是两个不同的事实**：preset 是这个会话的 agent-plane 组合（prompt / 命令 / 技能面），并且只在会话**没有插件记录**时决定引擎（§3.3）。换过引擎的会话，preset 仍是创建时那一份——所以 harness 自己的会话头 preset 标签显示的是 preset，不是引擎，会滞后（§2.2 那条说明仍然成立）。
- **插件刻意绕开了 harness 对会话 composition 的冻结**：harness 给会话定的规矩是"preset 在会话开始后不可变"（`AgentPresets.select` 抛 `agent-preset/locked`，判定与抛点在主仓 `packages/preset/agent-presets/src/index.ts:713-721`），而引擎在 harness 的设计里就是 preset 的函数——于是"给一条已经跑起来的会话换引擎"在 harness 内部没有表达手段，日志那种"插件自有事件"的路也被读取端堵死（§3.10）。插件没有去改主仓，也没有假装这件事不存在：它把这条事实记在自己的记录里，托管引擎之间**原地换手**（不拆会话，§3.7），与 in-process 之间**释放这条会话 + 让页面重载**（因为 harness 那半既不给句柄也不肯被别人接管，见 `docs/per-session-engine.md` §5.4；这次重载是"清掉被 `session/disposed` 标记过的页面状态"的最小动作，进程本身不动），并把两种代价如实写进上面几条。
- **引擎的答案只有两条事实，读取点只有一个函数**（§3.3）：`engineOfSession`（`src/engine-of-session.ts:77-91`）先看插件自己的记录（`:82-83`），**命中记录时连日志都不看**；没有记录才用 `ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })` 读持久化的 `agentPreset` 投影（`:86`）。路由（`createAgent` 的父继承与 `resume`）与插件自己的 Remote 共用它，所以"跑什么"与"显示什么"不可能不一致。会话头记的是**创建时**的 preset，不能单独用来回答"这条会话跑什么"；`ResumeAgentOptions` 也没有任何元数据（主仓 `packages/core/agent/src/index.ts:125-144`）。观察是只读租约（主仓 `packages/session-query/session-query/src/index.ts:139-144`），不取写句柄、不占写锁，`using` 立即释放。deployment 没有组合 `sessionQuery` 时答 `unset`、路由落 in-process（`src/engine-of-session.ts:84-85`，测试 `tests/router-loop.spec.ts:484`）。
- **Remote 的线协议是"参数名即 wire 字段"**：`loopEngine/engine` 与 `loopEngine/select` 都没有主仓 codegen 生成的 strict descriptor，所以网关走 SRC 路径——用 `Function.prototype.toString` 读活方法的形参表当参数名（主仓 `packages/api/gateway/src/index.ts` 的 `methodParameterNames`）。因此 `engine(request)` / `select(request)` 的**形参名就是线字段名**，不能改名、不能解构、不能带默认值；浏览器半那份手写 descriptor（`src/client/session-engine.ts:429-459`）必须声明同一个 wire 名（§4.6）。`tests/engine-remote.spec.ts` 的最后一条测试把这件事钉死（读源码文本断言形参名是 `request`），esbuild 也必须保留形参名（`lib/index.js` 里是 `async engine(request) {`）。
- **provider 路由占位**（§3.6）："部署方已占标签"的识别**结构性 code 优先**（`DUPLICATE_ADAPTER`，主仓 `packages/llm/llm/src/index.ts:429`），消息匹配只是无 code registry 的兜底。
- **同步写盘不可改为异步**（§2.5）：`onChange` 无 await，提交即落盘是重启正确性的前提。同一个 `writeFileAtomicSync` 也服务侧车记录（§3.9），所以改它的 durability 语义会同时影响两处。
- **`hasManagedBlock` 的子串匹配是刻意的、也脆弱**：`includes('# -- dsh-loop-engine managed block')`（`src/patch-manager.ts:87`）意味着用户手写一行同前缀注释也会被当成 managed span 吃掉；无 end 标记时该 span 一直延伸到文件末尾。迁移路径也依赖这个前缀：`managedSpan` 用 `LEGACY_MANAGED_BLOCK_BEGIN.length` 跳过首个标记行（`:112`），所以"带引擎名的新式 begin 标记"即使存在也只会被当成长一行的 begin。
- **空行记账是功能不是洁癖**：`managedSpan` 的 `blankBefore` 与替换时的折叠逻辑保证往返 byte-for-byte（`tests/patch-manager.spec.ts`），改这里先跑那个 spec。
- **hosted preset 是托管产物**：`$DSH_HOME/.agent-presets/loop-engine-<engine>/` 每次启动从当时的 `standard` 重新生成，手改会被覆盖。`stripPresetRows` 只认列 0 的 `- id:` 行结构，主仓 preset 文件若改了行结构会保守地保留该行而不是出错（`src/preset.ts:123-169`）。
- **默认 preset 被本插件占用**：插件在托管引擎为默认期间持有 `agent-presets.default`（§3.5）。用户在设置页另选的默认 preset 会在切回 `in-process` 时被还原值覆盖——这正是"还原部署默认值"的语义，不是丢失。
- **浏览器半不再读 `projectionValues.agentPreset`**：会话头 chip 与 composer 都走插件自己的 Remote（§4.3、§4.6），因为那个投影 hint 是缓存形状的偏值，在换过引擎的会话上会停在创建时的 preset——真实事故是"实际跑 pi、chip 显示 Claude Code"。harness 自己的 preset 标签（主仓 `packages/client/ui-agent-preset`）仍读它、仍会滞后，本插件改不了主仓，所以文档（`docs/per-session-engine.md` §2.2）明确说明这个差别。
- **turn-status 行是 document 级属性，只能由在屏会话带焦点守卫地驱动**（§4.3）：那行的配色/字形由 `<html data-loop-engine>` 驱动（`src/client/turn-status.ts:275` 的样式表；写属性的是 `:333` 的 `reflectTurnStatusEngine`，配合 `:357` 的 `focusTurnStatusSession` 与 `:373` 的 `blurTurnStatusSession`），并且**还要这一轮还在跑**（`<html data-loop-engine-running>`，`:94`、`:408` 写它）——0.1.7 那行收尾后仍留在屏上，只按引擎门控会把字形与扫光留在一条结束的轮次上。**属性不再由缓存写**：`SessionEngineCache.publish`（`src/client/session-engine.ts:704-706`）只通知 watcher，因为属性是 document 级的、写者却不止一个（chip 与 composer 给每个渲染过的会话登记 watcher，切换会话时旧会话迟到的取值照样 publish），"谁最后写谁就是当前会话"因此会把不在屏会话的引擎画到当前会话那一行上（实测：屏上跑 pi、那一行画出 Kimi 的月亮）。驱动者是 chip 与 composer 共用的 hook（`src/client/use-session-engine.ts:79`）：声明焦点 → 按同一个会话 id 连同**这一轮是否在跑**（`session.running`，由两个槽顶层的 `useSession` 读出）一起反射 → 卸载时撤下焦点，**非焦点会话的反射一律无操作**，`legacy` / `unset` / 宿主还没答出来 / 换引擎时缓存被作废这四种反射 `undefined`（删属性、回 harness 原样），绝不猜。它**不是**会话级挂点（样式表要属性选择器，而那一行本身不是 slot）；属性不在卸载时清除——同一会话的另一个界面还在用，残留属性在没有这一行的页面上无害。还有一条 DOM 层的坑：只能写 camelCase 的 `dataset.loopEngine`，写 `dataset['data-loop-engine']` 会被 `DOMStringMap` 的命名 setter 拒绝并抛 `SyntaxError`（`-[a-z]` 不是合法属性名），那会把整条反射路径带塌——`src/client/turn-status.ts:388-392` 的注释与 `tests/session-engine-cache.spec.ts` 的假 `document` 都记着这条。
- **`/goal` 与 `command-goal` 的措辞已统一**：`src/preset.ts:67-73`、`src/engine-kimi/commands.ts:24-28`、`src/patch-manager.ts:19-29`、`tests/patch-manager.spec.ts:51-54` 现在说的是同一套事实——`tool-goal` / `command-goal` 都剥，因为模型面工具只在 in-process loop 驱动下有效，人类命令留在菜单里则背后什么都没有；而 `command-goal` 行住在 preset 层，所以只能在 preset 层剥（`STRIPPED_ROWS` 见 `src/preset.ts:79`）。没有任何托管引擎实现 `/goal`（`src/engine-kimi/commands.ts:24-28`，`KIMI_COMMANDS` 六条见 `:60-67`），所以托管会话里既没有 dsh 的 `/goal`，也没有接替它的引擎命令。
- **harness 自己的 preset 选择器仍会拒绝已启动的会话，这不是缺陷**（§4.4、§3.7）：跑过一轮的会话 composition 已定，`AgentPresets.select` 抛 `agent-preset/locked`（原文 `session "…" has already started; its agent preset is fixed`；判定与抛点在主仓 `packages/preset/agent-presets/src/index.ts:713-721`）——这是 harness 的立场，本插件不去动它，而是**自己另开一条路**：composer 的切换走 §4.6 的 `loopEngine/select`，根本不经过 preset 通道。空白会话的 preset 切换仍会让路由器释放旧 agent 并按新 preset 重建（§3.7 的 `rebuildOnEngineChange`，含"最后一次用户动作胜出"）。
- **两个"循环引擎"选择器语义不同，别当成同一个开关**（§4.3）：设置页写的是**新会话默认值**（settings 段），composer 写的是**这条会话的引擎记录**（§3.9），并会为这条会话重建 agent。默认值改动不影响任何已存在的会话；composer 的改动只影响它那一条会话、且不改默认值。
- **标准座位的两个成员在产物面上要靠结构化重述**（§4.5）：发布出来的 `dsh-client-ui-*` 声明把承载 `SessionStandardProps` / `GlobalStandardProps` 合并的 `import type {}` 抹掉了，所以 `src/client/session-engine.ts` 自己声明 `SessionSeat`。harness 若改了这两个成员的名字或形状，这里要跟着改——它是本插件唯一一处"照运行期事实写类型"的地方。
- **Windows**：构建/测试里的 junction、`rm` 需要重试（`tests/index.spec.ts:206-214`）；preset authoring 的记忆化正是为了避免两条路径并发走同一批文件（§3.8）。
- **测试约定**：`tests/index.spec.ts` 用真实服务栈（SessionStore/SystemPrompt/AgentRegistry/Subprocess/LlmRuntime + 内存 settings provider）起真实 Cordis context；`tests/router-loop.spec.ts` 只用假的 `HostedEngineRuntime`（只记录 create/resume 并回一个句柄，`tests/router-loop.spec.ts:66-115`）钉路由决策，因为那是路由器与引擎之间的全部契约；`tests/engine-remote.spec.ts` 把两者接到一起——真实 `SessionStore` + 真实 JSONL 持久化 + 会真正折叠的投影、一条 header 记 `loop-engine-claude-code` 而日志记 `agent-preset/selected = loop-engine-pi` 的会话，断言 Remote 报 `pi` 且路由器 resume 时构建的是 Pi（这是"显示与路由不可能不一致"的回归钉）；`tests/engine-of-session.spec.ts` 单独钉三态判定与那次读取。按主题分组：路由分发 / resume 路由 / 记账 / 空白期换引擎（`:320`、`:421`、`:510`、`:583`），插件级的分组是 `apply managed block`（`tests/index.spec.ts:418`）、`apply engine presets`（`:574`）、`apply provider routes`（`:707`）、`apply engine remote`（`:830`）、`apply preset steering`（`:881`）、`apply router mount`（`:1125`）；路由器挂载的**重试窗口**单独一组在 `tests/router-mount.spec.ts:196` 起（窗口内释放后成功挂载 / 永不释放则 loud 放弃 / 卸载中途停止重试 / 非冲突错误不重试）。
- **inject 门与「属性读取」守卫**（§3.1 的 `ROUTER_SERVICES`）：cordis 只对**未 inject 服务的属性读取**报错，`ctx.get(...)` 不受约束；而属性读取在**祖先 fiber 的 store 里能兜住**，`agent` 的 scope ctx 是 isolate 边界、兜不住 —— 所以漏一个服务会在「创建 agent 时全绿、第一轮真回合才按 `turn/end` 的 `error` reason 失败」。`tests/router-inject.spec.ts` 因此不只断言路由器自身的 ctx，而是断言**路由器创建的 agent 的 scope ctx** 能解析 `AgentLoop.inject` 的每一项，并显式比对 `ROUTER_SERVICES` 与 `AgentLoop.inject`（不硬编码服务名，harness 上游加服务会直接红）。`tests/router-turn.spec.ts` 是端到端那条：经 `apply()` 起路由器、用 `agentPreset: 'standard'` 跑完一轮 canned 模型回合，断言 `turn/end` 的 `reason.kind === 'completed'`。共享替身在 `tests/helpers/session-projections.ts`（必须真正折叠：`ReactLoopInbox.current()` 每轮回读自己的 cell）与 `tests/helpers/tool-runtime.ts`。

## 8. 跨代兼容：一份产物同时服务 0.1.5 线与 0.1.7 线

本插件从 `0.1.7-rc1` 起，**一个发布产物**同时跑在 harness 的 **0.1.5 线**（`>=0.1.5-rc.1 <0.1.6-0`，三段 `rc` 共用同一套旧 settings API）与 **0.1.7 线**（`>=0.1.7-rc.1 <0.1.8-0`）上。两条线的差异不是版本号而是**API 形状**，所以在**运行期**探测、分叉，而不是发两份包。**本篇讲架构；逐文件的兼容点清单、四种跨代手法、以及"跟着 harness 升级到下一代"的操作清单在 [compatibility.md](compatibility.md)**——升级时先看那一篇。

### 8.1 唯一的代际开关：`src/compat.ts`

`LEGACY_HARNESS` 在模块加载期做一次结构探测：

```ts
import * as dshSettings from '@deepseek-ai/dsh-settings'
export const LEGACY_HARNESS: boolean = 'SettingsProvider' in (dshSettings as object)
```

0.1.5 线的 `dsh-settings` 导出具名 `SettingsProvider` 类；0.1.7 线删掉了它，换成 `SettingsForms` + 每条目 `.volatile()` Config 字段。探测解析到**运行 profile 实际提供的那份** `@deepseek-ai/dsh-settings`。**它只在 node 半使用**：浏览器 bundle 不得引入宿主包（§4.1），所以 `src/client/*` 从不 import 它，客户端另用"两个 inject 回调各自注册"来分流（§8.4）。

用到它的模块（共 5 处，`grep -rn "LEGACY_HARNESS" src/` 应只剩这 5 个加 `compat.ts` 自己）：`src/index.ts`（Config 形态与 settings 接线）、`src/router-loop.ts`（`super` 的 Config）、`src/driver-core/hosted-engine-runtime.ts`（创建公告）、`src/driver-core/system-head.ts`（0.1.5 不补 system 头）、`src/settings.ts`（`.volatile()` 防御）。完整清单见 [compatibility.md](compatibility.md) §4。

### 8.2 逐接缝的分叉

| 接缝 | 0.1.5 线 | 0.1.7 线 |
|---|---|---|
| settings 宿主 | `ctx.settings.installSection(ctx, ns, schema, entry, { setSource, onChange })`（`SettingsProvider`） | `settings.configure({ auto: false })` + `ctx.on('settings/document-updated')` + `config.engine.get()` |
| settings 命名空间 | `'agent-loop-engine'`（`LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL`） | `'loop-engine'`（插件自己的 profile 条目 id） |
| 条目的活字段 | 无：`Config` 只有引擎旋钮，选中值是 settings 段 | `engine` / `showInComposer` 两个 `.volatile()` 字段 |
| 客户端 settings 服务 | `ctx.settingsScope.bind({ namespace, decode })` | `ctx.configForms.get('loop-engine')` |
| agent 创建公告 | `agents.announce(agent)` 同步 + 单独 `emitAgentEvent(…, 'agent/session-start', …)` | `await agents.announce(agent, source, signal)`（即 `agent/created`） |
| `AgentLoop` 并行上限 | `maxParallelToolCalls?: number`（基础 loop 自带默认） | 必填 `Volatile<number>`，`super` 自己钉引用 |
| tool-result 消息 | `role:'user'`，单块 `tool-result` 内嵌 `content` 与 `isError` | 一等 `role:'tool'` 消息，块与 `isError` 在消息本体 |

`src/namespace.ts` 两个字面量并存，浏览器半与 node 半都从这里取，保证两半一致。

`src/settings.ts` 同时导出两族 schema：0.1.5 的 `LOOP_ENGINE_SETTINGS_SCHEMA` + `loopEngineSettingsNamespace()`，与 0.1.7 的 `LOOP_ENGINE_ENGINE_SCHEMA` / `LOOP_ENGINE_SHOW_IN_COMPOSER_SCHEMA`。后者的 `.volatile()` 只在 0.1.7 的 schemastery（3.18.4）存在；0.1.5 的 3.18.1 没有它，但 0.1.5 从不装配这两个字段，所以 `withVolatile` 在 API 缺席时降级返回普通 schema，模块在两代都能安全加载。

`src/driver-core/prompt.ts` 的 tool-result **按结构识别**而非按代际常量：`role==='tool'` 走 0.1.7 读法（`message.content` / `message.isError`），`role==='user' && source.kind==='tool'` 走 0.1.5 读法（`content[0]` 的内嵌块与 `isError`）。两代产出的 transcript 文本逐字节一致，所以 `serializeHistory` 的断言在两代都成立。

### 8.3 依赖声明

`package.json` 的每个 `@deepseek-ai/dsh-*` peer 范围写成 `">=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.1 <0.1.8-0"`；`@deepseek-ai/cordis` peer 放宽到 `^4.0.1`（`Volatile` 类型只在**构建期**用到，0.1.5 线的 cordis 4.0.x 运行期足够）。`devDependencies` 仍钉 `0.1.7-rc.1` 用于本仓库的类型检查与构建；`@deepseek-ai/schemastery` 保持 `3.18.4`（`.volatile()` 只在现代分支需要）。

### 8.4 客户端分流

`src/client/index.ts` 的静态 `inject` 只列两代都有的 `['slots', 'locale']`（`configForms` 与 `settingsScope` 互斥，不能同时列）。`apply` 里注册**两个** inject 回调：`ctx.inject(['configForms'], …)` 装现代页（`configForms.get('loop-engine')` + `whileServed`），`ctx.inject(['settingsScope'], …)` 装 0.1.5 页（`settingsScope.bind` + 直接 register）。哪个服务在，哪个回调就触发；两者都把各自的服务落进同一个 `LoopEngineSettingsTransport`（`src/client/store.ts` 的内部适配接口），所以设置页与 composer 共享同一份 store。图标同理：`import * as primitives` 后运行期取 `IconChevronDownOutlineRegular ?? IconChevronDownOutline14`。

### 8.5 验证两代

- **0.1.7**：`pnpm run typecheck && pnpm run build && pnpm run test && pnpm run test:coverage`（覆盖率仍是 `src/**` 每文件 100%，`src/client/**` 排除）。
- **0.1.5**：`.compat-015/` 是隔离的 0.1.5 依赖集（`pnpm install` 只写它自己的 `node_modules`），`vitest.config.compat015.ts` 把每个 `@deepseek-ai/*` 指向该目录，`npx vitest run --config vitest.config.compat015.ts` 用**同一批 spec**跑 0.1.5。
- spec 侧靠 `tests/helpers/harness-generation.ts`（复刻探测 + `toolResultView` 把两代的 tool-result 读成同一份事实）与 `tests/helpers/fake-settings.ts`（假 settings 服务同时实现 `installSection` 与 `configure`/`mutate`/`describe`；`createLiveLoopConfig` 按代际把"提交默认引擎"写到正确的通道）实现"同一文件两代都过"。

> **覆盖率注释的边界**：只在一条代际上执行的分支（`src/index.ts` 的 legacy settings 接线、`src/router-loop.ts` 的 legacy `super` 形态、`src/driver-core/hosted-engine-runtime.ts` 的 legacy 公告、`src/settings.ts` 的 `.volatile()` 降级）在 0.1.7 覆盖率跑里标了 `/* v8 ignore */`，其真实执行由 `vitest.config.compat015.ts` 那次运行保证——那一次不跑覆盖率，是**功能性**验证。

### 8.6 会话 system 头（`src/driver-core/system-head.ts`）

托管驱动不写 `system/message`（外部 CLI 自带系统提示），所以**从托管引擎起步**的会话没有 surface 头。它一旦后来跑过 in-process，harness loop 会把 `system/message` 追加到**中段**，而 V3→V4 迁移要求 `system/message` 必须是**第一个** surface 事件（`session-format-v3-to-v4/src/relationships.ts` `foldSurface`），整条会话因此被拒（`system/message requires a protected first surface head`，历史加载失败）。

四个驱动在**会话首个 step** 调一次 `appendSystemHeadIfMissing(session, turn, step)`：仅当会话尚无任何 surface 事件时，补一条**空 content** 的 `system/message` 头。头受保护 → 后来的 in-process system 消息是 `replace` 而非错位追加；空 content 被 `deriveEventMessage` 丢弃 → **不进模型历史**，引擎收到的 prompt 不变（`tests/engine-claude/agent.spec.ts` 断言首个 surface 事件就是它）。

该头是 0.1.7/V4 的需求，0.1.5 的 v3 不需要（且本构建在 0.1.5 上驱动不了这个事件、会让回合报错），所以 `appendSystemHeadIfMissing` 以 `LEGACY_HARNESS` 门控，在 0.1.5 上直接返回、不碰任何东西。
