# 需求：让 `AgentFactory` 能在一条已有会话上交接 agent

> **目标仓库**：deepseek-harness（主仓）。本文件记录背景与建议改动，供提交为 GitHub issue。凡引用主仓文件的行号，均已对照本仓库同级的 `../deepseek-harness` 检出（harness `0.1.5-rc.2`）核验；相对本插件自身检出根的路径写作 `src/...`。
>
> **范围**：会话生命周期与 agent registry 的接缝。本提案不要求新的持久化格式、不改变既有 API 的行为，只要求把"把一条活会话交给另一个 agent"这件事从"私有闭包 + 内部类"变成可表达的操作。

## 动机

仓外插件 `dsh-loop-engine` 用**一个路由器**占住进程里唯一的 AgentFactory 槽位，把每个会话分派给四个托管引擎（`claude-code` / `codex` / `pi` / `kimi`）之一或 harness 自带的进程内 loop。它的核心功能是**在一条已经开始的会话上换引擎**——用户就在对话页里点一下换。harness 自己的 preset 通道做不到这件事：`AgentPresets.select()` 对已开始的会话直接以 `agent-preset/locked` 拒绝（`packages/preset/agent-presets/src/index.ts:709-726`）。

插件曾经的做法是：写下自己的逐会话记录，然后 `dispose()` 掉这条会话的 agent，让宿主的下一次 resolve 用新引擎重建它。这条路**会破坏活着的会话**：harness 的 `AgentHandle.dispose()` 在停完机器之后还会 `detachSession()`（`packages/core/agent-loop/src/index.ts:664` 取得、`:610` 调用），把 Session 从 `ctx.sessions` 摘掉并发出一条 `session/disposed`（`packages/core/session/src/index.ts:1064-1074`）。宿主把这条事件变成 `api-session/removed`（`packages/api/session-controller/src/index.ts:149-151`），浏览器那半据此把该会话从会话列表里删掉、把"当前会话"清成 `undefined`——用户看到输入框变成"会话不可用"，或者整个对话面退回"选择一个工作区开始"。更糟的是客户端那侧的这个标记只被写 `true`、没有复位路径（`packages/api/session-controller/src/client/sessions/session.ts:571-575`、`:807`），所以在那个页面的生命周期里这条会话再也回不来。

**托管引擎之间**这一路插件已经自己解决了（原地换手：`retire()` 旧 agent、只用**同一个 `Session` 对象**发布继任者，见 `docs/architecture.md` §3.7），因为两个 registry 的 disposer 都是普通闭包、四个引擎的 agent 都能用一条已存在的 Session 构造。**但只要一边是进程内 loop 就无解**，而进程内 loop 正是默认引擎，所以"新建的会话默认跑 in-process，用户给某条会话选一个托管引擎"是最常见的一条路径。

## 现状：进程内 loop 的两半都够不到

**1. 交出方向（in-process → hosted）：拿不到接管所需的两样东西，也空不出槽位。**

`AgentLoop.prepare` 把这条会话的 store 条目 disposer 与写句柄放在**私有闭包**里：

```ts
let detachSession: (() => void) | undefined
...
detachSession = agent.ctx.sessions.enter(session)   // :664
...
detachAgent?.()
detachSession?.()                                   // :609-610
```

（`packages/core/agent-loop/src/index.ts:568-670`。`handle` 同样只是 `prepare` 的形参，唯一的释放点是 `:604` 的 `await handle?.close()`，而它在 `create` 路径上由 `persistence.create` 内部产生（`:765` 附近）、在 resume 路径上由 `persistence.open` 内部产生（`:893` 附近）。）插件的路由器继承 `AgentLoop` 只是为了拿到进程内语义，它对这条闭包没有任何访问面；而 `AgentRegistry` 也没有公开的"按 id 移除"，只有 `enter` / `register` 返回的单次闭包（`packages/core/agent/src/index.ts:458`、`:434`），所以连先空出槽位再注册继任者这一步都做不到（`agents.enter` 对重复 id 抛 `agent "…" is already registered`，`:466`）。

**2. 接管方向（hosted → in-process）：公开入口都拒绝一条已经活着的会话。**

`prepare` 是私有的，而它唯一的公开入口都会重新准备会话：

- `create` → `this.runtime.ctx.sessions.prepare(id, { meta })`（`:700`）；
- `resume` → `persistence.open(id, 'write')` 之后 `sessions.prepare(id, { seed, meta, … })`（`:879`、`:893`）。

