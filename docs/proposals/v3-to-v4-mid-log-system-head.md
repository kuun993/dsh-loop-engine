# 需求：v3→v4 迁移应能修复"中段 `system/message`"，而不是整条拒掉会话

> **目标仓库**：deepseek-harness（主仓）。本文件记录背景与建议改动，供提交为 GitHub issue。下文主仓路径相对 harness 仓库根；裸 `src/...` 相对本插件检出根。所有行号已对照 `0.1.7-rc.1` harness 检出核验。
>
> **范围**：`packages/session/session-format-v3-to-v4` 的一次性迁移。不改会话格式版本，不改一方事件的写入方式，只改一条**拒绝条件**——它在真实会话上会把一条完全可读的历史判成不可读。

## 现状

`session-format-v3-to-v4` 的 `RelationshipFolder.foldSurface` 有一条硬拒绝（`packages/session/session-format-v3-to-v4/src/relationships.ts:126`）：

```ts
foldSurface(event: SessionFormatEvent): void {
  if (!SURFACE_TYPES.has(event.type)) return
  if (event.type === 'system/message' && this.surface.length > 0 && this.protectedHead === undefined) {
    throw new SessionFormatError('system/message requires a protected first surface head')
  }
  if (event['surfaceOp'] === 'append') {
    if (event.type === 'system/message' && this.surface.length === 0) this.protectedHead = event.seq
    this.surface.push(event.seq)
    return
  }
  ...
```

规则本身是对的：**当一个 surface 头存在时，它必须是第一个 surface 事件**（`:130` 只在 surface 还空时才把某个 `system/message` 认作受保护的头）。问题在于失败方式——一旦一条日志里出现"中段的 `system/message`"，迁移**整条拒绝**，错误经 `packages/session/session-format/src/catalog.ts:246` 包成 `SessionFormatUnsupportedMigrationError`，用户侧表现为**会话打不开**（`failed to observe session …: Session migration from v3 to v4 refuses the transformed artifact: system/message requires a protected first surface head`）。

## 为什么会产出这种日志

会话的 surface 头由 harness loop 在**它自己的第一步**写下（`packages/core/agent-loop/src/agent.ts:399`，`systemPrompt.project` → `session.append('system/message', …)`）。**任何不经过 harness loop 的 agent 工厂都不会写它。**本部署里那条工厂是 `dsh-loop-engine` 的托管引擎驱动：外部 CLI 自带系统提示，驱动只写 `user/message` / `assistant/message` / `tool/*`。

于是这条因果链成立：

1. 一条会话**由托管引擎起步** → 前几轮没有 `system/message`（合法：v3 不要求头；v4 本身也容忍"整条都没有头"，线上大量 `sys=0` 会话即证）。
2. 同一条会话后来**跑过 in-process** → harness loop 在那一刻写下它自己的第一个 `system/message`，位置在既有 surface 事件**之后**。
3. 该日志 migrate 到 v4 时命中 `:126`，整条被拒。

真实会话的 surface 轨迹（一条 `--D-workspace-person-code--` 的 v3 日志，surface 事件按 seq）：

```
  9 user/message      surfaceOp=append
 13 assistant/message surfaceOp=append
 ... (数轮 user/assistant)
 70 system/message    surfaceOp=append        ← 第一个，但 surface 已有事件
 84 system/message    surfaceOp={replace 70}
113 system/message    surfaceOp={replace 84}
```

对应的请求 provider（`request/header`）：`external/default`（托管引擎）@10、@52；随后 `responses` / `anyai` / `meicloud`（in-process）@74 起——切换点正是 `system/message` 出现的时刻。

**注意**：混用方向的会话（in-process 起步 → 切到托管引擎）没有问题，因为头已经在第一步写下了。触发条件是**托管引擎先行**。

## 影响

- 用户升级到 0.1.7 后，任何**先跑过托管引擎、后跑过 in-process** 的旧会话都打不开（本部署一次性出现多条）。
- 该会话本身完全可读——只是迁移器拒绝产出它。

## 建议改动

**A（推荐）：迁移时修复，而不是拒绝。** `packages/session/session-format-v2-to-v3/src/migration.ts:110-133`（`emitSystem`）已经演示了正确做法：**在需要时分段合成一个受保护的头**。v3→v4 可做同样的事：

- 当 `system/message` 以 `append` 到达、`surface` 非空且 `protectedHead === undefined` 时，把它当作**在历史中更新系统提示**处理，而不是错误：在 surface 头部合成一个受保护的头（provider 由该事件自身携带，内容为空或取该事件的 content），并把中段的这条改成对合成头的 `replace`（`sourceEventSeqs` 指向合成头）。这样 `protectedHead` 建立、后续 `replace`（`session-format-v3-to-v4/src/relationships.ts:141-144`）按既有规则续上。
- 判据要窄：仅在"确实存在一条 `system/message`，只是来得晚"时修复；整条没有任何 `system/message` 的日志维持现状（合法）。

**B（备选，成本更低）：放行 + 归一。** 允许该 `system/message` 以 `append` 落在中段，但在迁移后把它归一为一次"历史中的系统更新"（不设为头），并让 `protectedHead` 保持 `undefined`。需要确认 v4 的读取路径（`assertV4SystemMessageFields`、`surface.ts`）在"无受保护头 + 中段 system 更新"下能自洽——若不能，A 更稳。

**C（不推荐）：只改错误信息。** 拒还是拒，只是把会话 id 与 seq 写清楚。对用户没有价值。

## 考虑过并否决的替代方案

**插件侧补头**：`dsh-loop-engine` 已在自己的四个驱动里，于会话首个 step、且仅当尚无任何 surface 事件时，补一条**空 content** 的 `system/message` 头（`src/driver-core/system-head.ts`）。这能保证 0.1.7 上**新建**的托管会话带上受保护的头，但它**救不了已存在的日志**——迁移发生在一个已经写死的文件上。凡是"会话先于修复创建"的场景，只能由迁移器自己修复。故本提案仍需落地。

## 验证方式

- 单测：构造一条 v3 日志，surface 为 `[user/message, assistant/message, system/message(append)]`，断言迁移**成功**且产出的 v4 日志满足 `protectedHead` 规则（而不是抛 `SessionFormatUnsupportedMigrationError`）。
- 回归：`packages/session/session-format-v3-to-v4/tests` 现有用例应保持；新增用例覆盖"中段 system 头"这一形态。
- 端到端：用本提案附带的那条真实 v3 日志（或等价构造）跑 `pnpm run test:snapshot` / 手工 `dsh --profile web` 打开该会话。
