# 源码启动 harness 时给 profile 补 `file:` shim

**适用场景**：harness 从**源码 checkout** 启动（`cd deepseek-harness && pnpm dsh web`），而 `dsh-loop-engine` 是**打包安装**的（npm 或 tarball，`lib/` 里只有构建产物）。用 **`link:` 本地链接**安装插件时不需要这一步（见文末）。

发布版 dsh（`npx @deepseek-ai/dsh`）也不需要。

## 为什么需要

两侧会把同一个 harness 包解析成**两个不同的文件**：

| 一侧 | `@deepseek-ai/dsh-scope` 解析到 |
|---|---|
| 源码启动的 harness | `packages/core/scope/src/index.ts`（走 tsconfig `paths`） |
| 安装的插件（tarball 只带 `lib/`） | `packages/core/scope/lib/index.js` |

也就是**一个包被加载成两份模块实例**。`dsh-scope` 用一个模块内的 `Symbol('dsh.scope')` 给 context 打标记，所以经一份实例铸出的 scope 在另一份里不存在，resume 会话时会失败：

```
agent-presets: refusing to compose an unscoped context;
the scope key is what joins an agent to its preset
```

修法是让两侧共用一份：把 profile 的 harness peer 包用 `file:` shim 指回 harness 源码。

## 怎么做

把 `HARNESS` 设为 harness checkout 的 **`file://` URL**，然后把 `VERSION` 设为**当前 harness 版本**（`deepseek-harness/package.json` 的 `version`，例如 `0.1.7-rc.2`），在 profile 目录里执行：

> shim 的 `version` **不能随便写**：它要满足本插件 `peerDependencies` 里那条并集范围（`>=0.1.7-rc.1 <0.1.8-0`）。写成 `0.0.0` 之类的占位值，pnpm 会判定 peer 不满足，**再装一份 harness 包**——于是 profile 里出现两份模块实例，`agent-presets: refusing to compose an unscoped context` 那类失败就回来了。这些 shim 的存在意义正是"只留一份"。因此每次升级 harness 后跟着改这里的版本号。

```sh
HARNESS=file:///path/to/deepseek-harness   # 例如 file:///D:/repos/deepseek-harness
VERSION=0.1.7-rc.2                          # deepseek-harness/package.json 的 version
cd "$DSH_HOME/profiles/web" && mkdir -p shims
while IFS='|' read -r name rel; do
  mkdir -p "shims/$name"
  printf '{"name":"@deepseek-ai/%s","version":"%s","private":true,"type":"module","main":"index.mjs"}\n' \
    "$name" "$VERSION" > "shims/$name/package.json"
  printf "export * from '%s/%s'\nimport * as mod from '%s/%s'\nexport default mod.default\n" \
    "$HARNESS" "$rel" "$HARNESS" "$rel" > "shims/$name/index.mjs"
done <<EOF
cordis|vendor/cordis/src/index.ts
schemastery|vendor/schemastery/src/index.ts
dsh-agent|packages/core/agent/src/index.ts
dsh-agent-loop|packages/core/agent-loop/src/index.ts
dsh-scope|packages/core/scope/src/index.ts
dsh-session|packages/core/session/src/index.ts
dsh-session-persistence|packages/session/session-persistence/src/index.ts
dsh-settings|packages/settings/settings/src/index.ts
dsh-subprocess|packages/subprocess/subprocess/src/index.ts
dsh-timeout|packages/util/timeout/src/index.ts
dsh-llm|packages/llm/llm/src/index.ts
dsh-invariants|packages/runtime-diagnostics/invariants/src/index.ts
dsh-home-paths|packages/util/home-paths/src/index.ts
dsh-typert-protocol|packages/typert/protocol/src/index.ts
EOF
```

（`cordis` 与 `schemastery` 的版本号**不跟** `$VERSION`：它们有各自的版本，且必须满足插件的 peer 范围——`@deepseek-ai/cordis` 声明 `^4.0.1`、`@deepseek-ai/schemastery` 声明 `3.18.4`。）

再把 profile 的 `package.json` 指向它们并重装：

```sh
node -e 'const f="package.json",j=require("./"+f),d=j.dependencies??={}
for(const n of ["cordis","schemastery","dsh-agent","dsh-agent-loop","dsh-scope","dsh-session","dsh-session-persistence","dsh-settings","dsh-subprocess","dsh-timeout","dsh-llm","dsh-invariants","dsh-home-paths","dsh-typert-protocol"])
  d["@deepseek-ai/"+n]="file:./shims/"+n
require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")'
pnpm install
```

然后重启 `dsh web`。

> **这份清单必须跟住本插件 `package.json` 的 `peerDependencies`**：每新增一个 harness peer（例如为"会话级模型"引入的 `@deepseek-ai/dsh-typert-protocol`）就要在 shim 列表与上面那段 `node -e` 里各加一项，否则源码启动的 profile 会缺一个包。

### 子路径导出

若有东西加载 `@deepseek-ai/dsh-scope/invariant` 这类**子路径**，给该 shim 再补一个 `invariant.mjs`（`export * from '$HARNESS/packages/core/scope/src/invariant.ts'`）并在它的 `exports` 里加 `"./invariant": "./invariant.mjs"`。

## 不需要这一步的情况

把插件以本地 **`link:`** checkout 安装即可绕过：checkout 放在 harness 仓旁边时会继承 harness 自己的 `tsconfig.json`，于是拿到同一份 `paths` 映射。这个分裂只在**打包的插件**遇到**源码的 harness** 时出现。

## 相关

- 为什么要保证每个 `@deepseek-ai/*` 只有一份实例：`docs/architecture.md` 的构建/外部化一节。
- 插件的 peer 清单与版本对齐规则：`README.md` 的 Version compatibility 一节。
