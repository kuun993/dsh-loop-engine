# 需求：允许仓外插件追加一条插件自有的 ignorable 会话事件

> **目标仓库**：deepseek-harness（主仓）。本文件记录背景与建议改动，供提交为 GitHub issue。下文所有路径均相对 harness 仓库根，裸 `src/...` 路径除外——那些相对本插件自身的检出根；所有行号均已对照 `0.1.5-rc.2` harness 检出核验（`package.json:3`）。
>
> **范围**：会话日志兼容性包络（compatibility envelope）的生产端这一半。本提案不要求新的格式版本，不改变一方事件（first-party event）的写入方式，也不与 `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md` 冲突——它要求的只是那份 note 的移除条件所点名、而当下无人提供的那一块。

## 动机

`dsh-loop-engine`（仓外插件，<https://github.com/kuun993/dsh-loop-engine>）需要持久记录一条逐会话事实：**这个会话跑的是哪个 agent loop 引擎**。该插件托管多个引擎（`claude-code`、`codex`、`pi`、`kimi`）作为内置进程内 loop 的替代，而同一个部署要服务跑着不同引擎的多个会话。

会话日志是这条事实的正确归宿，也是 harness 自身的卫生规范唯一留下的口子："Model-visible ⟺ logged"（`AGENTS.md:111`）——任何进入请求的内容都必须能从日志重建。插件自有的旁路存储（side store）会成为会话已经拥有的东西的第二份真相来源：对每一个日志读者（会话列表、fork、压缩、会话日志上传）都不可见，还自带迁移与垃圾回收问题。

插件无法把这条事实追加进日志。它今天落地在**插件自有的侧车文件**里（`$DSH_HOME/.loop-engine/engines.json`，`src/session-engine-store.ts:65`、`:147-217`）——那正是本提案所要求的接缝缺失后被逼出来的绕行方案（见"考虑过并否决的替代方案"）。更早的版本只能挪用 harness 自有的字段：会话的 `agentPreset`，写成 `loop-engine-<engine>`（`src/agent-preset-ids.ts:38`、`:61-63`），再通过 harness 的 `agentPreset` 投影读回（`src/engine-of-session.ts:71-85`）；这条 preset 路径至今仍是**没有侧车记录的会话**的兜底答案。只要"引擎可以是 agent preset 的函数"成立，那套做法就成立——而 harness 在会话启动的那一刻就冻结了 preset：`AgentPresets.select()` 重读 `turnBoundary` 投影，并以 `agent-preset/locked` 拒绝（`packages/preset/agent-presets/src/index.ts:714-721`，错误码在 `:718`），只把已提交的切换记为 `agent-preset/selected`（`:726`）。于是"换掉这个会话的引擎"在日志里无路可走，纯粹因为引擎没有属于自己的持久表示——侧车成了唯一的落地方式，而它带来的是第二份真相来源。

## 现状

**1. `Session.append` 无法设置包络的 `ignorable` 标记。**

```ts
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
): SessionEvent<T>
```

（`packages/core/session/src/index.ts:703-707`。）`SurfaceIntent` 只携带 `surfaceOp` 与 `sourceEventSeqs`，它自己的 doc 写明它 "forbidden on log-only events"（`packages/core/session/src/types.ts:438-450`）——因此对 log-only 类型，options 元组就是字面量 `[]`，调用方无法传入*任何* option 对象。包络字面量在 `append` 内部组装（`index.ts:725-731`），硬编码 `type` / `seq` / `time` / `data`，外加按条件合并的 surface 元数据（`:708-712`）；其中没有 `ignorable` 这一项。该标记的含义记录在包络上："Absent means required… A writer sets `true` only on purely informational records whose loss cannot affect reconstruction"（`types.ts:473-483`，字段在 `:483`）。

**2. 读路径恰好拒绝 `append` 产出的那个事件。**

