# 按会话选择引擎：用户可见行为

这份文档讲**用起来是什么样**：怎么让会话 A 跑 Codex、会话 B 跑 Kimi、它们怎么并发、引擎什么时候能换（以及哪一半是原地换手、哪一半会释放会话并重载页面）、默认引擎与逐会话引擎分别怎么设、以及和 harness 内置的 agent preset 选择器是什么关系。

实现（单 AgentFactory 槽位、单槽路由器、managed block、preset authoring、引擎侧车存储、原地换手的事务与 `SessionLifetime`、切换涉及 in-process 时的释放与页面重载）见 `docs/architecture.md` 与 `docs/driver-core.md`，本文不重复。本文中的 `src/…` 引用相对本仓库根，主仓文件相对 `../deepseek-harness/`。

## 1. 一句话模型

**引擎是本插件持有的逐会话事实，不再由 agent preset 决定。** 判定顺序只有一个（§1.1）：先读插件自己的会话级记录（`$DSH_HOME/.loop-engine/engines.json`，`src/session-engine-store.ts:65` 的 `resolveEngineRecordPath`），**有记录就以它为准**；没有记录的会话（所有老会话、所有没换过引擎的会话）**回退**到原来那套 preset 映射，行为与本次改动之前逐字一致。

同一个 `dsh web` 进程里可以同时跑多个引擎的不同会话。设置页里那个"循环引擎"选择器是**新会话的默认值**（§4.1），composer 里那个选择器改的是**当前会话**（§4.2）——两者读写的不是同一个东西。

preset 现在的定位是**agent-plane 组合**：它决定这个会话的 prompt 面、命令面、技能面（§3），也仍然是"没有记录的会话跑哪个引擎"的答案来源。它不再是"运行中的会话跑哪个引擎"的开关。

### 1.1 引擎判定的优先级

| 优先级 | 事实 | 位置 | 何时命中 |
|---|---|---|---|
| 1 | 插件的逐会话引擎记录 | `$DSH_HOME/.loop-engine/engines.json`，读写 `src/session-engine-store.ts:147-216` | 这个会话被换过引擎（无论空白期还是跑过一轮之后） |
| 2 | 会话记录（持久化日志）的 `agentPreset` 投影 | `src/engine-of-session.ts:78` 的 `engineOfSession`，经 `ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })` | 这个会话没有插件记录——所有老会话 |

命中 1 时**不再读日志**：有记录就照记录回答，因此持久化不可用时会话的引擎照样答得出来。命中 2 时读的是**持久化**的 `agentPreset` 投影 —— 把会话 header 与日志里每一条 `agent-preset/selected` 一起折出来的结果。

它**不**读会话 header（那是创建事实：空白期换过引擎的会话，header 仍写着创建时的 preset），也**不**读客户端会话列表里的 `agentPreset` 投影 hint（主仓 `packages/api/session-controller/src/list.ts:268-292` 的 `projectionsFor()` 自己写明那是缓存形状的偏值："Listing hints contain every currently cached wire value but remain partial: missing cells and cache rows are never materialized here"）。历史上 chip 读的正是后者，于是出现过真实事故：一条 header 记 `loop-engine-claude-code`、日志里 `agent-preset/selected = loop-engine-pi` 的会话**实际跑 pi**，chip 却显示 Claude Code。现在这条路已经不存在。

**路由与显示读同一段判定，显示再多一层「活 agent」。** 路由（`src/router-loop.ts:212` 的 `engineFor`、`:316` 的 `resume`、`:284` 的 `createAgent`）用它决定用哪个引擎建 agent，插件自己的 Remote（`src/engine-remote.ts`，端点 `loopEngine/engine`）用它回答显示——所以「会话被哪个引擎驱动」与「会话被显示成哪个引擎」在构造上是同一段判定，而**显示**还要再精确一步（§1.3）：一条有活 agent 的会话，它的引擎就是路由器账上那个 agent 的引擎；记录只在**没有**活 agent 时才作为「这条会话跑什么」的答案。

**显示永远只报「实际」，记录多出来的那一半单独标出。** 换引擎只有两种落地方式（§5）：托管引擎之间**原地换手**（记录与活 agent 同时改，没有第二个事实），涉及 in-process 时**先写记录、再释放这条会话的 agent、然后让页面重新载入**（会话变冷，记录就是它下一次构建要用的引擎，同样没有第二个事实）。所以报告里那两个事实**在正常路径上只剩一个**；`{ engine: <实际>, pending: <记录的那个> }` 这个形状只在**那次释放没成功**时才出现（teardown 抛错、或有人手改了侧车文件），此时会话仍由旧引擎驱动，chip / composer 写的是「正在跑的那个 · 切到 X · 尚未接管」，并提示再选一次目标引擎重试。三处露面（会话头 chip、composer、turn-status 行）**一律显示实际**，只有 chip 与 composer 额外把那句标注渲染出来（composer 的菜单里被标注的那一项也带同样的后缀，§1.3/§4.2）。`select` 的回包在「涉及 in-process」那次会带 `reload: true`，客户端据此**自动重新载入页面并回到这条会话**（§4.2、§5.2）；被拒绝时回包带一个**原因码**（`LoopEngineRefusalCode`，`src/agent-preset-ids.ts:198-223`）加上宿主自己那句话，客户端按码给本地化文案、把宿主原话留作详情（§5.3）。

### 1.2 preset 映射（回退路径）怎么读

四个引擎各自对应一个 preset id，映射是固定且公开的规则：

| preset id | 引擎 | 显示名 |
|---|---|---|
| `loop-engine-codex` | Codex | `Codex` |
| `loop-engine-kimi` | Kimi Code | `Kimi Code` |
| `loop-engine-claude-code` | Claude Code | `Claude Code` |
| `loop-engine-pi` | Pi | `Pi` |
| `loop-engine`（旧版单 preset id，只出现在旧会话里） | **未记录**——它当时跑的确实是托管引擎，但这个 id 没说是哪一个 | `旧版托管引擎` |
| 其它 preset（harness 自带的 `standard` / `minimal` / `ptc` / `cordis`，或部署自建的） | in-process（harness 自带的 agent loop） | 该 preset 自己的名字 |

规则定义在 `src/agent-preset-ids.ts:97`（engine → preset id，`enginePresetId`）与 `src/agent-preset-ids.ts:119`（preset id → engine，`engineOfPreset`）；只有本插件 own 的 id 才算引擎，任何部署自己写的 preset 一律落到 in-process。旧版单 preset id 是具名常量 `LEGACY_HOSTED_PRESET_ID`（`src/agent-preset-ids.ts:88`）。这个模块**零导入**，所以 node 侧与浏览器侧共用同一份规则：`src/preset.ts:43-47`、`src/settings.ts:22-27` 只是把它转出去（理由见 `docs/architecture.md` §4.5）。

三态（同一个类型 `SessionEngine`，`src/agent-preset-ids.ts:136-141`）的含义与显示规则：

| 会话记录的 preset | 三态 | 路由 | 显示 |
|---|---|---|---|
| `loop-engine-<engine>` | `{ kind: 'engine', engine: '<engine>' }` | 那个引擎 | 那个引擎的名字 |
| 其它任意 preset（含部署的 `standard`） | `{ kind: 'engine', engine: 'in-process' }` | in-process | in-process 的名字 |
| `loop-engine`（旧版单 preset id） | `{ kind: 'legacy' }` | in-process（`engineOfPreset` 读作 `undefined`，由 harness loop 兜底） | 「旧版托管引擎」——**托管引擎，但没记录是哪一个**，不冒充进程内 |
| 没有 preset / 读不到 | `{ kind: 'unset' }` | in-process | 会话头 chip 不渲染，composer 显示「未记录」 |

判定函数是 `sessionEngineOf`（`src/agent-preset-ids.ts:297`）。`hostedEngineOf`（`src/agent-preset-ids.ts:314`）是路由那一半：它把三态收成「托管引擎 id 或 undefined」，所以 `legacy` / `unset` / `in-process` 三种回答在路由上都落回 harness loop。

### 1.3 「实际」与「记录」：报告的形状与判据

`remote.loopEngine.engine({ sessionId })` 的回答是一个**报告对象**，不是一个裸引擎：

| 字段 | 含义 | 怎么得到 |
|---|---|---|
| `engine` | 这条会话**此刻真正在跑**的引擎（仍是 §1.2 那个三态 `SessionEngine`） | 有活 agent 且由本路由器驱动 → 路由器账上那个 agent 的引擎；否则 → §1.1 的读取（记录，或 preset 映射） |
| `pending?` | 这条会话**已经记下**、但活 agent 没能让位给它的引擎 | 只在有活 agent、且侧车记录与它不同时出现——**正常路径上不会出现**，见下 |

形状定义在 `src/agent-preset-ids.ts:158-168`（`SessionEngineReport`），判定在 `src/engine-of-session.ts:128`（`engineReportOfSession`），端点由 `RouterLoop.reportEngine`（`src/router-loop.ts:385`）供货（没有挂上路由器时退回 `engineOfSession`）。

- **判据是「谁在驱动」，不是「写了什么」。** 路由器 `live` 记账里的 `engine`（`RouterLoop.live`，`src/router-loop.ts:176`）是它**自己构建**这个 agent 时用的引擎——它最清楚这条会话现在由什么在跑，所以它压过记录。
- **`pending` 在正常路径上不出现。** 换引擎只有两种落地方式（§5）：托管引擎之间**原地换手**（记录与活 agent 一起变），涉及 in-process 时**释放这条会话的 agent**（会话变冷 → §1.1 的记录直接就是答案，没有第二个事实）。所以「活 agent 的引擎 ≠ 侧车记录」只剩一种来源：**那次释放没有成功**（teardown 抛错、或有人手改了侧车文件）。这时会话仍由旧引擎驱动，而记录写的是新引擎——报告把两个事实都报出来，chip / composer 写「正在跑的那个 · 切到 X · 尚未接管」（§4.2），用户再选一次目标引擎即可重试那次释放。
- **没有活 agent 时报告的 `engine` 就是记录（没有记录则是 preset 映射），`pending` 永远不出现。** 冷会话（宿主没加载它）、路由器还没挂上的窗口，都没有「正在跑」这件事可说；此时记录**就是**「这条会话跑什么」——它就是下一次构建会用的引擎。**刚被一次切换释放掉的那条会话正是这个状态**：记录就是它重新载入页面后被构建时用的引擎（§5.2）。
- **有活 agent 且没有记录**（本插件从没换过这条会话）→ `engine` 就是活 agent 的引擎，`pending` 不出现：没有记录就没有第二个事实可言。
- **`pending` 不是引擎名。** 它从不占「当前引擎」的位置（§4.2、§5.2、§8），只作为一句标注出现；chip 与 composer 的选中项都是 `engine`。
- **代价不变**：有活 agent 时这条路**不读会话日志**（记录已经够回答第二个字段，`src/engine-of-session.ts:137-140`），只有没有活 agent 时才走 §1.1 的持久化投影。

**一个连带的语义变化（重要）**：上一版里「旧版单 preset id」（§1.2 的 `legacy`）在显示上被硬性说成「至少不是进程内」。现在「实际」优先，所以一条**已经打开、由路由器按 harness loop 跑着**的 legacy 会话，chip 报的就是 **`in-process`**——那是它此刻真正在跑的东西（`legacy` 只是「这个 id 没记下当年跑的是哪个托管引擎」）。`legacy` 仍然出现在**没有活 agent** 的回答里（冷会话、或宿主还没来得及构建它），chip 在此期间照旧显示「旧版托管引擎」。判定不变、语义更准：知道更多就不再说「不知道」。

## 2. 让会话 A 跑 Codex、会话 B 跑 Kimi

### 2.1 新会话页的 preset chip 是 **agent-plane 组合**选择器

