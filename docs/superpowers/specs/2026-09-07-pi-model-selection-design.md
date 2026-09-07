# Pi 引擎在 dsh web 页面切换模型 — 设计

**目标**：让运行在 Pi loop engine 上的会话，能通过 dsh 原生的 `/model` 弹层与 composer 模型位切换 Pi 的推理模型，且该选择真实驱动 Pi 子进程的 `--model`。

改动全部收在 `dsh-loop-engine` 插件内（`src/provider-route.ts` + `src/engine-pi/`），**不修改主仓 harness**。

## 背景与问题

- Pi 引擎把模型经 `cordis.yml` 的 `model` 配置项传给 PiLoop → `spawnSpec()` 拼进 `pi --mode rpc` 的 `--model`（`engine-pi/agent.ts`）。这是**部署配置，读一次定死**，运行时 `/model` 怎么改都碰不到。
- Pi 引擎的 provider 路由占位是 `HostedEngineRouteAdapter`，其 `listModels` 继承空数组 → `/model` 目录构建丢弃该空组（主仓 `catalog.ts`），所以弹层不显示任何 Pi 模型。
- Pi 引擎**刻意**不镜像 harness 的会话模型选择到 header（`engine-pi/agent.ts` 注释），因为它从不驱动查询。
- RPC 客户端**跨 step 复用**且 `specsEqual` 逐项比 argv（`engine-pi/agent.ts`）：只要 spawn 参数变为新模型，argv 变 → 子进程 respawn → 新模型生效。

## 可行性验证（已完成）

`pi --list-models [search]` 是 Pi CLI 提供的列模型命令（README CLI Reference）。实测输出为列对齐表格：

```
provider   model                                   context  max-out  thinking  images
anthropic  claude-sonnet-4-6                       1M       128K     yes       yes
deepseek   deepseek-v4-pro                         1M       384K     yes       no
```

动态发现**可行**：subprocess spawn `pi --list-models`，按空白切分解析表格前两列（`provider` / `model`），即得模型清单。

## 架构闭环

```
/model 弹层 / composer 模型位
        │
        ├─ modelCatalog ─► PiAdapter.listModels()  ◄─ 读挂载缓存（挂载时 spawn pi --list-models 解析）
        │                        │
        └─ selectModel ───► 写会话日志 model/selection 事件（主仓 session-controller/agent.ts）
                                     │
                                     ▼
                        PiAgent.spawnSpec() 读本会话最新 model/selection 的 model
                            → 覆写 config.model → 拼 `--model <id>`
                            → specsEqual 检测 argv 变化 → respawn 子进程
```

## 决策（已确认）

1. **Provider 分组：单一 `pi` 组**。组内每项模型 id = `provider/model` 全名（如 `anthropic/claude-sonnet-4-6`），`--model` 原生支持这种 `provider/id` 形态。不与 harness 已有的真实 provider 组（`anthropic`/`deepseek` 等）冲突。
2. **探针缓存：挂载时缓存**。PiLoop 挂载时跑一次 `pi --list-models`，结果存内存；`PiAdapter.listModels` 读缓存，不现场 spawn。
3. **选择流链路：`PiAgent.spawnSpec` 读 `model/selection` 事件覆写** `config.model`。改动局部，`specsEqual` 自动触发 respawn，resume 重放日志能恢复选择。

## 改动清单

### 1. `src/engine-pi/types.ts` — 扩展 `ResolvedConfig`

新增字段，供驱动与 adapter 共享探针结果：

```ts
interface ResolvedConfig {
  // ...既有字段
  /** 部署声明的模型来源刷新策略；缺省仅挂载时探针一次。 */
  readonly modelCatalogRefresh?: 'never' | 'mount' | 'session-start'
  /** 探针结果（provider/<id> 全名清单）；由 PiLoop 挂载时填充。 */
  readonly listModels?: () => readonly PiModelEntry[]
}
```

> 次要：`modelCatalogRefresh` 是可选配置，默认 `mount`。若部署对探针结果新鲜度有要求可调成 `session-start`（每次 agent 装配时刷新），本文档默认 `mount`。

### 2. `src/engine-pi/loop.ts` — 挂载时探针 + 注入缓存

- 新增 `runPiModelProbe(bin, spawn): Promise<readonly PiModelEntry[]>`，spawn `pi --list-models`（stdin 关闭、不传 prompt），解析 stdout 表格；失败返回空数组并 log warn（探针失败不阻塞引擎挂载 —— 模型目录为空体，`/model` 显示"无可选模型"兜底）。
- `PiLoop` 构造时（`resolveConfig` 附近）若 `config.modelCatalogRefresh !== 'never'` 则触发探针，把结果存到 `config.listModels` 闭包。
- `ResolvedConfig` 用函数闭包承载探针结果，避免把可变数组直接暴露成配置。