`validateStoredEvents` 会拒绝生成集合之外的任何类型，除非已存储的包络携带该标记：

```ts
if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
  throw unsupported(
    `session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`,
    location,
  )
}
```

（`packages/session/session-persistence/src/storage-contract.ts:75-79`，函数 doc 在 `:69-73`；`unsupported()` 映射到 `SessionFormatUnsupportedError`（`:23-28`），类在 `packages/session/session-persistence/src/errors.ts:111-121`。）JSONL 后端在两条读路径上都调用它：当前代（current-generation）prepare（`packages/session/session-persistence-jsonl/src/index.ts:627`）与当前日志加载（`:758`）。

**3. 已知集合只从本仓库生成。**

`KNOWN_SESSION_EVENT_TYPES` 由 `scripts/gen-persistence-catalog.ts` 生成到 `packages/core/session/src/known-event-types.ts`（输出路径 `:17`，生成的声明 `:423-425`；npm scripts 在 `package.json:158-159`）。生成器扫描 `packages/*/*/src/**/*.ts`（`gen-persistence-catalog.ts:176`），收录 `declare module '@deepseek-ai/dsh-session/types'` 的合并（`:127-142`，顶层 interface 规则在 `:189`）——这正是 `session-log-deepseek/delivery-accepted` 这类仓内插件事件位于该集合中的原因（`known-event-types.ts:52`，声明于 `packages/session/session-log-deepseek/src/types.ts:78-89`）。仓外包按构造就在该 glob 之外，生成的 doc 注释也这么说，并附上了那个显然的修法被否决的理由："Downstream (out-of-repo) plugin events are outside this list by construction. The persisted `SessionEvent.ignorable` marker is the compatibility mechanism; event-name registration was rejected because it does not classify omission safety and would make reads composition-dependent"（`known-event-types.ts:15-19`）。

**4. 编译期词表已经接纳插件自有类型；持久词表没有。**

`SessionEventType = keyof SessionEventMap`（`types.ts:404`），建立在 "merge-extensible, append-only source of truth" 之上（`types.ts:263-269`），所以插件可以用模块增强（module augmentation）声明自己的事件——`dsh-loop-engine` 已经为一个一方类型这么做了（`src/driver-core/hosted-tool-vocabulary.ts:52-56`），`session-log-deepseek` 也为自己的类型这么做（`packages/session/session-log-deepseek/src/types.ts:78-89`）。于是插件一旦声明 `loop-engine/engine-selected`，`session.append('loop-engine/engine-selected', { engine: 'pi' })` 在它自己的编译中就通过类型检查，而 harness 的持久记录闸门永远不知道这个名字。这种不对称——类型系统接受该事件，持久化读路径拒绝这份日志——就是全部问题。

**5. 实测后果。**

用已发布的 `0.1.5-rc.2` 产物、真实的 `SessionStore` 与真实 JSONL 后端、以及插件声明的事件类型跑出来：

```text
Session.append('loop-engine/engine-selected', { engine: 'pi' })   // succeeds in memory
<persistence write>                                               // succeeds, no error
<session store closed and reopened>                               // cold read
SessionFormatUnsupportedError: session "probe-a" contains event type "loop-engine/engine-selected" (seq 3) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness
```

写入报告成功，而下一次冷读拒绝整个会话。手工构造的、携带 `ignorable: true` 的包络可以干净地往返，所以这个标记是好用的——它只是无法经由 `append` 触达。

**6. 没有别的写路径。**

