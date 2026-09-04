# dsh-loop-engine 总体架构与插件核心

面向要修改本插件的工程师。本文只覆盖**插件核心**（引擎选择机制、managed block、settings 接缝、client 注入、构建）；各引擎驱动（`engine-claude/`、`engine-codex/`、`engine-pi/`、`engine-kimi/`）是另一层主题，本文只在挂载点处提及。

文中 `src/index.ts:239` 格式的引用均相对本仓库根；主仓文件相对 `../deepseek-harness/`。

## 1. 插件定位与核心问题：单 AgentFactory 槽位

dsh（DeepSeek Harness）主仓里，agent 的创建由 `AgentRegistry.setFactory` 注册的**唯一** `AgentFactory` 提供；第二次注册直接抛 `an agent factory is already registered`（主仓 `packages/core/agent/src/index.ts:372-381`，README 明确"Throws on a second factory"）。默认情况下这个槽位由基础包 composition 里的 `agent-loop` 行（`@deepseek-ai/dsh-agent-loop`，主仓 `packages/bundle/base/cordis.patch.yml:436-437`）占住——它就是"in-process"引擎。

本插件要支持 web 设置页切换引擎，又不能改主仓一行代码，因此唯一的出路是：

- **不让两个工厂共存**。选中非默认引擎时，先通过 loader patch 禁用基础包的 `agent-loop` 行，把槽位让出来，再由本插件托管的引擎工厂去注册（`src/index.ts:5-11`）。
- **`in-process` 引擎 = 插件什么都不注册**。基础行保持活跃，槽位仍归基础 loop（`src/index.ts:10-11`、`src/patch-manager.ts:50-51`）。

引擎选择落在**两个平面**上，二者必须一致：

1. **持久平面**：`$DSH_HOME/profiles/web/cordis.patch.yml` 里的一段 managed block。它是启动时的 ground truth——`apply()` 同步读它来决定挂载哪个工厂（`src/index.ts:258-260`）。
2. **运行时平面**：当前进程内以 Cordis 插件 fiber 形式挂载/卸载的引擎工厂（`src/index.ts:492-522`）。运行中切换不能等重启，所以 fiber 必须同进程换槽。

模块头注释（`src/index.ts:13-18`）点明了一个容易误解的事实：harness 的 config-only HMR watcher 会重新应用 patch 文件，但**无法在运行中重新注册 AgentFactory**。所以"写文件"与"换工厂"是两条独立路径，插件两条都要走。

## 2. managed block 机制

### 2.1 格式

插件在用户的 profile patch 文件里拥有一段由 begin/end 标记界定的连续区间（`src/patch-manager.ts:41-44`）：

```yaml
# -- dsh-loop-engine managed block: claude-code --
- id: agent-loop
  disabled: true
- id: command-goal
  disabled: true
# -- /dsh-loop-engine managed block --
```

- begin 标记携带引擎 id，`currentEngineOf` 用正则 `^# -- dsh-loop-engine managed block: (\S+) --$` 仅凭文件内容读出当前引擎（`src/patch-manager.ts:68-76`）。
- 块体只做**禁用**，不插入任何新行：`agent-loop` 让出唯一 AgentFactory 槽位（引擎工厂由本插件的 composition 行托管，不需要出现在 patch 文件里，`tests/patch-manager.spec.ts:37-40` 专门断言块里不含引擎行）；`command-goal` 把 dsh 的 `/goal` 一并撤下——托管引擎接管会话的命令面（见 §3.5），dsh `/goal` 留着只会与引擎自己的 goal 命令（Kimi）撞名，或挂在没有 UI 驱动的 goal 服务上空转。其余 dsh 原生命令（`/export`、`/feedback`、`/permission`）是引擎无关的会话/设置控制，在托管引擎下仍然真实生效，保留。
- `in-process` 渲染为**空串**：块整体从文件中消失，基础行恢复活跃（`src/patch-manager.ts:50-51`）。
- 未识别的引擎 id（比如新版插件写的、旧版在读）读回 `in-process`（`src/patch-manager.ts:71-76`）。

### 2.2 `applyManagedBlock` 的语义

`applyManagedBlock(text, engine)` 是纯字符串变换（`src/patch-manager.ts:153-178`），文件 I/O 全部在插件侧。规则：

