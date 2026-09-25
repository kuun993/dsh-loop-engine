# 跨代兼容：兼容点清单与升级手册

> 读者：下一次要跟着 harness 升级的人（很可能是未来的你）。
> 目标：**升级时不用满仓库找"哪里是跟着 harness 版本走的"** —— 打开这一篇就能拿到全部位置、判断手法是否还成立，并照着 §6 的手册走一遍。

`docs/architecture.md` §8 讲的是**为什么要这么设计**（架构层面的解释）；本篇是**可操作的清单与手册**。两篇互相引用，重复的部分以本篇为准。

---

## 1. 现状：一个产物服务两代

从 `0.1.7-rc1` 起，**同一个已发布产物**同时跑在两代 harness 上：

| 插件版本 | 目标 harness | 说明 |
|---|---|---|
| `0.1.7-rc1`（当前） | `>=0.1.5-rc.1 <0.1.6-0` **或** `>=0.1.7-rc.1 <0.1.8-0` | 两代由运行期探测分流 |
| `0.1.5-rc3` … `0.1.5-rc5` | `0.1.5-rc.2` | 单代 |
| `0.1.5-rc1` / `0.1.5-rc2` | `0.1.5-rc.1` | 单代 |
| `1.0.0-rc8` … `1.0.0-rc15` | `0.1.2-rc.1` | 单代（旧命名法） |

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

### 4.1 node 半（受 `LEGACY_HARNESS` 直接控制 —— 共 5 处）

| 位置 | 0.1.5 线 | 0.1.7 线 | 手法 | 回归用例 |
|---|---|---|---|---|
| `src/index.ts` 的 `Config` 形状 | `Config` 只有引擎旋钮，选中值在 settings 段 | 多出 `engine` / `showInComposer` 两个 `.volatile()` 字段 | A（`...(LEGACY_HARNESS ? {} : {…})`） | `tests/index.spec.ts` |
| `src/index.ts` `apply()` 尾部的 settings 接线 | `ctx.inject(['settings'])` → `settings.installSection(ctx, ns, schema, seed, { setSource, onChange })` | `settings.configure({ auto: false })` + `ctx.on('settings/document-updated')` + `config.engine.get()` | A | `tests/index.spec.ts` |
| `src/router-loop.ts` 的 `super(ctx, …)` | `maxParallelToolCalls?: number`，基础 loop 自带默认 | 必填 `Volatile<number>`，`super` 自己钉 `{ get: () => DEFAULT_MAX_PARALLEL_TOOL_CALLS }` | A | `tests/router-mount.spec.ts` |
| `src/driver-core/hosted-engine-runtime.ts` `publish` | `announce(agent)` **同步** + 另发一条 `agent/session-start` | `await announce(agent, source, signal)` —— 它**就是**创建公告 | A | `tests/index.spec.ts`（经 router） |
| `src/driver-core/system-head.ts` `appendSystemHeadIfMissing` | 0.1.5 是 v3，**不需要**受保护 system 头；且该构建**驱动不了**这个事件（会让回合报错） | v4 要求 `system/message` 是第一个 surface 事件 | A（`if (LEGACY_HARNESS) return`） | `tests/driver-core/system-head.spec.ts` |

### 4.2 node 半（不引 `LEGACY_HARNESS` 的分支）

| 位置 | 差异 | 手法 |
|---|---|---|
| `src/settings.ts` 两族 schema | `LOOP_ENGINE_SETTINGS_SCHEMA`（0.1.5 的 settings 段）+ `loopEngineSettingsNamespace()` vs `LOOP_ENGINE_ENGINE_SCHEMA` / `LOOP_ENGINE_SHOW_IN_COMPOSER_SCHEMA`（0.1.7 的活 Config 字段） | 两族都导出，由 `src/index.ts` 按代际选 |
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
| `src/client/turn-status.ts` 的 `ROW_SELECTORS` | 行本身换了元素与类名机制（见 §5） | D：按代各出一份样式表 |
| `src/client/turn-status.ts` 的 `RUNNING_ATTR` | 不是代际差异，是**行为**差异：0.1.7 的行在轮次结束后仍留在屏上 | 新增门控属性（`session.running`） |
| `src/client/use-session-engine.ts` 的 `SessionSeat` | 需要 `useSession`（`SessionStandardProps`）读 `session.running` | 声明为**可选**，缺席时门保持不动而不是猜 |
| `src/client/LoopEngineSection.tsx` 的 `IconChevronDown` | 0.1.7 把图标从 `IconChevronDownOutline14` 改名为 `IconChevronDownOutlineRegular` | B：`Regular ?? 14` 运行期回退 |

