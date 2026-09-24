# 提案：把 dsh 配置的模型端点与凭据交给托管引擎

> **目标**：让四个托管引擎（claude-code / codex / pi / kimi）不只是拿到 dsh 选中的**模型名**，而是真正跑到 **dsh 配置的那个模型端点**上——用 dsh 的 `baseURL` + 凭据 + 模型 id 去对话，而不是各 CLI 自己那份 provider 配置。
>
> **范围**：本提案是**调研 + 可行性判定 + 方案**，不改任何源码。落地主体在 `dsh-loop-engine`（`src/engine-*/` 的 spawn/env 组装、`src/driver-core/` 的新读取接缝），**不需要改主仓**（`deepseek-harness/` 只读）。
>
> **与既有提案的关系**：`per-session-model-for-hosted-engines.md`（下文简称「前篇」）解决的是"**模型名**怎么从会话选择送到引擎"（已落地：`src/driver-core/session-model.ts`，四个驱动每 step 消费）。本提案解决它的**后半截**：拿到模型名之后，引擎**用什么端点、什么凭据**去调这个模型。两篇正交，可以叠加。
>
> **行号基准**：本仓库自身检出（`0.1.5-rc3`）；主仓引用写作 `packages/...`，对照同级 `../deepseek-harness` 检出（harness `0.1.5-rc.2`）。本机 CLI 版本见 §7。

---

## 0.5 状态：已实现（0.1.5-rc5）

本提案的方案已在 `dsh-loop-engine` 落地，**未改主仓**。落点与本提案 §5 的差异如实记在下面：

- **共享解析**：`src/driver-core/model-handover.ts` 的 `resolveModelHandover(ctx, override)` 返回 `{ provider, model, baseURL, api, apiKey } | undefined`。签名比 §5.1 的草案收窄为**收 `override`（`sessionModelOverrideOf` 的结果）而不是 `session`**，这样每个驱动仍是一处读、一处判。
- **映射规则（比草案更严）**：provider → settings 地址**不再硬编 `llm-pi-ai` / `llm-deepseek`**，而是读 llm 注册表自己的**可配置 provider 目录**（`ctx.llm.listConfigurableProviders()`，`LlmConfigurableProvider.settingsNs` + `settingsPath`）。注册表/directory 缺席、或没有这条 provider → **不注入 + warn 一次**。profile 还必须给出非空 `baseURL` 与 `api`，否则同样不注入（草案没要求 `api` 必填、拿不准时倾向回退；落地取"缺 `api` 就不注入"，因为不猜协议）。
- **凭据**：`ctx.credentials.resolve(apiKeyEnv)`，seam 缺席或答空再回落 `process.env[apiKeyEnv]`。key 只进子进程 env / Pi 的 `0600` 目录文件 / argv，**不进日志、不进事件、不进 `request/header`、不进 warn 文案**。
- **warn 去重**：每 `(context, provider/model, 失败原因)` 只 warn 一次（步骤每轮重解析）。
- **逐引擎入口**：claude → `Options.env` 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`；kimi → 子进程 env `KIMI_MODEL_NAME`/`_API_KEY`/`_BASE_URL`/`_PROVIDER_TYPE`（`src/engine-kimi/model-handover.ts`），**有端点注入时跳过 `session/set_model`**（env model 已是默认，且 `set_model` 要的是 kimi 的 model alias 而不是裸 id）；pi → 插件自建 agent 目录（`src/engine-pi/model-handover.ts`，`os.tmpdir()/dsh-loop-engine-pi-agent/<hash>/models.json`，0700/0600，进程退出清理）+ `--provider`/`--api-key` + `PI_CODING_AGENT_DIR`；codex → `src/engine-codex/model-handover.ts` 产出 `-c model_provider="dsh"` + `-c model_providers.dsh={base_url,wire_api,env_key}` + env，并补上 **`AppServerClient.create(argv, env)`** 这条通路（`env` 是叠加在 `process.env` 之上；`config.env` 从此真正被消费）。
- **协议不匹配 → 引擎报错**（按用户裁决，覆盖 §5.2 里 codex "回退 + UI 说明"的建议）：codex 对 `anthropic-messages` **省略 `wire_api`**、用它自己的默认 wire 去请求 dsh 端点并报错；kimi 对无等价 type 的协议**省略 `KIMI_MODEL_PROVIDER_TYPE`**、退回 kimi 默认并报错。插件不假装支持、也不静默回退。
- **`subprocess` scrub 核实结论**：显式 `spec.env` **原样传到子进程**——`childEnv(extra)`（主仓 `packages/subprocess/subprocess-local/src/spawn.ts:46-56`）先取 `scrubbedParentEnv()` 再 `{ ...env, ...extra }`（Windows 上按大小写不敏感覆盖），所以 `SENSITIVE_ENV_PATTERN` 只清**父环境**里继承来的名字，显式传入的 `ANTHROPIC_AUTH_TOKEN`/`KIMI_MODEL_API_KEY` 不会被清掉。方案成立。（codex 驱动不走这个 seam，走 `{ ...process.env, ...env }`，所以它的父环境**没有**做凭据清理——与现状一致，但和 `Config.env` 注释说的 "credential-scrubbed" 不符。）

**已真机/真实栈验证到哪一步**：本仓库的 `typecheck` / `test:coverage`（per-file 100%）/ `build` 全绿；四个引擎各有"真实 dsh 模型 → 端点/凭据/模型都注入到该引擎入口 / `external` 或空不注入 / 解析不到不注入 + warn 一次 / 中途改端点生效"一组端到端测试（假 CLI / 假 SDK / 假 app-server 夹具），codex 的 `create(argv, env)` 通路另有单测。**未做**：对任何真实 dsh 端点发过模型调用；`codex app-server -c` 的实际解析行为、kimi env-model 与 `session/new` 的 `configOptions` 一致性、`ANTHROPIC_BASE_URL` 的路径前缀接受方式、pi 对最小 `models.json` 的接受与容量字段缺失的容忍度，**都未实测**（沿用 §7 的约束）。这几条是残留风险，真机首次启用时应逐条验证。

---

## 0. 结论速览

| 引擎 | 能否指向 dsh 端点 | 自动注入的方式 | wire 格式 | 能否全自动（不动用户 CLI 配置） |
|---|---|---|---|---|
| **pi** | **能** | env `PI_CODING_AGENT_DIR=<插件自建目录>`（内含 `models.json` 写死 `baseUrl`/`api`/`models`）+ `--provider` / `--model` / `--api-key` | pi-ai 协议，`openai-completions` 与 `anthropic-messages` **都支持** | **能**（自建 agent 目录，不碰 `~/.pi`） |
| **claude-code** | **能** | env `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`）；`Options.model` 传 id | 必须是 **Anthropic Messages**（`/v1/messages`） | **能**（纯 env + `Options.model`，无需改 `~/.claude`） |
| **codex** | **能** | `codex app-server -c model_provider=… -c model_providers.…={base_url,wire_api,env_key}` + env `env_key` 指向的 key | **必须是 OpenAI wire**：`responses` 或 `chat`（**不是** anthropic-messages） | **能**，但要先给 `AppServerClient.create()` 补 argv/env 通路（见 §3.3、§4.2 的缺口） |
| **kimi** | **能** | env `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` + `KIMI_MODEL_BASE_URL` + `KIMI_MODEL_PROVIDER_TYPE`（kimi 内置的 env-model 通路） | `KIMI_MODEL_PROVIDER_TYPE ∈ {kimi, anthropic, openai}`，可匹配 anthropic-messages | **能**（纯 env，不碰 `~/.kimi-code/config.toml`） |

**一句话结论**：**四个引擎都能被指向 dsh 的端点，而且都能全自动**——三条走纯 env（claude / kimi），一条走"插件自建配置目录 + env"（pi），一条需要先补一个 argv/env 通路（codex）。**唯一真正的格式门槛在 codex**：它只认 OpenAI 的 `responses`/`chat`，dsh 把 `meicloud` 配成了 `anthropic-messages`——同一个 LiteLLM 网关大概率两种都开，但这条**必须实测**（本提案受"不发模型调用"约束，未测）。

---

## 1. 现状：我们只传了模型名

四个驱动都在"每 step 把会话选择透传给引擎"（前篇 §0）：pi `--model <provider>/<model>`（`src/engine-pi/agent.ts:519-543`）、claude `Options.model`（`src/engine-claude/sdk.ts:102`）、codex thread `model`、kimi ACP `session/set_model`。**凭据与端点一概没给**：每个引擎仍用自己那份 provider 配置：

- pi：`~/.pi/agent/models.json` 的 `providers.meicloud.{baseUrl,apiKey,api}`（明文 key）；
- codex：`~/.codex/config.toml` 的 `[model_providers.custom]{base_url,wire_api,requires_openai_auth}`；
- kimi：`~/.kimi-code/config.toml` 的 `[providers.meicloud]{type,base_url,api_key}`；
- claude：环境里的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_*`（或官方默认端点）。