- **块不存在 + 目标非 in-process**：追加块，前面补一个空行分隔（`src/patch-manager.ts:157-163`）。
- **块存在 + 目标非 in-process**：原位替换，保留 begin 标记前的空行（`src/patch-manager.ts:169-170`）。
- **目标 in-process**：移除整个区间，并折叠掉分隔空行，使往返切换不在文件里堆积空行（`src/patch-manager.ts:164-168`、`managedSpan` 的 `blankBefore` 记账，`src/patch-manager.ts:79-97`）。块外字节逐一保留——往返切换后文件与原样 byte-for-byte 相等（`tests/patch-manager.spec.ts:124-128`）。
- **无 end 标记的块**被视为延伸到文件末尾（`src/patch-manager.ts:85-86`）。这意味着用户若手删了 end 标记，块尾之后的自有内容会在下次重写时被吞掉——改这里要慎重。

### 2.3 YAML 可加载性修复

managed block 本身是**根级 block sequence**，这带来两个真实踩过的坑（注释在 `src/patch-manager.ts:104-140`）：

- **种子占位符 `[]`**：新 profile 的种子模板是孤零零一行根级 `[]`。若在其后追加块，文件里就有**两个根级集合**，js-yaml 直接拒绝（"end of the stream or a document separator is expected"），web 无法启动。`dropSeedPlaceholder` 在加块时删掉整行的根级 `[]`（`src/patch-manager.ts:126-130`）；锚定列 0，条目配置里缩进的 `options: []` 不受影响（`tests/patch-manager.spec.ts:199-204`）。
- **空文件 / 纯注释文件**：harness 要求 patch 文件解析为顶层数组，纯注释文件解析为 `null`。移除块后若无任何条目，`seedEmptyArray` 补回一行 `[]`（`src/patch-manager.ts:137-140`）；而真正不存在（空/纯空白）的输入保持原样——空是"无这一层"的合法信号（`src/patch-manager.ts:173-177`）。

这一节的所有行为都被 `tests/patch-manager.spec.ts` 按字节级钉死；`src/invariant.ts` 再把"写-读往返是不动点"作为运行时不变量注册（见 §5）。**不要用 YAML 库重写这一段**：保留注释与用户格式正是用字符串变换的原因。

### 2.4 写入：同步 + 原子

写盘固定为"同目录临时文件 + rename"（`writePatchFile` / `writePatchFileSync`，`src/index.ts:162-182`），保证读者永远看到完整的新或旧内容。同步变体存在的理由写在它的 docstring 里（`src/index.ts:169-176`）：settings 的 onChange 是**无 await 的同步钩子**，而用户可能在切换提交后立即重启 `dsh web`——写入必须在提交返回前落盘，否则重启读到旧引擎。同目录 rename 也为 Windows 上的目录项一致性留了余地（测试清理在 `tests/index.spec.ts:119-123` 有对应的重试）。

异步的 `writePatchFile` / `syncManagedBlock`（`src/index.ts:162-197`）是导出的公共 helper（测试直接用），但插件自身的切换路径只走同步变体。

## 3. 启动与运行时切换流程

### 3.1 启动：`apply()` 的顺序

`apply(ctx, config)`（`src/index.ts:257`）依次做：

1. `resolvePatchPath` 解析 patch 文件路径：`patchPath` 显式指定优先，否则 `$DSH_HOME/profiles/<profile>/<patchFilename>`，默认 `web/cordis.patch.yml`（`src/index.ts:136-144`）。空字符串 `patchPath` 视为未指定。
2. **同步**读文件，`currentEngineOf` 得出 `fileEngine`（`src/index.ts:260`）。读失败（非 ENOENT）直接抛出，不让插件带着未知状态启动（`tests/index.spec.ts:306-315`）。
3. `mountEngine(fileEngine)`：非默认引擎立即托管对应工厂 fiber 并注册其 provider 路由占位（见 §3.6）；`in-process` 什么都不挂（`src/index.ts:612-618`）。
4. `steerPresetDefault(fileEngine)`：把会话的命令/技能面导向匹配当前引擎的 preset（见 §3.5）。
5. `ctx.inject(['settings'], …)` 内用 provider 方法 `settings.installSection` 注册 `agent-loop-engine` 段，**composition base 用 `{ engine: fileEngine, showInComposer: true }`**（`src/index.ts:643-644`）——settings 段从文件种子出发，UI 因此镜像文件而非反向。