### 4.4 测试与发布

| 位置 | 作用 |
|---|---|
| `tests/helpers/harness-generation.ts` | 测试侧代际探测 + `toolResultView()` / `toolResultRole()`，把两代的 tool-result 读成**同一份事实**，让同一份 spec 两代都过 |
| `tests/helpers/fake-settings.ts` | 假 settings 服务同时实现两代接口（`installSection` 与 `configure`/`mutate`/`describe`），按代际把"提交默认引擎"写进正确通道 |
| `.compat-015/` | **隔离的 0.1.5 依赖集**（`package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml`；`node_modules` 不进仓库）。只装 0.1.5 那一套，与本仓库的 0.1.7 `node_modules` 互不干扰 |
| `vitest.config.compat015.ts` | 把每个 `@deepseek-ai/*` 别名到 `.compat-015/node_modules/@deepseek-ai/`，跑**同一批 spec**：`npx vitest run --config vitest.config.compat015.ts`（**不跑覆盖率**，是功能性验证） |
| `package.json` `peerDependencies` | 联合范围 `">=0.1.5-rc.1 <0.1.6-0 \|\| >=0.1.7-rc.1 <0.1.8-0"`；`@deepseek-ai/cordis` 放宽到 `^4.0.1`（`Volatile` 只在**构建期**用）；`schemastery` 钉 `3.18.4` |
| `pnpm-workspace.yaml` `minimumReleaseAgeExclude` | pnpm "最小发布年龄"供应链护栏的豁免名单（护栏**当前未开启**，所以这项是前瞻性声明：将来一旦开启，刚发布的 harness 预发布版才不会被拦） |

> **覆盖率注释的边界**：只在一条代际上执行的分支，在 0.1.7 覆盖率作业里标了 `/* v8 ignore */`（注释里写明"由 `vitest.config.compat015.ts` 接管"）。**这些分支的真实执行只由兼容作业保证**；改动它们之后，两套命令都要跑（§6 步骤 5）。

---

## 5. 编译器看不见的兼容点（最容易漏，升级时优先怀疑）

这些都是**结构化声明**：类型检查、构建、以及"在 0.1.7 上跑单测"全都抓不到，只有真机（或兼容作业）才暴露。历史上每个都真的炸过：

| 声明 | 形状漂移 | 不对齐时的表现 |
|---|---|---|
| Remote contribution 的 strict codec | `{ schema }` → `{ create: () => schema }` | 会话级 Remote 从没挂上，**对话页引擎选择器永远「读取中」**，而设置页（另一条路径）正常 |
| agent-presets roster 读法 | `read(id)` → `readDocument(id)` | `Unknown agent preset: loop-engine-claude-code`——预设根本没写出来，恢复会话失败 |
| turn-status 行挂点 | `[class$="_turnStatus"]` → `button[data-turn-process] [class$="_label"]` | 0.1.7 上托管引擎那一行**没有字形/扫光** |
| turn-status 行的生命周期 | 0.1.5 行随轮次消失 → 0.1.7 行**结束后仍留在屏上**（折叠摘要「用时 X 秒」） | **对话结束后动画还在** |
| CSS Modules 命名 | `[hash]_[local]`：真实类名是 `<hash>_label`，**不存在**字面量 `.label` | 选择器匹配不到任何元素（静默失效） |
| `dataset` 键拼写 | `dataset['data-loop-engine']` 会被 `DOMStringMap` 的命名 setter 拒绝并抛 `SyntaxError` | 整条反射路径带塌（只能写 camelCase 的 `dataset.loopEngine`） |
| 事件名 / 方法签名 | `agent/session-start`、`sessions.enter/announce`、`agents.announce(agent)` vs `announce(agent, source, signal)` | 会话创建公告缺失，或 `announce` 被当作同步调用 |
| 图标/原语名 | `IconChevronDownOutline14` → `IconChevronDownOutlineRegular` | 图标不渲染 |

**挑锚点的优先级**（对 harness 内部 DOM/类名）：**稳定属性**（`data-*`）> **类名后缀**（`[class$="_x"]`）> **类名字面量**（`.label`，基本必错）。0.1.7 的 turn-status 行就是靠 `data-turn-process` + `[class$="_label"]` 才站住的。

