# 跨代兼容：兼容点清单与升级手册

> 读者：下一次要跟着 harness 升级的人（很可能是未来的你）。
> 目标：**升级时不用满仓库找"哪里是跟着 harness 版本走的"** —— 打开这一篇就能拿到全部位置、判断手法是否还成立，并照着 §6 的手册走一遍。

`docs/architecture.md` §8 讲的是**为什么要这么设计**（架构层面的解释）；本篇是**可操作的清单与手册**。两篇互相引用，重复的部分以本篇为准。

---

## 1. 现状：一个产物服务三代

从 `0.2.0-rc1` 起，**同一个已发布产物**同时跑在三代 harness 上：

| 插件版本 | 目标 harness | 说明 |
|---|---|---|
| `0.2.0-rc1`（当前） | `>=0.1.5-rc.1 <0.1.6-0` **或** `>=0.1.7-rc.1 <0.1.8-0` **或** `>=0.2.0-rc.1 <0.2.1-0` | 三代由运行期探测分流；每条线内的新 `rc` 由同一段并集范围覆盖，**插件无需改版** |
| `0.1.7-rc1` … `0.1.7-rc5` | 0.1.5 线 + 0.1.7 线 | 同一套规则，各自对应这一份工作区的一次发布 |
| `0.1.5-rc3` … `0.1.5-rc5` | `0.1.5-rc.2` | 单代 |
| `0.1.5-rc1` / `0.1.5-rc2` | `0.1.5-rc.1` | 单代 |
| `1.0.0-rc8` … `1.0.0-rc15` | `0.1.2-rc.1` | 单代（旧命名法） |

> **`rcN` 的读法**：**核心版本**（`0.2.0`）对齐的是 harness 的**线**，不是 harness 的某个 `rc`——并集范围 `>=0.2.0-rc.1 <0.2.1-0` 本来就覆盖整条线，所以 `0.2.0-rc1`、`0.2.0-rc2`… 全都服务 `0.2.0-rc.1` 与 `0.2.0-rc.2`。**`rcN` 是本插件对这条线的第 N 次发布号**，与 harness 自己的 `rc.N`（如 `0.2.0-rc.2`）**没有编号对应关系**：它们撞名只是历史写法，别把它读成"这个插件只对 harness `rc2` 有效"。

**支持一条线 = 一份隔离依赖集 + 一条 vitest 配置**（`§4.4`）：本仓 devDependencies 跟最新线（0.2.0），另外两条线各占一个 `.compat-0xx/`。加一代的成本主要在这里。

**已逐个核对过的 harness 小版本**（"支持"= 跑过 `typecheck` + 全部线的测试，**且启动过一次 `dsh web` 看启动日志**）：

| harness | 状态 | 依据 / 未决项 |
|---|---|---|
| `0.1.5-rc.1` … `0.1.5-rc.3` | 支持（单代） | `.compat-015/` 兼容作业；0.1.5 上托管引擎的**老会话恢复**仍会撞 `$.prefix`（见 §9） |
| `0.1.7-rc.1` | 支持 | `.compat-017/` 兼容作业；启动日志无插件报错 |
| `0.1.7-rc.2` | 支持 | 同上。曾有「preset 载体写错代际」的缺陷（见下面那段），已修 |
| `0.2.0-rc.1` / `0.2.0-rc.2` | 支持（当前工作区所对） | 本仓 devDependencies + `.compat-020/` 兼容作业；启动日志无插件报错。**这一代唯一的形状漂移是 turn-status 行**（见 §4.3 与 §5），其余节点半差异都是增量 |

> **`0.1.7-rc.2` 上修掉的缺陷：preset 的载体写错了代际（2026-09-25 定位）**。插件把四个托管 preset 写成
> **目录** `$DSH_HOME/.agent-presets/loop-engine-<engine>/{agent.cordis.yml,preset.yml}`——那是 **0.1.5 的
> 载体**。0.1.7 把 preset 重做成了**组合行**（一行 `@deepseek-ai/dsh-agent-preset`，其 `config.plugins` 就是
> 组合，见 `packages/preset/agent-preset-registry` 与 `packages/bundle/web-app/presets/*.patch.yml`），
> **不再读 `.agent-presets`**（0.1.5 的 `dsh-agent-presets` 包整包消失，`grep -rn "\.agent-presets"`
> 在 0.1.7 的 `packages/ app/` 里只剩一处 skill 文档命中）。后果是 authoring 报告成功、磁盘上文件也在，
> 而 roster 只答 `["standard","ptc","minimal","cordis"]`——`session/create {agentPreset:'loop-engine-kimi'}`
> 报 `Unknown agent preset: loop-engine-kimi`，**所有会话退回 harness loop，托管引擎在 0.1.7 上根本选不了**。
> 这是 §5「编译器看不见的兼容点」的极端典型：类型、构建、单测全绿，因为死掉的是**机制**而不是 API。
> 修法：preset 载体按代际分流（§4.1 的 `authorHostedPresets`），0.1.7 上把四条 `insert` 行写进插件本来就
> 在管的 profile patch。另外 `readDocument(agentPreset)` 只暴露"渲染后的文本"，registry 的公开读
> （`list` / `resolve` / `readDocument` / `compositionInventory`）都拿不到 `config`，所以**不能**用
> `ctx.agentPresets.register(definition)` 把源 preset 重新注册一遍——只能从文本出发，这也是本插件
> 一直以来的手法（`stripPresetRows` 是行变换，不解析 YAML）。