`installSection` 的契约（主仓 `packages/settings/settings/src/index.ts:472-496` 的 provider 方法）：注册 scope 后**先 `setSource` 再立刻 `onChange`**，之后每次已提交的变更触发 watcher 再调 `onChange`；全部同步。`src/index.ts:640-642` 的注释指出，因为 setSource 保证先于首次 onChange，`source!` 的非空断言是契约守卫而非侥幸。首次 attach 的 onChange 读到与 `fileEngine` 相同的值，自然短路成 no-op（`src/index.ts:648`）——这就是"文件已匹配则 attach 不写盘"（`tests/index.spec.ts:242-254`）。

### 3.2 运行时切换：onChange 管线

settings 提交后的 `onChange`（`src/index.ts:646-669`）：

1. `next = source!().engine`；与 `fileEngine` 相同则返回。
2. `mountedEngine !== next` 时先 `unmountEngine()` 再 `mountEngine(next)`——切回 `in-process` 即卸载托管 fiber，让基础 loop 重占槽位；在托管引擎之间互切则先卸后挂（`tests/index.spec.ts:611-639` 等逐个验证）。重复进入已挂载引擎是 no-op。
3. **同步**重写 managed block 并更新 `fileEngine`。写失败只记 error、保持旧值——此时工厂已经换了但文件没换，`fileEngine` 不变使得下次 onChange 还会再进挂载/写盘路径，而已挂载的 fiber 靠 `engineFiber` 守卫保证第二次挂载是 no-op 而非重复（`tests/index.spec.ts:461-488`）。
4. 写盘成功（即选择真正提交）后 `steerPresetDefault(next)`，把新会话的 preset 默认导向匹配引擎的那套（见 §3.5）；写失败不导向，保持与文件一致。

### 3.3 工厂的挂载与槽位竞争重试

`hostFactory`（`src/index.ts:492-522`）是挂载的核心，两个要点：

- **触碰 fiber 使其立即启动**：Cordis 的插件 fiber 在 await 时才懒启动，而 settings 钩子是同步回调没有 await，所以 `void fiber.then(...)` 主动触发（`src/index.ts:497-500`）。
- **有界槽位竞争重试**：运行时切到托管引擎时，patch 层的 reload（禁用基础 `agent-loop` 行）与新工厂注册是**竞争关系**——reload 落地前基础工厂仍占槽位，`setFactory` 以 `an agent factory is already registered` 拒绝。命中这条错误消息且未超上限时，每 50ms 重试一次，上限 `MAX_MOUNT_ATTEMPTS = 40`（约 2 秒窗口，`src/index.ts:84-85、511-518`）；reload 释放槽位后重试即成功（`tests/index.spec.ts:490-527`）。窗口耗尽或其他任何错误 → 一条 loud error，不无限循环（`tests/index.spec.ts:550-571`）。
- 重试 timer 随插件 dispose 清理（`ctx.effect`，`src/index.ts:639`），否则在已停用的 context 上迟到的挂载会刷噪声日志（`tests/index.spec.ts:529-548`）。

注意重试靠**错误消息字符串匹配**（`src/index.ts:513`），这是对主仓 `packages/core/agent/src/index.ts:374` 文案的脆弱耦合——主仓改文案时这里会静默退化为"不重试、直接报错"。

### 3.4 挂载的副作用：命令与技能注册

各引擎挂载时还会向宿主可选服务注册附属物（服务用 `ctx.get` 惰性获取，可能缺席，`src/index.ts:270-291`）：

| 引擎 | 斜杠命令 | 技能 Provider |
|---|---|---|
| claude-code | 内置 7 个 + 发现 `~/.claude/commands/*.md`（`src/index.ts:524-555`） | `ClaudeCodeSkillProvider`（`.claude/skills/`、`CLAUDE.md`，`src/skills.ts:219`） |
| codex | 无 | `CodexSkillProvider`（AGENTS.md，`src/index.ts:558-568`） |
| pi | 无 | `PiSkillProvider`（`src/index.ts:570-581`） |
| kimi | `KIMI_COMMANDS`（`src/index.ts:583-609`） | `KimiSkillProvider` |

