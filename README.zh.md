# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/@kuun993/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/@kuun993/dsh-loop-engine)

像切换模型一样切换 **dsh web** 的 agent 循环引擎:设置页的「Loop engine」下拉选择运行 agent 的驱动——内置 in-process 循环、Claude Code CLI,或 Codex CLI——**无需改动主仓库**。

## 能做什么

- **引擎由设置决定,而非改代码。** 在设置页选 `in-process`(默认)、`claude-code` 或 `codex`,选择持久保存,编辑 profile 也不丢失。
- **Claude Code 执行。** 由 Claude Code CLI 驱动 agent,并把 token 流式转发进会话日志。
- **Codex 执行。** 驱动 spawn `codex app-server` 并把其 token 级增量流式转发进会话日志,每一步一个 turn。
- **可扩展。** 新增引擎只需加一个驱动模块 + 设置 schema 里加一个枚举值。
- **零主仓改动。** 仅作为 profile 依赖 + 一行组合配置安装。

## 环境要求

- dsh `0.1.1-rc.2`(或 peer 包版本匹配的构建)。
- 使用 Claude Code 引擎时需要本机已安装并登录 Claude Code CLI。
- 使用 Codex 引擎时需要完成认证:本机执行过 `codex login`,或配置 `CODEX_API_KEY` 环境变量。
- 当 harness 以**源码方式**运行(如在 `deepseek-harness` 仓库内执行 `pnpm dsh`)时,profile 需要把本插件的 harness peer 包解析到主仓 **源码**,通过 profile 的 `shims/` 目录里的本地 `file:` 垫片实现;正式部署(单一发布版 `node_modules`)则无需垫片。

## 配置方法

1. 构建插件:

   ```sh
   pnpm install && pnpm run build
   ```

2. 在 `$DSH_HOME/profiles/web/package.json` 添加依赖:

   ```json
   "dependencies": {
     "@kuun993/dsh-loop-engine": "1.0.0-rc2",
     "...保留其余依赖"
   }
   ```

   包已发布到 npm,名称 `@kuun993/dsh-loop-engine`。本地开发时改用指向你本地代码副本的 `file:` 引用。

3. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加一行组合:

   ```yaml
   - insert:
       - id: loop-engine
         name: '@kuun993/dsh-loop-engine'
   ```

4. 安装并重启:

   ```sh
   cd $DSH_HOME/profiles/web && pnpm install
   ```

   重启一次 `dsh web` 使插件生效。

> 切换引擎会重写 `cordis.patch.yml` 中一小段受管理的内容,文件里你写的其它部分都会保留,只改动插件自己的区间。

## 使用方法

1. 打开 **Settings → Loop engine**。
2. 选择引擎:
   - **In-process**(默认)——内置循环驱动;
   - **Claude Code CLI** —— Claude Code 驱动;
   - **Codex CLI** —— OpenAI Codex 驱动。
3. 引擎之间切换在**重启 `dsh web` 后生效**;切回默认时选择 **In-process** 并再次重启即可。
4. 卸载插件:从 `cordis.patch.yml` 删除 `loop-engine` 行,并从 `package.json` 移除依赖,然后 `pnpm install` 并重启 `dsh web`。

### Codex 引擎的实现细节

驱动绕过 `@openai/codex-sdk`(它只输出整条 item),改为 spawn `codex app-server` 子进程,通过 stdio 走 JSON-RPC。app-server 会流式输出 **token 级增量**(`item/agentMessage/delta` 与 `item/reasoning/summaryTextDelta`),因此思考与回复会在会话里逐步呈现——与 Claude Code 引擎一致。

- **流式。** 推理增量与回复增量实时转发为 `assistant/chunk` 事件;持久化消息在正确的 step 边界落盘,turn 结束时附加用量。
- **技能。** Codex 引擎注册了一个技能提供者,把 `AGENTS.md`(项目根与 `~/.codex/AGENTS.md`)通过与 Claude 技能相同的 dsh 技能注入接口暴露出来。
- **无交互式工具审批。** 权限是声明式的 `sandboxMode` + `approvalPolicy` 组合,每次查询按会话的权限开关解析(也可通过插件的 `sandboxMode`/`approvalPolicy` 配置固定)。会话的 `ask` 策略映射为 `on-request`,其 CLI 交互提示在无人值守的 dsh 运行时会退化为拒绝。
- **不接入 dsh subprocess 沙箱。** 驱动自行 spawn `codex app-server`,dsh 的 subprocess 服务(及其沙箱)不会包裹它。
- **本版本不为 Codex 注册引擎专属斜杠命令。**

## License

MIT