> **踩过的坑（导致上一版结论错了一次）**：逐个 diff 的路径必须**真实存在**，否则 `git diff` 不报错、
> 静默输出空 → 读起来像"没变"。本轮就误写了 `packages/preset/agent-presets/src/index.ts`（该包不存在，
> 真名是 `packages/preset/agent-preset-registry`），于是漏掉了 registry 的改动。
> 现在用 `git cat-file -e <tag>:<path>` 先确认路径存在，或把命令换成 `git diff <旧> <新> -- <包目录>`
> （目录不存在时同样要警惕）。判定"要不要动代码"，**最终仍以启动一次 `dsh web` 看日志为准**。

> 新增一个小版本的**判定成本很低**：按 §5 的清单逐个 `git diff <旧tag> <新tag> -- <路径>`，落在清单外的改动不用看。这条命令就是"要不要动代码"的答案。

两条线的差异**不是版本号，而是 API 形状**，所以分流是**运行期结构探测**，不是 semver 解析。

---

## 2. 唯一的布尔开关：`src/compat.ts`

```ts
import * as dshSettings from '@deepseek-ai/dsh-settings'
export const LEGACY_HARNESS: boolean = 'SettingsProvider' in (dshSettings as object)
```

- 0.1.5 线的 `dsh-settings` 导出具名 `SettingsProvider` 类；0.1.7 线删掉它，换成 `SettingsForms` + 每条目 `.volatile()` Config 字段。
- 探测解析到**运行 profile 实际提供的那份** `@deepseek-ai/dsh-settings`（不是本仓库 devDependencies 里那份）。
- **只在 node 半可用。** 浏览器 bundle 不得引入宿主包（`docs/architecture.md` §6 的产物体积/纯度约束），所以 `src/client/**` **永远不要** import 它；客户端另走"服务在不在"的注入探测（§4.2）。

测试侧有一份**刻意的副本**：`tests/helpers/harness-generation.ts` 的 `LEGACY_HARNESS`。spec 必须从那里取，不能从 `src/compat.ts` 取——原因不是禁止，而是让 spec 的探测点与被测代码解耦，同时也是浏览器半"不能 import"这一约束在测试里的镜像。

---

## 3. 四种兼容手法（升级时按这个优先级选）

| 手法 | 何时用 | 优点 | 本项目用例 |
|---|---|---|---|
| **B. 形状/能力分发**（首选） | 差异表现为"某个字段/方法/服务在不在" | 下一代再变时**通常不用改**；不引入布尔常量 | `prompt.ts` 按 `role` 结构分支；`preset.ts` 先 `readDocument` 后 `read`；`client/index.ts` 两个 `ctx.inject` 各自注册；`withVolatile()` 探测 `.volatile` |
| **C. 双形状并存，各代各读各的**（首选） | 纯数据契约：wire codec、config、依赖范围 | 两代各自**忽略**多余字段，零分支、零探测 | `RemoteCodec` 同时带 `schema` 与 `create`；`package.json` 的联合 peer 范围；`host-servers.ts` 两个可选方法 |
| **D. 双份产出** | 目标不是数据而是"匹配物"（CSS 选择器、样式规则） | 命中的一份生效，另一份 inert，无运行期判断 | `turn-status.ts` 的 `ROW_SELECTORS` 按代各出一份样式表 |
| **A. 运行期探测 + 布尔分叉** | 差异是**行为**（不是数据形状），且无法用 B/C 表达 | 直白 | `LEGACY_HARNESS` 的 5 处（见 §4.1） |

**升级建议**：能改写成 B 就改写成 B。B 的判据是"新代多了一个入口 / 旧代少了一个入口"；一旦差异是"同一入口语义不同"（例如 `announce` 从同步变异步），才落到 A。

---

## 4. 兼容点总清单

> 位置以**符号名**为准（行号会漂）。要一次性找全，用 §7 的两条 grep。

### 4.1 node 半（受 `LEGACY_HARNESS` 直接控制 —— 共 6 处）