新的 web 会话页上有一个 agent preset chip（harness 的 `conversation.hero.agentPreset` 座位，主仓 `packages/client/ui-agent-preset/src/client/index.ts:154-157`）。它的菜单列出 roster 当前发现的所有 preset，包括本插件写的四个。

它选的是**这个会话的 agent-plane 组合**（prompt 面、命令面、技能面）。它顺带仍然是引擎的决定者，但只在**新会话**这一条路径上成立：新会话还没有插件记录，所以引擎按 §1.1 落到 preset 映射。等这个会话被换过引擎之后，chip 和它显示的东西就不动了——引擎归插件记录管，preset 不再变。

- **会话 A**：新建 → preset 选 `Codex` → 发第一条消息。这个会话从第一轮起就是 Codex 在驱动。
- **会话 B**：再新建 → preset 选 `Kimi Code` → 发消息。它与 A **同时**跑在同一个进程里，各有自己的 CLI 子进程。
- 想要 in-process 就选 `standard`（或任何部署自己的 preset）。

选择是**逐会话**的：`AgentPresetSeat` 的说明就是"picking stages; the choice reaches a session when one becomes current"（主仓 `packages/client/ui-agent-preset/src/client/AgentPresetSeat.tsx:8-13`）。chip 的默认值来自 roster 的默认 preset，也就是 §4.1 设置的那个默认引擎。

### 2.2 会话头是"这个会话在跑什么"的可靠指示

会话头部有一个 preset 标签，显示该会话记录的 preset 的**显示名**（`Codex` / `Kimi Code` / `Claude Code` / `Pi`，或部署 preset 的名字）（主仓 `packages/client/ui-agent-preset/src/client/AgentPresetLabel.tsx:46-62`）；这四个显示名正是本插件写进每个 preset 目录的 `preset.yml`（`src/preset.ts:89-100`）。

它是只读的，而且它读的是会话列表里的 `agentPreset` hint —— 在**换过引擎**的会话上它会停在**创建时**记的那个 preset（主仓 `packages/client/ui-agent-preset/src/client/AgentPresetLabel.tsx:1-8` 的模块注释）。现在它额外的语义变化是：**引擎已经不写在 preset 里了**，所以它显示的是"这条会话的组合面"，而不是"这条会话跑哪个引擎"。

同一个 header 里还有**本插件的引擎 chip**（座位 `conversation.session.header.actions`，`src/client/index.ts:114-127`；`order: -20`，排在 preset 标签前面，`:122`）。它读的是**本插件自己的 Remote**（`remote.loopEngine.engine`，`src/client/LoopEngineBadge.tsx:87-111`，取值 hook 在 `src/client/use-session-engine.ts:71`）——也就是 §1.3 那份「实际 + 记录」报告。呈现规则：

- **名字永远取自 `engine`（实际）**：有引擎（活 agent 的、记录的、或 preset 映射给出的）→ 那个引擎的名字，tooltip 用 `sessionNotice` 说明"本会话当前运行的引擎：有活 agent 时就是正在驱动它的那个引擎，没有活 agent 时才看插件的会话级记录，没有记录再回退到它自己的 agent preset"（`src/client/locales.ts:116` 中文、`:161` 英文）。
- **记录多出来的那一半只作为标注追加**，例如 `循环引擎 · Pi CLI · 切到 进程内引擎（默认） · 尚未接管`：文案由 `enginePendingPrefix`/`enginePendingSuffix`（`src/client/locales.ts:118-119` / `:163-164`）加目标引擎自己的名字拼出（`pendingEngineText`，`src/client/locales.ts:237`），tooltip 换成 `pendingSessionNotice`（`:121` / `:166`）说清"记录里的引擎没能接管，此刻仍由另一个引擎驱动；出现这种情况只有一种原因（上一次切换要释放旧 agent，而那次释放没有完成），再选一次目标引擎即可重试"。没有这一半时 chip 上一个字都不多。
- 旧版单 preset id `loop-engine` → **"旧版托管引擎"**（`engineLegacy`，`:103` / `:148`）。它当时跑的确实是托管引擎，但那个 id 没记录是哪一个，所以 chip 不冒充"进程内引擎"；tooltip 换成 `legacySessionNotice`（`:117` / `:162`）如实说明"这是本插件早期版本创建的会话，它实际跑的引擎没有被记录"，并提示**选一个引擎就能在本会话里切换**。⚠️ 例外：这条会话**已经打开**时它由 harness loop 跑着，报告里的 `engine` 是 `in-process`（§1.3 末条），chip 就如实写 `in-process`；`legacy` 只在这条会话**没有活 agent** 时出现。
- 其它 preset（harness 自带的 `standard` / 部署自建的）→ `in-process`（映射规则 §1.2）。
- 会话没有记录任何 preset 且没有插件记录（或宿主答不出来）→ **chip 不渲染**（返回 `null`）。宿主第一次回答到达之前同样不渲染——**chip 从不猜**。

**chip 与 preset 标签的差别（重要）**：chip 显示的是"这条会话实际在跑什么"，而 harness 自己的 preset 标签读的是会话列表里的 `agentPreset` 投影 hint，在**换过引擎**的会话上它会停在**创建时**记的那个 preset。真实数据佐证：一条 header 记 `loop-engine-claude-code`、之后换到 pi 的会话，实际跑的是 pi（它自己写进 `request/header` 的 provider 就是 `pi`），chip 显示 Pi 而 preset 标签仍显示 Claude Code。判断"这条会话到底在跑什么"以 chip（或实际行为）为准。

⚠️ **仍然只显示默认值的地方就剩设置页**（设置 → 循环引擎）：那一栏是"新会话默认跑什么"，与当前打开的会话可能不一致——例如默认已切到 Codex，而你正开着一条 Kimi 会话时，chip 显示 Kimi、设置页显示 Codex。判断某条会话跑什么，看 chip。

**turn-status 行与 chip 同源，只跟在屏的那条会话，而且只画「实际」，并且只在这一轮还在跑时画**：对话页那行「深度求索中…」的配色与字形跟着**当前会话**的引擎走，不跟设置里的默认值，也不跟 pending——一次还没落地的切换不该改变这行动画。它由一个 **document 级属性** `<html data-loop-engine>` 驱动（样式表要按属性选择器选中 harness 哈希过的类名，而这一行不是 slot、插件也改不了它的文本），而属性只能由**在屏会话**写：chip 与 composer 共用的 hook `useEngineOfSession`（`src/client/use-session-engine.ts:79`）先声明焦点（`focusTurnStatusSession`，`src/client/turn-status.ts:357`）、再按同一个会话 id 反射**报告里的 `engine`**（`hostedEngineOf(report.engine)`，`reflectTurnStatusEngine`，`:333`，守卫在函数第一行：**非焦点会话的反射是无操作**；卸载时 `blurTurnStatusSession`，`:373`），样式表 `installTurnStatusStyles` 只负责注入（`src/client/turn-status.ts:426`）。所以 chip 显示 Pi 时那一行画的就是 Pi 的动画，而且**不会被别的会话改掉**：缓存 `SessionEngineCache` 发布答案时只通知该会话的 watcher（`src/client/session-engine.ts:704-706` 的 `publish`，**不再碰 document**）——旧实现是在 publish 里无条件反射，于是不在屏的会话（或切换会话时旧会话那次迟到的取值）能把它改成自己的引擎，用户实测到的正是"屏上跑 Pi、那一行画出 Kimi 的月亮"。`legacy` / `unset` / 宿主还没答出来 / 换引擎后缓存被作废的那一刻都**不画**（清掉属性、恢复 harness 原样）——不知道是哪个引擎就不冒充任何一个。属性不在卸载时清除：同一会话的另一个界面还在用它，而残留属性在没有这一行的页面上无害。

**整张样式表还挂在第二个属性上：`<html data-loop-engine-running>`**（`src/client/turn-status.ts:94` 的属性、`:408` 的写入、`:275` 的样式表）。原因在两代的 DOM 差异：0.1.5 那行只在轮次进行时存在，轮次一结束就没有承载物；0.1.7 把它重做成了 `button[data-turn-process]`，而且**每一轮的行都留在屏上**——所以只按会话门控不够（新一轮开始会把前面所有已结束的行一起重新涂上），0.1.7 的选择器还必须带 `:disabled`（ui-chat 的 `disabled={!canCollapse}`，只在轮次进行中为真，也正是"有箭头那行不是当前行"的原因）：文字在类名后缀 `_label` 的 `<span>` 里，`[class$="_label"]` 选中；字面量 `.label` 不存在，harness 的 CSS Modules 命名是 `[hash]_[local]`，**并且这行在轮次结束后仍留在屏上**——变成"用时 4 秒"那种折叠摘要。只按引擎门控，字形与扫光就会留在一个已经收尾的轮次上（用户实测："对话结束之后动画还在"）。这个门是**界面自己答的**：`session.running` 来自每个会话级槽都拿得到的 `SessionStandardProps.useSession`（`ui-session` 以 `hooks: ['session']` 注册，渲染器折成 `useSession`），chip 与 composer 在组件顶层无条件读出、连同引擎一起交给 hook（`src/client/LoopEngineBadge.tsx`、`src/client/LoopEngineComposerSelect.tsx`，都在各自 early return 之前；`running` 也进了 effect 依赖 `[sessionId, engine, running]`）。**答不出来的界面什么也不传**（`undefined`），门保持上一个能答的界面留下的样子，而不是替它猜"在跑"。0.1.7 那行的渐变（`--dsw-static-deepseek-*` + 扫光）是**插件自己补上的**：harness 这次改版把那行的渐变去掉了，只留一句朴素的三级文字，所以样式表在两种代际上都自己声明这条渐变（0.1.5 上是等值覆盖，无副作用）。

## 3. 与内置 preset 选择器的关系

本插件没有自己的 preset 机制，它只是**往用户 preset 根里写四个 preset**（`$DSH_HOME/.agent-presets/loop-engine-<engine>/`，`src/preset.ts:200-210`），并把 roster 的默认值指过去。因此：

- 这四个 preset 在 **设置 → Agent preset** 里和别的 preset 一起出现，能像它们一样被查看、被"设为默认"（主仓 `packages/client/ui-agent-preset/src/client/section-store.ts:330-337`，其文档也明确"运行中的会话保持它们开始时的 composition"）。
- 每个 preset 的 composition 是**部署自己的 `standard` 剥掉六行**（`skill-filesystem`、`tool-skill`、`tool-goal`、`command-goal`、`planning`、`compaction`，`src/preset.ts:79`）再加上引擎自己桥进来的命令与技能。理由：dsh 的 `/plan`、`/compact`、`/goal`、dsh 技能目录在外部引擎接管会话时只会重复或误导。其中 `command-goal` **必须在 preset 层剥**：dsh 的人类 `/goal` 命令是 `standard` 组合自己那一行注册的（主仓 `packages/preset/agent-presets/presets/standard/agent.cordis.yml:95`），profile patch 里禁用 host 面那一行够不到由这份组合出来的会话（`standard` 自己带了同名行），所以托管会话里 dsh 的 `/goal` 去留由托管 preset 决定；剥掉之后这个名字不再挡着引擎自己的命令面（Kimi 的 ACP 面没有 `/goal`，它的桥接因此也不注册，`src/engine-kimi/commands.ts:11-28`）。文件头有 managed 标记，**每次启动都从当时的 `standard` 重新生成**（`src/preset.ts:81-86`，`ensureEnginePresets` 在 `:200-210`），手改会被覆盖。
- **真正决定"新会话跑哪个引擎"的是 roster 的 `default` 字段**：设置里"设默认 preset"和设置里"循环引擎"写的是同一个字段。区别只在语义层：循环引擎那一栏是"引擎视角"（in-process / claude-code / codex / pi / kimi），并且**切回 in-process 时会把默认值还原成插件替换前的部署默认**（`src/index.ts:504-528`）。如果你在 Agent preset 里把默认改成了别的东西，再切回 in-process，会看到默认被还原——这是设计语义，不是覆盖你的修改。
- **preset 选择器同时是对引擎的一次选择——只在"这个会话已有插件记录"的空白会话上**：用 harness 自己的选择器换 preset 时，如果新 preset 映射到**别的**引擎、而这个会话已经有插件记录，插件会把记录一并更新到那个引擎（"最后一次用户动作胜出"，`src/router-loop.ts:637-662`）。没有记录的会话不进记录，引擎继续由 preset 映射回答。

