# 提案：让 dsh web 的模型选择驱动托管引擎

> **目标**：在 dsh web 里给某条会话选一个模型（`/model` 弹层或 composer 模型位），让这条会话的**托管引擎真的用那个模型**，而不是由引擎自己的原生配置决定。
>
> **范围**：改动主体在 `dsh-loop-engine`（`src/provider-route.ts`、`src/driver-core/`、四个 `src/engine-*/`、`src/model-selection-reset.ts`、`src/client/`）；另有一处**建议的主仓改动**（`session.selectModel` 的默认值持久化），单独列在 §8。
>
> **与本目录既有提案的关系**：`model-selection-disable.md` 的诉求是"托管引擎下**隐藏**模型选择器"。本提案针对同一问题给出**相反方向的解**：能枚举出模型清单的引擎让它**生效**，枚举不出来的才保持"原生决定 + UI 说明"。该提案 §"建议改动"的第 1 条（引擎能力标志 `consumesModelSelection`）与本提案 §5.5 的"按引擎的 UI 说明"是同一件事，本提案给出了它的判据，因此两篇不矛盾。

## 0. 落地状态（0.1.5-rc3）：方案 A + 透传（方案 C）；方案 B（真目录）仍是升级路径

> **本次改动：模型选择「透传」给引擎（方案 C）。** 用户拍板，取代了下面「惰性不生效」那段结论：**会话选了一条真实 dsh 模型（provider 不是共享标签 `external`，也不是旧四家）时，四个驱动把这条选择原样下发给引擎**，不再静默忽略。共享判据在 `src/driver-core/session-model.ts`（`sessionModelOverrideOf(ctx, session)` → 宿主读法：投影 `modelSelection.pending` 优先，否则最新 `request/header` 的 config；`sessionModelOverride(selection)` 是纯判据），四处消费：
> - **pi**：`--model <provider>/<model>`（pi 的 `--model` 接受 `"provider/id"` 复合串，`pi --help` 实测；复合串自带 provider，故不再下发 `--provider`）。**不恢复探针/目录校验**（`src/engine-pi/probe.ts` 保持删除）。
> - **claude-code**：`Options.model`（裸 model id/alias）。
> - **codex**：`thread/start` 与 `turn/start` 的 `model`（裸 slug）。
> - **kimi**：ACP `session/set_model { sessionId, modelId }`（在 `prompt` 之前发一次，回包是错误帧即失败那一步）。
>
> 选择是 `external/default` 或日志里没有任何选择时**不下发任何模型参数**，用引擎原生默认或部署钉住的 `config.model`（**会话选择优先，pin 回落**）。粒度是**每个驱动 step**，所以中途 `/model` 下一步生效。**透传优先、逐引擎兼容待后续**：插件不替引擎校验模型能不能用（引擎用自己那份凭据/provider 配置解析），引擎拒绝就**如实报错**（不吞）；哪个引擎接受什么串（尤其 pi 是复合串还是裸名 + `--provider`、claude/codex/kimi 的裸 model id 是否要带命名空间）仍需逐个在真 CLI 上击破。测试基线：每个引擎一组「真实模型下发 / `external` 或空不下发 / pin 回落 / 中途改值」断言，kimi 另有一组「`set_model` 报错浮上来」。

**方案 A 仍在**（用户当时拍板）：让模型座**不再显示一个不存在的模型**。

- **四个托管引擎共用一个 provider 标签（`external`）**，该路由广告恰好一条目录条目：`{ provider: 'external', id: 'default', name: 'default' }`（`src/provider-route.ts`，id/name 都取 `HOSTED_DEFAULT_MODEL`，`src/agent-preset-ids.ts`）。**为什么不是每个引擎一条**：浏览器模型目录是**整个 Host 代际共享、不按会话区分**的（`packages/api/session-controller/src/catalog.ts` "Build the browser model catalog without requiring a Session"），每个引擎各占一个标签只会让菜单里出现四条一模一样的 `default`，所以折叠成一条；分组显示名取 `providerInfo().name`，与 wire 上的 id 是同一个 ASCII 串 `external`。
- **四个驱动写进 `request/header` 的模型标签（部署未钉 model 时）就是这个 `default`，provider 都是 `external`**（各自 `PROVIDER` 常量 = `HOSTED_ROUTE_LABEL`；claude 那条 reasoning-only 兜底消息同值）。**id 必须与标签逐字相同**：picker 用目录条目的 `model.id` 与宿主推导的 `model` 比对（主仓 `packages/client/ui-model-selection/src/client/ModelSelect.tsx` 的 `choices`/`selectedIndex`），不一致就回落渲染 `${provider}/${model}`——用户看到的"不存在的模型" `kimi/kimi-native` 正是那次回落。对齐后模型座显示 `default`，且菜单里高亮的是同一条。**早期逐引擎写的四家标签（`claude-code` / `codex` / `pi` / `kimi`）不再被注册**，但 `isHostedProviderRoute` 仍把它们判为托管路由，好让带旧标签的老会话被重置（详见 `docs/per-session-engine.md` §5.2）。
- **`name` 也是固定串 `default`**：`LlmModelInfo.name` 由 picker 原样渲染、没有 i18n 钩子，语义解释放在插件自己的文案里（`hostedEngineModelNotice`，`src/client/locales.ts:115` / `:160`，判据 `isHostedEngine`，渲染点 `src/client/LoopEngineSection.tsx:213`、`src/client/LoopEngineComposerSelect.tsx:375-376`）。
- **pi 的探针/目录校验已删除**（§4.3、§5.1、§5.3 的 pi 部分因此过期）：`src/engine-pi/probe.ts` 与 `tests/engine-pi/probe.spec.ts` 不再存在；`PiLoop` 的 `Config.piCatalogHolder` / `catalog` 字段、`PiAgent.dynamicModel()` / `pickModel()` 全部移除；`src/index.ts` 的 `piCatalogHolder` 与给 pi 单独注入 `listModels` 的分支也移除了。`piProvider` / `piThinking` 两个旋钮与模型目录无关，保留。（**本次改动**把"按会话喂模型"加回来了——但走共享判据 `sessionModelOverrideOf`、**不带任何目录校验**，见本节开头。）
- **结论（已随本次透传改动更新）**：**四个托管引擎都会读 dsh 的模型选择**——选择是一条真实 dsh 模型时把它透传给引擎（pi `--model <provider>/<model>`、claude `Options.model`、codex thread/turn `model`、kimi ACP `session/set_model`）；选择是 `external/default` 或不存在时不下发，用引擎原生配置或部署钉住的 `config.model`。所以引擎的模型不再是"完全由它自己决定"：它有一个默认，外加一条 dsh 给它的覆盖值。
- **顺手兜住了方案 A 带来的默认值污染**（§7.1）：模型菜单把选中的 `default` 存成部署默认后，一条新 in-process 会话的第一轮会打到占位路由上 loud 抛 `HOSTED_ENGINE_ROUTE`。插件现在在两个时刻把会话的选择换成真实模型（`ModelSelectionReset.resetFor` / `guardFor`，`src/model-selection-reset.ts:148-175`；构建那一刻经路由器的 `guardedOptions` 包裹 `setup` 落地，`src/router-loop.ts:336-341`，create `:286` / resume `:313`），取不到真实模型时**只如实 warn 一次**。详见 §5.6 与 §7.1 的现状段。