| 位置 | 0.1.5 线 | 0.1.7 线 | 手法 | 回归用例 |
|---|---|---|---|---|
| `src/index.ts` 的 `Config` 形状 | `Config` 只有引擎旋钮，选中值在 settings 段 | 多出 `engine` / `showInComposer` / `showEngineBadge` 三个 `.volatile()` 字段 | A（`...(LEGACY_HARNESS ? {} : {…})`） | `tests/index.spec.ts` |
| `src/index.ts` 的 `authorHostedPresets()` | preset 的载体是**目录** `$DSH_HOME/.agent-presets/loop-engine-<engine>/{agent.cordis.yml,preset.yml}`（`ensureEnginePresets`） | preset 的载体是 profile patch 里的四条 `insert` 行（`ensureEnginePresetRows`，`name: '@deepseek-ai/dsh-agent-preset'`） | A（`if (LEGACY_HARNESS) return …`） | `tests/index.spec.ts`（两代各断言自己那一半：现代行 + `describe.runIf(!LEGACY_HARNESS)` 块）与 `tests/preset.spec.ts` |
| `src/index.ts` `apply()` 尾部的 settings 接线 | `ctx.inject(['settings'])` → `settings.installSection(ctx, ns, schema, seed, { setSource, onChange })` | `settings.configure({ auto: false })` + `ctx.on('settings/document-updated')` + `config.engine.get()` | A | `tests/index.spec.ts` |
| `src/router-loop.ts` 的 `super(ctx, …)` | `maxParallelToolCalls?: number`，基础 loop 自带默认 | 必填 `Volatile<number>`，`super` 自己钉 `{ get: () => DEFAULT_MAX_PARALLEL_TOOL_CALLS }` | A | `tests/router-mount.spec.ts` |
| `src/driver-core/hosted-engine-runtime.ts` `publish` | `announce(agent)` **同步** + 另发一条 `agent/session-start` | `await announce(agent, source, signal)` —— 它**就是**创建公告 | A | `tests/index.spec.ts`（经 router） |
| `src/driver-core/system-head.ts` `appendSystemHeadIfMissing` | 0.1.5 是 v3，**不需要**受保护 system 头；且该构建**驱动不了**这个事件（会让回合报错） | v4 要求 `system/message` 是第一个 surface 事件 | A（`if (LEGACY_HARNESS) return`） | `tests/driver-core/system-head.spec.ts` |

### 4.2 node 半（不引 `LEGACY_HARNESS` 的分支）

| 位置 | 差异 | 手法 |
|---|---|---|
| `src/settings.ts` 两族 schema | `LOOP_ENGINE_SETTINGS_SCHEMA`（0.1.5 的 settings 段）+ `loopEngineSettingsNamespace()` vs `LOOP_ENGINE_ENGINE_SCHEMA` / `LOOP_ENGINE_SHOW_IN_COMPOSER_SCHEMA` / `LOOP_ENGINE_SHOW_ENGINE_BADGE_SCHEMA`（0.1.7 的活 Config 字段） | 两族都导出，由 `src/index.ts` 按代际选 |
| `src/settings.ts` `withVolatile()` | 0.1.5 的 schemastery `3.18.1` **没有** `.volatile()`；模块在两代都会加载到这段声明 | B：能力探测，缺席时降级返回普通 schema |
| `src/namespace.ts` | `'agent-loop-engine'`（0.1.5 settings 段命名空间）vs `'loop-engine'`（0.1.7 profile 条目 id） | C：两个字面量并存 |
| `src/driver-core/prompt.ts` | tool-result 在 0.1.5 是 `role:'user'` + 单块 `tool-result` 内嵌 `content`/`isError`；0.1.7 是一等 `role:'tool'` 消息 | B：按 `role` 结构分发，**不引代际常量** |
| `src/preset.ts` `readComposition()` | roster 的 `read(id)` → 文本 vs `readDocument(id)` → `{ content }` | B：先 `readDocument`，回退 `read`，都没有则抛 |
| `src/driver-core/host-servers.ts` `AgentPresetsService` | 同上，两个方法名 | C：两个方法都声明为**可选** |

### 4.3 浏览器半（**不得** import `src/compat.ts`）

