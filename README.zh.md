# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

像切换模型一样切换 **dsh web** 的 agent 循环引擎:设置页的「Loop engine」下拉选择运行 agent 的驱动——内置 in-process 循环、Claude Code CLI、Codex CLI、Pi CLI,或 Kimi Code CLI——**无需改动主仓库**。

## 安装

```sh
dsh plugin --profile web add dsh-loop-engine
```

重启 `dsh web`,然后打开 **Settings → Loop engine**。

> 切换引擎会重写 `cordis.patch.yml` 中一小段受管理的内容,文件里你写的其它部分都会保留,只改动插件自己的区间。

### 环境要求

- 使用 Claude Code 引擎时需要本机已安装并登录 Claude Code CLI。
- 使用 Codex 引擎时需要完成认证:本机执行过 `codex login`,或配置 `CODEX_API_KEY` 环境变量。
- 使用 Pi 引擎时需要以 `pi` 要求的方式完成认证(其自身的 `~/.pi/agent/auth.json`,或提供方的 API-key 环境变量,如 `ANTHROPIC_API_KEY`)。
- 使用 Kimi Code 引擎时需要本机已安装并登录 `kimi` CLI(例如 `kimi login`),且在 `PATH` 上(或在组合条目里用 `kimiBin` 固定为绝对路径)。

## 使用方法

1. 在 **Settings → Loop engine** 选择引擎——`in-process`(默认)、`claude-code`、`codex`、`pi` 或 `kimi`——然后重启 `dsh web`。
2. 要切回默认,选 **In-process** 再重启即可。
3. 卸载插件:`dsh plugin --profile web remove dsh-loop-engine`,然后重启 `dsh web`。

### 引擎说明

- Codex 驱动运行 `codex app-server`,没有交互式工具审批——权限来自会话的 `sandboxMode` + `approvalPolicy`。
- Pi 驱动运行 `pi --mode rpc`;Pi 没有权限系统,所以整个子进程经 dsh subprocess 服务做沙箱化(默认 `read-only`)。
- Kimi Code 驱动运行一个常驻的 `kimi acp` 子进程(Agent Client Protocol over stdio),每步一次无状态的 `session/new` + `session/prompt`;durable 会话日志是唯一模型上下文。它把助手文本(`agent_message_chunk`)与**思考**(`agent_thought_chunk`)**增量**写入日志,并把工具调用/流(`tool_call` / `tool_call_update`)映射为 `tool/call` + `tool/result`。ACP 通过 `session/request_permission` 暴露工具审批,驱动根据会话的 dsh 审批旋钮应答(ask 策略拒绝,失败关闭)。子进程经 dsh subprocess seam 拉起——唯一权限边界(默认只读沙箱)。其项目 `AGENTS.md` 链(cwd→git 根)与 `.kimi-code/skills/` 目录(用户与项目)通过 dsh 技能注入接口暴露,其斜杠命令也已桥接(内置命令把原始 `/name` 行转发回引擎展开)。prompt 是 ACP 请求体而非 argv 位置参数,因此**不存在命令行长度上限**。注意 Kimi 剩余的斜杠命令面是纯 TUI(`/login`、`/provider`、`/settings`、`/sessions`…),这些不桥接(ACP prompt 面不扩展它们);`skill:` 命令由技能接口与 kimi 自身的 shorthand 承载。

## License

MIT