命令 handler 的语义是**转发**：dsh 的 `commands` 运行时会在本地消费已注册命令（不会到达模型），而真正展开命令的是引擎 CLI，所以 handler 把原始 `/name args` 行作为普通用户消息回投给接收 agent（`src/commands.ts:64-72`）。注册的意义是让命令出现在 web 斜杠菜单里。与 dsh 原生命令撞名时记 warn 跳过，不让挂载失败（`src/index.ts:540-542`）。项目级 `.claude/commands/` 有意不注册——它按 cwd 生效，全局注册会跨项目冲突（`src/commands.ts:16-18`）。

**命令注册的命名禁区**：web 客户端自带 `/model` 等 client 侧贡献，host 侧同名命令会让 `ui-commands` 直接把整个 command 菜单源判死（主仓 `packages/client/ui-commands/src/client/service.ts:259-261` 抛错，`ui-input-trigger` 降为 source-failed）——表现是斜杠菜单里命令全消失、只剩技能。Kimi 的 `/model` 因此刻意不桥接（`src/engine-kimi/commands.ts` 模块注释）。

`skills.ts` 还内嵌了一个小型 YAML frontmatter 子集解析器（支持 `>`/`|` 块标量，`src/skills.ts:84-154`），因为 Claude 的 SKILL.md 大量使用折叠写法的 `description`。类型全部是本地镜像（`src/skills.ts:14-16`、`src/commands.ts:29-30`），刻意避免对 `dsh-skill` / `dsh-commands` 增加直接 peer 依赖。

卸载或挂载失败时 `cleanupEngineRegistrations` 统一回收这些注册（`src/index.ts:472-481`、失败路径 `src/index.ts:500-504`）。

### 3.5 会话命令/技能面的接管：hosted preset

引擎注册自己的命令/技能（§3.4）只是"加"；真正让"切到某引擎就只剩该引擎的命令和技能"成立的是**减**掉 dsh 原生的那部分。dsh 原生面分两层，手段各不同：

- **全局层命令**（`/goal` 等）：行在根树组合里，profile patch 够得着——managed block 直接禁用 `command-goal`（§2.1）。
- **preset 层**（`/compact`、`/plan`、`skill-filesystem`、`tool-skill`、`tool-goal`）：这些行活在 `standard` agent preset 的组合文件里，由运行时独立的 `PresetTree` 挂载，**profile patch 够不到**（主仓 `packages/preset/agent-presets/src/mount.ts:340`）；`commands`/`skills` 服务也没有"注销别人注册"的 API。所以插件走了 preset 机制本身：

`src/preset.ts` 在每次需要托管引擎的启动时，把 roster 的 `standard` preset 组合读出来（经 `agentPresets.read`，`src/index.ts:448-469`），用纯行变换 `stripPresetRows` 剥掉 `skill-filesystem`、`tool-skill`、`tool-goal`、`planning`、`compaction` 五个顶层行（连同其节注释），写进用户 preset 根 `$DSH_HOME/.agent-presets/loop-engine/`（幂等：内容一致不动盘，standing mount 的 file-stamp 就不会被骗）。随后 `steerPresetDefault` 把 roster 的默认 preset 指到 `loop-engine`——用的是 `agent-presets` settings 命名空间的 `default` 字段（`settings.mutate`，热生效、只影响之后新建的会话），而不是 patch `agent-presets` 行的 config：patch 的 config 覆盖是**整体替换**语义（主仓 `vendor/include/src/index.ts:121-124`），会顺带抹掉部署方在同行配置的 `roots`，settings 层则天然叠在 config 之上、可 unset 还原。

几个关键决策：

- **切回 `in-process` 时还原**：被替换的旧默认值记在 `savedPresetDefault`，切回时 set 回去；没有旧值（或启动时读到残留的本插件 id）则 unset，落回行配置的 `standard`（`src/index.ts:421-437`）。
- **namespace 注册竞争**：roster 的 settings 段由它自己的 inject 回调注册，可能晚于本插件的 apply；mutate 撞上 `not registered` 时有界重试（30×100ms），其他错误 loud 一次（`src/index.ts:399-413`）。同理，in-process 启动时的"残留值清理"先读到的可能是 attach 前的 config 默认，所以干净首读也要按同一窗口复查几轮（`src/index.ts:421-437`）。
- **authoring 失败不导默认值**：preset 没写成就绝不能把默认指过去，否则每个新会话都 loud 失败（`src/index.ts:455-463`）。
- **preset 永不删除**：会话日志记着 `agent-preset/selected`，resume 要按它重新解析；留下的 `loop-engine` preset 目录是无害的（roster 发现是文件系统的，`tests/index.spec.ts:991` 起的分组覆盖以上每条）。
- **活会话不迁移**：默认只影响之后新建的会话；已在跑的会话保持自己 join 的 preset，页面刷新（§4.3 的 reload）后新建会话自然落到新面。