所以"给不给 dsh 模型"这件事，今天实际是"**引擎能不能在它自己的 provider 表里找到这个模型名**"——和我们想表达的语义（用 dsh 那份端点+凭据）不是一回事。

---

## 2. dsh 这一侧知道什么、插件能不能读到（问题 B）

### 2.1 provider 配置的位置与形状

dsh 的 provider 定义在**用户设置文档** `$DSH_HOME/settings.yaml`，由 `llm-pi-ai` 插件消费：

```yaml
llm-pi-ai:
  providers:
    meicloud:
      apiKeyEnv: MEICLOUD_API_KEY      # 凭据引用（环境变量名），值不在文档里
      api: anthropic-messages          # wire 协议
      baseURL: https://ai.meicloud.com/litellm
      models:
        - id: 6dd28e9b/custom_openai/deepseek-v4-flash-deepseek
          name: 6dd28e9b/custom_openai/deepseek-v4-flash-deepseek
          contextWindow: 1000000
          maxTokens: 384000
          reasoningEfforts: { off: , low: low, high: high, max: max }
    anyai:
      apiKeyEnv: ANYAI_API_KEY
      api: openai-completions
      baseURL: https://anyai.com/v1
      models: [...]
```

对应的 schema 是 `packages/llm/llm-pi-ai/src/config.ts:91-182`（`PiAiProviderProfile`）与 `:322-345`（`profile` 对象）。命名空间常量 `NS = 'llm-pi-ai'`（`packages/llm/llm-pi-ai/src/index.ts:93`），base bundle 也把这条写进了注释（`packages/bundle/base/cordis.patch.yml:88,107-108`）。

另有 `llm-deepseek` 插件，命名空间 `llm-deepseek`，形状更简单：`{ apiKeyEnv, baseURL, models }`（`packages/llm/llm-deepseek/src/index.ts:134-139,187-189`）。同一套读法适用。

### 2.2 端点、协议、模型：**可读**