`packages/core/session/src/index.ts:742` 是活跃会话上唯一向日志追加的点。另一个追加点是私有构造函数的 seed 循环（`:581`），经由 `Session.create`（`:508`）与 `Session.fromRestore`（`:530`）可达，也就是创建时带着一个借来的事件数组；seed 包络校验器接受 `ignorable`（类型为 `undefined | true`，`:225`）。`Session` 上其余一切都是只读的：`eventAt`（`:621`）、`snapshotEvents`（`:633`）、`ownEvents`（`:648`）、`isOwnSeq`（`:657`）、`seq`（`:662`）、`requestHeader`（`:769`）、`requestContext`（`:790`）、`deriveMessages`（`:825`）、`deriveEventMessage`（`:854`）。所以今天 `ignorable` 包络的唯一生产者是自己构造裸记录的写入方——创建时的 seed，或手写的 JSONL——而会话中途才得知的事实（这个会话在跑哪个引擎）完全无路可走。

**7. 归属的那份 Agent Note 没有覆盖生产端。**

`2026-08-30-retain-ignorable-external-session-events.md` 保留该字段，因为存在 "a third-party plugin that currently depends on the field"，且 "The plugin has no replacement registration or versioning mechanism"（`:11`）。其 Decision 写明 "The persistence seam's stored-event validation (`validateStoredEvents`) continues to refuse an unknown event unless its stored envelope explicitly carries `ignorable: true`"（`:15`）——这是*读方*保证。其移除条件是 "a replacement supports the current third-party plugin across event production, persistence, reload, and transport"（`:17`）——而生产端正是没有接缝的那一半。本提案要求的正是那份 note 所假定的生产者。

## 建议 API

### 方案 A —— 在 append 接缝上开放该标记（首选）

与现有契约一致的最小改动；仅限 log-only 类型。

```ts
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType
    ? [opts: SurfaceIntent<T>]
    : [opts?: { ignorable?: true }]
): SessionEvent<T>
```

- **只允许 `true`。** 包络自身的契约就是 `true` 或缺省（`types.ts:483`；seed 校验器已经强制 `undefined | true`，`index.ts:225`）。不设 `false` 成员：缺省已经表示必需，而三态标记会诱使写入方意外削弱某个一方事件。
- **仅限 log-only 类型。** 该 option 位于元组的非 surface 分支，因此四个 `SurfaceEventType`（`types.ts:412-416`）的 options 保持不变。塑造派生消息历史的事件绝不可能是可选的，这样也保持 surface 构造语义不变。
- **运行时校验。** 对 surface 类型上的 `ignorable` option 抛 `Error` 拒绝，与 `index.ts:713-733` 现有的拒绝并列，并像现在合并 surface 元数据那样，在 `:725-731` 有条件的把该字段合并进包络字面量。
- **类型层面。** 插件声明自己的类型不需要任何新东西：merge extension 已经让它获得 `SessionEventType` 成员资格（见"现状"§4）。harness 不必接受这个名字，读方的拒绝仍是读方自己的事——标记就是为了这个。要求 harness 在 `SessionEventMap` 里声明插件的 payload，等于把第三方的 ABI 放进主仓。
- **`stateVersion` / 投影。** 对既有 unit 无改动：log-only 事件从不进入 surface，而 `deriveEventMessage`（`index.ts:854`）按类型分发，因此不会有任何一方投影开始看到它。*选择*折叠该事件的消费方注册自己的 unit，此时它的 `stateVersion`——即持久缓存的失效版本，在 "whenever the serialized state fields or the fold semantics change" 时递增（`packages/session/session-projection/src/index.ts:86-92`）——就是那个 unit 自己的事，与任何新投影完全一样。折叠它的人负责把缺省当作 "unknown"，这也是这类记录的本意语义；本插件根本不打算折叠（路由器读取该事件，它从不成为消息状态）。

### 方案 B —— 显式的仓外事件类型注册

一个*确实*在声明时对"省略安全性"（omission safety）做分类的注册接缝，例如 `ctx.sessions.registerExternalEventType({ type: 'loop-engine/engine-selected', omission: 'safe' })`。这就是 `known-event-types.ts:16-19` 说已被否决的那个替代方案——但那里的否决针对的是"接受与否由读方组成推断"，而一个把 "omission is safe" 记为该类型声明属性的注册是另一回事。在值得动手之前，有两个问题要先定下来：