| 位置 | 差异 | 手法 |
|---|---|---|
| `src/client/index.ts` 的静态 `inject` | `configForms`（0.1.7）与 `settingsScope`（0.1.5）**互斥** | 只列两代都有的 `['slots', 'locale']`；`apply` 里注册**两个** `ctx.inject` 回调，哪个服务在就哪个触发，两者都落进同一个 transport（`src/client/store.ts`） |
| `src/client/index.ts` 的 `LegacySettingsScopeService` | 0.1.5 的 `settingsScope.bind({ namespace, decode })` 已被 0.1.7 删除 | 本插件自带的最小接口声明（`as unknown as`），不 import 宿主类型 |
| `src/client/session-engine.ts` 的 `RemoteCodec` | strict 分支从 `{ typeSymbol, schema }` 变成 `{ typeSymbol, create: () => schema }` | **C：两个字段都带** |
| `src/client/turn-status.ts` 的 `ROW_SELECTORS` | 行本身换了元素与类名机制（见 §5） | D：按代各出一份样式表——0.1.5 是 `[class$="_turnStatus"]`、0.1.7 是 `button[data-turn-process][data-loop-engine-live] [class$="_label"]`，0.2.0 换成 harness 自己的 `[data-chat-running]`（`RUNNING_ROW`，也是 `markLiveRow`/`bringsRow` 认的第二个挂点，单独一张表）；那一代的行**只在轮次进行时存在**，所以后一张表只挂引擎属性、**不用逐行标记**，反过来 `markLiveRow` 看到它就**什么都不盖**（那时屏上每个 `button[data-turn-process]` 都是已收尾的摘要） |
| `src/client/turn-status.ts` 的 `RUNNING_ATTR` | 不是代际差异，是**行为**差异：0.1.7 的行在轮次结束后仍留在屏上 | 新增门控属性（`session.running`） |
| `src/client/turn-status.ts` 的 `LIVE_ATTR` | 同上：0.1.7 **每一轮的行都留在屏上**，会话级门控分不出"在跑的这行" | 新增逐行标记（客户端盖在文档里最后一行上）＋ `MutationObserver` 跟随行的增删；0.2.0 上**这个标记从不写**（那一代的行是 harness 自己的 `[data-chat-running]`，只在轮次进行时存在，屏上没有可标记的 turn-process 行），但跟随器照跑，因为"运行节点出现/消失"要靠它重算标记 |
| `src/client/use-session-engine.ts` 的 `SessionSeat` | 需要 `useSession`（`SessionStandardProps`）读 `session.running` | 声明为**可选**，缺席时门保持不动而不是猜 |
| `src/client/LoopEngineSection.tsx` 的 `IconChevronDown` | 0.1.7 把图标从 `IconChevronDownOutline14` 改名为 `IconChevronDownOutlineRegular` | B：`Regular ?? 14` 运行期回退 |

### 4.4 测试与发布

| 位置 | 作用 |
|---|---|
| `tests/helpers/harness-generation.ts` | 测试侧代际探测 + `toolResultView()` / `toolResultRole()`，把两代的 tool-result 读成**同一份事实**，让同一份 spec 两代都过 |
| `tests/helpers/fake-settings.ts` | 假 settings 服务同时实现两代接口（`installSection` 与 `configure`/`mutate`/`describe`），按代际把"提交默认引擎"写进正确通道 |
| `tests/helpers/fake-dom.ts` | node 里能跑 turn-status 反射的最小 DOM（`querySelector(All)`、元素属性、以及**手工投递记录**的假 `MutationObserver`——真的那个什么时候触发由浏览器定，逐行标记就没法测）。选择器只认 `tag[attr]` 与裸 `[attr]` 两种形式（后者给 0.2.0 的 `[data-chat-running]`），查不到时像真 DOM 一样回 `null` |
| `.compat-015/` | **隔离的 0.1.5 依赖集**（`package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml`；`node_modules` 不进仓库）。只装 0.1.5 那一套，与本仓自己的 `node_modules` 互不干扰 |
| `.compat-017/` | 同上，装 **0.1.7 线**（`0.1.7-rc.2`）那一套 |
| `.compat-020/` | 同上，装 **0.2.0 线**（`0.2.0-rc.2`）那一套 |
| `vitest.config.compat0NN.ts` | 把每个 `@deepseek-ai/*` 别名到 `.compat-0NN/node_modules/@deepseek-ai/`，跑**同一批 spec**（**不跑覆盖率**，是功能性验证）：`npx vitest run --config vitest.config.compat017.ts` 等。只别名该集合里**存在**的包，所以嵌套传递依赖仍走 pnpm 自己的布局 |
| `package.json` `peerDependencies` | 联合范围 `">=0.1.5-rc.1 <0.1.6-0 \|\| >=0.1.7-rc.1 <0.1.8-0 \|\| >=0.2.0-rc.1 <0.2.1-0"`；`@deepseek-ai/cordis` 放宽到 `^4.0.1`（`Volatile` 只在**构建期**用）；`schemastery` 钉 `3.18.4` |
| `pnpm-workspace.yaml` `minimumReleaseAgeExclude` | pnpm "最小发布年龄"供应链护栏的豁免名单。本仓库**没有开启** `minimumReleaseAge`（`pnpm config get minimumReleaseAge` = `undefined`），所以这项目前是前瞻性的；但 `pnpm install` 会**自动**把刚装上的版本追加进去，因此每次提版后这个文件都会自己变长——跟着提交即可，不要手删。 |
| `pnpm-workspace.yaml` 的 profile shim 版本 | 源码启动的 harness 用 `file:` shim 指回源码（`docs/source-checkout.md`），**每个 shim 声明的 `version` 必须落在上面的并集范围内**——写成占位值会让 pnpm 再装一份 harness 包，于是同一个包出现两份实例。换线时跟着改这里 |

