# 需求：claude 引擎会话隐藏/禁用模型选择器

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
- 切回进程内引擎：模型选择器恢复。
- 不影响 ACP/无头路径（无 UI 的消费方不受 `models` 空目录影响）。