- **注册给读方买到了什么？** 如果它只是授权写入方设置该标记，它就退化为方案 A 加一次能力检查，而持久记录依然必须携带该标记——这才是诚实的结果。如果它让读方在*没有*标记的情况下接受该类型，就重新引入了组成依赖：没挂载该插件的 profile 会拒绝同一份日志。
- **注册的生命周期归谁？** 注册过的名字就是发布出去的名字，而标记是那份 note 的移除条件唯一能 grep 的东西。

方案 A 被优先提出，因为它不需要注册表、不需要新的生命周期、也不需要新的策略面：它用那份 note 已经承诺的机制补上生产端的缺口。

## 考虑过并否决的替代方案

**插件在运行时改写 `KNOWN_SESSION_EVENT_TYPES`。** 否决。该集合是生成的、受新鲜度门禁约束（`package.json:159`），以 `ReadonlySet<string>` 导出（`known-event-types.ts:22`），并被各包在模块作用域按值消费（`storage-contract.ts:10`、`packages/session/session-log-deepseek/src/index.ts:12`）；插件只能靠类型转换（cast）够到它，而且改写在进程内局部有效。实测到的失败是*冷读*——另一个进程，那里根本不存在该改写——而持久记录依然不携带标记，而包络契约存在的意义正是防止这个状态。装载顺序还会决定改写在读取之前是否就位，使正确性依赖组成顺序。

还有第二个独立理由，在上传路径上可见：`DeepSeekSessionLogWireEvent` 对 `SessionEventMap` 之外的类型只有一种表示，即 opaque 变体，而它要求 `ignorable: true`（`packages/session/session-log-deepseek/src/types.ts:47-56`，在 `packages/session/session-log-deepseek/src/index.ts:91-101` 的专用分支里构造）。本地注册但未标记 `ignorable` 的名字在该契约中没有表示；标记了的则被完整带过。所以 wire format 围绕的是标记——而不是名字——它必须能在事件产生处被设置。

**复用已有的已知事件类型。** 否决。可能的候选都有各自的一方所有者：`agent-preset/selected` 由 roster 在提交切换之后追加（`packages/preset/agent-presets/src/index.ts:726`）并转发到 Cordis 总线（`:228-229`），供每个关心 preset 变化的监听者消费；`model/selection` 被折叠为模型状态。改用途的 payload 要么误导这些消费方，要么迫使他们学习一套私有约定；而且被复用的类型是读时必需的（它在生成集合里且从不标记 ignorable），插件会因此悄悄继承一个一方事件的语义。

**插件自有的带外存储（按 session id 索引的侧车文件）。** 这是插件**今天实际采用**的方案，不是假想：`$DSH_HOME/.loop-engine/engines.json`（`src/session-engine-store.ts:65`，文档形如 `{ version, engines }`，同目录 temp + rename 原子写，`writeFileAtomicSync` 在 `:109-114`）。判定优先级是侧车优先、没有记录时回退到 harness 自有的 `agentPreset` 投影（`src/engine-of-session.ts:71-85`），写入点是一次显式的换引擎（`src/router-loop.ts:259-292`）。它确实解决了"跑过一轮的会话也能换引擎"，代价正是本提案想消除的那些：这份事实对每个日志读者（会话列表、fork、压缩、会话日志上传）都不可见，换机器或换 `DSH_HOME` 就丢，插件还得自己承担格式版本、损坏降级与"只增不删、不做 GC"的取舍。本提案落地后它就是可退役的兜底方案。

## 风险与待定问题