## 4. 引擎怎么选：默认值 vs 当前会话

两个入口，**语义不同**（这是本插件的核心区分）：

### 4.1 设置 → 循环引擎：改的是**默认值**

section id `loop-engine`（注册点 `src/client/index.ts:100-106`）：下拉 + 确认弹窗（`src/client/LoopEngineSection.tsx:171-180`）。提交后发生什么：

1. 插件把 roster 的默认 preset 指向 `loop-engine-<engine>`（in-process 则还原部署默认值）。
2. **下一个新建的会话**用这个引擎。
3. 已有的会话**完全不受影响**——`defaultId` 是每次调用现读的（主仓 `packages/preset/agent-presets/src/index.ts:240-242`）。已经换过引擎的会话由其插件记录决定，换过默认值也动不了它。
4. **不需要重启 `dsh web`，也不需要刷新页面**：client 侧提交后不做任何 reload（`src/client/LoopEngineSection.tsx:171-180`）。

UI 文案与这一语义一致：`switchNotice` 只说"这一选择只决定新会话用哪个引擎，已经在跑的会话不受影响"（`src/client/locales.ts:108`，英文 `:153`），`confirmBody` 只说"此后新建的会话会使用这个引擎；已存在的会话保持它们各自的引擎不变，也不需要刷新页面"（`:111`，英文 `:156`），section 的 `description` 也限定为"新会话默认使用"（`:97`，英文 `:142`）。

### 4.2 composer 里的引擎选择器：改的是**当前会话**

座位 `conversation.input.right`（注册点 `src/client/index.ts:153-170`），可用设置里的 `showInComposer` 关掉。它选的是**这条会话跑的引擎**：

- **显示**：有会话时只显示**这条会话自己**的报告，绝不回退到设置里的默认值（`src/client/LoopEngineComposerSelect.tsx:320-329` 取值、`:169-175` 的 `triggerFace` 折成"显示什么"）：名字与图标、以及菜单高亮的那一项，永远是**实际**引擎（`engineStateLabelKey`，`src/client/locales.ts:214`）——有引擎 → 引擎名；旧版单 preset id → `engineLegacy`「旧版托管引擎」；没有 preset 且没有记录 / 宿主答不出 → `engineUnrecorded`「未记录」。后两种情况**不高亮菜单里任何一项**（`selectedId` 为空），也不会画引擎图标——会话的引擎不是任何默认值能顶替的。宿主**第一次回答到达之前**显示 `engineLoading`「读取中…」（`:152` 的 `READING`），既不是默认值也不是旧值。只有**没有会话**（会话前的新会话页，也就是这个座位的防御分支）时才显示设置里的默认值（`:178-180` 的 `defaultFace`）。
- **引擎还在读取时，选择器是禁用的（置灰、打不开菜单）**。有会话而报告还没到时，这个控件不但不冒充任何引擎，**也不接受任何操作**：trigger 用 `disabled` 样式（`:361` 的 `disabled = !writable || !switchReady`，样式 `triggerDisabled`，`:253`），点它不会打开菜单，但**文案照旧是「读取中…」**——这一条与"未记录""旧版托管引擎"都不同，那两种是**已有答案**（分别是"没有记录"与"记录里那个旧 id"），只是答案里没有引擎名；这里等的是**答案本身**。判据是 `engineSwitchReady`（`src/client/session-engine.ts:205`，`report !== undefined` 的谓词），它同时是类型收窄：`onSelect` 里先过它，`switchNeedsReload` 才拿得到报告里的实际引擎（详见下一条）。**没有会话时不适用**：那一支写的是新会话的默认值，不等任何东西、也不重载任何页面，所以从一开始就可点（`:336` 里的 `sessionId === undefined ||`）。
- **记录里的那一半用一句标注，不当名字**（`src/client/LoopEngineComposerSelect.tsx:365-375`）：报告里带第二个字段时，触发按钮的标签变成 `Pi CLI · 切到 进程内引擎（默认） · 尚未接管`（三段由 `pendingEngineText` 拼出，`src/client/locales.ts:237`），菜单高亮的仍是实际引擎，tooltip 换成 `pendingComposerHint`（`src/client/locales.ts:122` / `:167`）——那句话说清"记录里的引擎没能接管，本会话此刻仍由另一个引擎驱动（只有涉及进程内引擎的切换才会这样，而这种状态说明那次释放没有成功）"，以及"再选一次目标引擎即可重试；选当前正在跑的那个引擎则会把记录改回去"。
- **记录里的那一项在菜单里也带标注**（`src/client/LoopEngineComposerSelect.tsx:474` 的 `option.value === pending`，后缀文案 `engineMenuPendingSuffix`，`src/client/locales.ts:120` / `:165`，样式 `rowPendingMark`，`:284-288`）：菜单行的标签变成 `进程内引擎（默认）（尚未接管）`。原因很实在——触发按钮在 220px 的宽度里会截断成省略号，用户展开菜单如果看不出哪一项对不上，就会以为"点了没反应"。**✓ 仍然只标在不是"实际在跑"的那一项上**（`selectedId` 来自报告的 `engine`，`:479`）：`pending` 与 `engine` 在构造上就不可能相同（`src/engine-of-session.ts:141` 只在 `recorded !== live` 时才产出 `pending`），所以被标注的那一行永远不会同时是选中行——显示必须等于实际。
- **托管引擎之间：选中即生效，什么也不弹**。`onSelect`（`src/client/LoopEngineComposerSelect.tsx:432-453`）在菜单选中那一刻先判一句"这次会不会重载页面"（`switchNeedsReload`，`src/client/session-engine.ts:250-253`）：**目标引擎与这条会话实际在跑的引擎恰好一边是 `in-process`**（实际引擎取自报告，不是记录）才会重载，托管引擎之间不会。不会重载就直接提交、**不弹任何东西**；选中项与**实际**引擎相同时是纯 no-op，连请求都不发——注意这条判定比对的是实际引擎而非记录（"把记录撤回、让它保持原样"正是靠它）。**这条判定只对已知引擎做**：`onSelect` 先过 `engineSwitchReady`（`:446`），报告没到手就直接返回、什么都不提交、也不弹任何东西。正常路径上走不到这一支——引擎未知时选择器是禁用的（上一条）——它兜的是"菜单开着、答案被一次已提交的切换作废掉"那一下：那一瞬间控件重新变回"读取中…"，此时从还开着的菜单里点一项，会被丢掉而不是拿去猜。提交走**本插件自己的** Remote：`remote.loopEngine.select({ sessionId, engine })`（`commitSwitch`，`:382-425`，调用点 `:395`；helper 与线协议在 `src/client/session-engine.ts:760-803`；主机端点 `loopEngine/select`，`src/engine-remote.ts:233-255`，实现 `src/router-loop.ts:404-441`）；没有会话时（理论上不会出现在这个座位上）才写默认值。**这条会话现在能不能换由宿主判定**，客户端不预判：会话列表里的 `running` 之类提示都是缓存值，正是本插件一直在摆脱的东西，所以选了就直接发请求，被拒时再把原因显示出来。**切回 `in-process` 时宿主的答复里还包含"这条会话的模型选择已经改成部署默认模型"这个连带动作**（§5.2），界面上不需要额外提示——模型座本来就在宿主那半按会话的当前选择渲染。
- **涉及 in-process：先确认代价，再提交**。要重载的那一类会先弹一个**两个按钮的确认框**（`switchReloadConfirmTitle` / `switchReloadConfirmBody` / `switchReloadConfirmAction` 与 `cancelAction`，`src/client/LoopEngineComposerSelect.tsx:505-518`，文案 `src/client/locales.ts:131-133` / `:176-178`）：正文说清这次切换要重新载入页面才能让 harness loop 接管、**滚动位置与没发出的草稿会丢**、会话记录不受影响；用户点确认才发请求（`confirmReload`，`:454-458`），点取消就当没选过。**为什么客户端敢自己判**：这一类的边界是确定的（§5 的判据），而且判错的方向是不对称的——多弹一次只花一次点击，少弹一次就是用户丢草稿；`legacy` / `unset` 这两种"报告没给引擎"的会话按 in-process 那一侧算（路由对它们也是这么兜底的，§1.2），而宿主**还没答出引擎**的会话**根本选不了**（选择器禁用，见上面「引擎还在读取时」那一条），所以这里的判断**只对已知引擎做**：它没有、也不该有"未知"这一支——`switchNeedsReload` 的形参已收紧成 `SessionEngine`（非可选），猜测被挪走成了"先禁用、等答案"。**为什么托管引擎之间不弹**：那一类原地换手、页面不重载，多一个确认框只会让人以为切换有代价。
- **成功（托管引擎之间）**：插件把记录写进侧车，然后**原地换手**——会话的 `Session` 对象、store 条目、写句柄全部保留，只有 agent 被换成新引擎的（§5.1）。选择器的显示**不再**被动等投影变化：成功回调（`src/client/session-engine.ts:793`，接在 `src/client/index.ts:148`）立刻**作废该会话的缓存并向宿主重新取值**——否则换完还会显示旧引擎。回包不带 `reload`，所以页面不重载。
- **成功但需要重载页面（与 in-process 之间）**：宿主在成功回包里带 `reload: true`（§5.2），客户端**自动重新载入页面**：先把这条会话的 id 存进本标签页的 `sessionStorage`（`armReloadReturn`，`src/client/reload.ts:95-107`），再 `window.location.reload()`（`sessionEngineSwitcher`，`src/client/session-engine.ts:799-800`）。重载之前会先弹一句说明（标题 `switchReloadTitle`、正文 `switchReloadBody`「已切到新引擎，正在重新载入页面并回到本会话…」，`src/client/LoopEngineComposerSelect.tsx:420-423`、`src/client/locales.ts:134-135` / `:179-180`），而不是让页面自己一闪而过。重载完成、页面重新拉回会话列表后，插件用存下的 id 调 `sessions.open(id)` 回到这条会话（`restoreReloadReturn`，`src/client/reload.ts:164-206`；接线在 `src/client/index.ts:91` 的 `installReloadReturn`），宿主随即按记录构建它——这是这条连接**真的会重载页面，且进程不重启**的原因（§5.2）。
- **被拒绝：按原因码说人话，宿主原话留作详情**。回包里的 `code` 决定文案（`refusalFace`，`src/client/locales.ts:299-301`；映射表 `REFUSAL_FACES`，`:278-286`），中英各一句、陈述语气，**不再**把宿主那句英文原话直接当正文（§5.3 逐条列出码与文案）。两个码（`record-failed`、`rebuild-failed`）的文案说不清底层原因，于是把宿主的 `reason` 以小字附在下面（`noticeDetail`，`src/client/LoopEngineComposerSelect.tsx:304-309`、渲染点 `:527`）；没有码或码不认识（更新的宿主、网关拒掉的调用、连接断了）则回落到显示 `reason`，任何情况下都有可读信息。拒绝不改会话的引擎，所以选择器**自动回到会话实际运行的引擎**（缓存本就没错）。拿不到插件自己的 Remote 服务时才说本插件自己的话：`switchUnavailable`（`src/client/locales.ts:136` 中文、`:181` 英文）。
- **弹窗用途要分清**：提交前的**确认框**（两个按钮：确认 / 取消，只有"会重载"的那一类才出现）、事后报告的**错误提示**（一个"关闭"按钮）、以及重载时那句**说明**（`switchReloadTitle` / `switchReloadBody`）——三者的标题、正文、按钮各不同，见上两条；确认框**不能**退化成一个只会"关闭"的提示（那等于没给用户选择）。
- **文案如实说清代价**：`composerHint`（`src/client/locales.ts:123`，英文 `:168`）写的是"选择本会话运行的引擎：托管引擎之间选中即生效，原地换手，会话保持打开、agent 被替换；与进程内引擎之间的切换无法原地接管（harness 的 loop 既不交出活会话、也不接管别人建的会话），选中时会先说明代价并等确认，确认后宿主拆掉这条会话的 agent 并让页面重新载入，回来时仍是这条会话，由新引擎重建（那次重载会丢掉这一页的滚动位置与未提交的草稿，会话记录不受影响）。会话需已打开且空闲，否则宿主会说明原因"。