### 3.6 provider 路由占位：为什么第二轮 prompt 需要它

四个托管引擎各自把固定的 provider 标签（`claude-code` / `codex` / `pi` / `kimi`）写进会话的 `request/header`（各引擎文档的 request/header 节）。而 web 宿主侧从**最新一条 header** 推导会话的模型选择（主仓 `packages/host/apiproxy/src/api-proxy.ts:1095-1122` 的 `selectionFor`），并在 `session.prompt` 起点拒绝"没有任何 adapter 服务的 provider"（`routeServed` / `turnAgentFor`，主仓 `api-proxy.ts:1777-1808`，错误码 `model-unavailable`）。两个事实叠加：首轮 prompt 时空会话的模型选择回落到部署默认值（有 adapter 服务，放行），同时第一轮把 header 落进日志；第二轮 prompt 读到的会话选择就变成了 `kimi` / `kimi-native` 这类没有 adapter 的组合——**必被拒**。这就是"切引擎后第一次对话正常、第二次报 model-unavailable"的根因。

插件的应对是在引擎挂载期间把该标签注册成一条**占位 provider 路由**（`src/provider-route.ts` 的 `HostedEngineRouteAdapter`，接线在 `mountProviderRoute`，`src/index.ts:366-396`）：

- **目录零污染**：占位 adapter 继承默认的空 `listModels`，目录构建会丢弃不广告任何模型的组（主仓 `api-proxy.ts:315`），模型选择器看不到这条路由；`stream` 被调到即 loud 抛 `HOSTED_ENGINE_ROUTE`——托管引擎原生持有模型，真有查询路由到这里就是接线 bug。
- **生命周期跟随引擎**：`mountEngine` 注册（`src/index.ts:613`），`unmountEngine` 与插件 dispose 经 `releaseRoute` 回收（`src/index.ts:347-353、624、639`）。切回 `in-process` 后，带着托管 header 的旧会话再发 prompt 会被拒——这是正确语义：那些会话本就无法在 in-process loop 下继续。
- **llm 服务缺席时有界重试**（30×100ms，与 preset 默认值的 attach 竞争同款，`src/index.ts:329-330、373-379`）：web profile 里 llm 是更靠前的 composition 行，但 fiber 启动顺序不是契约；完全没有 llm 服务的极简 composition 里 `routeServed` 直接放行（主仓 `api-proxy.ts:1774-1775`），不占位也无害。
- **幂等与冲突**：同一引擎的挂载重入（§3.3 的槽位重试会再次进 `mountEngine`）靠 `routeEngine + routeHandle` 跳过（`src/index.ts:370`）；部署方自己的 adapter 已占该标签时记 warn 跳过，且卸载不会回收不属于自己的路由（`src/index.ts:383-390`）。

行为钉在 `describe('apply provider route')`（`tests/index.spec.ts:851` 起）与 `tests/provider-route.spec.ts`。

## 4. settings 段与 web UI

### 4.1 namespace 常量的拆分原因

段名 `'agent-loop-engine'` 放在**零运行时导入**的 `src/namespace.ts`（`src/namespace.ts:9`）。原因（`src/settings.ts:1-11` 的模块注释）：浏览器 bundle 也要引用这个字面量，而 node 侧的 `SettingsNamespace` 品牌类型来自宿主侧服务包 `dsh-settings`——若字面量与品牌类型引用同文件，client bundle 会把整个 `dsh-settings` 拖进浏览器产物。于是 node 半通过 `loopEngineSettingsNamespace()` 把字面量断言为品牌类型（`src/settings.ts:41-43`），浏览器半直接引字面量，两边共享一个字符串。

schema（`src/settings.ts:36-39`）：`engine` 五选一并默认 `in-process`，`showInComposer` 默认 `true`（控制对话页 composer 是否显示引擎选择器）。

### 4.2 client bundle 的三个露面点

`src/client/index.ts`（`inject = ['slots', 'locale', 'settingsScope']`，`src/client/index.ts:42`）注册了三处 UI，全部共享同一个 `LoopEngineStore`/快照：