**降级路径**：跨代要稳定的字符串（namespace、事件名、remote 方法名、dataset 键、CSS 锚点、preset 前缀）尽量集中到**零导入模块**（`src/namespace.ts`、`src/agent-preset-ids.ts`、`src/client/turn-status.ts` 顶部常量），让"改一处"就是"改一处"。

---

## 6. 跟着 harness 升级到下一代的清单

以"支持 `0.1.8-rc.1`（同时保留 0.1.5 与 0.1.7）"为例：

1. **拿到新 harness 的 API 差异**。不要凭 CHANGELOG 猜，直接对源码做结构化 diff：新 checkout 的 `packages/**/lib/types/**/*.d.ts`（或 `src/`）对比当前 devDependencies 那版。重点看 §5 表里那几类：服务类/方法、事件名、codec/typert 形状、`SessionEventMap`、插槽 props（`SessionStandardProps`）、preset roster、CSS Modules 命名。
2. **先跑一次兼容作业**，让差异自己冒出来：把新 harness 装进一个新的隔离依赖集（照 `.compat-015/` 复制一份 `.compat-018/`），`vitest.config` 别名过去，跑同一批 spec。**这一步是探针，比读代码快**。
3. **逐个改**，按 §3 的优先级选手法：能用 B 就不用 A；纯数据用 C；匹配物用 D。**不要**把 `LEGACY_HARNESS` 从 bool 改成枚举——那会让每次升级都动到所有分支。要么再加一个独立的能力探测（如 `HAS_XXX`），要么优先改写成 B。
4. **补 `v8 ignore` 与兼容用例**：新代的专属分支在覆盖率作业（跑最新代）里会被标 `v8 ignore`，注释里必须写明"由哪套 compat 作业接管"。
5. **两套命令都跑绿**：
   ```sh
   pnpm run typecheck && pnpm run build
   pnpm run test:coverage                          # 最新代，逐文件 100%
   npx vitest run --config vitest.config.compat015.ts   # 0.1.5 线
   npx vitest run --config vitest.config.compat018.ts   # 新加那一代
   ```
6. **更新声明与文档**：`package.json` 每个 `@deepseek-ai/dsh-*` peer 范围加上新一代（`|| >=0.1.8-rc.1 <0.1.9-0`），`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 跟着加；然后更新本篇 §1 的矩阵、§4/§5 的清单，以及 `docs/architecture.md` §8 与两个 README 的版本对应段落。
7. **版本号**：插件版本跟 harness 走 `<harness version>-rcN`（`0.1.8-rc.1` → `0.1.8-rc1`）。
8. **真机冒烟**：源码 harness + 发行版 harness 各起一个 `dsh web`，跑 in-process 与托管引擎各一轮对话，并**硬刷新**核对 turn-status 行（进行中要有字形+扫光、结束后要回朴素）。

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

> 自检：`1)` 的输出若多出 `src/compat.ts` 与 `tests/helpers/harness-generation.ts` 两处定义，其余应全部落在 §4.1 的 5 个文件里。数量对不上，说明有新的分叉没记进本篇。

---

## 8. 已知不做的事（避免以后重复判断）

- **0.1.5 上"恢复一条用托管引擎跑过的老会话"仍会失败**（`agent-presets: preset "loop-engine-<engine>" failed to mount: invalid config: $.prefix missing required value`）。0.1.7 的 persona 行要求 `prefix`，插件给 0.1.5 授权的托管 preset 里没有这个字段；**0.1.5 上新建会话完全正常**，只有"升级前就存在的、由托管引擎驱动过的会话"在 0.1.5 上恢复会撞这个。已评估为**不修**（收益小、改动面落在 preset 授权逻辑上），修的话应在 `src/preset.ts` 的授权路径按代际补 `prefix`。
- **代理半的 legacy 路径没有单测**（`src/client/**` 不在覆盖率内），只做代码审查 + 产物自检 + 真机冒烟。

---

## 9. 相关文档

- `docs/architecture.md` §8 —— 跨代兼容的架构解释（§4.1/§8.1-8.6）。
- `docs/per-session-engine.md` §5 —— 引擎切换的落地方式（与代际无关，但兼容改动常波及）。
- `docs/deepseek-harness-0.1.7-rc.1-变更总结.md`（容器仓根）—— 本次 0.1.7 适配的逐条变更记录。