## 5. 引擎何时能换：任何打开且空闲的会话都能换

**引擎是插件持有的会话级记录，所以任何时候都能换**——包括已经跑过很多轮的会话。这是本次改动的核心：旧规则"引擎在会话创建/空白期确定，之后锁定"已经不存在。

- **能换的前提**：这条会话**已经打开**（有活 agent），并且**当前空闲**（没有进行中的一轮）。两个前提各对应一条可读的拒绝原因（§5.3）。
- **分成两半，判据是"有没有 in-process"。** 这条会话现在驱动的引擎与要换成的引擎**都是托管引擎** → **原地换手**（§5.1）；**任一边是 in-process** → 宿主**释放这条会话的 agent**，并让页面重新载入（§5.2）。两边都不需要知道"下一次构建是谁触发的"：释放之后会话就变冷，而冷会话的下一次构建（= 页面重新打开它）一定按记录选引擎。
- **模型座位与记录同时落盘**：写下记录之后**立刻**写这条会话的模型座位（§5.2「模型座位跟着引擎走」），按**目标引擎**定值：目标是托管引擎就写共享的 `external/default`，目标是 in-process 就写部署默认模型；会话日志里已经是一条**真实 dsh 模型**（provider 不是托管路由标签，`external` 或旧四家）时一个事件都不写。这个标签只有本插件的**占位路由**服务、真有模型调用过来会直接抛 `HOSTED_ENGINE_ROUTE`，而进程内那一侧才是真去调模型的——所以座位必须跟着引擎走。
- **进行中的输出永远不会被中断**：正在跑的时候直接拒绝，不做抢占（§5.3）。
- **空白会话仍然照旧**：宿主自己的 preset 选择器对没跑过一轮的会话依然可用（`AgentPresets.select`，主仓 `packages/preset/agent-presets/src/index.ts:709-726`）。换 preset 时 harness 只重组合 agent 的 scope、**不重建 agent**，所以插件自己补一步：若新 preset 指向**别的**引擎且该会话是空白的，就释放旧 agent，下一次 resolve 用新引擎重建（`src/router-loop.ts:637-662`）。这条路径也走 release（会话被拆掉重建），理由见 §5.1 末尾；它同时做上面那条同样的模型座位写入——目标是托管引擎就写 `<新引擎>/default`，映射回 **in-process** 就写部署默认，真实模型不动——而且必须在释放**之前**（`moveModelSelection`，`src/router-loop.ts:660`）。
  - "空白"= 没有开着的 turn 且 `lastTurn === 0`；**只跑过斜杠命令不算跑过一轮**（主仓 `packages/preset/agent-presets/src/index.ts:712-713`）。
  - 这条路径同时实现"最后一次用户动作胜出"：会话已有插件记录时，把记录也更新到新 preset 指向的引擎，否则两个入口会互相打脸（选择器按 preset 重建，下一次 resume 又按记录搬回去，`src/router-loop.ts:637-662`）。
- **resume（宿主还没有活 agent 时的构建路径：进程重启后的冷读、从列表里打开一条本进程没加载过的会话、或一条刚被切换释放掉的会话）按记录优先**：有记录用记录，没记录用日志里记的 preset（`src/router-loop.ts:316-324`，读走 `src/engine-of-session.ts:78-92`）。所以"关掉浏览器明天再来"不会让你的 Kimi 会话变成 in-process，也不会丢掉换引擎的结果。**涉及 in-process 的那次切换就靠这条路落地**：会话已经是冷的，页面重载并重新打开它的那一次 resolve 会按记录构建它（§5.2）。

### 5.1 托管引擎之间：原地换手（hot swap）

**会话不会被拆掉。** 一次换引擎（`src/router-loop.ts:430-467` 的 `selectEngine`，换手在 `:535-570` 的 `hotSwap`）按固定顺序做这些事：

1. **校验**（非法请求由端点拒绝）：会话打开 / 空闲 / 非子会话，以及这条会话确实归本路由器管（§5.3）。
2. **先写侧车记录**（`SessionEngineStore.record`，`src/session-engine-store.ts:177-182`，temp + rename 原子写）。写不进去就拒绝，会话原样不动。
3. **模型座位跟着换**（`moveModelSelection`，`src/router-loop.ts:691-693`，调用点在 `:465`）：按**目标引擎**定值——托管引擎写 `<新引擎>/default`，`in-process` 写部署默认；会话日志里已经是**真实 dsh 模型**、或**一条选择都没有**时不写（§5.2「模型座位跟着引擎走」）。它必须在换手**之前**落地，因为继任者那次构建（原地 swap 的 `setup`、或重载之后那次 resume）紧接着就会读它。
4. 记录与活 agent 的引擎相同时返回（记下就完了，不重建，也不重载）。
5. 否则按 §5.2 的判据分两路：**任一边是 in-process** → `release`（`:504-511` 的 `move` 调 `:602-604` 的 `release`），回包带 `reload: true`；**两边都是托管引擎** → `hotSwap`：
   1. **旧 agent 退场**：`retire()`（`src/driver-core/hosted-engine-runtime.ts:274-279`）停机器（`cancel({kind:'disposed'})` → `whenIdle()` → scope 回收）并**只从 `ctx.agents` 摘掉自己**——会话的 store 条目与写句柄留在 `SessionLifetime` 里，随会话交给继任者（`src/driver-core/session-lifetime.ts:35-78`）。
   2. **新 agent 就地发布**：新引擎 runtime 的 `swap()`（`src/driver-core/hosted-engine-runtime.ts:468-483`）用**同一个 `Session` 对象**构造新 agent、跑调用方的 composition 回调、注册进 `ctx.agents`。`sessions.enter` / `sessions.announce` 都不会再调一次——它们对一条已活的会话直接拒绝（主仓 `packages/core/session/src/index.ts:1033`、`:1085-1087`），所以"能走到这一步"本身就是"会话是被 join 的、不是被重新进入的"的证明。
   3. 路由器把 `live` 记账换成新 agent（`src/router-loop.ts:245-264` 的 `adopt`）。

顺序是硬要求：一个 sessionId 只能有一个 agent（`agents.enter` 对重复 id 拒绝，主仓 `packages/core/agent/src/index.ts:466`），而两个机器同时挂在一个会话上会互相 splice 同一个收件箱；所以旧机器必须**先**完全退场、**再**发布继任者。

- **客户端视图不受影响**：这条会话从未离开 `ctx.sessions`，也没有发布过任何 `session/disposed`。浏览器那半只认这个事件（§5.4），收不到就等于什么都没发生。
- **历史与持久化连续**：继任者用的是同一条会话日志，同一个写句柄（后端的 live 路由是按 sessionId 找 writer，主仓 `packages/session/session-persistence-jsonl/src/storage.ts:535`），所以换手既不丢事件、也不会去找第二个 writer（那会被后端以"已被占用"拒绝）。
- **下一轮就是新引擎**：宿主的 prompt 路径每一轮都按 sessionId 现取 agent（主仓 `packages/api/session-controller/src/agent.ts:187` 的 `liveAgent`），所以注册完继任者，下一条输入自然落到它身上。⚠️ 继任者拿到的 `agentOptions` 是这条会话**构建时**那一份（`BuildRecipe.agentOptions`，`src/router-loop.ts:131-138` 由 `hotSwap` 交给 `swap()`）——换手不重算它，任何引擎都不读它；真正被宿主读到的是第 3 步与上面那次构建写进日志的座位。
- **换手失败怎么办**：旧机器已经退场、继任者没能发布，这时**没有东西在驱动这条会话**。插件把这条会话的 `SessionLifetime` 释放掉（关写句柄 + 离开 store，`src/router-loop.ts:561-567`），于是它变回一条冷会话：下一次打开时按记录（也就是刚写下的新引擎）重建，和任何宿主没加载过的会话一样。拒绝原因里写清了失败原文。
- **preset 通道也走 release，但那条路径没有页面重载**：harness 自己的 preset 选择器换的是**组合**，新 agent 要用**新 preset 的** composition，而这份 composition 只有 API 层会组装（`composeAgent`，主仓 `packages/api/session-controller/src/agent.ts:374-390`）；插件手里只有引擎选择器那条路径的 composition 回调，拿不到"某个 preset 的"回调，所以这条路径继续"释放旧 agent、下一次 resolve 重建"。它只对**空白**会话生效（§5 的上一条），删掉这条释放不会有任何收益（旧 agent 的 scope 与写句柄都还在）。**不同之处**：这条路径由 harness 自己的控件触发，插件的客户端半插不上话，所以它**发不出**"重载页面"这一步——release 同样会发 `session/disposed`，那条会话在页面上的表现与 §5.4 描述的一致。这是本次改动**没有**覆盖的一处（已知限制，见 §8）。

### 5.2 与 in-process 之间：写记录 → 释放这条会话的 agent → 页面重载（进程不重启）

harness 自带的 loop 在这件事上两头都做不了（证据逐条在 §5.4）：

- **托管 → in-process**：接管方 `AgentLoop` 不接受一条不是它自己创建的会话；
- **in-process → hosted**：交出方既拿不到会话的 store 条目与写句柄，也没法把旧 agent 从 `ctx.agents` 摘掉。

但"做不了原位换手"不等于"只能等进程重启"。这两个方向的实际做法是**把这条会话放冷，再让它被重新构建**，前后 6 步（第 0 步在客户端，只针对这一类的切换）：

0. **客户端先确认再提交**：这一类切换会重载页面，所以在发请求之前先弹一个两个按钮的确认框，说清代价（滚动位置与未提交草稿会丢、会话记录不受影响，§4.2），用户点确认才走下面的 1-6 步——托管引擎之间的切换不走这一步，也不弹任何东西。
1. **记录立即写下**（`selectEngine`，`src/router-loop.ts:430-467`）；
2. **第 2 件立刻发生的事：这条会话的模型座位跟着换**（`moveModelSelection`，`src/router-loop.ts:691-693`，调用点在 `:465`，即记录之后、换手之前）——按目标引擎定值（见下面那一段）；
3. **释放这条会话的 agent**（`release`，`src/router-loop.ts:602-604`）。走的就是 harness 自己那套 teardown（`cancel → whenIdle → scope.dispose → handle.close() → detachAgent() → detachSession()`，主仓 `packages/core/session/src/index.ts:1064-1074` 的 `detachEntered`）——**会话因此变冷，而记录就是它下一次构建要用的引擎**；
4. **成功回包带 `reload: true`**（形状 `LoopEngineSelectResult`，`src/agent-preset-ids.ts:234-276`）：`{ ok: true, engine: '<新引擎>', reload: true }`；
5. **客户端据此重载页面**：先把这条会话的 id 写进本标签页的 `sessionStorage`（`armReloadReturn`，`src/client/reload.ts:95-107`），再 `window.location.reload()`（`sessionEngineSwitcher`，`src/client/session-engine.ts:760-803`）；重载前会先弹一句说明（`switchReloadTitle` / `switchReloadBody`，§4.2）。
6. **页面重新拉回会话列表后，插件用存下的 id 调 `sessions.open(id)`** 回到这条会话（`restoreReloadReturn`，`src/client/reload.ts:164-206`；接线在 `src/client/index.ts:91`）。宿主随即构建它：`ApiSessionAgentController.resolve` 的第一件事是看这条会话有没有活 agent（主仓 `packages/api/session-controller/src/agent.ts:183-192`），**此时没有**，于是走 `ctx.agents.resume(...)`（`:430-435`）→ 路由器读记录选引擎（§1.1）。**进程从头到尾没有重启，也不需要重启。**