> **覆盖率注释的边界**：只在一条代际上执行的分支，在现代线（本仓 devDependencies，当前 0.2.0）的覆盖率作业里标了 `/* v8 ignore */`（注释里写明"由哪套 compat 作业接管"）。**这些分支的真实执行只由兼容作业保证**；改动它们之后，所有线都要跑（§6 步骤 5）。

---

## 5. 编译器看不见的兼容点（最容易漏，升级时优先怀疑）

这些都是**结构化声明**：类型检查、构建、以及"在 0.1.7 上跑单测"全都抓不到，只有真机（或兼容作业）才暴露。历史上每个都真的炸过：

| 声明 | 形状漂移 | 不对齐时的表现 |
|---|---|---|
| Remote contribution 的 strict codec | `{ schema }` → `{ create: () => schema }` | 会话级 Remote 从没挂上，**对话页引擎选择器永远「读取中」**，而设置页（另一条路径）正常 |
| agent-presets roster 读法 | `read(id)` → `readDocument(id)` | `Unknown agent preset: loop-engine-claude-code`——预设根本没写出来，恢复会话失败 |
| **托管 preset 的载体** | 用户 preset 根下的目录（`<home>/.agent-presets/<id>/agent.cordis.yml`）→ **组合行**（`insert` 一行 `@deepseek-ai/dsh-agent-preset`，`config.plugins` 就是组合） | 两代都"写成功"：0.1.7 上 roster 只答内置那四个 preset，`Unknown agent preset: loop-engine-<engine>`，托管引擎**根本选不了**。类型、构建、单测**全绿**——死掉的是机制而不是 API，旧代的位置照旧能跑，所以只有"在 0.1.7 真机上看 roster 答什么"才暴露 |
| turn-status 行挂点 | `[class$="_turnStatus"]` → `button[data-turn-process][data-loop-engine-live] [class$="_label"]` → `[data-chat-running]` | 换代的共同症状都是托管引擎那一行**没有字形/扫光**（选择器匹配不到，静默失效）。0.1.7 上那一代**每一轮的行都留在屏上**，所以选择器还得逐行区分"在跑的这行"与"已收尾的那些行"——只按会话门控时，新一轮开始会把前面所有已结束的行一起重新涂上。**别再用行自己的 `:disabled` 顶替这个标记**：它表达的是 ui-chat 的"这一轮不可折叠"，`aborted` / `error` 收尾的行会一直留着它，于是那些僵尸行会在后续轮次里一起被画上（实测：一条"用时 3秒"的旧行戴着引擎字形与扫光）。标记由客户端自己写（`data-loop-engine-live` 盖在文档里最后一行上）。**0.2.0 把在跑的那一行搬走了**：`TurnProcessNodeView` 只在 `turn.status === 'closed'` 时渲染（turn-process 按钮从此刻起永远是已收尾的摘要），在跑的行是 `RunningStatus.tsx` 渲染的 `[data-chat-running]` 节点，只在会话运行期间存在。所以这一代**只挂引擎属性**（不需要会话级门控）、**不写逐行标记**（屏上没有可标记的行），样式也只做两件事：覆盖该行解析颜色用的两个别名、用 `::before` 把字形挂到内容行上，并把 harness 这一代第一次摆出来的那枚指示物（`[class$="_runningIcon"]`：`RunningWhaleTail` 的 APNG mask 与 SVG fallback 都在里面，画的是 DeepSeek 的鲸鱼标）从那一行里去掉——托管引擎在下面干活、上面顶着别家的标，是这一行最不能说的话，字形是来**替换**它而不是排在它旁边的；该规则按 `html[data-loop-engine]` **在不在**门控，不逐引擎重复（四个引擎藏的是同一个东西，"属性不在"恰好就是 in-process）——**不能再叠一条渐变**，harness 自己已经在跑 `TextShimmer` 的扫光（`packages/client/ui-primitives/src/TextShimmer.tsx`），重声明只会和它打架。`markLiveRow` 因此要先看有没有 `[data-chat-running]`：有就一个标记都不盖（否则盖到的是**已收尾**的新摘要） |
| turn-status 行的生命周期 | 0.1.5 行随轮次消失 → 0.1.7 行**结束后仍留在屏上**（折叠摘要「用时 X 秒」）→ 0.2.0 **在跑的行又只剩运行期间**：在跑的是 `RunningStatus.tsx` 的 `[data-chat-running]`，`TurnProcessNodeView.tsx` 只在 `turn.status === 'closed'` 时渲染，turn-process 按钮只当已收尾的摘要 | 0.1.7 上的症状：**对话结束后动画还在**（只按引擎门控）；0.2.0 上反过来——**只看 turn-process 行就什么都画不到**（那一代没有"在跑的按钮"了） |
| CSS Modules 命名 | `[hash]_[local]`：真实类名是 `<hash>_label`，**不存在**字面量 `.label` | 选择器匹配不到任何元素（静默失效） |
| `dataset` 键拼写 | `dataset['data-loop-engine']` 会被 `DOMStringMap` 的命名 setter 拒绝并抛 `SyntaxError` | 整条反射路径带塌（只能写 camelCase 的 `dataset.loopEngine`） |
| 事件名 / 方法签名 | `agent/session-start`、`sessions.enter/announce`、`agents.announce(agent)` vs `announce(agent, source, signal)` | 会话创建公告缺失，或 `announce` 被当作同步调用 |
| 图标/原语名 | `IconChevronDownOutline14` → `IconChevronDownOutlineRegular` | 图标不渲染 |

