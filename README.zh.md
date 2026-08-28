# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

像切换模型一样切换 **dsh web** 的 agent 循环引擎:设置页的「Loop engine」下拉选择运行 agent 的驱动——内置 in-process 循环、Claude Code CLI、Codex CLI,或 Pi CLI——**无需改动主仓库**。

## 能做什么

- **引擎由设置决定,而非改代码。** 在设置页选 `in-process`(默认)、`claude-code`、`codex` 或 `pi`,选择持久保存,编辑 profile 也不丢失。
- **Claude Code 执行。** 由 Claude Code CLI 驱动 agent,并把 token 流式转发进会话日志。
- **Codex 执行。** 驱动 spawn `codex app-server` 并把其 token 级增量流式转发进会话日志,每一步一个 turn。
- **Pi 执行。** 驱动 spawn `pi --mode rpc` 并把其 `message_update` 增量流式转发进会话日志,每一步一个无状态 `new_session` + `prompt`。
- **可扩展。** 新增引擎只需加一个驱动模块 + 设置 schema 里加一个枚举值。
- **零主仓改动。** 仅作为 profile 依赖 + 一个 bundle 层安装,无需改动主仓库。

## 安装

```sh
dsh plugin --profile web add dsh-loop-engine
```

重启 `dsh web`,然后打开 **Settings → Loop engine**。

`dsh plugin add` 会把包装进 web profile,并注册为 bundle 层——包声明了 `dsh.bundle.patch`,所以无需手动改 `cordis.patch.yml`。包已发布到 npm,名称 `dsh-loop-engine`。

### 环境要求

- 使用 Claude Code 引擎时需要本机已安装并登录 Claude Code CLI。
- 使用 Codex 引擎时需要完成认证:本机执行过 `codex login`,或配置 `CODEX_API_KEY` 环境变量。
- 使用 Pi 引擎时需要以 `pi` 要求的方式完成认证(其自身的 `~/.pi/agent/auth.json`,或提供方的 API-key 环境变量,如 `ANTHROPIC_API_KEY`)。

> 切换引擎会重写 `cordis.patch.yml` 中一小段受管理的内容,文件里你写的其它部分都会保留,只改动插件自己的区间。

## 使用方法

1. 打开 **Settings → Loop engine**。
2. 选择引擎:
   - **In-process**(默认)——内置循环驱动;
   - **Claude Code CLI** —— Claude Code 驱动;
   - **Codex CLI** —— OpenAI Codex 驱动;
   - **Pi CLI** —— Pi(earendil-works/pi)驱动。
3. 引擎之间切换在**重启 `dsh web` 后生效**;切回默认时选择 **In-process** 并再次重启即可。
4. 卸载插件:`dsh plugin --profile web remove dsh-loop-engine`,然后重启 `dsh web`。

### Codex 引擎的实现细节

驱动绕过 `@openai/codex-sdk`(它只输出整条 item),改为 spawn `codex app-server` 子进程,通过 stdio 走 JSON-RPC。app-server 会流式输出 **token 级增量**(`item/agentMessage/delta` 与 `item/reasoning/summaryTextDelta`),因此思考与回复会在会话里逐步呈现——与 Claude Code 引擎一致。

- **流式。** 推理增量与回复增量实时转发为 `assistant/chunk` 事件;持久化消息在正确的 step 边界落盘,turn 结束时附加用量。
- **技能。** Codex 引擎注册了一个技能提供者,把 `AGENTS.md`(项目根与 `~/.codex/AGENTS.md`)通过与 Claude 技能相同的 dsh 技能注入接口暴露出来。
- **无交互式工具审批。** 权限是声明式的 `sandboxMode` + `approvalPolicy` 组合,每次查询按会话的权限开关解析(也可通过插件的 `sandboxMode`/`approvalPolicy` 配置固定)。会话的 `ask` 策略映射为 `on-request`,其 CLI 交互提示在无人值守的 dsh 运行时会退化为拒绝。
- **不接入 dsh subprocess 沙箱。** 驱动自行 spawn `codex app-server`,dsh 的 subprocess 服务(及其沙箱)不会包裹它。
- **本版本不为 Codex 注册引擎专属斜杠命令。**

### Pi 引擎的实现细节

驱动 spawn `pi --mode rpc` 子进程,通过 stdio 走 strict-LF(`\n`)JSONL 协议——从不用通用行读取器,因为 Pi 允许在 JSON 字符串里使用 U+2028 等 Unicode 分隔符。它**每个 dsh step 运行一个无状态会话**:先 `new_session`,再发一条携带序列化会话历史的 `prompt`。与 Codex/Claude 驱动一样,Pi 原生拥有自己的 system prompt,因此不会运行 dsh 的 system-prompt 组装——持久化会话日志仍是模型上下文的唯一来源。

- **流式。** `message_update` 增量(`text_delta` / `thinking_delta`)实时转发为 `assistant/chunk` 事件;工具调用与结果落为 `tool/call` + `tool/result`,用量在 `turn_end` 附加。
- **由 dsh subprocess 接口做沙箱化。** Pi **没有权限系统**("以用户权限运行"),因此驱动把整个 `pi` 子进程经由 dsh subprocess 服务转发,并把 `--tools` 裁剪到已解析的沙箱立场——`read-only`(默认)、`workspace-write` 或 `danger-full-access`(不裁剪)。`ask` 策略退化为只读拒绝,因为 Pi 没有交互式审批回调。
- **技能。** Pi 引擎注册了一个技能提供者,把 `AGENTS.md`(项目根与 `~/.pi/AGENTS.md`)通过与 Claude 技能相同的 dsh 技能注入接口暴露出来。
- **模型/提供方。** 通过 `--provider` / `--model` 传给子进程(固定的 `thinkingLevel` 会追加为 `:<level>`);省略时由 Pi 原生设置接管模型。

## License

MIT