**为什么页面必须重载（这条路的唯一代价，也是它唯一做的动作）**：`AgentHandle.dispose()` 的最后一步把 Session 摘出 `ctx.sessions` 并发出 `session/disposed`；宿主把它转成 `api-session/removed`（主仓 `packages/api/session-controller/src/index.ts:148-151`），浏览器那半据此把这一行从会话列表里删掉、把当前会话清成 `undefined`，并在那个 Session 实例上写下 `removed = true`——而**这个标记在这份页面生命周期里没有任何复位路径**（主仓 `packages/api/session-controller/src/client/sessions/session.ts:572-573` 写入、`:807` 进快照；消费方 `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:60`、`:128-141` 会把输入框与模型座一起锁住）。也就是说：**不重载的页面会看到一条"用不了"的会话**——这正是用户实测到的「会话不可用」，也是上一版实现把一个能用的功能做成事故的原因。重载的作用只有一个：把整份页面状态换成一份新拉回来的列表与一个**新的、没有标记的** Session 实例。宿主重建 agent 靠的是第 6 步里那次 `resume`，不是重载本身。

**回到同一条会话靠两件事（都可核）**：

- **这条会话仍然在磁盘上**，所以重载后重新拉的列表里**有**它：宿主那半的列表是"持久化 header ∪ 活会话"（主仓 `packages/api/session-controller/src/list.ts:126-144` → `packages/session-query/session-query/src/corpus.ts:61-80`，唯一的过滤是 header 没有 `cwd` 的记录，`:138`）。释放只是让它变冷，不删日志。
- **`sessions.open(id)` 能重新选中它**：`ISessions.open` 就是 `manager.select(id)`（主仓 `packages/api/session-controller/src/client/sessions/service.ts:270-272`），而 `select` 要求这个 id 已在列表里（`manager.ts:168-185`：不在就抛 `sessions.select: unknown session`）。所以插件**只在列表第一次就绪时判断一次**：有它就 `open`，没有就放弃并记一条 warn（`restoreReloadReturn`，`src/client/reload.ts:164-206`）——不然用户早就走开了，页面却在几分钟后突然跳进一条会话。
- 插件**不**依赖客户端自己的"回到上次那条会话"：重载会把宿主侧的持久化选中断言清掉（主仓 `packages/api/session-controller/src/client/sessions/service.ts:633-635`：`current === undefined` 时 `selection.set({})`），而工作区的启动导航只复用最近工作区里的一条**空白**会话、否则新建（主仓 `packages/client/ui-workspace/src/client/navigation.ts:197-241`）。所以 id 由插件自己存、自己开。

**模型菜单里能看到什么（0.1.5-rc3 起；0.1.5-rc5 起四个引擎折叠成一条）**：模型目录是**进程级、按 provider**、而且**整个 Host 代际共享、不按会话区分**的事实（主仓 `packages/api/session-controller/src/catalog.ts:16-46` "Build the browser model catalog without requiring a Session"；主仓 `packages/client/ui-model-selection/src/client/catalog.ts:1` 的注释就写着 "One Host-generation model catalog shared by every Session selector"）。正因为目录不随会话变，**每个托管引擎各占一个标签**只会让每条会话的菜单里同时出现四条一模一样的 `default`；所以四个引擎**共用一个 provider 标签**（`HOSTED_ROUTE_LABEL = 'external'`，显示名同样是 `external`，`src/agent-preset-ids.ts`），菜单里只占一个分组：