设置服务是**命名空间无关**的：

- `SettingsProvider.get(ns): unknown` —— "Read one registered namespace's resolved value"（`packages/settings/settings/src/index.ts:540-548`）；
- `SettingsProvider.describe(options?): SettingsDescriptor[]` —— 每个已注册 ns 的 `{ns, schema, value, base, user, revision}`（`:498-538`）。

插件的 `ctx.get('settings')` 已经是它在用的接缝（`src/index.ts:460`、`:656-657`），只是今天只用来 `mutate`/`describe`（插件侧形状 `SettingsMutator`，`src/driver-core/host-servers.ts:42-56`）。读另一个 ns 的 `value` 或 `get('llm-pi-ai')` 就能拿到 `providers.<route>.{baseURL, api, models, apiKeyEnv}`。

> **耦合风险**：`get()` 返回 `unknown`，插件要自己按结构校验（`meicloud` 可能是 `llm-pi-ai`，也可能是 `llm-deepseek`，字段名不同）。这是"读别人的私有 ns"，主仓没有任何契约保证——**要在插件侧写成防御式读取 + 读不到就优雅回退**，并在文档里写明这层耦合。

### 2.3 凭据：**可读，但必须走 credential seam，不在 process.env 里**

`apiKeyEnv` 是 `CredentialRef`（环境变量**名**），值存在 `$DSH_HOME/.credentials.yaml`。base bundle 的注释明说这份文档 **never materialized into the process environment**（`packages/bundle/base/cordis.patch.yml:83-93`）。

解析通路：
- 服务定义 `ctx.credentials: CredentialProvider`（`packages/credentials/credentials/src/index.ts:149-151`），
- `resolve(ref): Promise<ResolvedCredential | undefined>` 返回 `{ value, source }`（`:176-183`，接口在 `:117-121`）；
- 官方用法见 `packages/llm/llm-pi-ai/src/index.ts:168-191`（`resolveApiKey`：`ctx.get('credentials')` → `credentials.resolve(ref)?.value`，缺失则 loud 抛 `MISSING_CREDENTIAL`）。

插件的 `inject` 是空数组（`src/index.ts:91`），走 `ctx.get(...)` 惰性取服务——所以读 `ctx.get('credentials')` 与现有风格一致。**注意**：插件 `package.json` 里没有 `@deepseek-ai/dsh-credentials`，若要 `import { credentialRef }` 需要加一个 peer（或者直接传字符串，运行时 `resolve` 只认名字）。

### 2.4 协议：`llm-pi-ai` 支持三件套

`packages/llm/llm-pi-ai/src/provider.ts:47-51`：

```ts
const PROTOCOLS = {
  'openai-completions': openAICompletionsApi,
  'openai-responses':   openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
}
```

而 `anthropicMessagesApi` 在 pi-ai 里 POST 到 `/v1/messages`（pi-ai bundle：`this._client.post("/v1/messages", …)`）。所以 dsh 把 `meicloud` 配成 `api: anthropic-messages` 于 `https://ai.meicloud.com/litellm`，等价于说：**这个网关在 `<baseURL>/v1/messages` 上提供 Anthropic Messages 协议**。这是判断 claude 可行性的关键证据（§3.2）。

`ctx.llm` 注册表本身**不暴露**端点/凭据：`LlmProviderInfo` 只有 `{id, name}`，`LlmResolvedModelInfo` 也不含 baseURL。所以**读端点只能走 §2.2 的设置文档，读凭据只能走 §2.3 的 credential seam**，不能指望 llm 注册表。

### 2.5 给子进程注入 env：四引擎的现状