- 设置页 section：`settings.section` 槽，`order: 30`（`src/client/index.ts:69-75`）。
- 会话头部引擎徽章：`conversation.session.header.actions` 槽，`order: -20`（`src/client/index.ts:81-97`）。
- composer 引擎选择器：`conversation.input.right` 槽（`src/client/index.ts:104-119`），受 `showInComposer` 控制。

后两处通过 `ctx.inject(['slots', 'conversation'], ...)` 注册，确保 ui-conversation 先声明了目标槽位。文案走 `ctx.locale` 的 `settings.loop-engine` 词典，中英双语（`src/client/locales.ts`）。

`LoopEngineStore`（`src/client/store.ts:33`）以 settings scope 为传输：`decodeLoopEngine` 收窄线上值（非法引擎 id 读为 undefined → 落默认；`showInComposer` 缺失视为 true，`src/client/store.ts:21-30`）。`setEngine`/`setShowInComposer` 的成败判定不是看 promise 是否拒绝，而是**写完后对照 scope 留下的快照**（`src/client/store.ts:59-77`）——被拒绝的写在恢复后会报 `unavailable`。

### 4.3 切换的 UI 语义

设置页（`src/client/LoopEngineSection.tsx`）选择引擎只**暂存**，需经 Modal 确认；确认落地后 `window.location.reload()`（`src/client/LoopEngineSection.tsx:170-181`）——旧引擎工厂下建立的会话视图不会迁移，整页刷新让所有会话对新 composition 重新 attach。claude-code 引擎下额外显示"模型选择不生效"提示（`src/client/LoopEngineSection.tsx:213`，背景见 `docs/proposals/model-selection-disable.md`）。

## 5. invariant 入口

`src/invariant.ts` 是独立的 companion 插件（`loop-engine-invariant`，`inject = ['invariants']`，`src/invariant.ts:25-27`），向 harness 的 invariant 注册表登记本包拥有的不变量——patch-manager 的写-读往返：

- 对每个引擎，`applyManagedBlock` 后再按读回的引擎重放，必须是不动点（`src/invariant.ts:45-48`）。
- `in-process` 不得改动裸（空）层（`src/invariant.ts:49`）。
- 非默认引擎渲染的块必须能读回同一引擎（`src/invariant.ts:50`）。
- `in-process` 必须把纯注释文件修复为可加载的 `[]`（`src/invariant.ts:51-53`）。

它单独占一个 `./invariant` 出口（`package.json` 的 `exports`，`package.json:17-20`），由部署侧按需 compose 进 invariant 检查通道；检查本身是对纯变换的再断言，失败通过 `fail` 上报并挂在包名下（`src/invariant.ts:35-56`）。价值在于：写方与读方的互逆关系被绑定在同一次注册里，任一侧回归都会在部署的 invariant 轮里立刻炸出来。

## 6. 构建产物与外部化策略

`build.mjs` 是两段式（`build.mjs:1-13`）：

1. `tsc -p tsconfig.build.json` 产出 `lib/types/**` 声明（同时产出的 JS 运行时不使用）。
2. esbuild 打三个 bundle：
   - `lib/index.js`、`lib/invariant.js`：ESM、node 平台，只内联相对导入的 `./src` 模块（`build.mjs:76-87`）。
   - `lib/client.js`：CJS 闭包包进 `window.__ModuleLoader__.load({ id: 'dsh-loop-engine', factory })` 的 client-module 工厂（`build.mjs:90-106`），harness 的 web 模块加载器按此约定装载。没有 CSS loader，所以 section 组件用 token 内联样式而非 CSS module（`src/client/LoopEngineSection.tsx:9-11`）。

**为什么所有 `@deepseek-ai/*` 保持 external**（`build.mjs:33-56`）：本仓库的 `node_modules` 里，harness 包往往是指向主仓**源码目录**的 junction；esbuild 基于 node_modules 的自动 external 判断会把它们当成本地源码**内联**进 bundle，后果是 cordis 实例一分为二——插件里的 `Context`/`Service` 与宿主不是同一个运行时，注册全部对不上。因此每个值导入都显式列入 `NODE_EXTERNALS`，运行时经包的 node_modules 解析，保证所有 harness 包是全进程单例。浏览器侧同理：`react`、`dsh-client-*` 等由宿主的模块表提供，列入 `BROWSER_EXTERNALS`（`build.mjs:60-70`），与 `package.json` 的 `dsh.client.external` 声明对应（`package.json:54-60`）。