- **dsh 自己服务的真实模型照旧全在**（`deepseek-official/…` 之类），在**任何**会话里都能选中，但只对 **in-process** 会话有意义；
- **所有托管引擎共用一个 `external` 分组，名下恰好一条 `default`**：分组名取自 `providerInfo().name`（`HOSTED_ROUTE_NAME`，与 wire 上的 `HOSTED_ROUTE_LABEL` 同一个串 `external`）——目录的 `group.name` 是宿主原样渲染、**没有 i18n 钩子**的固定串，所以每个语言看到的都是它（写进 `request/header`、进选择、参与比较，且 `providerInfo().id` 必须等于注册时的 provider）。`default` 是那一条目录条目的 `id` 与 `name`（`HOSTED_DEFAULT_MODEL`，`src/agent-preset-ids.ts`；`HostedEngineRouteAdapter.listModels`，`src/provider-route.ts`）。它不是模型，而是这批引擎"模型由它自己决定"的那个词：四个驱动把**同一个** provider 标签与**同一个** 模型串写进会话的 `request/header`，于是宿主推导出的 `(provider, model)` 正好落在这一条上，模型座显示 `default`，而不是回落渲染 `${provider}/${model}` 原样串——0.1.5-rc3 之前用户看到的那个"不存在的模型" `kimi/kimi-native` 就是那次回落（选择器拿目录条目的 `model.id` 与宿主推导的 `model` 比对，主仓 `packages/client/ui-model-selection/src/client/ModelSelect.tsx` 的 `choices`/`selectedIndex`）。解释放在插件自己的文案里（任一托管引擎都显示那句 `hostedEngineModelNotice`，判据 `isHostedEngine`，`src/client/locales.ts:115` / `:160`）；
- **托管引擎下选 dsh 的真实模型会连同它的端点与凭据一起交给该引擎**（0.1.5-rc5 起）：四个驱动**每个 step 都重读**这条会话当前的选择（`sessionModelOverrideOf`，`src/driver-core/session-model.ts`），选择指着一条真实 dsh 模型（provider **不是**托管路由标签，也不是旧四家）时，再把这条模型的**端点 / 协议 / 凭据**从 dsh 自己的设置里解析出来（`resolveModelHandover`，`src/driver-core/model-handover.ts`）并注入到各引擎的入口：

  - **解析规则**：provider → 设置地址的映射取自 llm 注册表的"可配置 provider 目录"（`ctx.llm.listConfigurableProviders()`，主仓 `packages/llm/llm/src/types.ts` 的 `LlmConfigurableProvider`：`llm-pi-ai` 把一条路由映射到 `['providers', 路由名]`，`llm-deepseek` 把唯一一条路由映射到整个 `llm-deepseek` 段）；从那个段里读 `baseURL` / `api` / `apiKeyEnv`（`settings.get` 会套 schema 默认值，只有 `models`/`baseURL` 的 `llm-deepseek` 段照样能读出 `apiKeyEnv` 的默认值），凭据走 `ctx.credentials.resolve(apiKeyEnv)`（key 的值**不在** process.env 里，见主仓 `packages/bundle/base/cordis.patch.yml`），seam 缺席时才回落到 `process.env[apiKeyEnv]`。**读的是别人插件的私有段**，所以全程防御式：形状不符一律**不注入**并只 warn 一次（不抛、不猜一个端点）——但**准入只看 `baseURL` 与凭据**，`api` 缺失**不是**拒绝理由（拒绝会让引擎拿 dsh 的模型名去打**它自己**的端点，那是像鉴权问题的假象）：此时照常交出端点、`api` 为 `undefined`，由各引擎自己降级；对 adapter 自己拥有 wire 的 shipped 路由用一行表补协议（`SHIPPED_ROUTE_APIS`：`deepseek-official → openai-completions`），profile 写了 `api` 则以它为准。
  - **逐引擎入口**：claude-code 走 `Options.env`（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`）+ `Options.model`；kimi 走子进程 env 的 `KIMI_MODEL_NAME` / `KIMI_MODEL_API_KEY` / `KIMI_MODEL_BASE_URL` / `KIMI_MODEL_PROVIDER_TYPE`（kimi 自己的 env-model 通路，不改 `~/.kimi-code/config.toml`）；pi 走插件**自建**的 agent 目录（`PI_CODING_AGENT_DIR` 指向它，内含写好的 `models.json`）+ `--provider` / `--model` / `--api-key`（绝不碰用户 `~/.pi`）；codex 走 `codex app-server` 的 `-c model_provider=… -c model_providers.…={name,base_url,wire_api,env_key}` + env（端点变了就重启这条 app-server），模型仍是 thread 自己的 `model`。
  - **能不能用取决于引擎**：dsh 端点只按 dsh 配的 `api`（`anthropic-messages` / `openai-completions` / `openai-responses`，缺省时由 shipped 表补）翻译成各引擎自己的协议词；引擎不支持那个协议时不假装支持——codex 拿不到等价的 `wire_api` 时就用它自己的默认 wire 去请求 dsh 端点并**报错**，kimi 拿不到等价 provider type 时省略该变量、退回 kimi 默认并**报错**，pi 则因为自己的 provider 声明要求 `api` 存在而**不接收**这样的 handover。错误由引擎抛出，插件不吞、也不静默退回原生默认。
  - **选择是共享标签 `external/default`（菜单里那条 `default`，即"交回引擎自己决定"）或日志里根本没有选择时，端点与凭据都不注入**：用引擎自己的原生配置，或部署在 composition 里钉住的 `config.model`（**会话选择优先，pin 只是回落**）。选真实 dsh 模型但**端点或凭据解析不到**时同样不注入（只 warn 一次），模型名照旧透传给引擎。

  凭据只进子进程的 env（或 pi 自建的 `0600` 目录文件）与 argv，**不进会话日志、不进 `request/header`、不进任何 warn/错误文案**。把 key 放进子进程 env 是"让这台机器上的第三方 CLI 用 dsh 端点"的固有代价：该 CLI 进程能看到它。

**模型座位跟着引擎走：两个时刻，同一个写入**（0.1.5-rc3 起写 in-process 一侧；0.1.5-rc4 起**两个方向都写，而且换引擎那一刻就写**）：这条会话的模型选择**跟着引擎走**——四个托管引擎都会把**同一个** provider 标签（`external`）写进会话的 `request/header`（模型没被部署钉死时就是 `default`），宿主从最新一条 header 推导这条会话的模型选择（`selectionFor`：日志里那条 `pending` 优先，其次最新 header）。harness loop 这一侧**真的**去调模型，而这个标签只是一个**占位路由**服务的：占位路由平时不报错（它的作用就是让宿主"这个 provider 没人服务"的检查放行，否则托管会话的第二轮就失败），可真被调用时它 loud 抛 `HOSTED_ENGINE_ROUTE`。用户实测到的那句"托管引擎之间怎么切都正常、切回 harness 默认每轮报错"就是这条。**早期版本逐引擎写的四个标签（`kimi` / `claude-code` / `codex` / `pi`）现在没有任何 adapter 服务了，但 `isHostedProviderRoute` 仍然把它们判为托管路由**——这样一条 header 还是旧标签的老会话，在切回 `in-process` 或被重建时会被重置成 `external/default`（或部署默认），而不会被宿主以 `model-unavailable` 拒掉。所以插件把这条座位**提前写进日志**，写的是 harness 自己的 `model/selection` 事件——与宿主模型选择器写下的是**同一个事件、同一个形状**（`{ provider, model, reasoningEffort? }`），因此折进的是宿主读的那一格投影，宿主下一次给这条会话装选择时读到的就是它（`ModelSelectionReset`，`src/model-selection-reset.ts`）：

**两个时刻**：

- **构建时**（`guardFor(session, engine)`，`src/model-selection-reset.ts:191-194`）——路由器的 `engineOptions`（`src/router-loop.ts:355-378`：create 的两个分支在 `:289`/`:291`，resume 的 in-process 分支在 `:323`）把调用方的 `setup` 包一层，**先写、再让宿主装选择**。为什么必须在这个时刻：宿主是在**调用方的 `setup` 里**装这条会话的模型选择的（主仓 `packages/api/session-controller/src/agent.ts` 的 `composeAgent` → `installSelection` → `selectionFor`），它读的是日志里那条 `pending` 选择；晚一步写就没有意义了。**新建会话在托管引擎上就是在这里拿到自己的座位的**；harness loop 那一侧它只在真的需要时写——会话当前选择已经指向真实模型（普通会话的常态）时**一个事件都不写**。harness loop 那一路还保持调用方给的 `agentOptions`（对 harness loop 来说那不是座位，**就是**这条会话的请求路由，主仓 `packages/core/agent-loop/src/agent.ts:512`），托管引擎那一路则拿到与座位同一个值（`engineRouteOptions`，`src/router-loop.ts:708-710`）。
- **换引擎时**（`resetFor(session, engine)`，`src/model-selection-reset.ts:171-174`）——插件自己的引擎选择器（`selectEngine` → `moveModelSelection`，`src/router-loop.ts:465`、`:691-693`）与 harness 的 preset 通道（`rebuildOnEngineChange`，`:660`）都在**换的那一刻**写，不等下一轮：宿主读的是日志，而原地换手的 `setup` 与重载之后那次 resume 紧接着就会读它。

**写入什么（两个时刻共用同一套判据）**：

- **目标是托管引擎 → 共享的 `external/default`**：这个字符串既是引擎自己写进 header 的那个词，也是唯一一条目录条目（§5.2 上一段）。四个引擎写的是**同一个**值，所以托管引擎之间互切通常不追加第二条座位（幂等判据见下）；
- **目标是 in-process → 部署默认模型**：`agentDefaultModel.currentSelection()`（宿主给新会话用的那个）——进程内那一侧真的要调模型，所以必须是一条真实路由。
- **默认值本身是托管标签时**（这条不是假想：模型菜单会把选中的 `default` 存成部署默认——`session.selectModel` 除了装会话选择，还会把它 `saveSelection` 进 `agent-default-model` settings 段，主仓 `packages/api/session-controller/src/commands.ts:151-160`，而部署默认正是**每个新会话**的 `agentOptions`，主仓 `packages/api/session-controller/src/agent.ts:490-493`）：拿它去服务进程内会话必炸，所以插件改取**部署 composition 自己声明的默认模型**——settings 描述符的 `base` 层（`configuredDefault`，`src/model-selection-reset.ts:347-354`；`packages/bundle/base/cordis.patch.yml` 给 `agent-default-model` 行配的就是一个真实模型）。写入它，并如实报**一次** warn 说清"部署默认被托管路由占了、这次用 composition 的值顶替、选一个真实模型即可恢复"。连 composition 都给不出可用模型（没这个段、读不到 settings、配的也托管或不可用）时**只 warn、不写**，会话保持它日志里的选择。
- **真实 dsh 模型不动**：会话当前的选择（投影的 `pending`，否则会话最新一条 `request/header` 的 config）provider **不是**托管路由标签（既不是 `external`，也不是旧四家 `kimi` / `claude-code` / `codex` / `pi`——旧标签仍被 `isHostedProviderRoute` 判为托管路由，所以带旧标签的老会话会被重写）时一律不写——那是一次显式选择，换引擎没有理由把它删掉（在托管引擎下这条选择会被**交给**该引擎当模型用，见上一条）。
- **已经是写入值就不重复写**：provider + model 相同就一个事件都不追加（`appendSeat`，`src/model-selection-reset.ts:230-247`），反复切只在日志里留一条。
- **一条选择都没有时，换引擎这条路不写**：`resetFor` 的第一条判据（`src/model-selection-reset.ts:171-173`）——日志里没有座位可改写，而"给一条会话第一条座位"是**构建时**那条路的职责（日志 `pending` 与 header 都缺席的会话由宿主的读取回落到部署默认，仍是一条真实路由，所以不写也不会坏）。
- **拿不到部署默认值就跳过**：composition 里没有 `agentDefaultModel` 服务、或它抛错/答不出可用 provider+model → 只报**一次** warn、不写事件，**切换或构建本身照常成功**（`src/model-selection-reset.ts:284-297` 的读取、`:369-376` 的一次性告警）。
- **preset 通道同样**：宿主自己的 preset 选择器换一条**空白**会话的 preset 时，插件在释放旧 agent **之前**做同一件事——目标是托管引擎就写共享的 `external/default`，映射回 in-process 就写部署默认（`src/router-loop.ts:660`）。

**重载之前那一瞬间报告会短暂带上第二个事实**：记录已写、旧 agent 还在退场的最后一刻，`engine` 是旧引擎而记录是新引擎（§1.3）。页面正在重载，所以这没有用户可见的后果；**而如果那次释放真的失败**（teardown 抛错、或有人手改了侧车文件），它就会留下来，chip / composer 写「正在跑的那个 · 切到 X · 尚未接管」，此时**再选一次目标引擎即可重试那次释放**（记录已经是对的，选它会重新走一遍第 3-6 步）。

- **"撤回"只对释放失败那次有意义**：正常路径上会话已经变冷、页面已经重载，记录就是它跑的引擎——没有"当前引擎"可以对回了。释放失败时报告的 `engine` 仍是旧引擎，选中它就把记录改回去（宿主比对的是活 agent 的引擎，`src/router-loop.ts:466`），什么都不重建。
- **想让它在不重启的前提下生效：这条路就是它。** 6 步全在 §5.2 上面。⚠️ 如果目标**本来**就是另一个托管引擎，那更简单：直接改选它即可（托管引擎之间原地换手，连重载都没有）。
- **重载之后显示会跟着变，不需要再做什么**：页面对一条会话的报告是**在它的界面出现时重新取一次**的（`SessionEngineCache.watch`（`src/client/session-engine.ts:575-586`）在一条会话的**第一个** watcher 到来时调 `refresh`（`:602-606`）；由 `useEngineOfSession` 里那个以 sessionId 为依赖的 effect 触发，`src/client/use-session-engine.ts:81-84`）。重载后这次取值回来的 `engine` 就是新引擎，第二个字段也随之消失。同一条会话在屏上持续渲染时**不会反复请求**（effect 依赖不变；同一会话的两个界面同时出现也只发一次请求，因为只有第一个 watcher 触发重取，第二个并进同一次读取）。
- **如实说清丢了什么**：重载会丢掉**这一页的临时状态**——滚动位置、还没发出的草稿、未提交的输入；会话记录（对话历史与事件流）一字不少。自动回到这条会话依赖两件事成立：那次 `sessionStorage` 写成功、且重载后的列表里有它（§5.2 上面那两条）。任一不成立时页面不会硬造，用户从左侧列表点开这条会话即可——**缓存与草稿**这类东西本来也不该由插件替用户保留。

### 5.3 拒绝原因（全部）

`remote.loopEngine.select` 的返回形状是 `{ ok: true, engine, reload? } | { ok: false, code, reason }`（`src/agent-preset-ids.ts:234-276`）。`code` 是**原因码**（`LoopEngineRefusalCode`，`src/agent-preset-ids.ts:198-223`），决定界面说哪句话；`reason` 是**宿主自己那句英文完整句**，不再是正文，而是详情（两个带底层错误的码会以小字显示它，其余情况只在码不认识时才拿出来当正文）。客户端侧的映射在 `refusalFace`（`src/client/locales.ts:299-301`，表 `:278-286`）。

| 情况 | code | 客户端文案（中文 / 英文） | 宿主原话（`reason`，只作详情） |
|---|---|---|---|
| 插件进程里路由器还没挂上（还在等基础 `agent-loop` 行让出槽位） | `router-unmounted` | 这个进程暂时无法切换引擎（循环引擎路由器还没就绪）。/ This process cannot switch engines right now (the loop engine router is not ready). | `this process cannot switch engines yet: the loop router is not mounted` |
| 这条会话的 agent 不归本路由器管（基础 loop 还占着槽位的窗口期） | `not-driven` | 同上（对用户与 `router-unmounted` 是同一件事） | `session "…" is not driven by this plugin's loop router` |
| 这条会话**没有打开**（冷会话） | `session-closed` | 这条会话还没有打开。先打开它，再切换引擎。/ This session is not open yet. Open it, then switch its engine. | `session "…" is not open; open it first, then switch its engine` |
| 这条会话**正在跑一轮** | `turn-running` | 这条会话正在运行中——等这一轮结束后再切换引擎。当前这一轮不会被打断。/ This session is running — switch its engine after this turn ends. The turn in flight is not interrupted. | `session "…" is running; switch its engine after this turn ends` |
| 这条会话是**子会话**（`origin: 'subagent'`） | `subagent-session` | 这是子代理会话；它的引擎跟随派发它的主会话，不能单独切换。/ This is a subagent session; its engine follows the main session that spawned it and cannot be switched on its own. | `session "…" is a subagent session; its agent belongs to subagent routing` |
| 侧车记录写不进去（只读 home / 磁盘满） | `record-failed` | 引擎记录写入失败，切换没有生效。（宿主原话作为小字详情）/ The engine record could not be written, so the switch did not happen. | `could not record the engine of session "…": <原始错误>` |
| 旧 agent 退场了、新引擎却建不起来（引擎驱动起不来等） | `rebuild-failed` | 切换没有生效：新引擎没能建起来，这条会话的 agent 已经释放。再打开一次这条会话，它就会用新引擎重建。（宿主原话作为小字详情）/ The switch did not happen: the new engine could not be started and this session's agent has already been released. Open this session again and it is rebuilt on the new engine. | `could not rebuild session "…" on <引擎>: <原始错误>` |
| 请求里 `sessionId` 不是非空字符串 | —（不是原因码） | 由网关拒绝，客户端没有文案 | 抛 `gateway/bad-request`：`sessionId must be a non-empty string` |
| 请求里 `engine` 不是已安装的引擎 id | —（不是原因码） | 同上 | 抛 `gateway/bad-request`：`engine must be one of in-process, claude-code, codex, pi, kimi` |
| 客户端拿到一个**不认识的 code**（更新的宿主），或回包根本没有 code（老宿主、网关拒绝、连接断了） | — | 没有本地文案，直接显示 `reason`（保证任何情况下都有可读信息） | 宿主/网关自己的那句话 |
| 会话与 in-process 之间切换（任一方向） | —（不是拒绝） | `{ ok: true, engine, reload: true }`；页面会重载，重载前先确认（§5.2 第 0 步），`switchReloadTitle` / `switchReloadBody` 是重载时的说明 | 没有句子 |

两个"参数非法"的分支**故意没有码**：它们不是会话的状态，而是调用方的错误，按 typert 的惯例抛 `RemoteError`（`gateway/bad-request`），客户端侧只会走"拿不到 `code`"那一行。`pending`（§1.3）**也不是拒绝分支**：它是报告里的第二个事实，不是 `select` 的失败，所以没有码、也不需要一条。

拒绝一律**不改**会话的引擎：记录没写、agent 没动，路由与显示仍然一致（Remote 会把**同一个**引擎报成 `engine`，没有第二个字段）。端点的实现在 `src/engine-remote.ts:233-255`，判定在 `src/router-loop.ts:430-467`。上面表格最后那条**不是**拒绝——记录已经写下、会话的 agent 也已经被释放，客户端据此重载页面并回到这条会话（§5.2）；而每一条成功的切换都会连同**模型座位**一起动（§5.2「模型座位跟着引擎走」）：目标是托管引擎就写共享的 `external/default`，目标是 `in-process` 就写部署默认，日志里已经是真实 dsh 模型或一条选择都没有时不写。另外：拿不到部署默认模型时插件只 warn，**不会**因此拒绝这次切换。