- **格式版本策略。** 包络是结构性的：`SESSION_FORMAT_VERSION` 的 doc 说，只有在 "the header shape, the `SessionEvent` envelope, core event semantics, or the surface mechanism" 时才需要递增版本，而 "Adding an ordinary event type does not bump — the per-event `SessionEvent.ignorable` guard covers vocabulary growth instead"（`types.ts:66-87`）。方案 A 不改变任何形状：对一次词表扩充而言，它只是让写入方能设置一个包络已有、读方也已尊重的字段。这应当是非递增改动，但值得在 PR 里明确决定，而不是靠推断。
- **迁移边界刻意保持更严。** 在 released-v0 路径上，v0→v1 边界会计算 ignorable 情形，但依然拒绝未知类型（`packages/session/session-format-v0-to-v1/src/validation.ts:116-125`，拒绝文案在 `:120`；对应的 payload 校验在 `:194`）。本次改动之后写入的会话处于当前代，不会跨越那条边界；而万一落进 v0/v1 产物的插件事件仍会被拒。保留 note 把这一有界例外记为有意为之（`2026-08-30-retain-ignorable-external-session-events.md:19`），归属 `2026-08-31-alpha-historical-unknown-event-refusal.md`。本提案不要求放宽它。
- **传输层已经携带该标记——因此也携带该事件。** `SessionWireEvent` 有 `type: string`、`ignorable?: true`，以及 opaque 的 `sourceEventSeqs` / `surfaceOp`（`packages/api/session-controller/src/types.ts:425-435`，标记在 `:430`），由对已冻结日志事件的直接 cast 填充（`packages/api/session-controller/src/history.ts:416-421`）。方案 A 不隐含任何传输层工作。另一面是：未知 ignorable 事件*会*到达客户端，因此假定 `type` 是封闭联合的客户端必须跳过而不是噎住。接口注释已经把识别责任指派给持久化读方（`types.ts:423`）。
- **对折叠它的人来说，缺省必须始终可容忍。** 就本插件的用法而言，没有东西折叠该事件：路由器读取它，它从不成为消息状态。但一般而言，`ignorable` 事件可以被任何读方跳过，因此折叠它的消费方必须把缺省视为 "unknown"，而生产者不得依赖它能挺过某个陌生 profile 的读-改-写。
- **生产者清单。** 该标记应当能通过 option 对象设置，还是通过一个独立的、可 grep 的方法（`appendIgnorable`）。那份 note 的移除条件最终需要一份完整的生产者清单，因此一个可静态搜索的生产端面是有价值的。

## 验收标准

- 仓外插件能通过公开的 `Session.append` 接缝追加一条插件自有的、标记为 `ignorable: true` 的 log-only 事件，且无需访问内部实现。
- 这样的会话能被不认识该事件类型的 harness 构建冷恢复：不出现 `SessionFormatUnsupportedError`，插件自己的读取仍能看到该记录事件，不认识它的读方跳过它。
- 该标记不能设置在 `SurfaceEventType` 上，也不能被设为 `true` 以外的值。
- 不做格式版本递增；既有一方 `append` 调用点不变，其持久化包络也不变。

## 落地后插件会有什么变化

`dsh-loop-engine` 把逐会话引擎事实搬回会话日志：一条会话的引擎被选定或改变时，路由器追加 `loop-engine/engine-selected`（`{ engine: 'claude-code' | 'codex' | 'pi' | 'kimi' | 'in-process' }`），并通过日志读回它，而不是从 `agentPreset` 字符串或侧车推导答案。引擎于是不再是 agent preset 的函数，跑过一轮的会话可以在不触发 `agent-preset/locked` 拒绝的情况下换引擎（`packages/preset/agent-presets/src/index.ts:714-721`）——preset 保留自己的含义（组成与命令面），引擎变成一条独立记录的事实。迁移期的读取顺序是：日志里的记录 → 侧车（改动前写入的会话，`src/session-engine-store.ts:147-217`）→ 由 preset 推导的答案（`src/engine-of-session.ts:71-85`，这条兜底同时负责把"未记录"如实报成 legacy 而不是猜测）。侧车只服务迁移期的老会话，可以在后续版本里退役。
