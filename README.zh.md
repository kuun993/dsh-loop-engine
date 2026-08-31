# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/@vidge/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/@vidge/dsh-loop-engine)

像切换模型一样切换 **dsh web** 的 agent 循环引擎:设置页的「Loop engine」下拉选择运行 agent 的驱动——内置 in-process 循环、Claude Code CLI、Codex CLI,或 Pi CLI——**无需改动主仓库**。

## 安装

```sh
dsh plugin --profile web add @vidge/dsh-loop-engine
```

重启 `dsh web`,然后打开 **Settings → Loop engine**。

> 切换引擎会重写 `cordis.patch.yml` 中一小段受管理的内容,文件里你写的其它部分都会保留,只改动插件自己的区间。

### 环境要求

- 使用 Claude Code 引擎时需要本机已安装并登录 Claude Code CLI。
- 使用 Codex 引擎时需要完成认证:本机执行过 `codex login`,或配置 `CODEX_API_KEY` 环境变量。
- 使用 Pi 引擎时需要以 `pi` 要求的方式完成认证(其自身的 `~/.pi/agent/auth.json`,或提供方的 API-key 环境变量,如 `ANTHROPIC_API_KEY`)。

## 使用方法

1. 在 **Settings → Loop engine** 选择引擎——`in-process`(默认)、`claude-code`、`codex` 或 `pi`——然后重启 `dsh web`。
2. 要切回默认,选 **In-process** 再重启即可。
3. 卸载插件:`dsh plugin --profile web remove @vidge/dsh-loop-engine`,然后重启 `dsh web`。

### 引擎说明

- Codex 驱动运行 `codex app-server`,没有交互式工具审批——权限来自会话的 `sandboxMode` + `approvalPolicy`。
- Pi 驱动运行 `pi --mode rpc`;Pi 没有权限系统,所以整个子进程经 dsh subprocess 服务做沙箱化(默认 `read-only`)。
- 两者都往会话日志流式输出,并通过 dsh 技能注入接口暴露 `AGENTS.md`。

## License

MIT