**方案 B（= 本文档其余章节的设计）**：某个引擎若能**枚举自己的真实模型清单**，就让它的路由广告**真目录**（而不是那一条 `default`），并让该驱动**按会话读** dsh 的选择去驱动引擎。§4 的逐引擎实测（claude `supportedModels()`、codex `model/list`、kimi `session/new` 的 `configOptions`、pi `--list-models`）与 §5.3 的逐引擎做法仍然是可用蓝图，**但有两点已经变化，落地时必须重新设计**：

1. §5.1 那个"可注入 `listModels` 的接缝"**已被删除**（方案 A 让 `HostedEngineRouteAdapter` 固定返回一条 `default`，且四个引擎共用一个 `external` 标签：`src/provider-route.ts`）。真目录必须重新引入一个**引擎中立**的清单来源（按引擎的 holder / provider），并且**必须同时决定那条 `default` 条目去留**——它今天正是"引擎原生默认"在菜单里的名字，而真目录出现后它要么保留为"引擎决定的默认"、要么换成真模型条目。
2. 四个驱动的 `modelLabel()` **今天写死 `default`**。要让 dsh 的选择驱动引擎，`request/header` 必须改记"本步实际交给引擎的模型"（§5.4 的收益仍在），并让引擎的 `spawnSpec` / thread params / ACP `set_model` 读会话选择（§5.3）。

**行号基准**：本仓库 `dsh-loop-engine` 自身检出；主仓引用写作 `packages/...`，对照同级 `../deepseek-harness` 检出（harness `0.1.5-rc.2`）。§4 的行号是撰写时实测；§0 的行号在 0.1.5-rc3 实装时重新核对过，**§4–§12 里其余引用的行号按那时的代码写，方案 B 落地时需重新核对**。


## 1. 结论速览

| 引擎 | 能否按会话喂模型 | 清单能否拿到 | 需要改什么 |
|---|---|---|---|
| **claude-code** | 能。SDK `Options.model` 接受别名或完整 id，直接透传即可（`src/engine-claude/sdk.ts:102`） | **能，但本次未做端到端实测**。SDK 的 `Query.supportedModels()` 返回 CLI 的 initialize 响应里的 `models`（不发模型请求即可拿到，见 §4.1） | 每步把"会话选择 ?? `config.model`"塞进 `spec.model`；在首个真实 step 里顺手 `query.supportedModels()` 填清单 |
| **codex** | 能。`thread/start` 与 `turn/start` 都收 `model`，而线程本来就是**每 step 新建**（`src/engine-codex/agent.ts:630-644`） | **能，且已实测**。app-server 有 `model/list` 方法，本机返回 5 个模型带完整元数据（§4.2） | 给 `AppServerClient` 加一个 `modelList()`；起 app-server 后探一次填清单；每步 `threadParams.model` 用会话选择 |
| **pi** | **不再读**（0.1.5-rc3 撤掉了这套 plumbing，见 §0） | 能（`pi --list-models`，但探针已随 §0 删除） | 方案 B 下：恢复探针/清单 + `sessionModelFor` 读取（§5.3 的 pi 部分已按新现状标注） |
| **kimi** | 能。ACP 会话级 `session/set_model { sessionId, modelId }` 确实存在（装在本机的 `kimi.exe` 里内嵌了实现，§4.4） | **能，而且是白送的**。`session/new` 的响应里带 `configOptions`，其中 `id: 'model'` 的 select 就是全部模型——而 `session/new` 本来就**每 step 调一次** | `newSession()` 顺带返回 `configOptions`；`session/new` 之后、`prompt` 之前按需发一次 `session/set_model` |

**建议实施范围（方案 B）**：codex + kimi 先做（清单已实测/已确认），pi 恢复并收紧；**claude-code 等 `supportedModels()` 在目标 CLI 上实跑确认后再做**（§4.1 末、§9）。拿不到清单的引擎保持"原生决定"并在 UI 上说明——**这一点已经由方案 A 实装**：今天**四个**引擎共用同一句文案（`hostedEngineModelNotice`，`src/client/locales.ts:115` / `:160`），判据是"是不是托管引擎"而不是引擎名。

## 2. 动机

宿主那侧，模型选择**本来就是按会话的、可持久化的、并且会被引擎之外的消费者读**：

- 选择以 `model/selection` 事件落在会话日志里（声明 `packages/api/session-controller/src/types.ts:40`，事件类型注册 `packages/core/session/src/known-event-types.ts:45`），折进 `modelSelection` 投影（`packages/api/session-controller/src/model-selection-projection.ts:39-43`）。
- 宿主用一个按 **agent（≈会话）** 的缓存把该选择装给 agent（`ApiSessionAgentController.selectionFor`，`packages/api/session-controller/src/agent.ts:276`），并在起 turn 前检查"这个 provider 有没有 adapter 服务"（`prompt()`，`packages/api/session-controller/src/commands.ts:322-328`；判定函数 `routeServed` 在 `:653-655`，只读 `ctx.llm.listProviders()`）。
- 起新 turn 的检查**只认 provider**，不认 model：只要 provider 注册过就放行，模型是否存在由 adapter 自己决定。我们的占位路由（`src/provider-route.ts`）注册了这一个共享标签，所以链路是通的——**缺的只是"引擎那一侧真的去读这条选择"**。