`SessionStore.prepare` 与 `enter` 对一条已在 store 里的 id 都直接抛（`packages/core/session/src/index.ts:970`、`:1033`），`enter` 甚至对同一个 Session 对象再调一次也抛（`:1034`）。而 `prepare` 的 `publish` 是无条件 `sessions.enter(session)` + `sessions.announce(session)`（`:664`、`:668`），`announce` 对已 announce 的 entry 同样拒绝（`packages/core/session/src/index.ts:1085-1087`）。后端的写句柄也帮不上忙：`persistence.open(id, 'write')` 在同一条会话已经有一个活 writer 时抛 `SessionAlreadyOwnedError`（`packages/session/session-persistence-jsonl/src/storage.ts:429-431`）。

**3. 自己造一个进程内 agent 也不行。**

真正的实现类 `ReactLoopAgent` 只在包内导出（`packages/core/agent-loop/src/agent.ts:72` 是 `export`，但 `packages/core/agent-loop/src/index.ts` 没有 re-export 它），而那个包的 `exports` 只有 `.` / `./invariant` / `./package.json`，`files` 里也没有 `lib/agent.js`。仓外插件既不能 import 它，也不能从发布产物里找到它。

## 建议 API

两个方向各自缺的东西不同，所以建议两个**可选**的接缝，任一落地都能把对应方向变成原地换手；两个都落地则四个方向全部可以原地换手。

### 方案 A —— 把"交出一条活会话"做成 `AgentHandle` 的一部分（解 in-process → hosted）

让工厂发布的 handle 能交出**会话级**的两样东西，而不是只能在 `dispose()` 里一并释放。最小形状（命名词请主仓定）：

```ts
interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
  /**
   * Hand this agent's session over: stop driving it, leave the session entered,
   * and return the resources its successor needs. Only valid while the agent is
   * idle and still owns the session.
   */
  retire?(): Promise<SessionHandover>
}

interface SessionHandover {
  /** The live Session object, still entered in the store. */
  readonly session: Session
  /** The session's write handle, left open for the successor. */
  readonly handle: SessionHandle | undefined
  /** Leave the store and close the handle; idempotent. */
  release(): Promise<void>
}
```

对 `AgentLoop` 来说这只是把已在闭包里的 `detachSession` 与 `handle` 暴露出来，并把 dispose 拆成"停机器 + 摘 agent"与"释放会话"两步。`dsh-loop-engine` 已经自己实现了这一对语义（`src/driver-core/hosted-engine-runtime.ts` 的 `retire` / `SessionLifetime`、`src/driver-core/session-lifetime.ts`），可以作为参考形状。

### 方案 B —— 让 `AgentFactory` 能在一份已交给它的会话上发布（解 hosted → in-process）

给 `AgentFactory` 增加一个入口，语义是"用这条已经活着的 `Session` 建一个 agent"：

```ts
interface AgentFactory {
  // …既有 createAgent / resume…
  /** Build an agent onto a session another agent already entered and announced. */
  join?(
    ownerCtx: Context,
    options: {
      readonly session: Session
      readonly agentOptions?: AgentOptions
      readonly setup?: AgentSetup
      readonly parentAgent?: Agent
    },
  ): Promise<AgentHandle>
}
```

`AgentLoop` 侧的实现是把 `prepare` + `setupAndPublish` 里的"准备会话"那一段换成"用调用方给的 `Session`"，`publish` 跳过 `sessions.enter` / `sessions.announce`（只做 `agents.enter` + `agents.announce` + `agent/session-start`，`source` 取 `'resume'`）。配合方案 A，接管方还需要能接收会话的写句柄，否则它只能让对方的句柄保持打开——那会让后端按 sessionId 的 writer 登记与"谁负责关闭"错位，不建议。

### 方案 C（备选）——只导出 `ReactLoopAgent`

如果主仓不想动 registry 契约，仅把 `ReactLoopAgent` 从包里导出（或给个 `createInProcessAgent(loopCtx, id, options, session)` 式的构筑函数）也能让插件自己完成两个方向：把 `prepare`/`publish`/`dispose` 那套事务按它自己的托管引擎那套镜像一遍（插件已经在 `src/driver-core/hosted-engine-runtime.ts` 里为四个托管引擎镜像了一份）。这一条改动最小，但把"发布/回收顺序"的正确性责任推给了仓外代码。

## 考虑过并否决的替代方案

