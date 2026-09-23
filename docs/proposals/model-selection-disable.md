# 需求：托管引擎会话隐藏/禁用模型选择器

> **状态（0.1.5-rc3 起）：本提案的"隐藏选择器"路线被方案 A 取代。** 插件不再把托管引擎的模型座留空——四个引擎现在共用一个 provider 标签（`external`，显示名同样是 `external`）并广告**恰好一条目录条目**（`{ provider: 'external', id: 'default', name: 'default' }`，见 `src/provider-route.ts` 与 `docs/architecture.md` §3.6），并把同一个字符串写进会话的 `request/header`，于是模型座显示引擎自己的词 `default` 而不是回落渲染的 `${provider}/${model}` 原样串（用户看到的"不存在的模型" `kimi/kimi-native` 就是那次回落）。同时插件在任何托管引擎下都显示一句说明（`hostedEngineModelNotice`，判据 `isHostedEngine`），并顺手把"模型菜单写进部署默认"的坑兜住（`ModelSelectionReset.guardFor`，见 `docs/per-session-engine.md` §5.2）。**本次补充（模型选择「透传」后）**：一条真实 dsh 模型选择**会**交给托管引擎使用（`src/driver-core/session-model.ts`，见 `docs/proposals/per-session-model-for-hosted-engines.md` §0），所以"模型选择对该引擎不生效"这句话不再成立——选 `default`（`external/default`，即"交回引擎自己决定"）时不下发，选真实模型时透传、引擎拒绝则报错。**本文件仍然有效的那一半是它的诉求 1 与 3**：语义上"这条选择是交给引擎用的、成不成取决于引擎"应当由引擎能力标志（`consumesModelSelection` 之类）表达、由 UI 与 RPC 一起尊重，而不是靠插件广告一条假条目 + 文案解释——那是主仓改动，仍值得作为 issue 提。诉求 2（`selectModel` 明确拒绝）今天做不到：插件不是这条 RPC 的实现方，而它必须继续注册这个共享 provider 标签（否则托管会话第二轮就被 `model-unavailable` 拒掉）。取舍与将来按引擎升级成真目录的方案 B 见 `docs/proposals/per-session-model-for-hosted-engines.md`。
>
> **保留的历史背景如下**（当时只有 claude-code 引擎，且 dsh 的模型选择对所有托管引擎都不生效）。

**目标仓库**：deepseek-harness（主仓）。本文件记录背景与建议改动，供提交为 GitHub issue。

## 背景

dsh web 的模型选择器有两个入口，均由主仓 `packages/client/ui-model-selection` 渲染：

- `/model` popupSelect 弹层
- composer 的 `conversation.input.model` 座位

两者都走 `session.models` / `session.selectModel` RPC（`packages/host/apiproxy/src/api-proxy.ts`）。

当会话由 `dsh-loop-engine` 的 **claude-code 引擎**驱动时，实际推理模型由 Claude Code 原生决定（或由插件 `cordis.yml` 的 `model` 配置项钉死）。模型选择器对该引擎**没有任何生效路径**：

- `selectModel` 只把选择写进 api-proxy 内存态（`selectionFor(agent)`）和默认选择持久化，claude 驱动从不读取；
- 唯一的影响是会话创建时 api-proxy 把默认选择塞进 `agentOptions.model`，被 claude 驱动的 request-header 日志当作模型标签记录——**误导且无意义**（插件已在 0.1.1-rc.2 之后修复为忽略该值）。

## 期望行为

claude-code 引擎会话下：

1. composer 的模型座位与 `/model` 弹层**不显示**（或显示为只读的"Claude Code 原生模型"）。
2. `session.selectModel` 返回明确的拒绝错误（如 `model-selection-inapplicable`），而不是静默成功。
3. `session.models` 对这类会话返回空目录（或仅返回"不可选"的提示行）。

## 建议改动

1. **引擎能力暴露**：给 AgentFactory / loop 工厂增加一个"是否消费模型选择"的能力标志（例如 `consumesModelSelection: boolean`，claude-code 引擎为 `false`）。通过会话投影或现有 RPC（`session.models` / `session.list`）透出给客户端。避免把"引擎身份"（`claude-code` 字符串）耦合进 client——语义是"模型选择对该引擎不生效"，不是引擎名本身。
2. **`packages/client/ui-model-selection`**：根据该标志隐藏两个入口（座位渲染为 null / 弹层不注册命令）。
3. **`packages/host/apiproxy`**：`selectModel` 对 `consumesModelSelection === false` 的会话拒绝并给出稳定错误码；`models` 返回空 groups（现有 UI 逻辑对空目录已有"无可用模型"的兜底表现，可复用）。

## 验收标准

- 新建 claude-code 引擎会话：composer 与 `/model` 均不出现模型选择入口。
- 直接调 `session.selectModel` RPC：返回 `model-selection-inapplicable` 且不写内存态、不改默认选择。
- 切回进程内引擎（或该引擎放行了这条选择）：模型选择器恢复。
- 不影响 ACP/无头路径（无 UI 的消费方不受 `models` 空目录影响）。
- 附注（0.1.5-rc3 起的插件现状）：模型目录里的条目是**插件广告的**`default`，不是引擎的真实模型清单，所以"引擎放行/拒绝这条选择"要靠新增的能力标志说出，不能靠目录是否为空推断——今天目录对四个引擎都非空。