也就是说：宿主把"这条会话选了什么"这件事已经完整地提供出来了。**0.1.5-rc3 起四个引擎一个都不读它**（那时 `grep -rn "model/selection" src/` 只剩 `src/model-selection-reset.ts` 这个写者：`resetFor` / `guardFor`）；**本次透传改动把读取补齐了**（共享判据 `src/driver-core/session-model.ts`，四个驱动每个 step 消费，见 §0 开头）。方案 B（真目录）是把"菜单里能选的模型"也换成引擎的真实清单，那是后续的升级路径。

## 3. 宿主侧链路的核对（问题 3 的答案）

按 §2 逐点核对，**没有任何一环会把它当成"全局"的**：

| 环节 | 位置 | 语义 |
|---|---|---|
| 选择写入 | `commands.ts:133-166`（`selectModel`）→ `agent.ts:326-330`（`selectForNextRequest`：`session.append('model/selection', …)` + 装内存态） | **按会话**：写进那条会话的日志，内存态按 agent 缓存（`agent.ts:276-325` 的 `this.selections` Map） |
| 选择读取（宿主） | `agent.ts:276-325` 的 `current` getter | **按会话**：先内存态 `picked` → 再本会话最新 `request/header` → 再 `agentDefaultModel.currentSelection()` |
| 选择退休 | `commands.ts:653` 附近的 `routeServed` 无关；退休在 `index.ts:159-167`（监听 `request/header` 调 `agent.ts:339-350` 的 `consumeSelection`） | **按会话** |
| 起 turn 放行 | `commands.ts:322-328` | **只查 provider 注册**，按会话读选择；不查 model，也不查当前 agent 是哪个引擎 |
| 清单 | `commands.ts:653` 的 `routeServed` 读 `ctx.llm.listProviders()`；目录由 `catalog.ts:16-46`（`buildModelCatalog`，`index.ts:264` 是 RPC 入口）构造 | **按 provider（全局）**，这是对的：模型清单本来就是 provider 级事实，选择才是会话级 |

一个必须写下来的**非显然结论**：`selectModel` 除了装会话选择，**还会把它存成部署默认**（`commands.ts:151-160` → `AgentDefaultModelConfig.saveSelection`，`packages/core/agent-default-model/src/index.ts:100-106`；该校验只要求 provider 已注册）。而部署默认正是**每个新会话**的 `agentOptions`（`agent.ts:490-493` 的 `agentOptions()`）。这条在本提案下会变成真实风险，展开在 §7.1。

**另一个结论**：`selectModel` 只要求 provider 注册、model 原样通过（`commands.ts:136-146` 的 `llm.resolveCallConfig` → `packages/llm/llm/src/index.ts:858-870` → 基类 `resolveModel` 默认返回 `{provider, id: model, name: model}`，`packages/llm/llm/src/index.ts:250-258`）。所以"自由输入模型名"在 **RPC 层面本来就能用**——限制只在 UI：`packages/client/ui-model-selection/src/client/ModelSelect.tsx` 只渲染 `state.groups`，**没有自由输入框**。这是 §6 退路讨论的前提。

## 4. 逐引擎事实（问题 1、2 的答案）

### 4.1 claude-code