**挑锚点的优先级**（对 harness 内部 DOM/类名）：**稳定属性**（`data-*`）> **类名后缀**（`[class$="_x"]`）> **类名字面量**（`.label`，基本必错）。0.1.7 的 turn-status 行就是靠 `data-turn-process` + `[class$="_label"]` 才站住的，0.2.0 的则是**直接用 harness 自己写在在跑那行上的 `data-chat-running`**（插件只往内容行 `[class$="_runningContent"]` 上挂字形）；**自己写的 `data-*` 属性比 harness 的状态属性更可靠**——`data-loop-engine-live` 由插件在"文档里最后一行"上盖出来，而不是去解读 ui-chat 的 `disabled` 想表达什么（§5 turn-status 行挂点那条）。

**降级路径**：跨代要稳定的字符串（namespace、事件名、remote 方法名、dataset 键、CSS 锚点、preset 前缀）尽量集中到**零导入模块**（`src/namespace.ts`、`src/agent-preset-ids.ts`、`src/client/turn-status.ts` 顶部常量），让"改一处"就是"改一处"。

---

## 6. 跟着 harness 升级到下一代的清单

以"支持 `0.1.8-rc.1`（同时保留 0.1.5 与 0.1.7）"为例：

1. **先判断"要不要动代码"**。**同一条线内的小版本**（如 `0.1.7-rc.1` → `0.1.7-rc.2`，几百个提交）多数时候不用改代码：先 diff §5 那张表里的面。**每个路径先确认存在**（不存在时 `git diff` 会静默输出空，读起来像"没变"）：

   ```sh
   cd deepseek-harness
   OLD=dsh-v0.1.7-rc.1 NEW=dsh-v0.1.7-rc.2
   for p in packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx \
            packages/client/tsdown.client.ts \
            packages/client/ui-session/src/client/index.ts \
            packages/bundle/web-app/presets \
            packages/preset/agent-preset-registry/src \
            packages/preset/persona/src \
            packages/settings/settings/src \
            packages/typert/registry/src \
            packages/core/session/src/known-event-types.ts \
            packages/session/session-format-v3-to-v4/src/relationships.ts \
            packages/api/session-controller/src/client/contract/snapshot.ts \
            packages/client/ui-conversation/src/client/contract/slots.ts; do
     git cat-file -e "$NEW:$p" 2>/dev/null || { printf '%-62s %s\n' "$p" '!! 路径不存在，别信空输出'; continue; }
     printf '%-62s ' "$p"; git diff --shortstat "$OLD" "$NEW" -- "$p" | tr -d '\n'; echo
   done
   ```

   落在清单外的改动（`client/ui-schedule` 之类）不用看。**这只是"要不要动代码"的第一道筛子**；最终必须**真启动一次 `dsh web` 并读启动日志**（§1 的记录就是这么来的——rc.2 正是过了这道筛子却在启动日志里报错）。

   **跨 minor（如 `0.1.7` → `0.1.8`）**才需要走完整流程：不要凭 CHANGELOG 猜，直接对新 checkout 的 `packages/**/lib/types/**/*.d.ts`（或 `src/`）做结构化 diff。重点仍是 §5 表里那几类：服务类/方法、事件名、codec/typert 形状、`SessionEventMap`、插槽 props（`SessionStandardProps`）、preset roster、CSS Modules 命名。