`package.json` 的 `dsh` 字段是插件与 harness 的装配契约：

- `dsh.bundle.patch: ./cordis.patch.yml`（`package.json:43-45`）：作为 bundle 安装时把本插件的 patch 层并入 profile。该文件只有三行（`cordis.patch.yml`）：`insert` 一行 `loop-engine` composition 条目——这就是引擎工厂的宿主行，引擎选择本身不再碰它。
- `dsh.client.inject` / `dsh.client.external` / `dsh.client.platform: web`（`package.json:46-61`）：声明浏览器产物的模块表依赖与不可内联清单。

发布文件集由 `files` 钉死（`package.json:28-34`）：三个 bundle + 类型 + `cordis.patch.yml`。

## 7. 已知约束与坑

- **手改 patch 文件不会在运行中生效**。文件只在 `apply()` 启动时读、在 onChange 时写；HMR watcher 重放 patch 也换不了 AgentFactory（`src/index.ts:15-16`）。调试时改了文件请重启 `dsh web`。
- **槽位竞争重试是字符串匹配**（见 §3.3）：主仓改 `setFactory` 的报错文案即破坏重试。2 秒窗口内 patch reload 不落地就 loud 失败。
- **provider 路由占位依赖 llm 注册表文案**（见 §3.6）：与槽位重试同理，"部署方已占标签"的识别靠 `already registered` 消息匹配（主仓 `packages/llm/llm/src/index.ts:407`），主仓改文案时会退化成一条 error 日志且不占位——第二轮 prompt 的拒绝会复现。
- **未知引擎 id 的降级路径有缺口**：begin 标记里出现当前版本不认识的引擎 id（如新版写、旧版读）时，`currentEngineOf` 读作 `in-process`（`src/patch-manager.ts:71-76`），插件不会挂载任何工厂；同时 managed block 仍在文件里禁用着基础 `agent-loop` 行，而启动路径里 `next === fileEngine` 会短路、**不会**清理这个块（`src/index.ts:647`）。净效果是没有任何 AgentFactory 注册，`ctx.agents.create` 全部拒绝。代码中没有针对该场景的修复路径，降级使用前先手工清块。
- **同步写盘不可改为异步**（§2.4）：onChange 无 await，提交即落盘是重启正确性的前提。
- **managed block 之外的 patch 内容受字符串变换保护，但不要动标记行**：`MANAGED_BLOCK_BEGIN` 的子串匹配（`hasManagedBlock` 用 `includes`，`src/patch-manager.ts:63-65`）意味着用户手写一行同前缀注释也会被当成 managed span 吃掉。
- **空行记账是功能不是洁癖**：`managedSpan` 的 `blankBefore` 与移除时的折叠逻辑保证往返 byte-for-byte（`tests/patch-manager.spec.ts:124-137`），改这里先跑 `tests/patch-manager.spec.ts`。
- **hosted preset 是托管产物**：`$DSH_HOME/.agent-presets/loop-engine/` 每次托管引擎启动时从当时的 `standard` 重新生成，手改会被覆盖；`stripPresetRows` 按列 0 的 `- id:` 切分顶层行，主仓 preset 文件若改了行结构（比如行首不是 `- id:`），剥除会保守地保留该行而不是出错（`src/preset.ts`）。托管期间 settings 文档里的 `agent-presets.default` 被本插件占用——用户在设置页另选的默认 preset 会在切回 `in-process` 时被还原值覆盖语义见 §3.5。
- **Windows**：构建/测试里的 junction、`rm` 需要重试（`tests/index.spec.ts:119-123`）；`stat` 跟随链接正是因为 Windows 的 junction 在 `Dirent` 上既非文件也非目录（`src/skills.ts:277-283`）。
- **测试约定**：`tests/index.spec.ts` 用真实服务栈（SessionStore/SystemPrompt/AgentRegistry/LocalSubprocessRuntime/LlmRuntime + 内存 settings provider，`tests/index.spec.ts:90-105`）起真实 Cordis context，假工厂 `fakeAgentFactory` 模拟基础 loop 占槽（`tests/index.spec.ts:330-335`）。新增引擎时照 `describe('apply <engine> engine')` 的既有分组补齐：挂载+配置转发、同进程互切、命令/技能注册三组断言；provider 路由占位随挂载断言在 `describe('apply provider route')`。