**模型怎么传**：`ResolvedConfig.model` → `claudeQueryOptions` 的 `spec.model` → `Options.model`（`src/engine-claude/sdk.ts:102`：`...spec.model === undefined ? {} : { model: spec.model }`），调用点 `src/engine-claude/agent.ts:565-574`（`:570` 是那个展开）。SDK 把它拼成 CLI 的 `--model`，接受**别名**（`sonnet`/`opus`/`fable`…）或**完整 id**（`claude-fable-5` 之类）→ `Options.model?: string`（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1710-1713`）；CLI 侧同义（`claude --help` 实测："Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name"）。**任意字符串都是合法输入**，所以"按会话喂模型"本身不需要新增任何接缝。

**清单**：CLI **没有**列模型的子命令（`claude --help` 的 Commands 段实测：`agents/attach/auth/auto-mode/doctor/gateway/import/install/logs/mcp/plugin/project/respawn/rm/setup-token/stop/ultrareview`，无 `models`）。清单在 **SDK 的 initialize 响应**里：

- `Query.supportedModels(): Promise<ModelInfo[]>`（`sdk.d.ts:2411`，接口 `Query extends AsyncGenerator<SDKMessage, void>` 在 `:2279`）。
- 实现是纯缓存读：`sdk.mjs` 里 `async supportedModels(){return(await this.initialization).models}`——`initialization` 是连接时那一次 `initialize` 控制请求的响应，**不需要发任何模型请求**。
- `SDKControlInitializeResponse.models: coreTypes.ModelInfo[]`（`sdk.d.ts:3446-3453`）。
- `ModelInfo` 有 `value`（喂给 `Options.model` 的值）、`displayName`、`description`、`resolvedModel`（别名行的规范 id）、`supportsEffort`/`supportedEffortLevels`（`sdk.d.ts:1222-1256`）——正好够填 `LlmModelInfo`。
- 注意 `system`/`init` 流消息**不带** `models`，只带当前 `model`（`sdk.d.ts:4412-4430`），所以清单只能走 `supportedModels()`，不能从消息流里捡。

**本次没有端到端实测**（`supportedModels()` 必须先把 CLI 子进程拉起来；用户本轮明确要求"别发起模型调用"，而一个"从不喂用户消息的 query"是否绝对零请求我无法在只读约束下证明），所以这一条标为**待验证**：实现前应先跑一次 `query({prompt: <永不 yield 的 AsyncIterable>, options})` + `await q.supportedModels()` + `q.interrupt()`，确认 (a) 能拿到 `value/displayName`，(b) 进程被干净回收，(c) 不发任何模型请求。

### 4.2 codex

**模型怎么传**：`config.model` 进两处——`ThreadStartParams.model`（`src/engine-codex/agent.ts:630-636`，类型 `src/engine-codex/appserver/types.ts:65-66`）与 `TurnStartParams.model`（`agent.ts:638-644`，类型 `:101`）。关键是**线程本来就是每 step 新建**（`AppServerThread.create(client, threadParams)`，`agent.ts:636`；`appServerClient()` 是跨 step 复用的，`:194-196` 只建一次），所以"每步换模型"天然成立，改一行即可。

**清单**：已实测。`codex app-server generate-json-schema --out <dir>` 产出的协议里存在 `model/list`（request 类型名 `Model/listRequest`，`ModelListParams` = `{cursor?, includeHidden?, limit?}`，`ModelListResponse` = `{data: Model[], nextCursor}`）。我用一个临时脚本（仓库外，已删除）对着 `@openai/codex@0.149.1` 的 `app-server` 子进程发 `initialize` + `model/list`，**不发任何 turn**：

- 响应顶层键 `["data","nextCursor"]`；
- `data[].id` = `["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","gpt-5.2"]`（5 条）；
- 每条带 `displayName` / `description` / `inputModalities` / `supportedReasoningEfforts`（含 `low…ultra`）/ `defaultReasoningEffort` / `isDefault` / `hidden` / `serviceTiers`。

`hidden` 字段可直接映射成"不在选择器里露出"（`includeHidden` 默认 false，服务端已经替我们过滤了一层）。

### 4.3 pi（旧实现，0.1.5-rc3 已删除；方案 B 要按新代码重做）

> ⚠️ 本节描述的实现**已经不存在**（§0）：`src/engine-pi/probe.ts` 与 `tests/engine-pi/probe.spec.ts` 被删除，`PiAgent` 的 `dynamicModel()` / `pickModel()` 与 `PiLoop` 的 `catalog` 字段也没了，`spawnSpec` 只读 `this.config.model`。保留本节只是为了让方案 B 的落地者知道"曾经这样做过、坑在哪"。

当时的做法（供参考）：

- 每步 `spawnSpec()` 里 `--model` 可能来自部署 `config.model`、也可能来自会话选择。pi 的子进程**每步无条件重建**（`rpcClient()`、step 的 finally 都 dispose），所以中途换模型下一步即生效。
- `dynamicModel()` 反向扫 `session.snapshotEvents()` 找**最新**一条 `model/selection`，取 `data.model`。
- `pickModel()` 用 `pi --list-models` 探针的目录校验：候选值要么等于目录条目的 `model`，要么等于其 `provider/model` 全名，否则返回 `undefined` → 落回 pi 原生默认；**目录为空时跳过校验、保留候选**。
- 它的 `config.model` 是回退值，`request/header` 记的是 `config.model ?? 'default'`（标签在 0.1.5-rc3 统一成 `default`），**不镜像**会话选择。

**当时留下、方案 B 不要再犯的两个坑**：

1. **不看 `provider`**：`dynamicModel()` 只读 `data.model`，不比对 `data.provider`。靠目录校验间接兜底（跨引擎的模型名不在 pi 目录里就被丢），语义上应该是"只认发给本引擎的选择"。见 §5.2。
2. **目录为空时保留候选**：探针还没跑完（异步）时会把一个未校验的字符串直接塞进 `--model`。对 pi 最坏是子进程报 "Model ... not found"；对 codex/kimi 不该复制这个折中（§5.2）。

### 4.4 kimi

**模型怎么传（今天）**：`config.model` **只进 request header 标签**（`src/engine-kimi/agent.ts:447-449`），`spawnSpec` 只发 `kimiAcpArgv(bin)` = `[bin, 'acp']`（`src/engine-kimi/agent.ts:496-501`、`src/engine-kimi/process.ts:66-76`，注释明说 "no model flag"）。于是 `src/engine-kimi/loop.ts:33-34` 那句注释（"Model alias for the `kimi` child (`-m`)"）与实现**不符**——`grep -n "this.config.model" src/engine-kimi/agent.ts` 只命中 `:448` 一处。这是本提案要修正的一处文档/行为错位（`config.model` 要么变成真钉住 kimi 模型，要么把注释改成"仅日志标签"）。

**ACP 面**：`kimi acp --help` 只有 `--login` / `--region`（无 `-m`），所以模型只能走 ACP。装在本机的 `kimi.exe` 是打包后的 JS，内嵌源码里能直接读到实现：

- `SET_SESSION_MODEL_METHOD = "session/set_model"`，参数校验 `session/set_model expects { sessionId: string, modelId: string }`，并注册为 ACP request（`…onRequest(SET_SESSION_MODEL_METHOD, parseSetSessionModelParams, (ctx) => getServer().setSessionModel(ctx.params))`）；
- `session/new` 响应里的模型目录由 `buildSessionConfigOptions(...)` 产出，其 `buildModelOption()` 返回：
  ```js
  { type: "select", id: "model", name: "Model", category: "model",
    currentValue: currentBaseModelId,
    options: models.map(m => ({ value: m.id, name: m.name, ...(m.description ? {description: m.description} : {}) })) }
  ```
  另外还会按模型能力追加一个 `thinking` select 和一个 `mode` select。

所以 **kimi 的清单是白送的**：`src/engine-kimi/acp/client.ts:180-184` 的 `newSession()` 现在就每 step 调一次 `session/new`，把响应里的 `configOptions` 读出来即可，**不需要额外进程、不需要额外探针**。`currentValue` 还能当"原生默认模型"的标签用。

要新增的只有一次往返：`session/new` 之后、`prompt` 之前发 `session/set_model`。

## 5. 建议设计

### 5.1 一个按引擎的"清单 + 取值"接缝

> ⚠️ **0.1.5-rc3 起这个接缝已被删除**（§0）：`HostedEngineRouteAdapter` 只接 label、固定返回一条 `default`（`src/provider-route.ts:73-92`）。方案 B 要重新引入一个**引擎中立**的清单来源，形状可按下面这份原始设计。

`HostedEngineRouteAdapterOptions.listModels`（旧形状：`() => readonly PiModelEntry[]`）泛化成一个引擎中立的形状：

```ts
/** 一个托管引擎可选的一个模型，按 harness 选择器看得懂的样子。 */
export interface HostedModel {
  /** 提交给选择器的 id，也是原样交给引擎的那个值。 */
  readonly id: string
  /** 选择器里显示的名字。 */
  readonly name: string
  readonly description?: string
}
```

旧设计里的 `piCatalogHolder` 泛化成 `Record<LoopEngineId, {entries: readonly HostedModel[]}>` 之类的按引擎 holder，`mountProviderRoutes` 给每个引擎传自己的 `listModels`（方案 A 之后 `src/index.ts` 的 `mountProviderRoutes` 已不带任何 options，`:356-383`）。引擎自己的 `provider/model` 拼接留在该引擎的 catalog 里做，`provider-route.ts` 不知道引擎的形状。

**取值（引擎侧）**放进 `src/driver-core/`（引擎无关，四个引擎共用），形状建议：

```ts
/**
 * 这条会话是否给本引擎选了一个模型，选了就返回要交给引擎的值。
 * 只认 provider === 本引擎标签的选择；有目录时还必须能在这条目录里找到。
 */
