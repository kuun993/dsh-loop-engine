# dsh-loop-engine

在 dsh web 里像切换模型一样切换 agent 循环引擎:设置页的「Loop engine」下拉可选 in-process 默认引擎(`agent-loop`)或 Claude Code CLI 驱动(`claude-code`);后续引擎(如 Codex)在同一选择里扩展。

本包是**非默认引擎本身 + 切换机制**的唯一 out-of-tree 存放处——一个仓库、一个插件行、零主仓改动。Claude Code 引擎(agent 驱动、流式、SDK 映射、子进程投影)就在 `src/engine/` 里。

## 原理

dsh 的 AgentFactory 槽是**唯一**的(`ctx.agents.setFactory`,二次注册抛错)。`dsh-loop-engine` 为非默认引擎托管一个 AgentFactory;基底 `agent-loop` 行是默认的 in-process 工厂。

选择存于设置段(`agent-loop-engine.engine`),并通过 profile 的 `cordis.patch.yml` 里一段 managed block 落地——它禁用基底 `agent-loop` 行,把唯一工厂槽让给本插件托管的驱动:

```yaml
# -- dsh-loop-engine managed block: claude-code --
- id: agent-loop
  disabled: true
# -- /dsh-loop-engine managed block --
```

- `claude-code`:写入 block、基底 `agent-loop` 禁用、Claude Code 工厂注册;
- `in-process`:移除 block、基底 `agent-loop` 重新作为工厂。

工厂在启动时按 block 决定注册,所以 `in-process` 与托管引擎之间切换需要重启一次;两个托管引擎之间可即时切换(同一工厂,按设置在创建 agent 时选择)。

用户写在 `cordis.patch.yml` 里的其它内容在切换时逐字节保留,插件只重写自己那段 span。

## 安装(一次性,零主仓改动)

1. 构建本包(产出 `lib/`):
   ```sh
   pnpm install && pnpm run build
   ```
2. 在 `$DSH_HOME/profiles/web/package.json` 加一个 file 依赖:
   ```json
   "dependencies": {
     "@deepseek-ai/dsh-loop-engine": "file:D:/workspace/github/dsh-loop-engine",
     "...保留其它依赖"
   }
   ```
3. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加一行:
   ```yaml
   - insert:
       - id: loop-engine
         name: '@deepseek-ai/dsh-loop-engine'
   ```
4. 在 profile 目录 `pnpm install`,然后**重启一次 `dsh web`**(客户端清单与组合树需要重启才能接入插件)。

## 使用

1. Web UI → Settings → "Loop engine"。
2. 选择引擎:
   - **In-process(默认)**:基底 `agent-loop` 驱动。
   - **Claude Code CLI**:本包托管的 Claude Code 引擎(需要本机已装并登录 Claude Code CLI;驱动使用自己的子进程与 scrub 后的环境)。
3. `in-process` 与 `claude-code` 之间切换在**重启 dsh web 后生效**(工厂在启动时选定);原引擎上的会话会被中断。

## 源码布局

| 路径 | 职责 |
| --- | --- |
| `src/namespace.ts` | 共享 namespace 字面量(零依赖,两端共用) |
| `src/settings.ts` | 设置段 schema(`z.const('in-process' | 'claude-code')`) |
| `src/patch-manager.ts` | managed block 纯字符串变换(写/替换/删除,逐字节保留) |
| `src/index.ts` | node half:托管引擎工厂、设置段、onChange → managed block |
| `src/invariant.ts` | 配套 invariant:block 往返为不动点 |
| `src/engine/*` | Claude Code 引擎模块(agent 驱动 + SDK 映射 + 工厂) |
| `src/client/*` | 浏览器端:设置页下拉(`settings.section` slot) |

## 验证

- 单测:`pnpm run test`(143 个用例,per-file 覆盖率 100%)。
- 构建:`pnpm run build` 产出 `lib/index.js`(node bundle,`@deepseek-ai/*` 与 `@anthropic-ai/*` 保持 external)、`lib/invariant.js`、`lib/client.js`(`window.__ModuleLoader__.load` 客户端模块契约)。
- 类型检查:`pnpm run typecheck`。

## 已知限制与待办

- `in-process` 与托管引擎之间切换需要重启一次 `dsh web`(AgentFactory 在启动时注册);两个托管引擎之间可即时切换。
- Claude Code 引擎通过官方 Claude Agent SDK 驱动,每 dsh step 一次无状态查询,并把 token 流式转发进会话日志;本机需安装并登录 Claude Code CLI。
- 新增引擎(如 Codex):在 `src/engine/` 加内部模块,并在 `src/settings.ts` 与 `src/index.ts` 的分发里登记。