2. **先跑一次兼容作业**，让差异自己冒出来：把新 harness 装进一个新的隔离依赖集（照 `.compat-020/` 复制一份 `.compat-030/`），`vitest.config` 别名过去，跑同一批 spec。**这一步是探针，比读代码快**。跨 minor 的这一步本身就够强：0.1.7 → 0.2.0 时 1260 条 spec 一次全绿，差异只剩浏览器半那一处。
3. **逐个改**，按 §3 的优先级选手法：能用 B 就不用 A；纯数据用 C；匹配物用 D。**不要**把 `LEGACY_HARNESS` 从 bool 改成枚举——那会让每次升级都动到所有分支。要么再加一个独立的能力探测（如 `HAS_XXX`），要么优先改写成 B。**跨 minor 的实测顺序**：先读"节点半差异清单"（服务/事件/codec/SessionEventMap），再用兼容作业探针；两代都绿之后**单独**核对浏览器半——它不跑在覆盖率作业里，兼容作业也照不到（0.2.0 的 turn-status 行就是这么发现的：spec 用的假 DOM 还画着旧标记，真机才暴露）。
4. **补 `v8 ignore` 与兼容用例**：新代的专属分支在覆盖率作业（跑最新代）里会被标 `v8 ignore`，注释里必须写明"由哪套 compat 作业接管"。
5. **所有线的命令都跑绿**：
   ```sh
   pnpm run typecheck && pnpm run build
   pnpm run test:coverage                                # 最新代（devDependencies），逐文件 100%
   npx vitest run --config vitest.config.compat015.ts    # 0.1.5 线
   npx vitest run --config vitest.config.compat017.ts    # 0.1.7 线
   npx vitest run --config vitest.config.compat020.ts    # 0.2.0 线
   ```
6. **更新声明与文档**：`package.json` 每个 `@deepseek-ai/dsh-*` peer 范围加上新一代（`|| >=0.2.1-rc.1 <0.2.2-0`），`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 跟着加；**源码启动的 profile 里那 12 个 `file:` shim 声明的版本也要跟着改**（`docs/source-checkout.md`，否则 pnpm 会再装一份 harness 包）；然后更新本篇 §1 的矩阵、§4/§5 的清单，以及 `docs/architecture.md` §8 与两个 README 的版本对应段落。
7. **版本号**：插件版本跟 harness 走 `<harness version>-rcN`（`0.2.0-rc.2` → `0.2.0-rc1`，`rcN` 是本插件那条线的发布号）。
8. **真机冒烟**：源码 harness + 发行版 harness 各起一个 `dsh web`，跑 in-process 与托管引擎各一轮对话，并**硬刷新**核对 turn-status 行（进行中要有字形+扫光、结束后要回朴素）。0.2.0 起还要多看一件事：**dsh 自己会在开机时按 peer 范围跳过不兼容的插件**（`dsh plugin allow-version` 可显式放行），所以启动日志里出现的 `skipping profile bundle` 是**别的插件**没跟上这一代，不是本插件的问题——本插件被跳过只可能因为它自己的 peer 范围没写上新线。

---

## 7. 一次性找全的检索配方

```sh
# 1) 所有直接代际分叉
grep -rn "LEGACY_HARNESS" src/ tests/

# 2) 所有"只在一代上执行"的分支（应等于 1) 在 src/ 里的落点）
grep -rn "v8 ignore" src/ | grep -i "legacy\|compat015"

# 3) 浏览器半的代际分流（不会出现 LEGACY_HARNESS）
grep -rn "configForms\|settingsScope\|readDocument\|\?\? (\|create:" src/client/

# 4) 依赖声明与发布面
grep -n "dsh-" package.json
grep -rn "minimumReleaseAgeExclude" -A3 pnpm-workspace.yaml | head