- **pi**：`spawnSpec()` 产出 `env: this.config.env`（`src/engine-pi/agent.ts:533-543`，env 在 `:541`），经 `piSubprocessSpec`（`src/engine-pi/loop.ts:94-102`）走 dsh subprocess seam。subprocess seam 的 `env` 是"**merge onto scrubbed parent base**"（`packages/subprocess/subprocess/src/types.ts:97-104`）。→ 通路成立。
- **kimi**：`spawnSpec()` 同形（`src/engine-kimi/agent.ts:507-514`，env 在 `:511`），经 `kimiSubprocessSpec`（`src/engine-kimi/process.ts:79-88`）。→ 通路成立。
- **claude**：`claudeQueryOptions` 把 `{...scrubbedParentEnv(), ...spec.env}` 交给 SDK 的 `Options.env`（`src/engine-claude/sdk.ts:87-90`），再由 `sdkEnvironmentOverlay` 转成完整 overlay（`src/engine-claude/process.ts:32-40`）。`spec.env` 就是 `this.config.env`（`src/engine-claude/agent.ts:585`）。→ 通路成立（且 SDK `Options.env` 是"**REPLACE** 整个子进程环境"，所以我们已经是显式 overlay 语义，见 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1435-1453`）。
- **codex**：**缺口**。`AppServerClient.create()` 用裸 `spawn` 拉 `codex app-server`，**既没传 `env` 也没传 `-c`**：

  ```ts
  // src/engine-codex/appserver/client.ts:88-95
  static async create(): Promise<AppServerClient> {
    const proc = spawn(process.execPath, [codexCliEntrypoint(), 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    ...
  }
  ```

  而 `ResolvedConfig.env` 是存在的（`src/engine-codex/loop.ts:52-53,62,71`），**却没有任何消费者**（`grep -rn "config.env" src/engine-codex/` 只命中 `loop.ts:71` 的解析本身）。codex 驱动也**不走 subprocess seam**（`src/engine-codex/loop.ts:6-8` 注释明说 "no spawn injection seam"）。→ **要自动注入，必须先给 `AppServerClient.create()` 加 `argv`（`-c …`）与 `env` 参数**。

---

## 3. 逐引擎事实（问题 A）

### 3.1 pi（`@earendil-works/pi-coding-agent@0.84.3`）

**CLI 入口**（`pi --help` 实测）：`--provider <name>`（默认 google）、`--model <pattern>`（支持 `provider/id` 与 `:<thinking>`）、`--api-key <key>`（defaults to env vars）、`--list-models`。**没有** `pi provider` / `pi models` 子命令（两者都回落打印顶层 help）。

**自定义 provider 在哪**：`~/.pi/agent/models.json`（`piConfig.configDir = ".pi"`；agent 目录解析见 pi bundle 的 `getAgentDir()`，`modelsPath: join(agentDir, "models.json")`）。本机该文件的形状（**key 已打码**）：

```json
{
  "providers": {
    "meicloud": {
      "baseUrl": "https://ai.meicloud.com/litellm",
      "api": "openai-completions",
      "apiKey": "sk-<redacted>",
      "models": [ { "id": "deepseek-flash", "name": "DeepSeek Flash",
                    "contextWindow": 1000000, "maxTokens": 384000,
                    "input": ["text","image"], "reasoning": true,
                    "compat": { "thinkingFormat": "deepseek", … } } ]
    }
  }
}
```

schema（pi bundle 内 typebox `ProviderConfigSchema`）：`{ name?, baseUrl?, apiKey?, api?, oauth?, headers?, compat?, authHeader?, models?, modelOverrides? }`。`api` 是**自由字符串**（pi-ai 认 `openai-completions` / `anthropic-messages` 等）。**没有 `apiKeyEnv`**——自定义 provider 的 key 只能是字面量 `apiKey`，或用 CLI `--api-key` 覆盖（pi bundle：`--api-key` → `result.apiKey`；`apiKey = options?.apiKey ?? auth.apiKey`）。

**能否只靠 env 给出 base URL**：**不能**。`PI_*` 里没有 base URL 变量（唯一像的 `PI_BASE_URL` 是 `GEMINI_NEXT_GEN_API_BASE_URL` 的子串，误报）。但有两个可用的 env：
- `PI_CODING_AGENT_DIR`（bundle：`ENV_AGENT_DIR = `${APP_NAME}_CODING_AGENT_DIR``，`getAgentDir()` 优先取它）——**重定向整个 agent 目录**（models.json / auth.json / settings.json 都在里面）；
- `--api-key` 覆盖 key，避免把密钥落到磁盘。

**`--model provider/id` 里的 provider 是否必须已存在**：是。provider 必须能在 `models.json`（或内置 catalog）里解析出 `baseUrl`/`api`，否则 pi 会报找不到 provider/model。

### 3.2 claude-code（`@anthropic-ai/claude-agent-sdk@0.3.220`）

**SDK 入口**：`Options.env?: { [k: string]: string | undefined }`（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1435-1453`）。文档明说这是**整体替换**子进程环境，不是 merge；并直接点名 `ANTHROPIC_API_KEY` 是要自行 spread 的变量之一。SDK 面**没有** `baseUrl`/`apiKey` 顶层字段，端点/凭据只能走 env。`Options.model?: string`（前篇已引，`sdk.d.ts:1710-1713`）接受别名或完整 id。

**CLI/SDK 是否尊重这些 env**：是。SDK 包里 `grep -rho "ANTHROPIC_[A-Z_]*"` 命中 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 等（还有 `ANTHROPIC_CUSTOM_HEADERS`、`ANTHROPIC_DEFAULT_*_MODEL`）。

**端点必须是 Anthropic Messages 吗**：是。claude CLI/SDK 说 `/v1/messages`，`baseURL` 之下的路径由客户端自己拼。→ 对应 dsh 的 `api: anthropic-messages`，**恰好匹配**（§2.4）。

### 3.3 codex（`@openai/codex@0.149.1`）

**CLI 入口**：顶层 `-c, --config <key=value>`（dotted path override，value 按 TOML 解析）、`-m/--model`、`-p/--profile`。**`codex app-server` 同样收 `-c`**（`codex app-server --help` 实测）。

**provider 形状**：`~/.codex/config.toml`：`model_provider = "<id>"` + `[model_providers.<id>]{ name, base_url, wire_api, requires_openai_auth }`。本机现状（key 未写进 config，走 auth/env）：

```toml
model_provider = "custom"
model = "6dd28e9b/custom_openai/deepseek-v4-flash-deepseek"
[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://ai.meicloud.com/litellm"
```

codex.exe 的字段名表（`grep -a` 命中）：`base_url`、`env_key`、`env_key_instructions`、`experimental_bearer_token`、`auth`、`aws`、`wire_api`、`query_params`、`http_headers`、`env_http_headers`、`requires_openai_auth`。→ provider 支持 **`env_key`**（"key 从哪个环境变量读"）与 `env_http_headers`，所以凭据可以**只走 env**。

**纯 env（`OPENAI_BASE_URL`/`OPENAI_API_KEY`）够不够**：不够通用。binary 里 `OPENAI_BASE_URL` 只出现 1 次、`OPENAI_API_KEY` 22 次——那是**内置 openai provider**的 ambient discovery，够不到自定义 provider。要把 codex 指向任意网关，必须写 `model_providers.<id>`（可写在 config.toml，或用 `-c` 覆盖）。

**wire 格式**：只有 `responses`（OpenAI Responses）或 `chat`（OpenAI Chat Completions）。**不接受 Anthropic Messages**。→ 与 dsh 的 `meicloud: anthropic-messages` 不同源；但本机 codex 已用 `wire_api = "responses"` 打同一个 `base_url`，说明该 LiteLLM 网关**很可能**同时提供 `/v1/responses`。**未实测**（本提案不发模型调用）。

### 3.4 kimi（`kimi acp`，本机 `kimi-code` 内嵌源码）

**CLI 入口**：顶层 `-m/--model <model>`（"LLM model alias … Defaults to default_model in config.toml"）；`kimi acp` **只有** `--login`/`--region`（无模型入口）；`kimi provider` 子命令：`add <url>`（导入自定义 registry api.json）、`remove`、`list`、`catalog`。

**内置的 env-model 通路（关键）**：`kimi.exe` 内嵌源码里有一个 `applyEnvModelConfig(config, env)`，在配置加载时调用（在 `init_env_model` 区块，紧邻 `init_secondary_model`）。**当 `KIMI_MODEL_NAME` 存在时**，它把一个 provider + 一个 model alias 叠到 config 上，并把 `defaultModel` 指向该 alias：

```js
// kimi.exe 内嵌源码（core packages/node-sdk/src/config/env-model.ts）
function applyEnvModelConfig(config, env = process.env) {
  const model = trimmed(env["KIMI_MODEL_NAME"]);
  if (model === undefined) return config;
  const apiKey = trimmed(env["KIMI_MODEL_API_KEY"]);
  if (apiKey === undefined) fail("KIMI_MODEL_NAME is set but KIMI_MODEL_API_KEY is missing.");
  const type = parseProviderType(trimmed(env["KIMI_MODEL_PROVIDER_TYPE"])); // 默认 "kimi"
  const baseUrl = trimmed(env["KIMI_MODEL_BASE_URL"]) ?? DEFAULT_BASE_URL[type];
  ...
  return validateConfig({ ...config,
    providers: { ...config.providers, [ENV_MODEL_PROVIDER_KEY]: { type, apiKey, baseUrl } },
    models:    { ...config.models,    [ENV_MODEL_ALIAS_KEY]: alias },
    defaultModel: ENV_MODEL_ALIAS_KEY });
}
// ENV_MODEL_PROVIDER_KEY = "__kimi_env__"; ENV_MODEL_ALIAS_KEY = "__kimi_env_model__"
// ALLOWED_TYPES = ["kimi","anthropic","openai"];  DEFAULT_BASE_URL = { kimi: "...moonshot.ai/v1", openai: "...openai.com/v1" }
```

其余可用的 env：`KIMI_MODEL_MAX_CONTEXT_SIZE`、`KIMI_MODEL_MAX_OUTPUT_SIZE`、`KIMI_MODEL_CAPABILITIES`、`KIMI_MODEL_DISPLAY_NAME`、`KIMI_MODEL_REASONING_KEY`、`KIMI_MODEL_ADAPTIVE_THINKING`、`KIMI_MODEL_THINKING_EFFORT`。→ **kimi 可以纯靠 env 指向任意端点/凭据/模型，不改 `config.toml`**。

**配置文件通路（备选）**：`~/.kimi-code/config.toml` 的 `[providers.<id>]{ type, base_url, api_key }` + `[models."<alias>"]{ provider, model, … }`。kimi 还支持**凭据走 env**：provider 可写 `api_key_env = "<ENVNAME>"`（内嵌错误文案："`Provider "X" declares api_key_env = "ENV" in config.toml, but the environment variable is not set or is empty.`"），且与 `api_key` 互斥。`kimi provider add <url>` 是导入 registry（非本提案所需）。

**home 可重定向**：`KIMI_CODE_HOME` 覆盖默认 home（内嵌 `defaultHomeDir`：`const override = env["KIMI_CODE_HOME"]; if (override …) return override; return join(homedir(), ".kimi-code")`）。驱动侧已有同名读取（`src/engine-kimi/process.ts:47-50`）。

**`session/set_model` 的 modelId 从哪来**：前篇已确认 `session/new` 的响应里带 `configOptions`（`id: "model"` 的 select 罗列可用模型），`session/set_model { sessionId, modelId }` 是会话级选择。kimi 的 env-model 会把 `defaultModel` 设成 env alias（`__kimi_env_model__`），所以**只要不显式 `set_model` 到别的值，env 模型就是默认**；这与驱动"只在会话选了真实 dsh 模型时才下发 `set_model`"是兼容的。

---

## 4. 逐引擎可行性表（问题 C）

> "能否自动做" = 插件能不能**不加用户手工改 CLI 配置**地把引擎指到 dsh 端点。

| 引擎 | 能否指向 dsh 端点 | 需要什么（env / 配置 / 参数） | wire 是否匹配 | 能自动做吗 | 缺什么才做不到 |
|---|---|---|---|---|---|
| **pi** | ✅ 能 | env `PI_CODING_AGENT_DIR=<自建目录>`（目录内 `models.json` 写 `providers.dsh.{baseUrl,api,models}`；或用 seam 落一份）；argv `--provider dsh --model dsh/<id>`；key 用 `--api-key <k>` 或写进该 `models.json` | ✅ 两种都有：`openai-completions` 与 `anthropic-messages` | ✅ **能**（自建 agent 目录，不碰 `~/.pi`） | 只需实现：每 step 算出 `env`+argv（今天 env 直接取 `config.env`，`src/engine-pi/agent.ts:541`），并管理一个临时目录的生命周期 |
| **claude-code** | ✅ 能 | env `ANTHROPIC_BASE_URL=<baseURL>` + `ANTHROPIC_AUTH_TOKEN=<key>`（或 `ANTHROPIC_API_KEY`）；`Options.model=<id>` | ✅ **恰好匹配**：dsh `meicloud` 就是 `anthropic-messages`，pi-ai 打 `<baseURL>/v1/messages` | ✅ **能**（纯 env + `Options.model`） | 只需实现：每 step 把这两个 env 叠进 `spec.env`（`src/engine-claude/sdk.ts:87-90` 已支持层叠） |
| **codex** | ✅ 能（前提：网关提供 OpenAI wire） | `codex app-server -c model_provider=dsh -c 'model_providers.dsh={base_url="…",wire_api="responses",env_key="DSH_ENGINE_API_KEY"}'`；env `DSH_ENGINE_API_KEY=<key>` | ⚠️ **必须是 `responses`/`chat`**，**不接受** anthropic-messages。dsh 的 `meicloud` 配成 anthropic-messages，**未证实**该网关也开 OpenAI wire（本机 codex 用 `responses` 打同一 base_url，是强旁证） | ✅ 能，**但缺一个通路** | 缺：`AppServerClient.create()` 目前**不收 argv/env**（`src/engine-codex/appserver/client.ts:88-95`）。补上 `-c` 参数与 env 即可；另需**实测**确认网关的 `responses`/`chat` |
| **kimi** | ✅ 能 | env `KIMI_MODEL_NAME=<id>` + `KIMI_MODEL_API_KEY=<key>` + `KIMI_MODEL_BASE_URL=<baseURL>` + `KIMI_MODEL_PROVIDER_TYPE=anthropic`（或 `openai`） | ✅ `PROVIDER_TYPE ∈ {kimi,anthropic,openai}`，`anthropic` 对上 anthropic-messages | ✅ **能**（纯 env 的 env-model 通路） | 只需实现：每 step 把这几个 env 叠进 `config.env`（`src/engine-kimi/agent.ts:511`）。**可选**用 `KIMI_CODE_HOME` 隔离，但那会丢掉用户的登录/skills，非必要 |

---

## 5. 建议方案

### 5.1 共同的读取接缝（`src/driver-core/`）

新增一个引擎无关函数，把"本会话要用的 dsh 模型端点+凭据"解析成一个结构：

```ts
/** dsh provider 配置解析出的端点事实，四个驱动共用。 */
export interface DshModelEndpoint {
  readonly baseURL: string
  /** dsh 的 wire 协议（llm-pi-ai 的 PROTOCOLS 之一，或 llm-deepseek 的隐含值）。 */
  readonly api: string
  readonly apiKey: string
  readonly model: string
}

/**
 * 从当前会话选择 + dsh 设置/凭据接缝解析端点。
 * 选择是真实 dsh provider（非托管标签）时才解析；读不到就返回 undefined，
 * 让引擎退回它自己的原生配置（今天的行为）。
 */
export async function resolveDshModelEndpoint(ctx: Context, session: Session): Promise<DshModelEndpoint | undefined>
```

实现要点：
1. `sessionModelOverrideOf(ctx, session)`（`src/driver-core/session-model.ts:101-107`）拿到 `{provider, model}`；`undefined` 则整体返回 `undefined`（保持"引擎自己决定"）。
2. `ctx.get('settings')` → `get('llm-pi-ai')`（或 `describe()` 找该 ns），从 `providers[provider]` 读 `baseURL`/`api`/`apiKeyEnv`；读不到改试 `'llm-deepseek'`（`{baseURL, apiKeyEnv}`）。**全部做结构校验**，任何形状不符 → 返回 `undefined` + 一次 warn（不抛）。
3. `ctx.get('credentials')?.resolve(credentialRef(apiKeyEnv))?.value` 取 key；无 seam / 无值时回退 `launchEnvironment`/`process.env[apiKeyEnv]`（与 `llm-pi-ai/src/index.ts:168-191` 同款），仍无 → `undefined` + warn。
4. 每个驱动**每 step 调一次**（与它们读模型选择的粒度一致），所以中途换模型/换 provider 下一步生效。

> **为什么不用 `ctx.llm`**：`LlmProviderInfo`/`LlmResolvedModelInfo` 不含端点与凭据（§2.4），注册表读不到。设置文档 + credential seam 是唯二通路。

### 5.2 各引擎的接线（都在既有 env 通路上加一层）

- **claude-code**（最简单，优先做）：`src/engine-claude/agent.ts:576-590` 取 `endpoint` 后，把 `env` 从 `this.config.env` 改成 `{ ...this.config.env, ANTHROPIC_BASE_URL: endpoint.baseURL, ANTHROPIC_AUTH_TOKEN: endpoint.apiKey }`，`model` 用 `endpoint.model`。`sdk.ts` 无需改（已层叠）。**注意**：claude 的 `Options.env` 是整体替换，`sdk.ts:87-90` 已经把 `scrubbedParentEnv()` 铺底，叠加安全。
- **kimi**：`src/engine-kimi/agent.ts:507-514` 的 `env` 改成 `{ ...this.config.env, KIMI_MODEL_NAME: endpoint.model, KIMI_MODEL_API_KEY: endpoint.apiKey, KIMI_MODEL_BASE_URL: endpoint.baseURL, KIMI_MODEL_PROVIDER_TYPE: (endpoint.api === 'anthropic-messages' ? 'anthropic' : 'openai') }`。可选再给 `KIMI_MODEL_MAX_CONTEXT_SIZE` 等。**不要**改 `session/set_model` 逻辑（env-model 已是默认）。
- **pi**：`src/engine-pi/agent.ts:519-543` 的 `spawnSpec()` 改成异步或在 step 头部预解析 `endpoint`，然后：`--provider`/`--model` 用 endpoint 的（`--model <provider>/<id>`，provider 与 `models.json` 里自建的名字一致）、`--api-key <key>`，并把 `env` 加上 `PI_CODING_AGENT_DIR=<插件管理的临时目录>`。临时目录里放一份只含 `{ providers: { <name>: { baseUrl, api, models } } }` 的 `models.json`（api：`openai-completions` 或 `anthropic-messages` 二选一，按 `endpoint.api`）。目录按"provider 集合的哈希"缓存、进程退出清理。
- **codex**：先给 `AppServerClient.create()` 加参数 `{ argv?: string[]; env?: NodeJS.ProcessEnv }`（`src/engine-codex/appserver/client.ts:88-95`），透传 `spawn(..., { env })` 与 `codexCliEntrypoint(), 'app-server', ...argv`；`src/engine-codex/agent.ts:205-212` 在创建时用 endpoint 生成 `-c` 数组与 env。**wire_api 的选择是硬约束**：`endpoint.api === 'openai-responses'` → `responses`；`'openai-completions'` → `chat`；`anthropic-messages` → **无法直接服务**，此时要么报错要求部署给一个 OpenAI 兼容路由，要么让它回退到 codex 自己的配置（推荐：回退 + UI/日志说明）。

### 5.3 方案分层

| 分类 | 内容 |
|---|---|
| **能自动做的** | claude（env）、kimi（env）、pi（自建目录 + env + `--api-key`）、codex（补 `create(argv,env)` 后 `-c` + env）——前提是 dsh 端点与引擎 wire 匹配 |
| **需要用户/部署侧配合的** | ① codex 需要一个 **OpenAI `responses`/`chat`** 的网关（dsh 今天把 `meicloud` 声明为 anthropic-messages，需确认网关也开 OpenAI wire，或让部署额外配一条 OpenAI 路由）；② 用户在 UI 里选的模型必须是**真实 dsh provider 的模型**（如 `meicloud/…`），而不是托管占位 `external/default`——否则驱动拿不到 `{provider, model}`，只能躺回引擎原生配置 |
| **当前做不到的** | ① **不保证**：codex 走 anthropic-messages 端点（协议不兼容）；② **不保证**：dsh 端点是"自研格式"时任何引擎都未必能直连（今天的所有 provider 都是 openai/anthropic 兼容，非自研）；③ **不保证**：把端点注入后引擎真的调用成功（网关是否接受该模型名/协议版本只有实跑才知道——本提案受约束未测） |

### 5.4 与"透传"的取舍

今天的透传（前篇）把 `provider/model` 直接塞给引擎，引擎用它**自己那份** provider 配置。本提案的价值是把"那份配置"换成 dsh 的。两者叠加时要注意：**pi 的 `--model` 复合串里的 provider 名**与**插件自建 `models.json` 里的 provider 名**必须一致（否则 pi 找不到 provider）。建议自建目录里的 provider key 就用 dsh 的 provider 名（`meicloud`），`--model meicloud/<dsh 模型 id>`，`--provider meicloud`。

---

## 6. 风险与未验证项

- **读别人的私有 ns**（§2.2）：`llm-pi-ai` / `llm-deepseek` 的配置形状是本插件的**隐式契约**；主仓可自由重命名字段。**必须**防御式读 + 读不到优雅回退 + 日志说明，且文档里写明这层耦合。
- **凭据泄露面**：把 key 注入子进程 env 后，key 会出现在子进程环境里（pi 还会出现在 argv 的 `--api-key`，可用 `models.json` 落盘的临时目录替代以避开 argv）。临时目录要 `0600` + 退出清理（pi 的 `models.json` 用字面 `apiKey` 时）。
- **codex 的 wire 不兼容**（§3.3）是**唯一的硬门槛**，且**必须实测**：对着 dsh 的 `meicloud` baseURL 发一次 `codex exec` 级别的**真实请求**（本轮不允许），或至少用一个非流式的 `/v1/responses` 探活。若网关只开 anthropic，codex 这条路就断了（除非部署加一条 OpenAI 路由）。
- **claude 的 baseURL 路径**：Anthropic 客户端自己拼 `/v1/messages`，`ANTHROPIC_BASE_URL` 要填到"路径前缀"那一层。dsh 的 `baseURL` 与 pi-ai 用的**同一个**值（`https://ai.meicloud.com/litellm`），pi-ai 也是拼 `/v1/messages`——所以直填同一值应当对，但**建议实测一次**确认网关对 `/<prefix>/v1/messages` 的接受方式。
- **未验证**：kimi 的 env-model 与 `session/new` 的 `configOptions` 是否一致（env alias `__kimi_env_model__` 是否出现在模型 select 里）；若不一致，驱动"只在选了真实 dsh 模型时 `set_model`"的策略可能需要微调。
- **进程/环境隔离**：pi 走 `PI_CODING_AGENT_DIR` 会**丢掉用户 `~/.pi` 里的 skills/auth/theme**——若引擎还需要这些，应改为**复制**用户目录后在副本上覆盖 `models.json`，而不是全量重定向。
- **未验证**：`ctx.settings.get('llm-pi-ai')` 在插件读的那一刻是否**已注册**（settings 服务从自己的 inject 回调挂载，时序有竞态——插件现有代码已为此重试，见 `src/index.ts:454-474` 的 `agent-presets` 处理）。读不到时按"回退到引擎原生配置"处理。

---

## 7. 本次调研实际跑过的命令

| 命令 | 结果摘要 |
|---|---|
| `pi --help` | 有 `--provider` / `--model`（`provider/id` + `:<thinking>`）/ `--api-key` / `--list-models`；**无** `provider`/`models` 子命令 |
| `pi provider --help` / `pi models --help` | 都回落打印顶层 help（不是子命令） |
| `pi --list-models` | 表格 `provider model context max-out thinking images`，一条 `meicloud deepseek-flash` |
| 读 `~/.pi/agent/models.json` | 自定义 provider：`{baseUrl, api:"openai-completions", apiKey:"sk-<redacted>", models:[…]}` |
| 读 pi bundle（`dist/bundle/chunks/*.js`） | `getAgentDir()` 认 `PI_CODING_AGENT_DIR`；`modelsPath=join(agentDir,"models.json")`；`ProviderConfigSchema = {name?,baseUrl?,apiKey?,api?,oauth?,headers?,compat?,authHeader?,models?,modelOverrides?}`；`--api-key` → `result.apiKey` |
| `claude --help` | 顶层可执行；SDK 里含 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`（`grep -rho "ANTHROPIC_[A-Z_]*"`） |
| 读 `@anthropic-ai/claude-agent-sdk/sdk.d.ts` | `Options.env`（`:1435-1453`，整体替换语义，文档直接点名 `ANTHROPIC_API_KEY`）；`Options.model`（`:1710-1713`） |
| 读 pi-ai bundle | `anthropicMessagesApi` POST `/v1/messages`；`anthropic-messages` 协议存在 |
| `codex --help` / `codex app-server --help` | 顶层与 app-server 都有 `-c, --config <key=value>`（dotted path）；顶层有 `-m/--model`；`codex app-server generate-json-schema` 存在 |
| 读 `~/.codex/config.toml` | `model_provider="custom"` + `[model_providers.custom]{name,wire_api="responses",requires_openai_auth=true,base_url=…}` |
| `grep -a` 扫 codex.exe | 字段名表含 `base_url` / `env_key` / `wire_api` / `env_http_headers` / `experimental_bearer_token` / `requires_openai_auth`；`OPENAI_BASE_URL` 仅 1 处 |
| `kimi --help` / `kimi provider --help` / `kimi provider list` | 顶层有 `-m/--model`；`provider` 只有 add/remove/list/catalog；本机 `meicloud type=openai models=1 source=inline` |
| 读 `~/.kimi-code/config.toml` | `[providers.meicloud]{type="openai",base_url,api_key}` + `[models."6dd28e9b/…"]{provider,model,…}` |
| python 扫 `kimi.exe` 内嵌源码 | `applyEnvModelConfig`（`KIMI_MODEL_NAME`/`KIMI_MODEL_API_KEY`/`KIMI_MODEL_BASE_URL`/`KIMI_MODEL_PROVIDER_TYPE`，`ALLOWED_TYPES=[kimi,anthropic,openai]`）；provider 支持 `api_key_env`；`KIMI_CODE_HOME` 覆盖 home（`defaultHomeDir`） |
| 读 `~/.dsh/settings.yaml`（结构，值打码） | `llm-pi-ai.providers.{meicloud,anyai}.{apiKeyEnv,api,baseURL,models}` |
| 读 `~/.dsh/.credentials.yaml`（结构，值打码） | `refs.DEEPSEEK_API_KEY` / `MEICLOUD_API_KEY` / `ANYAI_API_KEY` |
| 读主仓 `packages/llm/llm-pi-ai/src/{config,provider,index,auth}.ts`、`packages/llm/llm-deepseek/src/index.ts`、`packages/settings/settings/src/index.ts`、`packages/credentials/credentials/src/index.ts`、`packages/subprocess/subprocess/src/types.ts`、`packages/bundle/base/cordis.patch.yml` | 见 §2 各条引文 |

**未跑**（受"只读、不发模型调用、不登录、不改 CLI 配置"约束）：对 dsh 端点发任何真实模型请求（因此 codex 的 `responses` 兼容性、claude 的 `/<prefix>/v1/messages` 接受方式、kimi env-model 的 `configOptions` 一致性均为**待实测**）。

---

## 8. 明确不做的事

- **不把密钥写进日志/会话**。端点与凭据只进子进程 env（或 `0600` 临时文件），不进 session log、不进 `request/header`。
- **不修改用户 CLI 的配置**：不写 `~/.pi`、`~/.codex`、`~/.kimi-code`（pi 用自建 agent 目录；kimi/codex 用 env/`-c`）。
- **不发明新协议适配层**：只做"把 dsh 的 `{baseURL, api, apiKey, model}` 翻译成各引擎已有的入口"。dsh 端点不是三大 wire 之一时，宁可回退到引擎原生配置，也不硬塞。
- **不动主仓**：所有读取都走 `ctx.settings` / `ctx.credentials` 这两个既有接缝；`llm-pi-ai` 若未来想提供"按 provider 暴露端点"的正式 API，那是主仓侧的事，本提案不等它。