### 5.4 为什么 release 曾经把会话弄丢、为什么 in-process 那两个方向不能原地换手，以及这次为什么可以拆

**旧的实现**（更早的两版）：`select` 写完记录后调用 `release`，把这条会话的 agent `dispose()` 掉，然后**什么都不做**。而 harness 的 `AgentHandle.dispose()` 不只是停机器：它按 `cancel → whenIdle → scope.dispose → handle.close() → detachAgent() → detachSession()` 走完，**最后一步把 Session 也摘出 `ctx.sessions`**（主仓 `packages/core/session/src/index.ts:1064-1074` 的 `detachEntered`）。`detachSession` 会发出 `session/disposed`（`:1073`），宿主把它转成 `api-session/removed`（主仓 `packages/api/session-controller/src/index.ts:148-151`），浏览器那半据此把这一行从会话列表里删掉、把当前会话清成 `undefined`——于是输入框显示「会话不可用」、模型座变灰，或者整个对话面退回「选择一个工作区开始」。更糟的是客户端的 `removed` 标记只被写 `true`、没有任何复位路径（主仓 `packages/api/session-controller/src/client/sessions/session.ts:572-573`、`:807`），所以在那次页面生命周期里这条会话再也回不来。**根因不是记录写错了，而是会话被我们从客户端脚下抽走了。**

**这一版为什么又敢拆**：因为现在拆完**页面就重载**（§5.2 第 5-6 步）。上面那段说的是"拆掉之后还留在那个页面上"的后果——而重载恰好把那份被标记过的页面状态整份丢掉，换成一份新列表与一个新的 Session 实例。拆还是那套拆，代价变成了"这一页的临时状态"，而不是"这条会话在这一页里永久不可用"。顺带一条：`session/disposed` 只在**页面亲眼看到它**时才成问题，而重载之后页面重新订阅的是一条已经变冷的会话，它从来没有"被拆"过。

**托管引擎之间为什么能原地换手**：harness 的两个 registry 本来就分开注册 Session 与 agent（`ctx.sessions.enter` 与 `ctx.agents.enter` 各返回一个**独立的闭包 disposer**，主仓 `packages/core/session/src/index.ts:1028`、`packages/core/agent/src/index.ts:458`），两个 disposer 都不被 agent 的 scope 持有，所以"只摘 agent、留 Session"在机制上可行；四个引擎的 agent（`ClaudeCodeAgent` / `CodexAgent` / `PiAgent` / `KimiAgent`）都能用一条**已存在**的 `Session` 构造——它们只读日志（`DriverInbox` 折 `ownEvents()`、`lastTurn` 折 `turn/start`），不写事件、不注册 session 监听、不碰 `ctx.sessions`、也不需要写句柄，与 resume 路径做的事完全一样。剩下的只是**写句柄**：后端按 sessionId 只认一个 writer，所以句柄必须跟会话一起交接，`SessionLifetime`（`src/driver-core/session-lifetime.ts:35-78`）就是承载它的那个对象。

**与 in-process 之间为什么做不了**（三条都指向同一个事实：harness 自己那半既不给句柄、也不肯让别人接管）：

1. **托管 → in-process**：in-process 的 agent 由 harness 的 `AgentLoop` 构造，它同样把会话条目与写句柄放在 `prepare()` 的**私有闭包**里（主仓 `packages/core/agent-loop/src/index.ts:568-670`），插件拿不到；它的发布无条件调用 `sessions.enter(session)`（`:664`），对一条已活的 id 抛 `session "…" already exists`（主仓 `packages/core/session/src/index.ts:1033`）；而它唯一的公开入口 `create` / `resume` 都会重新 `sessions.prepare`（`:700`、`:893`），对已活的 id 同样直接抛。
2. **in-process → hosted**：既要拿到上面那两样，又要把旧 agent 从 `ctx.agents` 摘掉——`AgentRegistry` 没有公开的"按 id 移除"，只有 `enter` / `register` 返回的闭包（主仓 `packages/core/agent/src/index.ts:458`、`:434`），插件同样拿不到。所以连"空出槽位"这一步都做不到。
3. **自己造一个 in-process agent 也不行**：真正的实现类 `ReactLoopAgent` 只在包内导出（主仓 `packages/core/agent-loop/src/agent.ts:72`），而那个包的 `exports` 只有 `.` / `./invariant` / `./package.json`，发布产物里也没有 `lib/agent.js`，所以仓外插件够不到它。

所以这两个方向只有两种可能：**拆掉会话**（就是上面那个线上缺陷，这一版用重载把它变成可接受），或者**记录 + 等进程重启**（上一版，把重建的时机推给用户）。插件选了前者——**"拆"是这条路上唯一能立刻交付切换的方式**，而重载把它变得安全。要真正做成 in-place 换手，需要 harness 提供一个 seam（导出 `ReactLoopAgent`，或让 `AgentFactory` 支持"在一条已有会话上发布"与"只退 agent、不退会话"），设计写在 `docs/proposals/harness-agent-handover.md`。

**客户端能做的事只有两件，"重开那条会话"不是第三件。** 这一轮的设计正是建立在下面这几条取证上的（都读的是主仓客户端半 `packages/api/session-controller/src/client/**` 与 `packages/client/**`）：

1. **客户端没有"重开这条会话"这个动作。** `ISessions` 的全部能力是 `open` / `openSubagent` / `clear` / `refresh` / `create` / `fork` / `search` 等（主仓 `packages/api/session-controller/src/client/contract/sessions.ts:21-75`），而 `ISession`（同目录 `contract/session.ts:63-139`）**没有** `reopen` / `reload` / `resync` / `dispose`。`open(id)` 只是 `manager.select(id)`（`packages/api/session-controller/src/client/sessions/service.ts:270-272`），它只改选中项；真正拉窗口的 `Session.open()` 对**已打开**的实例是幂等的（同目录 `sessions/session.ts:378-388`：`if (this.openState === 'open') return`）。所以"打开它"这件事本身**不能**重建 agent——**能重建 agent 的是"宿主那半已经没有这条会话的活 agent"**，而这一点只有 release 能造成。
2. **宿主的 `resolve` 就是这样判定的**：第一件事是 `const live = this.liveAgent(sessionId); if (live !== undefined) return live`（主仓 `packages/api/session-controller/src/agent.ts:183-192`），只有**没有**活 agent 时才走 `ctx.agents.resume(...)`（`:430-435`）。§5.2 的第 6 步走的是后半句。
3. **`removed` 标记只写不复位**：`packages/api/session-controller/src/client/sessions/session.ts:572-573` 写入、`:807` 进快照，消费方 `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:60`/`:128-141`；`handleSessionAdded`（同目录 `sessions/manager.ts:714-728`）只碰 `blank` 与投影，`Session.dispose()`（`session.ts:591-601`）也不清它。复位只可能来自"实例被销毁后重建"，而那条路要求实例先离开当前舞台——**页面重载是最短的那条**（整份客户端状态重建，包括这条会话的实例）。
4. **插件的自动回到那条会话因此是"新的页面 + `sessions.open(id)`"，不是任何"reopen"**：`open` 被调用时列表里已有这条会话（它是磁盘上的记录），于是选中它、宿主 `follow` 它、`resolve` 发现没有活 agent 并 `resume`（§5.2）。
5. **刷新页面本身不保证回到它**（这是重载前必须自己存 id 的原因）：移除会把持久化的选中断言清掉（`packages/api/session-controller/src/client/sessions/service.ts:633-635`），重新加载后 `watchNavigation` 只挑最近的工作区、并且只会复用该工作区里**空白**的会话，否则新建一条（主仓 `packages/client/ui-workspace/src/client/navigation.ts:197-241`）。所以 id 由插件的 `sessionStorage` 存、由插件的 `sessions.open` 开（§5.2）。

**已知限制**：harness 自己的 preset 选择器移动一条**空白**会话时也走 release，而那条路径由主仓的控件触发，插件发不出"重载页面"（§5.1 末条）——那条会话在页面上的表现与上面第一段描述一致。这条不在本次改动范围内。

### 5.5 侧车记录的读写与降级

- **路径**：`$DSH_HOME/.loop-engine/engines.json`（`resolveEngineRecordPath`，`src/session-engine-store.ts:65`）。
- **格式**：`{ "version": 1, "engines": { "<sessionId>": "<engine>" } }`，整份文档一次性原子替换（同目录 temp 文件 + rename，`writeFileAtomicSync`，`src/session-engine-store.ts:109-114`）。
- **写入时机**：只在换引擎（§5）与 §3 的"最后一次动作胜出"时写；**写成功才更新内存视图**，写失败则旧文件与旧视图都不变（`src/session-engine-store.ts:177-182`）。
- **只增不删**：记录按 sessionId 累积，插件不做 GC。一个 sessionId 一行，量级可以忽略；被删掉的会话遗留的那一行永远不会被问到。
- **降级**：文件不存在 = 正常首次状态（不报警）；文件损坏 / 读不了 / 版本不认 → 当作"没有记录"，**打一条 warn**，然后每个会话照常回退到 preset 映射（`src/session-engine-store.ts:191-216`）。**侧车坏了绝不会让路由抛错**：一个会话最多丢掉"记住的引擎"，不会打不开。文档只在进程内读一次，所以一条 warn 不会随查询次数重复。

## 6. 并发语义

- **多引擎同进程并存**：进程里只有**一个** AgentFactory（harness 的硬约束），但它是路由器；每个用到的引擎在首次使用时构造一个 runtime，之后把该引擎的每个会话交给它（`src/router-loop.ts:226-232`）。所以"会话 A 跑 Codex、会话 B 跑 Kimi"是真正的并发，不是排队。
- **每个会话有自己的宿主进程/查询**：Codex、Kimi、Pi 每个 agent 起自己的子进程（`src/engine-codex/loop.ts:100`、`src/engine-kimi/loop.ts:92`、`src/engine-pi/loop.ts:186`），Claude Code 每个 dsh step 走一次 stateless query（`src/engine-claude/loop.ts:3`、`:106`）。一条会话的引擎进程退出不会牵动另一条。原地换手会把旧引擎的那一份资源收干净（`retire` 里 `cancel → whenIdle → scope.dispose`，`src/driver-core/hosted-engine-runtime.ts:274-279`），再让新引擎起它自己的一份。
- **同引擎多会话共享该 CLI 自己的认证目录**：每个 agent 起的子进程读的是该引擎 CLI 自己的 home（`~/.claude`、`~/.codex`、`~/.kimi-code`、`~/.pi`），插件**不加任何锁**；同引擎并发跑多条会话，就是并发读写同一份 CLI 配置与凭据。这是"直接驱动用户的 CLI"的固有形状，不是插件的锁缺失。
- **命令与技能按会话隔离**：每个引擎的斜杠命令与 skill provider 是**在 agent 创建时注册进那个 agent 的 scope**（`src/engine-surface.ts:77-97`），所以 A 会话的菜单不会出现在 B 会话里，agent 被关掉时整套面一起回收——原地换手也不例外：旧 agent 退场时它的整套面一起走，新 agent 的那套随新 scope 上来。
- **模型选择**：四个引擎默认用各自原生的模型，而页面上选的**真实 dsh 模型会被连同它的端点与凭据一起交给该引擎**（§5.2 上一条「托管引擎下选 dsh 的真实模型会连同它的端点与凭据一起交给该引擎」）：每个 step 重读会话选择并重新解析端点，引擎拒绝就报错，会话选择优先于部署钉住的 `config.model`；端点变了（codex）就重启子进程、（kimi）就换一个子进程 env。选 `external/default`（菜单里那条 `default`）或没有任何选择时不下发任何模型参数、也不注入端点与凭据。设置页对任何托管引擎都会提示这一点（`hostedEngineModelNotice`，`src/client/LoopEngineSection.tsx:213`）。**这条会话的模型座位由插件跟着引擎写**（§5.2）：新建会话在托管引擎上就先写下共享的 `external/default`，换引擎时座位跟着换（托管引擎之间写的是同一个值，所以通常不追加第二条；切回 `in-process` 则写部署默认模型）；日志里已经是一条真实 dsh 模型时**不动**它。之所以必须写：这个标签只有本插件的占位路由服务、进程内那侧真调用会抛 `HOSTED_ENGINE_ROUTE`，而占位路由的那一条 `default` 也正是模型座要显示的那个词。
- **权限与沙箱**：按会话的 dsh permission 设置折叠进各引擎自己的权限面，细节见各 `docs/engine-*.md`。
- **provider 标签常驻**：四个引擎共用的**一个** provider 标签（`external`）注册为占位路由（`src/provider-route.ts`），所以每个寄宿会话的第二轮 prompt 都不会因为"没有 adapter 服务这个 provider"被拒（宿主侧的拒绝点：主仓 `packages/api/session-controller/src/commands.ts:323-328`）。细节见 `docs/architecture.md` §3.6。所以原地换手之后的**第一轮**也不会被宿主以"provider 没有 adapter"为由拒绝：这个标签一直都在。

