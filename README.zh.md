# dsh-loop-engine

像切换模型一样切换 **dsh web** 的 agent 循环引擎:设置页的「Loop engine」下拉选择运行 agent 的驱动——内置 in-process 循环、Claude Code CLI,或(未来)Codex——**无需改动主仓库**。

## 能做什么

- **引擎由设置决定,而非改代码。** 在设置页选 `in-process`(默认)或 `claude-code`,选择持久保存,编辑 profile 也不丢失。
- **Claude Code 执行。** 由 Claude Code CLI 驱动 agent,并把 token 流式转发进会话日志。
- **可扩展。** 新增引擎(如 Codex)只需加一个驱动模块 + 设置 schema 里加一个枚举值。
- **零主仓改动。** 仅作为 profile 依赖 + 一行组合配置安装。

## 环境要求

- dsh `0.1.1-rc.2`(或 peer 包版本匹配的构建)。
- 使用 Claude Code 引擎时需要本机已安装并登录 Claude Code CLI。
- 当 harness 以**源码方式**运行(如在 `deepseek-harness` 仓库内执行 `pnpm dsh`)时,profile 需要把本插件的 harness peer 包解析到主仓 **源码**,通过 profile 的 `shims/` 目录里的本地 `file:` 垫片实现;正式部署(单一发布版 `node_modules`)则无需垫片。

## 配置方法

1. 构建插件:

   ```sh
   pnpm install && pnpm run build
   ```

2. 在 `$DSH_HOME/profiles/web/package.json` 添加依赖:

   ```json
   "dependencies": {
     "@deepseek-ai/dsh-loop-engine": "0.1.1-rc.2",
     "...保留其余依赖"
   }
   ```

   在包发布到 registry 之前,请改用指向你本地代码副本的 `file:` 引用,而非版本号。

3. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加一行组合:

   ```yaml
   - insert:
       - id: loop-engine
         name: '@deepseek-ai/dsh-loop-engine'
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
   - **Claude Code CLI** —— Claude Code 驱动。
3. 二者之间切换在**重启 `dsh web` 后生效**;切回默认时选择 **In-process** 并再次重启即可。
4. 卸载插件:从 `cordis.patch.yml` 删除 `loop-engine` 行,并从 `package.json` 移除依赖,然后 `pnpm install` 并重启 `dsh web`。

## License

MIT