export function sessionModelFor(
  session: Session,
  provider: string,
  catalog: readonly HostedModel[],
): string | undefined
```

实现要点：反向扫 `session.snapshotEvents()` 找最新一条 `model/selection`（pi 的 `dynamicModel()` 是同一段逻辑，直接搬过来共用）；`event.data.provider !== provider` 直接跳过；有目录且目录非空时要求命中，目录为空时返回 `undefined`（**不要**复制 pi 的"空目录保留候选"）。

### 5.2 统一规则：**不认别的引擎的选择**

一条会话的选择是持久的，而引擎是可以中途换的（`docs/architecture.md` §3.7）。规则必须是：

1. `provider` 必须**等于本引擎自己的标签**。在进程内选过 `meicloud/deepseek-flash` 的会话切到 claude-code 时，这条选择（provider `meicloud`）不该被任何一个托管引擎读走——今天 pi 是靠"目录里没有"间接丢掉的，改成显式判据后语义清楚且对别的引擎更安全。
2. 有目录时，`model` 必须命中本引擎的目录。这样"开着 kimi 会话选了 `claude-code/…` 这种标签"的结果是**忽略**（kimi 用原生默认），不是把 `claude-code/claude-sonnet-5` 当 kimi 模型名喂进去。
3. 目录为空（还没探到 / 探针失败）→ 本步忽略选择、用 `config.model` 或引擎原生默认。选择是持久的，下一步目录就绪后自然生效。

### 5.3 每引擎的具体做法

**codex**（推荐先做）

- `src/engine-codex/appserver/client.ts`：加 `async modelList(params?: ModelListParams): Promise<ModelListResponse>`（`:132` 附近，与 `threadStart` 同款，走私有 `request`），并在 `types.ts` 补 `ModelListParams` / `ModelListResponse` / `Model`（可从 `codex app-server generate-json-schema` 的输出抄，只需驱动用到的字段）。
- 清单来源：`appServerClient()`（`agent.ts:194-196`）**首次建立时**探一次，写进引擎的 holder；失败（app-server 版本没有该方法、spawn 失败）→ 空目录，功能退化为"原生决定"，只 warn 一次。
- 取值：`const model = sessionModelFor(this.session, PROVIDER, this.catalog) ?? this.config.model`，替换 `agent.ts:634` 与 `:642` 的两处 `this.config.model`。
- 可选增强：`Model.supportedReasoningEfforts` 映射成 `LlmModelInfo` 的…注意 harness 的 `LlmModelInfo` 没有 reasoning 字段（reasoning 走 `resolveModel` 的 `LlmResolvedModelInfo`），本提案**不做**（§9）。

**kimi**

- `src/engine-kimi/acp/client.ts:180-184` 的 `newSession()` 改成返回 `{ sessionId, configOptions }`；从 `configOptions` 里找 `id === 'model'` 的 select，把 `options[].{value,name,description}` 映射成 `HostedModel`（缓存进 holder，供 `listModels` 用），`currentValue` 可作为原生默认标签。
- `types.ts` 补 `AcpSessionConfigOption`（`{type,id,name,category,currentValue,options[]}`）。
- `src/engine-kimi/agent.ts`：`step()` 里 `newSession`（`:541`）之后、`prompt`（`:554`）之前，若 `sessionModelFor(...)` 有值且不在 kimi 当前模型上，发一次 `session/set_model { sessionId, modelId }`（client 加一个 `setSessionModel()`）。
- 顺带修正 `loop.ts:33-34` 的 `model` 文档：让它成为"钉住的 kimi 模型（经 `session/set_model` 下发）"，或在探针未就绪时的回退值。

**claude-code**（清单确认后再做）

- 取值：`agent.ts:565-574` 把 `...this.config.model === undefined ? {} : { model: this.config.model }`（`:570`）换成 `model: sessionModelFor(this.session, PROVIDER, this.catalog) ?? this.config.model`。
- 清单：**在首个真实 step 里顺手采**（推荐）——`const query = officialQuery(...)`（`agent.ts:575`）之后 `void query.supportedModels().then(list => holder.entries = map(list))`，失败静默；好处是零额外进程，代价是"弹层里第一次要等一次对话之后才有目录"。备选是 §4.1 的独立探针子进程，可在引擎挂载时预热。**两条都必须在实现前先确认**：(a) `supportedModels()` 与同时消费消息流是否安全（它走的是同一条 transport 上的控制请求，SDK 侧另有一条控制通道，但要在真实 CLI 上验证不抢帧）；(b) 目录的刷新时机——`supportedModels()` 返回的是**连接时**那一份快照，部署改了模型白名单不会自动反映，这与 pi 的"挂载时探一次"是同一种取舍，文档里要写明。
- 目录为空时的退化与 codex/kimi 一致（忽略选择）。注意 pi 的"空目录保留候选"在这里更危险：Claude 的 `--model` 收到一个不存在的名字会让整个 query 失败，所以**必须**保守。

**pi**

- 把 `dynamicModel()` 换成 `sessionModelFor(this.session, PROVIDER, this.catalog)`；`config.model` 仍是回退值。**注意 0.1.5-rc3 已经把旧的 `dynamicModel()`/`pickModel()` 连同探针一起删了**（§0），所以这一步是"重新实现"而不是"改造"，并且要同时决定那条 `default` 目录条目的去留。

### 5.4 `request/header` 与标签语义（建议，可选）

**0.1.5-rc3 已经把标签统一成 `config.model ?? 'default'`**（`HOSTED_DEFAULT_MODEL`；各自 `modelLabel()`：claude `src/engine-claude/agent.ts:505-506`、codex `:573-574`、kimi `:451-452`、pi `:482-483`），理由也从"它从不驱动查询"改成"id 必须与目录条目的 id 逐字相同"（§0）。方案 B 要再进一步：

建议把 `modelLabel()` 改成"**本 loop 实例实际交给引擎的模型**，没有就用原生哨兵"。收益：

- 弹层/座位在 `pending` 被消费后从 header 取值时（`agent.ts:288-305` 的 `current` getter）显示的是真相；
- `consumeSelection`（`index.ts:159-167`）能把匹配的 pending 正常退休，而不是永远挂着。

注意 `assertRequestHeader()` 每个 loop 实例只落一次（首个 step 前），所以中途 `/model` 不会刷新 header——这不影响正确性（内存态 `picked` 优先，重载后由投影的 `pending` 复原），但要在文档里写明。

### 5.5 UI 文案按引擎分流

**0.1.5-rc3 已实装**：那张文案已改名 `hostedEngineModelNotice`（`src/client/locales.ts:91` 声明、`:115` 中文、`:160` 英文），判据换成 `isHostedEngine`（`src/agent-preset-ids.ts:52`），渲染点 `src/client/LoopEngineSection.tsx:213`、`src/client/LoopEngineComposerSelect.tsx:375-376`——即**任何**托管引擎都显示它，不再写死 `claude-code`。方案 B 要做的是"按引擎分流"：有真目录的引擎改成"本会话选择的模型会驱动该引擎"。这正是 `model-selection-disable.md` 想要的 `consumesModelSelection` 标志，判据是"该引擎是否消费选择"。

### 5.6 `model-selection-reset.ts` 的加固（新语义下必须做）

**0.1.5-rc3 已实装加固**：`resetFor`（`src/model-selection-reset.ts:148-158`）和新增的 `guardFor`（`:172-174`，harness loop 构建会话时经 `guardedOptions` 调用）都不会把托管标签写进日志；默认值本身是托管标签时改取 composition 声明的真实模型（`configuredDefault`，`:303-310`）并如实报一次 warn。下面两条是当时的分析，第 1 条已按此处理。

原文分析：`ModelSelectionReset.resetFor` 在会话被切回 `in-process` 时，把 `agentDefaultModel.currentSelection()` 写成 `model/selection`。新语义下它有两条新问题：

1. **它写入的值本身可能就是托管标签**（§7.1 的污染）。若 `currentSelection().provider` 是托管路由标签（`external` 或旧四家），这次重置会把一个**已知不能用的值**当作"部署默认"写进会话日志——看似修好了，实则下一次 in-process 请求仍打到占位路由上 loud 抛 `HOSTED_ENGINE_ROUTE`。加固：**默认值是托管标签时不写**，按既有 `unavailable()` 那套只 warn 一次（`:198-203`），并且警告文案要说清"这条会话仍然不可用，根因是部署默认模型被托管标签占了"。**这不是修复，只是不再自我欺骗**；真正的解在 §7.1 的插件侧缓解或 §8 的主仓改动。
2. `currentSelection()` 的语义没变，判断仍成立——托管引擎侧真的去调模型的是 in-process 那一半，重置依然需要。

## 6. 拿不到清单时的退路

前提（§3 末）：**dsh web 的自带选择器没有自由输入框**，`ModelSelect.tsx` 只渲染 `groups`。所以"让用户自己敲模型名"**不是**现成的退路。可选做法，按代价排序：

1. ~~**保持现状 + UI 说明**：不注入 `listModels`，目录为空 → 组被丢掉 → 选择器里看不到这个引擎。~~ **0.1.5-rc3 选了另一条**：广告**恰好一条 `default`** 条目（目录非空、引擎因此出现在菜单里、模型座显示 `default`），并用 `hostedEngineModelNotice` 说明它（§0、§5.5）。空目录那条路会让选择器继续回落渲染原样串，而那正是要修的 bug。
2. **插件自带一个模型名输入框**：`LoopEngineComposerSelect.tsx` 已经是插件自己的座位，客户端那半本来就能注入 `sessions`（先例 `src/client/reload.ts:213`），所以可以自己调 `session.selectModel({ provider: <本引擎标签>, model: <用户输入> })`——§3 已确认 RPC 层对任意模型名放行。代价：多一套 UI + 同样的默认值污染（§7.1）+ 输入错误只能靠引擎报错。
3. **不注入目录但注入一条"占位条目"**：不可行——选择器提交的是固定 id，用户没法改成别的值，等于把所有人钉在同一个假模型上。

## 7. 风险

### 7.1 `selectModel` 会把选择存成**部署默认**，而托管标签不是模型端点

证据链：`commands.ts:151-160`（`selectModel` → `agentDefaultModel.saveSelection`）→ `packages/core/agent-default-model/src/index.ts:100-106`（写 settings 的 `agentDefaultModel` 段）→ `agent.ts:490-493`（`agentOptions()` 用它给**每个新会话**装 `{provider, model}`）。而 `selectModel` 的校验只要求 provider 注册（`:136-146`），占位路由**注册了**，所以这条写入不会被拦。

后果：用户在任意一条会话里选了 `claude-code/sonnet`，**部署默认模型**就变成 `claude-code/sonnet`。此后新建的会话若跑 **in-process**（默认引擎），它的第一轮请求就是这个 provider/model → 命中占位路由 → `src/provider-route.ts:87-92` loud 抛 `HOSTED_ENGINE_ROUTE`，**第一轮就失败**。

- **方案 A 已经把它从假想变成真实**：菜单里出现了四个引擎的 `default` 条目，随便选一次就把部署默认改成 `<engine>/default`。
- 托管引擎之间**不会**出这个问题：会话选择是真实 dsh 模型时驱动把它**透传**给引擎（§0 开头），不是拿它当部署默认去调模型；引擎拒绝则那一步报错。
- **插件侧的缓解已实装（0.1.5-rc3）**：不是在 `session/created` 上补写——宿主是在**调用方的 `setup` 里**装会话选择的（`composeAgent` → `installSelection` → `selectionFor`），所以路由器的 `guardedOptions`（`src/router-loop.ts:336-341`，create `:286` / resume `:313`）在 `setup` **之前**先跑 `guardFor`，让写进去的 `model/selection` 正是宿主会读到的那一条（`src/model-selection-reset.ts:172-174`）。等价于原来的设想，但时机更准：写晚了宿主读不到。
- **写入值不看"记得的上一次"**：部署默认本身是托管标签时，改取 composition 声明的真实模型（settings 描述符的 `base` 层，`configuredDefault`，`src/model-selection-reset.ts:303-310`）——`packages/bundle/base/cordis.patch.yml` 给 `agent-default-model` 行配的就是真实模型。这比"记住上一次"更可靠：进程重启、插件刚装上时它都在，冷启动洞因此小得多；**仍然存在的洞**是"composition 自己就配了托管标签或读不到 settings"——那时插件只如实 warn 一次（`unavailable`，`:325-332`），会话保持它日志里的选择，第一轮仍会失败。
- **修复是逐会话的，不是全局的**：插件不改部署默认本身（那是用户的设置，插件无权改写），所以每一条新 in-process 会话都会被同一个守卫照看一次：默认一直指着托管标签时，会话照常能跑，代价是设置里那个值一直是坏的、每次构建多一次 warn 之外的写入。**根治要动主仓（§8）**：让 `selectModel` 跳过"只服务 provider 路由、不服务模型"的 adapter。

### 7.2 跨引擎选择

按 §5.2 的规则处理：provider 不匹配 → 忽略；provider 匹配但模型不在目录 → 忽略。最坏情况是"用户以为换了模型、其实引擎用的是原生默认"，而这正是今天 claude-code 的行为，属于可接受的退化——但**必须在 UI 上说出来**（§5.5），否则就是静默失效。

### 7.3 中途换模型

四个驱动都**在构造时**持有 `session`（claude `agent.ts:146`、codex `:173`、kimi `:134`、pi `:147`，都是构造参数 `public readonly session: Session`），且模型**不是构造期冻结的**：每一步都能现读会话日志（见下）。所以"每个 step 读一次会话选择"理论成立——**唯一的构造期冻结是 `config.model`**，而它在新设计里只是回退值。

坑位（**四个引擎的粒度是一样的，措辞要说准**）：

- 旧文档里"每 step 读一次会话选择"这句话要打个折扣：四个引擎都会在**一次 query / 一次子进程或 ACP 会话之内**用 `beginSegment` 轮转出多个**持久 step**（claude `agent.ts:491-498` 调用点 `:654`/`:716`；codex `:158` 调用点 `:768`/`:816`/`:845`/`:856`/`:867`；kimi `:639` 调用点 `:652`/`:663`/`:674`/`:702`；pi `:135` 调用点 `:807`）。而模型参数是在**每个驱动 `step()` 的开头**取一次的（claude `agent.ts:565`、codex `:630-644`、kimi `:496-501`+`:541`、pi `:537-560`），一个 `step()` 恰好对应一次 query / 一个新 thread / 一次 `session/new` + `session/set_model` / 一次 `pi --mode rpc` 子进程。所以**粒度是"每个驱动 step"，不是"每个持久 step"**——一次 query 内部被轮转出来的那几步不重读（读也来不及：query 已经在跑了）。
- 落到用户可见行为：会话中途 `/model` 换模型，**下一个驱动 step 生效**（通常是下一轮用户输入，或工具循环里 `step()` 的下一次调用），不需要重建会话，也不需要重启 dsh web。claude 的 query 与 pi 子进程的生命周期各自更长/更短（pi 每步无条件重建：`rpcClient()` `:175-179`，finally `:920-921`），但都收敛到同一条粒度。

### 7.4 与既有 `model-selection-reset` 的语义冲突

见 §5.6。另注意 `docs/architecture.md:219`、`:246`、`docs/per-session-engine.md:209-214` 里"那些引擎原生持有模型、也不读这条选择"的措辞在本提案落地后**全部过期**，必须同步改（§9 的工作量里含这一项）。

## 8. 建议的主仓改动（可选，§7.1 的根治）

`session.selectModel` 在持久化"部署默认"之前，应当跳过一个**只服务 provider 路由、不服务模型的 adapter**。最小形状（命名词请主仓定）：给 `LlmAdapter` 加一个能力标志，例如

```ts
/** Whether this route can serve a real model call, or only exists so a provider id resolves. */
servesModelCalls(): boolean   // 默认 true；占位路由返回 false
```

`commands.ts:151-160` 据此跳过 `saveSelection`（会话选择照写）。这比"插件侧猜"精确，还能顺带解决 §7.1 的冷启动洞；**0.1.5-rc3 之后它是这条链上唯一的根治点**：插件侧的守卫只能逐会话把坏默认顶掉，改不了设置里的那个值（§7.1 末条）。

## 9. 工作量估计

| 工作项 | 估计 |
|---|---|
| `provider-route.ts` + `index.ts` 的 holder 泛化（含 `provider-route.spec.ts` / `index.spec.ts` 更新） | 0.5 天 |
| `driver-core` 的 `sessionModelFor`（共用读取 + provider/目录校验，含 spec） | 0.5 天 |
| codex：`modelList()` + 探测 + 每步模型（含 `appserver` spec / `agent.spec` / schema 类型） | 1 天 |
| kimi：`newSession` 返回 `configOptions` + `setSessionModel()` + 每步模型 | 1 天 |
| claude：`supportedModels()` 采集 + 每步模型（**前置**：实跑确认，§4.1） | 0.5–1 天 |
| pi：换成共用函数 + 去掉旧的目录校验分支（`engine-pi` spec 要改断言） | 0.5 天 |
| `model-selection-reset` 加固（拒绝托管标签，§5.6） | 0.5 天 |
| §7.1 的新会话缓解（若采纳插件侧那一条） | 0.5–1 天 |
| client 文案按引擎分流（locales + 两处渲染点 + spec） | 0.5 天 |
| 文档：`architecture.md` §3.6/§3.7、四篇 `engine-*.md`、`docs/per-session-engine.md` §5.2、本提案的落地状态 | 0.5 天 |

合计约 **6–7 天**，其中相当一部分是测试——本仓库 `pnpm run test:coverage` 对 `src/**` 是**逐文件 100%**（`src/client` 除外；见容器根 `../AGENTS.md` 的 dsh-loop-engine 一节），每个引擎都要补"有选择/无选择/目录未就绪/目录不命中/provider 不匹配"几条路径。

## 10. 测试与验收要点

- **共用函数**（`sessionModelFor`）：最新一条 `model/selection` 胜出；`provider` 不匹配 → undefined；目录命中/不命中；目录为空 → undefined；日志里没有该事件 → undefined。
- **每引擎**：(a) 会话选了本引擎的模型 → 该模型出现在 CLI argv / thread params / ACP `set_model` 参数里；(b) 没选 → 用 `config.model`，`config.model` 也没有 → 用原生默认（且**不**给引擎传任何模型参数）；(c) 选了别的引擎的标签 → 忽略（(b) 的行为）；(d) 目录未就绪 → 忽略。
- **清单**：目录里的条目确实出现在 `HostedEngineRouteAdapter.listModels` 的返回里，且 `id` 与引擎实际收到的值**逐字相同**（这是最容易错的一环：pi 用 `provider/model` 全名，codex 用 `id`，kimi 用 ACP `value`，claude 用 `ModelInfo.value`）。
- **端到端（keyless 不可能，需真实引擎）**：一条已存在的会话，第一轮用默认模型，中途 `/model` 换一个，下一轮确认引擎真的换了（codex 看 `thread/start` 参数、kimi 看 `session/set_model`、claude 看 `Options.model`、pi 看 argv）。
- **回归**：切回 in-process 仍写回真实默认（`model-selection-reset.spec.ts`）；新会话拿到健康默认（§7.1 的缓解路径）。

## 11. 明确不做的事

- **不把 reasoning effort 一并做**。harness 的 `LlmModelInfo`（目录条目）没有 reasoning 字段，reasoning 只在 `resolveModel` 的 `LlmResolvedModelInfo` 里（`packages/llm/llm/src/index.ts:250-258` 的基类返回 undefined）。要给目录条目带 reasoning，得让占位 adapter 覆写 `resolveModel`——那是另一件事（codex 的 `supportedReasoningEfforts`、kimi 的 `thinking` select、claude 的 `supportedEffortLevels` 都已经在手里，做起来不难，但会让 §10 的验收面翻倍）。
- **不解析模型质量/能力元数据**（context / max-out / images），与 `docs/superpowers/specs/2026-09-07-pi-model-selection-design.md` 的既有决定一致。
- **不动 harness 的 `packages/client/ui-model-selection`**（只读仓库）；插件自己的文案分流在插件那半做。
- **不给引擎加"选择器"以外的模型入口**（§6 的第 2 条只作为需要时的备选）。

## 12. 本次调研实际跑过的探测

| 命令 | 结果摘要 |
|---|---|
| `claude --help` | 有 `--model <model>`（别名或完整名）；**无** `models` 子命令（Commands 段只列 `agents/attach/auth/auto-mode/doctor/gateway/import/install/logs/mcp/plugin/project/respawn/rm/setup-token/stop/ultrareview`） |
| `codex --help` / `codex exec --help` | `codex exec` 有 `-m, --model <MODEL>`；顶层无列模型子命令（`agents/exec/review/login/logout/mcp/plugin/app-server/remote-control/app/completion/update/doctor/sandbox/debug/apply/resume/queue/archive/delete/migrate-rollouts/unarchive/fork/cloud/exec-server/features/help`） |
| `codex app-server generate-json-schema --out <tmp>` | 协议里有 `model/list`（`ModelListRequest` / `ModelListParams` / `ModelListResponse` / `Model`） |
| 临时 node 脚本（仓库外，已删）对 `@openai/codex@0.149.1` 发 `initialize` + `model/list` | `{data, nextCursor}`；`data` 5 条：`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-5.2`，带 `displayName`/`description`/`inputModalities`/`supportedReasoningEfforts`/`isDefault`/`hidden`。**未发起任何 turn** |
| `kimi --help` / `kimi acp --help` / `kimi provider --help` | 顶层有 `-m, --model`；`kimi acp` **只有** `--login`/`--region`（无模型入口）；`kimi provider` 只有 add/remove/list/catalog |
| `grep -a` 检索 `kimi.exe` 内嵌源码 | `session/set_model`（参数 `{sessionId, modelId}`）、`availableModels`、`currentModelId`，以及 `buildSessionConfigOptions` / `buildModelOption` / `buildThinkingOption` / `buildModeOption` 的函数体（见 §4.4 引文） |
| `pi --list-models` | 表格：`provider model context max-out thinking images`；本机一条 `meicloud deepseek-flash` |
| 读取 `node_modules/@anthropic-ai/claude-agent-sdk/{sdk.d.ts,sdk.mjs}` | `Query.supportedModels()`（`sdk.d.ts:2411`）实现为 `(await this.initialization).models`（`sdk.mjs`）；`Options.model?: string`（`:1710-1713`）；`ModelInfo`（`:1222-1256`） |
| `grep -rn "model/selection" src/` | 读者只有 `src/engine-pi/agent.ts:508`（+ 写者 `src/model-selection-reset.ts`） |

**未跑**（受"只读、不发模型调用"约束）：claude 的 `supportedModels()` 实跑、kimi 的 `session/new` 实跑（会创建 kimi 会话）。这两条是实施前必须补的第一步验证。