## 7. 从旧版本升级

旧版本把"当前引擎"写进 profile patch 文件里的一段 managed block（`# -- dsh-loop-engine managed block: <engine> --`，常量 `src/patch-manager.ts:54`），切换时整页刷新；再后来引擎改成写在 preset 里。升级后：

- 启动时插件会把这个旧块**重写成与引擎无关的常量块**，并把旧块里的引擎作为**新会话默认引擎**的初始 seed（`src/index.ts:271-276`、`:504-528`）。所以你升级前的选择会变成"新会话默认跑它"，不会丢。
- patch 文件从此**不再表达引擎选择**：它里面只有一段恒定的块（禁用主仓的 `agent-loop` 行，把唯一槽位让给路由器）。手改它不会改变任何引擎选择。
- **老会话没有任何插件记录 → 行为完全不变**：它们继续按 §1.2 的 preset 映射回答（`standard` → in-process、`loop-engine` → 「旧版托管引擎」、没有 preset → 「未记录」）。侧车文件是本次升级才出现的，老会话在里面没有条目，这**不是**"引擎丢了"。
- 只要你在某条老会话上换一次引擎，它就写进侧车（§5）；在那之前它的引擎答案依旧是 preset 映射。
- 引擎切换不再需要重启进程：涉及 in-process 的那次会释放会话并让页面自动重载（§5.2），托管引擎之间连重载都没有。升级后**不会**出现"所有旧会话都变成新引擎"。
- 安装/升级后的**第一次启动也不需要额外重启一次**：受管理块要到下一次 composition 才被读到，路由器在有界窗口内重试等基础 `agent-loop` 行让出槽位（`src/index.ts:588-615`，`docs/architecture.md` §3.8；这段窗口里 `loopEngine/select` 会返回 §5.3 那条"loop router is not mounted"）。
- ⚠️ **旧会话的引擎只能如实说"不知道"**：旧版本只有一个 preset id `loop-engine`（没有引擎后缀），而新规则只认 `loop-engine-<engine>`（`src/agent-preset-ids.ts:119`），所以日志里记着 `loop-engine` 的旧会话匹配不到任何引擎。路由侧因此继续按 in-process 跑它（§1.2 的兜底），显示侧也**不冒充**当年那个托管引擎：这条会话**没有活 agent** 时（冷会话）会话头 chip 与 composer 显示 **「旧版托管引擎」**（判定 `src/agent-preset-ids.ts:297`，文案 `src/client/locales.ts:103` / `:148`）。它**已经打开**时 chip 报的就是 `in-process`——那是它此刻真正在跑的东西（§1.3 末条）。同理，**没有记录 preset 的会话**也不声称任何引擎：chip 不渲染，composer 显示「未记录」（`:104` / `:149`）。想在旧会话上直接换成某个引擎，用 composer 选择器（§4.2/§5）即可——不需要新建会话。磁盘上遗留的 `$DSH_HOME/.agent-presets/loop-engine/` 不会被删除（插件只写自己那四份，不清扫别人的目录），它仍会出现在 preset 菜单里，但选中它等价于 in-process。
- 四个 preset 目录每次启动从部署当时的 `standard` 重新生成，手改会被覆盖（`src/preset.ts:200-210`）。
- **侧车文件在升级方向上是新增的**：插件只认自己写的格式（`version: 1`），不认的版本按"没有记录"降级处理（§5.5），所以降级回旧版本时那个文件只是被忽略，不会影响旧版本行为。

## 8. 常见现象与处理

| 现象 | 原因 / 处理 |
|---|---|
| 新建的会话还是 in-process | 默认 preset 不是 `loop-engine-*`。检查 设置 → 循环引擎，以及 设置 → Agent preset 里的默认项（两者是同一个字段）。 |
| 会话头 chip 显示 `Codex`，但设置里显示 In-process | 正常，而且这就是设计：设置里那一栏是**新会话默认值**，chip 才是这条会话实际跑的引擎（§2.2）。 |
| 在 composer 里换引擎，弹窗说「切换未生效」+ 一句中文说明 | 宿主拒绝了这次切换，界面按**原因码**给本地化文案（§5.3）：会话没打开、正在跑一轮、是子会话、或侧车写不进去。两个带底层错误的码（`record-failed` / `rebuild-failed`）会在下面以小字附上宿主原话；码不认识时正文就是宿主那句话。 |
| 在 composer 里换到/换出 in-process 时先弹了一个确认框 | 设计如此：这一类的切换要重新载入页面才能让 harness loop 接管，所以先说清代价（这一页的滚动位置、还没发出的草稿会丢；会话记录不受影响）再让用户决定（§4.2）。**托管引擎之间没有这个确认框**——那一类原地换手，选中即生效。 |
| 点了确认之后页面自动重载了 | 这次切换的目标或来源里有 in-process。宿主无法原位接管（§5.2/§5.4），于是**写记录 → 释放这条会话的 agent → 回包 `reload: true`**；客户端弹一句「切换已生效，正在重新载入页面」就把页面重载掉，并记下这条会话的 id，重载后自动打开它——宿主随即按记录构建它。**进程没有重启**，也不需要重启。重载会丢掉这一页的临时状态（滚动位置、未提交的草稿），会话记录一字不少。 |
| 在 composer 里换完引擎，弹窗没有、页面也没变，直接就好了 | 托管引擎之间的切换是**原地换手**：会话不重建、对话不关闭，只替换 agent（§5.1）。下一页输入自然落到新引擎。 |
| chip 上写着「Pi CLI · 切到 进程内引擎（默认） · 尚未接管」 | 罕见情况：记录写下了，但那次**释放没有成功**（teardown 抛错、或有人手改了侧车文件），所以这条会话此刻仍由 Pi 驱动（§1.3/§5.2）。**再选一次目标引擎即可重试那次释放**；选 Pi 则把记录改回去、让它保持原样。正常路径上这个标注不该出现——切换会伴随着一次页面重载。 |
| 在 composer 里换托管引擎，会话**不重建**、历史还在、下一轮就是新引擎 | 这是设计：托管引擎之间是**原地换手**（§5.1）。会话对象、store 条目、写句柄都保留，只换了 agent。 |
| 换回**当前实际在跑**的那个引擎，什么都没重建、也没报重载 | 这是设计：宿主比对的是活 agent 的引擎（`src/router-loop.ts:466`）。只有在"记录里的引擎没能接管"那种罕见情况下才谈得上"撤回"：选中实际在跑的那个，记录就跟着活 agent 改回去，标注随即消失。 |
| 换了引擎，会话的 preset 标签还是旧的 | 预期行为：引擎已经不是 preset 的事了。chip / composer / turn-status 会立刻更新到**实际**引擎（记录里多出来的那一半只作标注），preset 标签显示的是这条会话的组合面（§2.2）。 |
| 某条会话第二轮 prompt 报 `model-unavailable` | 该会话的 provider 标签没有被任何 adapter 服务。**旧标签是个已覆盖的坑**：`0.1.5-rc3` 之前每个引擎写各自标签（`kimi` / `claude-code` / `codex` / `pi`），现在只注册共享的 `external`，所以一条选择仍是旧标签、又没能被重置（切回/重建那条会话即可重写）的老会话会命中。正常部署下（共享标签常驻，§6）不会发生；若真遇到，先确认插件在 profile 里被组合、且没有卸载。 |
| 切了默认引擎，页面上的会话没变 | 预期行为：默认只影响之后新建的会话（§4.1）。 |
| 会话头 chip 显示「旧版托管引擎」 | 这条会话是插件早期版本创建的：它当时跑的是某个托管引擎，但共用的那一个 preset id 没记录是哪一个（§7）。它此刻**没有活 agent**（宿主还没构建它），chip 如实说明"引擎未记录"；一旦它被打开、由 harness loop 跑起来，chip 就报 `in-process`（§1.3）。用 composer 选择器换一个引擎，它就记下来了。 |
| 会话头没有任何引擎 chip | 该会话没有插件记录、也没有记录 agent preset（部署没组合 preset roster，或会话早于 preset 机制）。harness 自己的 preset 标签在这种情况下同样不渲染（§2.2）；composer 会显示「未记录」，且不高亮任何一项。 |
| 想让这条会话改用别的引擎 | 打开它、等它空闲，然后用 composer 选择器直接换（§4.2/§5）——包括已经跑过很多轮的会话。目标是托管引擎时立刻生效（原地换手，不弹任何东西）；任一边是 in-process 时会先弹确认，确认后宿主写记录、释放这条会话的 agent，并让页面自动重载回到本会话（§5.2）。 |
| 点了确认之后页面自动重载了，这正常吗 | 正常，这就是涉及 in-process 的切换的落地方式（§5.2）。重载之前那句提示（`switchReloadTitle` / `switchReloadBody`）在说这件事；重载后自动回到刚才那条会话，不需要自己去列表里点。 |
| 换完引擎显示没变（托管引擎之间） | 预期行为：托管引擎之间是原地换手，界面上的名字与图标会立刻更新（缓存被作废并重新取值，§4.2），而会话本身不重建。 |
| 想给一条**空白**会话换 preset | 用 harness 自己的 preset 选择器（新会话页的 chip）。它仍然会顺带决定引擎，而且这是唯一**仍然**会释放并重建 agent、且**不由插件控制**的路径（§5.1 末条）——那条路径发不出"重载页面"这一步，已知限制见 §5.4 末尾。 |
| 想知道侧车为什么是文件而不是写进会话日志 | 见 `docs/proposals/append-ignorable-events.md`：仓外插件目前**无法**产出带 `ignorable` 标记的会话事件，而没有该标记的未知事件会让整条会话在下次冷读时被拒绝（`../deepseek-harness/packages/session/session-persistence/src/storage-contract.ts:74-79`）。 |
| 换了引擎，这条会话的命令菜单/技能列表变了 | 预期行为：换引擎会替换 agent，命令面与技能面由新引擎提供（§5.1、§6）。 |
| 引擎的 preset 名字／命令菜单不对 | preset 是每次启动从 `standard` 生成的（`docs/architecture.md` §3.5）；命令清单按各引擎实测收敛，细节见对应 `docs/engine-*.md`。 |
| 托管会话里没有 `/goal` | 预期行为：`standard` 自带的 `command-goal` 行注册的是 preset 层的 dsh `/goal`，profile patch 够不到它，托管 preset 才是真正剥掉它的地方（§3）；引擎自己有没有 `/goal` 由引擎决定（Kimi 的 ACP 面没有，见 `src/engine-kimi/commands.ts:11-28`）。 |