### 3. `src/provider-route.ts` — Pi adapter 覆写 `listModels`

- 把 `HostedEngineRouteAdapter` 扩展为可注入"模型清单 provider"的形态（或对 Pi 单独构造一个子类）：
  - `listModels()` 返回 `config.listModels?.()` 的结果，映射成 `LlmModelInfo`（`provider: 'pi'`，`id: 'provider/model'`，`name: 'provider/model'`）。
  - `stream()` 仍抛 `HOSTED_ENGINE_ROUTE`（Pi 原生持有模型，真有查询路由到这里是接线 bug）。
- `mountProviderRoute`（`src/index.ts`）构造 Pi adapter 时，把 `config.listModels` 作为 `listModels` 源传入。

### 4. `src/engine-pi/agent.ts` — `spawnSpec` 读会话选择

- `spawnSpec()` 计算 `--model` 时，优先取本会话日志最新 `model/selection` 事件的 `model`，覆写 `config.model`：
  - 新增 `private dynamicModel(): string | undefined`，扫 `this.session.snapshotEvents()` 反向找最后一条 `type === 'model/selection'` 且含 `model` 的事件。
  - `spawnSpec` 里 `const model = this.dynamicModel() ?? this.config.model`，再按既有 `model`+`thinkingLevel` 拼接规则生成 `--model`。
- 若事件里 `model` 为空字符串（如 selectModel 被清空），回退 `config.model`。

### 5. 日志 / 文档

- `docs/engine-pi.md` 增补新配置项、`--model` 动态来源、探针流程。
- `docs/proposals/model-selection-disable.md` 是"隐藏选择器"的旧提案，与本设计方向相反（本设计是**让选择器生效**），保留但标注两者对 Pi 的关系：claude-code 仍不可选，Pi 现在可选。

## 边界与不做的事

- **`selectModel` 校验（已验证通过）**：主仓 `session-controller` 的 `selectModel` 调 `llm.resolveCallConfig`（`llm/src/index.ts:832`）→ `resolveModelInfoFor` → `HostedEngineRouteAdapter.resolveModel`（继承基线 `{ provider, id, name }`，无 reasoning）。该基线返回合法且无上下文的模型信息，**不会**因缺模型元数据抛 `model-unavailable`；且无 reasoning ⇒ `resolveCallWithInfo` 对 `reasoningEffort` 的检查也不触发。因此 `/model` 提交在 host 侧放行。Pi driver 的 `stream`（真实查询被错误路由时）仍抛 `HOSTED_ENGINE_ROUTE`，advisory 与解析互不干扰。
- **不改变 claude-code / codex / kimi 引擎**：它们仍保持"模型原生决定"，`/model` 不显示其模型（现状不变）。
- **probe 失败不报错**：模型目录为空，`/model` 显示"无可选模型"，引擎照常工作。
- **不做 UI 层面新增控件**：完全复用原生 `/model` 弹层与 composer 模型位。
- **不做模型质量/能力标注**：`listModels` 只提供 `id/name`，不解析 `context/max-out/thinking/images` 列（这些不进入 `LlmModelInfo` 的公开契约）。

## 测试要点

- 新增 `tests/engine-pi/probe.spec.ts`：解析 `--list-models` 表格 → `PiModelEntry`；`--list-models` 失败/非零退出 → 空数组不抛。
- `tests/engine-pi/agent.spec.ts` 增补：会话含 `model/selection` 事件时 `spawnSpec` 用它覆写 `config.model`；无事件或事件为空时回退 `config.model`；argv 变化触发 `specsEqual=false` → respawn（沿用既有复用断言）。
- `tests/provider-route.spec.ts` 增补：Pi adapter `listModels` 返回注入的清单，`stream` 仍抛 `HOSTED_ENGINE_ROUTE`。
- `tests/engine-pi/loop.spec.ts` 增补：`runPiModelProbe` 成功返回解析后的 `PiModelEntry`，失败返回空数组不抛。
- **已知已验证**：`selectModel` RPC 对 `pi` 占位路由放行（见「边界与不做的事」首条），无需在插件侧加白名单/校验绕行。

## 影响面

- 不触碰 harness（除非风险验证暴露必须改 host 的 `selectModel`，那将作为单独的 harness 变更提出）。
- 影响 Pi 引擎模型选择路径；其余引擎与 in-process 不变。