# 5) 兼容作业
ls .compat-0*/ && cat vitest.config.compat0*.ts
```

> 自检：`1)` 的输出若多出 `src/compat.ts` 与 `tests/helpers/harness-generation.ts` 两处定义，其余应全部落在 §4.1 的 6 处落点（5 个文件）里。数量对不上，说明有新的分叉没记进本篇。

---

## 8. 老 V3 / V4 会话日志的数据修复（一次性工具）

**症状**：在 0.1.7 上打开一条老会话，报下面之一：

```
Session migration from v3 to v4 refuses the transformed artifact:
tool/call <id> has no advertised tool lifecycle; source v3 artifact remains unchanged
```

```
stored session "<id>" is corrupt: stored log is corrupt:
SessionFormatError: tool/call <id> does not match one advertised tool call
```

（同族还有 `tool/result <id> has no advertised tool lifecycle`、`system/message requires a protected first surface head`、`step/end leaves unresolved tool call`。）第一条来自 **V3→V4 迁移**（只影响 `session.v3.jsonl.zstd`），第二条来自 **V4 加载路径**（影响 `session.v4.jsonl.zstd`）——两代产物、两条报错路径，工具都覆盖。

**成因**：托管引擎的会话是由**插件的驱动**写 durable 日志的，历史上有两族缺陷：

- **结构族**（2026-09-19 之前的驱动构建，`71ccdea` / `c293e25` / `5de4b91` / `1c94078` 这几个修复之前）：写出的 transcript **v3 读得下去、v4 的生命周期规则不接受**。v4 的规则在 `packages/session/session-format-v3-to-v4/src/relationships.ts`：一个 `tool/call` 必须**先**被某条 `assistant/message` 的 `tool-call` 内容块广告过（`id` 相同，且 `name`/`arguments` 与 `tool/call` 的数据一致），`tool/result` 同理。当前构建已按这个顺序写（`src/engine-kimi/agent.ts` 的 `flushSegment` → `flushAssistant`）。
- **投影族**（`005ab3a` 之前的驱动构建）：广告块与 `tool/call` **都在**，但内容不一致——驱动把引擎的**原始**调用名写进广告块（`Bash`、`Read`），而 `tool/call` 事件写的是**投影后的 dsh 拼写**（`bash`、`read`）；`arguments` 也可能不一致（原始 `path` vs 投影 `file_path`）。v4 报 `tool/call <id> does not match one advertised tool call`。**方向是已裁决的**：以 `tool/call` 事件为准，改写广告块——事件里的 dsh 投影拼写才是 Web 工具行、dsh 工具词表和后续 in-process 重放所依赖的，广告块才是**欠投影**的一侧。所以工具**只改块的 `name`/`arguments`，绝不反向、绝不动事件**。

**工具**：`scripts/repair-session-logs.mjs`（仓库根下，旧名 `repair-v3-tool-calls.mjs`）。它不参与运行时、不发布，纯修复路径只用 Node 标准库，接受 `session.v3.jsonl.zstd` **和** `session.v4.jsonl.zstd`：

```sh
node scripts/repair-session-logs.mjs --check          # 只报告（扫 $DSH_SESSIONS_ROOT 或 ~/.dsh/sessions，按代际分类统计两族）
node scripts/repair-session-logs.mjs <file...>        # 原地修复（先写 <file>.bak，与代际无关）
node --import tsx/esm scripts/repair-session-logs.mjs --verify <file...>   # 修完再用 harness 真oracle验证
```

`--verify` 会调兄弟仓 `deepseek-harness` 里**真实的** oracle 跑一遍结果与备份（这是唯一需要 harness checkout 的路径；默认 `../deepseek-harness`，可用 `--harness <dir>` 覆盖），**按代际选 oracle**：V3 走真实的 v3→v4 迁移 + V4 关系校验，V4 直接走加载路径最后那道 `assertReleasedV4Relationships`。修不动就落空：不改动时文件字节不变，写入走同目录临时文件 + rename；只有**被改动的**文件在 oracle 下失败才会以非零退出（本来就坏、工具没动的文件如实打印 verdict，但不判失败）。

它修的是**两族**缺陷。结构族（1–5）不止广告缺失：广告迟到（消息排在它自己的 `tool/call` 之后）、`tool/result` 重复写入、结果落在错误的 step（v4 在 `step/end` 清空该 step 的开放调用）、无结果的未完成调用（用 harness 自己的 `@deepseek-ai/dsh-session/repair` 收尾：`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`）、system 头错位（补一条空 `system/message` 头，与运行时 `src/driver-core/system-head.ts` 同一手法）。结构修完后 `seq` 重排密集、payload 里对 seq 的引用一并重映射。投影族（6）只改块 payload 字节，不增删挪事件，因此**不需要** seq 重排——这一点对两代产物都做过实测（投影修复后事件的 `seq` 数组逐位不变、仍密集），而非假设。

**仍有一族没修**：极少数 `format v3 inherited cut disagrees with its source marker`（继承切点与源标记不一致）。它需要判断"哪条 `session/end-seed` 才是真的继承边界"，信息不足以裁决，工具遇到这类文件不会改动，`--verify` 如实报 FAIL。除此之外，工具只处理上面两族；其它形态的日志损坏不在范围内。

---

## 9. 已知不做的事（避免以后重复判断）

- **0.1.5 上"恢复一条用托管引擎跑过的老会话"仍会失败**（`agent-presets: preset "loop-engine-<engine>" failed to mount: invalid config: $.prefix missing required value`）。0.1.7 的 persona 行要求 `prefix`，插件给 0.1.5 授权的托管 preset 里没有这个字段；**0.1.5 上新建会话完全正常**，只有"升级前就存在的、由托管引擎驱动过的会话"在 0.1.5 上恢复会撞这个。已评估为**不修**（收益小、改动面落在 preset 授权逻辑上），修的话应在 `src/preset.ts` 的授权路径按代际补 `prefix`。
- **代理半的 legacy 路径没有单测**（`src/client/**` 不在覆盖率内），只做代码审查 + 产物自检 + 真机冒烟。

---

## 10. 相关文档

- `docs/architecture.md` §8 —— 跨代兼容的架构解释（§4.1/§8.1-8.6）。
- `docs/per-session-engine.md` §5 —— 引擎切换的落地方式（与代际无关，但兼容改动常波及）。
- `docs/deepseek-harness-0.1.7-rc.1-变更总结.md`（容器仓根）—— 本次 0.1.7 适配的逐条变更记录。