- **让插件自己挂一个 `sessions` / `sessionPersistence` 的替身服务**，在 `enter()` / `create()` 处截获 disposer 与写句柄。否决理由：这要替换两个核心服务并依赖它们的内部记账（`SessionStore` 的 `store` 与 `attachments`、后端按 id 的 writer 表都是私有的），一旦主仓内部调整就会静默错位；而且那份 `attachments` 是模块级 WeakMap，同一 Session 对象本来就不可能同时挂进两个 store。
- **在插件侧监听 `session/disposed` 再 `enter` 回来**：`detachEntered` 已经发出过 `session/disposed`，客户端那个 `removed` 标记不会复位（见"动机"），所以会话在页面上依旧是死的。
- **把引擎写进会话日志（插件自有事件）**：那是另一条提案（`docs/proposals/append-ignorable-events.md`），它解决的是"引擎事实存哪"，不解决"换引擎要不要拆会话"。

## 风险与待定问题

- **`retire()` 之后的窗口**：agent 已从 `ctx.agents` 摘除、继任者尚未发布，此刻到达的一轮输入会走宿主的 resolve → resume 路径，对一条仍在 store 里的会话拿不到写句柄而失败。`dsh-loop-engine` 目前的处理是让这个窗口尽量短（旧机器 `whenIdle()` + `scope.dispose()` 之后立刻发布继任者），并把"继任者建不起来"的后果收敛成"释放这条会话、下次打开按记录重建"。若主仓提供方案 A/B，这个窗口是否应该由宿主的 resolve 变成"等待中的 join"来闭合，需要在实现时定。
- **`parentAgent`**：把一条**子会话**换出去时，谁继承它的 owner 关系（`AgentRegistry.enter(agent, owner)` 的第二个参数）需要明确。`dsh-loop-engine` 目前直接拒绝 subagent 会话（`selectEngine` 的第一道门），但如果接缝落地，这条限制可以放宽。
- **`session/disposed` 的语义**：原地换手让"会话离开 registry"与"agent 离开 registry"彻底分开，这是好事（客户端本来也只该看前者），但主仓若有任何一处把两者当作同时发生（例如"agent 没了就顺手关掉会话"），需要复查。
- **换手前那段窗口里的"模型选择"**：今天的做法是**切换那一刻**就把会话的模型选择写回部署默认（`src/model-selection-reset.ts`，见"落地后插件会有什么变化"）。所以在接缝落地之前，"这条会话的选择已经是部署默认、引擎还是旧的托管引擎"这段窗口是**有意**存在的：窗口里活 agent 是托管引擎、它并不读这条选择（唯一读它的 pi 驱动只把它当 `--model` 候选，不认识的模型直接丢掉），而进程内那一侧接管时读到的正是它——这正是这个顺序的目的。若接缝落地，这次重置应该挪到交接的那一刻发生。

## 验收标准

1. 一条**已经跑过一轮**、且当前 live 的持久化会话，在两个引擎（或进程内 loop 与一个托管引擎）之间切换之后：`ctx.sessions.get(id)` 仍是同一个 Session 对象、`ctx.agents.get(id)` 是继任者，且**全程没有 `session/disposed`**；
2. 切换后的下一轮由新引擎执行；会话的写句柄仍由当前持有者负责关闭（下一次 `persistence.open(id, 'write')` 在继任者 dispose 之前被拒、之后成功）；
3. 切换失败（继任者建不起来）时，会话不会停在一个"活着但没人驱动"的状态——要么旧 agent 仍在，要么会话干净地变冷、可在下一次打开时按记录重建。

## 落地后插件会有什么变化

`dsh-loop-engine` 会把 `move` 里的"与 in-process 之间：释放这条会话 + 让页面重载"（`src/router-loop.ts:448-453`）换成真正的原地换手：结果形状里的 `reload` 标志、客户端的重载与"回到那条会话"那半边（`src/client/reload.ts`）、以及 `docs/per-session-engine.md` §5.2 的整条流程都不再需要。接缝落地后报告也不再需要第二个字段（`pending`），chip / composer 的「切到 X · 尚未接管」标注与 `engineReportOfSession` 里那个"活 agent 与记录不同"的分支都可以删掉——报告只剩 `engine`。同样不再需要的是**"模型选择先落盘、引擎后接管"这半个分裂**：今天切回 `in-process` 时，插件必须在切换那一刻就追加一条 `model/selection`，把这条会话的选择从引擎的 provider 标签改回部署默认模型（`src/model-selection-reset.ts`，理由见 `docs/architecture.md` §3.6/§3.7 与 `docs/per-session-engine.md` §5.2），因为引擎本身要等到重载之后的那一次构建才接管。接缝落地后"下一次构建"这个概念就不存在了，这次重置可以放在交接那一刻做——写的事件、幂等判据与跳过条件都不用改。
