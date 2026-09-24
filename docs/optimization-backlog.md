# dsh-loop-engine 优化清单（Optimization Backlog）

面向**将来接手本插件的人**。本文把这一长串迭代里累积下来的、尚未真机验证的项、已知取舍、行为上还不诚实/不彻底的地方、工程债，以及两条依赖主仓的提案，收拢成**一份可逐条执行的清单**。每条都是**独立可执行、独立可验证**的一个小批，编号 `BL-xx` 供引用。

事实来源以**当前工作区状态**为准（`0.1.5-rc` 系列，`src/` 与 `docs/` 均按此刻检出核验）。文中的 `file:line` 除特别说明外**相对本仓库根**；主仓文件相对 `../deepseek-harness/`。标注「**待核实**」的，是尚未用命令核过、只依代码阅读得出的判断，落地前请先验。

## 怎么用这份清单

1. **先做 P0（BL-01~BL-04）**。这四条是「端点/模型透传到底能不能用」的判据，任何一条不成立，整条透传链在真机上就是不可靠的；其余项都排在它们之后。
2. **逐条开小批，一次只碰一个 `BL-xx`**。每条自带「证据 / 修法草案 / 验收标准」，可以单独建分支、单独评审。
3. **每批过门槛**：`pnpm run typecheck`、`pnpm run test`、`pnpm run test:coverage`（`src/**` per-file 100%）、`pnpm run build` 全绿。改动文档引用后，按 BL-13 的脚本再核一次引用。
4. **P0 的每一条还要过一次真机**：清单里的「怎么验」就是那一小步；验不过就按「验不过时怎么退」处理，并把结果回写本文件（把该项降级/升级，或改掉结论）。
5. 涉及主仓的（BL-07、BL-09、BL-12、BL-17、BL-18）先判断「上游做不做」，做不了就按各条的「现状代价」接受，别在本仓造一个假的替代。

## 一、未在真机验证过的（P0）

> 这一组没有代码缺陷的嫌疑，全部是「写完了、单测过了、但**没有对任何真实 dsh 端点发过一次调用**」。单测用的都是假 CLI / 假 SDK / 假 app-server 夹具，所以它们只证明「参数按预期注入到入口」，不证明「引擎/网关接受这些参数」。四条的共同来源见 `docs/proposals/dsh-model-into-hosted-engines.md:25`（那一段自己写了「都未实测，沿用 §7 的约束」）。

### BL-01 codex：`-c model_providers.dsh={...}` 的真实解析与 `wire_api` 兼容性

**优先级**：P0

**现象**：codex 的 dsh 端点透传完全靠 `codex app-server -c model_provider=dsh -c model_providers.dsh={base_url,wire_api,env_key}`（`src/engine-codex/model-handover.ts:63-76`），`wire_api` 只映射两个 OpenAI wire（`:34-37`：`openai-responses`→`responses`、`openai-completions`→`chat`）。这套 `-c` 语法、`{...}` 内联 TOML 的解析、以及 `wire_api` 与真实网关的匹配**从未对真机跑过**。

**证据**：`src/engine-codex/model-handover.ts:34-37`、`:63-76`；调用点 `src/engine-codex/agent.ts:222-228`；未验证声明 `docs/proposals/dsh-model-into-hosted-engines.md:249`、`:25`。

**影响**：若 codex 不认这个 `-c` 形状、或网关只开 anthropic-messages 而配置里又没有漏掉 `wire_api` 的路径，会话会在第一步就失败——而单测全绿，值班的人不会预期到。**protocol 不匹配时的报错形态**（是 codex 解析错误、还是 HTTP 4xx、还是 wire 不认）也没记录，排障时会误判。

**怎么验**（一条最小命令，不动 dsh）：
```sh
# 用会话里那条真实 dsh 模型的 baseURL/apiKey，直接起一个 app-server 并让它跑一次
codex app-server -c 'model_provider=dsh' \
  -c 'model_providers.dsh={base_url="<dsh baseURL>",wire_api="responses",env_key="DSH_LOOP_ENGINE_API_KEY"}' \
  # env 里带 DSH_LOOP_ENGINE_API_KEY=<key>，再走一次 initialize/newConversation/turn
```
或最小等价做法：在 dsh web 里把某会话切到 codex、选一条真实 dsh 模型，发一轮，看 codex 子进程 stderr 与 dsh 侧日志。要同时确认：① `-c` 被接受（无解析错）；② `wire_api=responses`/`chat` 与网关是否对得上；③ 故意传一个网关不支持的协议（如 anthropic-messages，此时 `wire_api` 被省略）时**报错形态**。

**验不过时怎么退**：把 `Config.model` 钉在 codex 自己的原生模型上、把 dsh 模型选择留给 in-process 会话；或在 codex 的 `CODEX_WIRE_APIS` 上收紧为「只有确证网关支持的 wire 才注入」，其余仍省略 `wire_api`（现状语义：不假装支持，让 codex 自己报错）。

**谁修**：本仓（验证 + 按结果调 `CODEX_WIRE_APIS` 或文档）。

**验收标准**：本文件记录一条真机结论（接受/不接受、报错原文、`wire_api` 该用哪个），且与代码/文档一致；若结论是「网关不支持 OpenAI wire」，则 BL-06 的凭据暴露面对 codex 可以降级为「不注入」。

### BL-02 kimi：env 定义的模型是否出现在 `session/new` 的 `configOptions`；`set_model` 被拒时的错误帧

**优先级**：P0

**现象**：kimi 的透传把 `KIMI_MODEL_NAME` / `_API_KEY` / `_BASE_URL` / `_PROVIDER_TYPE` 放进 `kimi acp` 子进程 env（`src/engine-kimi/model-handover.ts:45-52`），靠 kimi 内嵌的 `applyEnvModelConfig` 把它变成默认模型；此时**跳过** `session/set_model`（`src/engine-kimi/agent.ts:588` 一带的注释）。但「env 定义的模型是否出现在 `session/new` 返回的 `configOptions` 里」「dsh 的裸模型 id 被 `set_model` 拒绝时错误帧长什么样」两件事都没对真机跑过。

**证据**：`src/engine-kimi/model-handover.ts:29-33`、`:45-52`；`src/engine-kimi/agent.ts:574`（调用点）、`:467-469`（`modelLabel`）；kimi 内嵌通路来源 `docs/proposals/dsh-model-into-hosted-engines.md:210-231`；未验证声明 `docs/proposals/dsh-model-into-hosted-engines.md:25`。

**影响**：如果 ACP 的 `configOptions` 与 env 模型不一致，UI/上层做模型校验的地方可能按错误清单判断；`set_model` 的错误帧形态未知，排障时无法区分「模型不存在」与「协议失败」。

**怎么验**：用真实 dsh 端点起 `kimi acp`，走一次 `initialize` → `session/new`，把返回的 `configOptions` 抓下来看有没有 env 模型；再故意发一次 `session/set_model`（不带 env 注入的路径）传一个不存在的 id，记录错误帧。`tests/engine-kimi/acp/` 下已有抓帧夹具可复用来解析。

**验不过时怎么退**：回到 `session/set_model` 路径（即不注入 env、交给 kimi 自己的配置），或者把 env-model 注入限制在「确证 `configOptions` 认它」的 kimi 版本上。

**谁修**：本仓（验证 + 记录错误帧形状）。

**验收标准**：本文件记录 `configOptions` 与 env 模型是否一致、`set_model` 拒绝时的错误帧原文，并把结论折进 `docs/engine-kimi.md`。

### BL-03 claude-code：`ANTHROPIC_BASE_URL` 指向 dsh 端点时 `/<prefix>/v1/messages` 的接受方式

**优先级**：P0

**现象**：claude-code 透传把 `ANTHROPIC_BASE_URL = baseURL`、`ANTHROPIC_AUTH_TOKEN = apiKey` 叠进 `Options.env`（`src/engine-claude/agent.ts:587-597`），模型走 `Options.model`。Claude Code 会说 `/v1/messages`，但 dsh 的 `baseURL` 是**路径前缀**（如 `https://ai.meicloud.com/litellm`），网关是否接受 `/<prefix>/v1/messages`、以及模型名该用哪种形态（裸 id / alias）**未实测**。

**证据**：`src/engine-claude/agent.ts:587-597`；`src/engine-claude/sdk.ts:87-90`（`scrubbedParentEnv()` 铺底再叠 `spec.env`）；未验证声明 `docs/proposals/dsh-model-into-hosted-engines.md:312`、`:25`。

**影响**：路径前缀拼接错一位就 404/401，而单测只证明 env 叠对了。

**怎么验**：真机一次最小请求即可——把 `ANTHROPIC_BASE_URL` 设为 dsh baseURL、`ANTHROPIC_AUTH_TOKEN` 设为 dsh key，用 Claude Code SDK/CLI 直接发一次 `query`（`docs/proposals/dsh-model-into-hosted-engines.md:328` 记录了 `claude --help` 可用）；或把 `Options.model` 传 dsh 的裸 id，看是否 4xx。逐项记录：状态码、是否为「前缀层」问题、模型名形态。

**验不过时怎么退**：调整 `ANTHROPIC_BASE_URL` 为「补到 `/v1` 之前那一层」的形态；模型名按网关要求改成 alias；都不行则对 claude 也退回「不注入端点，用引擎自己的配置」。

**谁修**：本仓（验证 + 按结果调整拼接）。

**验收标准**：本文件记录一次成功的 claude-code → dsh 端点真机请求（含 baseURL 形态与模型名形态），并折进 `docs/engine-claude.md:192` 那一行。

### BL-04 pi：最小 `models.json` 的接受度；`--provider` + `--api-key` 与 `PI_CODING_AGENT_DIR` 的组合行为

**优先级**：P0

**现象**：pi 的透传依赖插件自建的 agent 目录里一份**最小** `models.json`（`src/engine-pi/model-handover.ts:91-101` 只写 `providers.<p>.baseUrl/api/apiKey/models[{id,name}]`），并通过 `--provider` / `--api-key` / `--model` 与 `PI_CODING_AGENT_DIR` 指过去（`src/engine-pi/agent.ts:532-542`、`:555`）。pi 是否接受缺 `contextWindow`/`maxTokens` 的条目、`--provider`+`--api-key` 与 agent 目录里的凭据会不会互相覆盖，**未实测**。

**证据**：`src/engine-pi/model-handover.ts:64-88`、`:91-101`；`src/engine-pi/agent.ts:532-542`、`:555`；提案里给了带 `contextWindow`/`maxTokens` 的完整示例（`docs/proposals/dsh-model-into-hosted-engines.md:71-72`、`:160`），说明这两个字段是 pi 模型条目的常规字段。

**影响**：pi 可能因缺容量字段拒绝该 provider，或静默用错默认容量（影响上下文裁剪）；`--api-key` 与目录内 `apiKey` 谁生效决定排障方向。

**怎么验**：造一个只有插件目录的临时环境（`PI_CODING_AGENT_DIR=<插件目录>`），跑 `pi --mode rpc` 一次 `new_session`+`prompt`，看是否接受最小条目；再单独只给 `--provider`/`--api-key`、目录 `apiKey` 留空，看哪一路生效。若本地无 pi CLI，记录「无法验证」并保留本条开放。

**验不过时怎么退**：把 `contextWindow`/`maxTokens` 补进 `models.json`（值从哪里来是子问题：settings 里若没有，需要一个部署可配项或合理默认）；或退回「pi 只用引擎自己的模型配置」。

**谁修**：本仓（验证 + 按结果补字段）。

**验收标准**：本文件记录最小条目是否被接受、`--api-key` 与目录 `apiKey` 的优先级，并把结论折进 `docs/engine-pi.md`。

## 二、明确的取舍（已知代价，需要时可换方案）

### BL-05 pi 重定向 agent 目录会丢掉用户 `~/.pi` 的 skills / theme / auth

**优先级**：P2

**现象**：pi 无法用 env 传 baseURL，唯一自动通路是给子进程一个**插件自建**的 agent 目录并设 `PI_CODING_AGENT_DIR`（`src/engine-pi/model-handover.ts:30`、`:64-88`）。这样用户自己的 `~/.pi` 就完全不被读取——skills、theme、auth 一起丢。

**证据**：`src/engine-pi/model-handover.ts:13-19`（明确写「用户 `~/.pi` 故意不写不读」「代价真实且已记录」）、`:30`、`:64-88`。

**影响**：选了真实 dsh 模型的 pi 会话看不到用户 pi 的 skills/主题/登录态。这是「不碰用户目录」换来的代价。

**修法草案（三选一）**：
- **A（现状）**：完全隔离，`~/.pi` 一律不读。理由：绝不写用户目录、绝不把用户会话史带进临时目录。
- **B 复制叠加**：把 `~/.pi` 复制/符号链接进临时目录，保留 skills/theme，但可能带入 pi 自己的会话史，且 pi 的写入落在临时目录（用户看不到、退出即删）。
- **C 写用户目录**：直接改 `~/.pi` 的 `models.json`（更侵入，且要处理并发会话用不同端点）。

**谁修**：本仓。

**验收标准**：若维持 A，在 `docs/engine-pi.md` 把三条代价写清楚（skills/theme/auth 全丢）；若采纳 B，补一条测试证明「用户 skills 在临时目录可见」且「用户 `~/.pi` 字节未被写」；采纳 C 则必须先解决多端点并发。

### BL-06 凭据进入子进程 env / pi 的 0600 目录 / argv

**优先级**：P2

**现象**：`ANTHROPIC_AUTH_TOKEN`（claude）、`KIMI_MODEL_API_KEY`（kimi）、`DSH_LOOP_ENGINE_API_KEY`（codex）、`--api-key`（pi，`src/engine-pi/agent.ts:542`）都会进入第三方 CLI 的可见范围；pi 还会把它写进临时目录的 `models.json`（`0600`，目录 `0700`，`src/engine-pi/model-handover.ts:79-84`）。这是「让这台机器上的第三方 CLI 用 dsh 端点」的**固有代价**，已是既定事实。

**证据**：`docs/architecture.md:217`（「凭据只进子进程 env / pi 自建 `0600` 目录 / argv……该 CLI 进程能看到它」）；`src/engine-pi/model-handover.ts:79-84`；`src/engine-pi/agent.ts:542`；`src/engine-codex/model-handover.ts:75`。

**影响**：任意能读该子进程环境/argv/临时目录的本地进程都能拿到 key；pi 的临时文件在进程存活期间留在磁盘上（退出才删，`model-handover.ts:41-50`）。

**修法草案（降低暴露面，均为可选增强）**：
- 优先走**短时效令牌**而不是长期 key（需要 dsh 端支持，主仓/网关侧）。
- pi：把凭据从 argv 移回 `models.json`（argv 在 `ps` 里可见），或反过来；并考虑 `0600` 目录放到一个只有当前用户可遍历的父目录。
- 统一在文档里给一张「凭据可见面」表（env / argv / 磁盘 / 日志），明确各自窗口。

**谁修**：本仓（降低暴露面）；长期令牌由主仓/网关侧（双方）。

**验收标准**：至少在 `docs/architecture.md` 或 `docs/driver-core.md` 有一张凭据可见面清单；任何新增凭据通路都必须回答「它进不进 argv、进不进磁盘、何时删」。

### BL-07 读的是 `llm-pi-ai` / `llm-deepseek` 的私有 settings ns

**优先级**：P2

**现象**：端点解析的 provider → settings 地址映射来自 llm 注册表的「可配置 provider 目录」（`ctx.llm.listConfigurableProviders()`），形状 `{ provider, settingsNs, settingsPath }`（`src/driver-core/model-handover.ts:69-76`）；值的形状（`baseURL` / `api` / `apiKeyEnv`）从那个段里读（`:148-168`）。这两个形状都是**主仓 `LlmConfigurableProvider` 与两个 provider 插件内部约定**，主仓改字段名就会**静默不注入**。

**证据**：`src/driver-core/model-handover.ts:69-76`、`:148-168`、`:202-226`、`:234-242`。现有防御：形状不符一律返回 `undefined`、**不抛不猜**，只 `warnOnce` 一次并回退到引擎自己的配置（`:119-128`、`:234-242`）。

**影响**：主仓改字段名后，会话虽不崩，但端点不再透传——行为与「没有这个功能」一样，容易误判为「引擎不支持」。

**修法草案**：
- 短期（本仓）：加一个**集成测试**，用当前主仓的 `LlmConfigurableProvider` 形状喂进 `resolveModelHandover`，把契约钉在测试里；主仓升级跑 `pnpm test` 就能发现形状变了。
- 长期（主仓）：让注册表直接暴露**端点/协议**（或一个稳定的 `baseURL`/`api` 读取面），插件不再读私有段。属于主仓改动。

**谁修**：双方（本仓先钉测试；终点在主仓暴露字段）。

**验收标准**：存在一条测试，其失败即表示「注册表可配置 provider 目录的形状变了」；`docs/driver-core.md` §7 记录该契约与 warn 语义。

## 三、行为上还不诚实 / 不彻底的地方

### BL-08 `request/header` 的诚实性：真实模型交出去了，header 却仍写 `external/default`

**优先级**：P1

**现象**：四个引擎的 `modelLabel()` 都是 `config.model ?? HOSTED_DEFAULT_MODEL`（`src/engine-claude/agent.ts:513-515`、`src/engine-codex/agent.ts:602-604`、`src/engine-kimi/agent.ts:467-469`、`src/engine-pi/agent.ts:491-493`），**完全不看会话当前选择**。所以即便某个 step 已经把一条真实 dsh 模型交给了 CLI（经 `sessionModelOverrideOf` / `resolveModelHandover`），写进 `request/header` 的仍是 `external/default`。

**证据**：上面四处 `modelLabel`；宿主消费逻辑 `packages/api/session-controller/src/index.ts:158-167`（收到 `request/header` 就调 `consumeSelection`）、`packages/api/session-controller/src/agent.ts:307-313`（`consume` 要求 provider/model/effort 与 pending 选择逐项相等）。因 header 写的是 `external/default` 而 pending 是真实模型，`consume` 永不匹配。

**影响**：① 会话日志里「用过的模型」与事实不符（BL-09/BL-10 同类）；② 宿主「header 与新选择一致就消费 pending」的逻辑**永不触发**，pending 一直挂着，模型座可能长期显示「待生效」而实际已生效。

**修法草案**：会话选了真实模型时，把那一对 `(provider, model)` 写进 `request/header`（而不是 `external/default`）；未选或选 `external/default` 时才写 `HOSTED_DEFAULT_MODEL`。要顺带确认：宿主 `selectionFor`（`packages/api/session-controller/src/agent.ts:276-303`）从 header 推导会话选择时，读到真实模型是否会与占位路由的注册冲突——**待核实**，落地前先跑一遍「选真实模型 → header 写真实模型 → 下一轮选择推导」的链路。

**谁修**：本仓。

**验收标准**：选一条真实 dsh 模型的托管会话，其 `request/header` 的 `config.provider/model` 等于所选的 provider/model；宿主在请求装配时确实消费掉了 pending（`consume` 返回 true）；`docs/architecture.md` §3.6 的说明相应更新。

### BL-09 `routeServed` 只校验 provider、不校验 model

**优先级**：P1

**现象**：宿主在 `session.prompt` 起点拒绝「没有任何 adapter 服务的 provider」，判定函数 `routeServed` **只比对 provider**（`packages/api/session-controller/src/commands.ts:653-655`，读 `ctx.llm.listProviders()`）。因此一个「provider 注册了、但该 model 不可用」的选择永远不会在这一层被拒。

**证据**：`packages/api/session-controller/src/commands.ts:323-328`（拒绝点）、`:653-655`（判定）。

**影响**：端点透传之后，大部分「模型不可用」会被引擎自己的报错覆盖（引擎拒绝就浮上来）；但**不可达端点之外的「模型名不存在」**——即端点可达、模型名错——仍可能在这一层静默通过，直到引擎报一个很靠后的错，甚至表现为「跑了另一个模型」。这正是用户最初报的「期望它报错却没报」。

**修法草案**：
- 短期（本仓）：在托管引擎入口做**预检**——把 `provider/model` 与目录 `listModels` 的结果比对（本插件占位路由只广告一条 `default`，所以真模型的目录来自 `llm-pi-ai`/`llm-deepseek`），不匹配就 warn 或拒绝。
- 长期（主仓）：`routeServed` 增加 model 维度（`ctx.llm` 已能列举模型），让这一层更早暴露。属主仓改动。

**谁修**：双方（本仓预检，主仓收紧 `routeServed`）。

**验收标准**：选一个真实 provider + 不存在的 model，在托管会话里**第一步就**得到明确错误（而不是静默跑完）；本文件记录该错误来自引擎还是来自预检。

### BL-10 旧标签会话的显示回落

**优先级**：P2

**现象**：早期版本逐引擎把 `claude-code` / `codex` / `pi` / `kimi` 写进 `request/header`；现在只有 `external` 注册。一条 header 仍是旧标签的老会话，在**被重建之前**，模型座找不到对应目录条目，会回落显示 `${provider}/${model}` 原样串（如 `kimi/default`）。

**证据**：`src/provider-route.ts:74`（标签清单）、`:91-93`（`isHostedProviderRoute` 把旧四家也算托管）、`src/provider-route.ts:128-130`（只广告 `external` 一条）；`docs/architecture.md:215`。

**影响**：用户看到一串「不存在的模型」。这类会话一旦被切换/重建就会自愈（`model-selection-reset.ts` 会把座位改写成目标引擎的值），所以影响是**临时且可自愈**的。

**修法草案**：可以在客户端对「provider 属于 `HOSTED_PROVIDER_LABELS`」的座位做本地化渲染（显示「引擎接管」而不是原样串），代价是要把旧标签清单同步到浏览器半（现在它只在 node 半）。或接受现状：文档里写清「老会话重建前会短暂显示原样串」。

**谁修**：本仓。

**验收标准**：决定二选一后落到代码或文档；若做渲染，`tests/` 里有一条覆盖旧标签会话的用例。

### BL-11 codex 不走 subprocess seam，`Config.env` 的「credential-scrubbed」说法不成立

**优先级**：P2

**现象**：`src/engine-codex/loop.ts:52` 的 `Config.env` JSDoc 写「layered over the **credential-scrubbed** parent environment」，但 codex 驱动**不走** dsh subprocess seam（`packages/*/subprocess` 会先 `scrubbedParentEnv()`）；它经 `AppServerClient.create` 用 `{ ...process.env, ...env }`（`src/engine-codex/appserver/client.ts:107`）直接把**完整父环境**交给子进程。所以父环境里的凭据**没有**被清理——文案与事实不符。

**证据**：`src/engine-codex/loop.ts:52`；`src/engine-codex/appserver/client.ts:101-108`；`scrubbedParentEnv` 仅被 claude 侧引用（`src/engine-claude/sdk.ts:15`、`:88`；`src/engine-claude/process.ts:14`），kimi/pi 走 subprocess seam（`src/engine-kimi/process.ts:17`、`src/engine-pi/rpc/client.ts:120`）。提案里也点过这一点：`docs/proposals/dsh-model-into-hosted-engines.md:23`。

**影响**：文案误导 + codex 子进程继承了比其它三个引擎更多的父环境（安全面更大）。**不是新发现的行为差异**，但「文档说的」与「代码做的」不一致。

**修法草案（二选一）**：
- 改字：把 `src/engine-codex/loop.ts:52`（及 `types.ts`、`docs/engine-codex.md` 若同语）改成「layered over the ambient parent environment」，如实描述。
- 改行为：让 codex 也经过一次凭据清理再 spawn（需要一个本仓的 scrub 或接入 subprocess seam）。属较大改动，需评估 codex app-server 是否需要父环境里的 auth 事实（`client.ts:92-94` 明确说它需要 `PATH` 等）。

**谁修**：本仓。

**验收标准**：文档描述与 `AppServerClient.create` 的实际 env 语义一致；若改行为，有一条测试断言敏感变量名不在子进程 env 里。

### BL-12 「托管会话隐藏模型座位」的可行性

**优先级**：P2

**现象**：用户提过「in-process 能否不显示模型座位」。现状**不可行**为「按会话隐藏」：模型目录是按 **Host 代**构建的、不随会话变化（`src/provider-route.ts:12-15` 引主仓 `packages/api/session-controller/src/catalog.ts`），插件不能按会话关掉座位。

**证据**：`docs/proposals/model-selection-disable.md`（诉求 2「`selectModel` 明确拒绝」今天做不到，插件不是该 RPC 的实现方）；`src/provider-route.ts:12-15`、`:91-93`。

**可行的近似**：样式注入 + `data-loop-engine` 焦点守卫隐藏座位——turn-status 行已挂在 `<html data-loop-engine>` 上（`src/client/use-session-engine.ts:90-100`、`src/client/turn-status.ts`），可以按该属性给模型座的 CSS 选择器加 `display:none`。代价：① 依赖主仓的类名后缀（脆弱）；② `/model` 弹层仍会打开（它不读该属性）；③ 语义上「藏起来」≠「选择不生效」，UI 在骗人。

**修法草案**：
- 真正做法（主仓）：给 AgentFactory / loop 加「是否消费模型选择」能力标志（`consumesModelSelection` 之类），UI 与 RPC 一起尊重（`docs/proposals/model-selection-disable.md` 诉求 1、3）。
- 近似做法（本仓）：样式注入 + 焦点守卫，明确只隐藏 composer 座位、不碰 `/model` 弹层。

**谁修**：主仓（能力标志）；本仓（若要做近似）。

**验收标准**：决定「做/不做近似」并记录理由；若做，明确列出三处代价并在 `docs/per-session-engine.md` 用户语义一节说明。

## 四、工程债

### BL-13 文档里大量 `file:line` 引用已漂移

**优先级**：P1

**现象**：多份文档里的 `src/xxx.ts:NNN` 引用指向的行已不是被描述的那个符号。**这不是本次改动引入的**，而是长期累积的漂移。示例（均已用 `sed -n` 核过）：

- `docs/per-session-engine.md:54` 引 `src/agent-preset-ids.ts:297`（`sessionEngineOf`）与 `:314`（`hostedEngineOf`）→ 实际在 `:330` 与 `:347`。
- `docs/per-session-engine.md:43` 引 `src/agent-preset-ids.ts:88`（`LEGACY_HOSTED_PRESET_ID`）→ 实际在 `:121`。
- `docs/architecture.md:136`、`:379`、`:419` 引 `src/agent-preset-ids.ts:158-168`（`SessionEngineReport`）→ 实际在 `:191`。
- `docs/architecture.md:420`、`docs/per-session-engine.md:28`、`:249` 引 `src/agent-preset-ids.ts:198`（`LoopEngineRefusalCode`）→ 实际在 `:242`。
- `docs/driver-core.md:474` 引 `src/router-loop.ts:362-369`（`reportEngine`）→ 实际在 `:385`。
- `docs/architecture.md:72` 引 `src/index.ts:165-182`（`writePatchFileSync`）→ 实际在 `:182`。
- 引用越过文件尾：`docs/per-session-engine.md:136` 引 `src/client/index.ts:153-170`（该文件 167 行）、`:306` 引 `src/engine-pi/loop.ts:186`（该文件 171 行）。
- `docs/engine-pi.md:165` 引 `src/engine-pi/probe.ts`（该文件已删除，文档已标注）。

**影响**：读者按行号跳过去找不到对应实现，误导排查。

**修法草案**：把它作为**一个独立任务**「整篇重编一次」，而不是顺手改几条。抓取/校验脚本思路（可作 `scripts/check-doc-refs.mjs` 的雏形）：对每份文档用正则抽 `(src|packages|scripts|apps|vendor)/...\.(ts|tsx)(:N(-M)?)?`，按前缀判断相对本仓还是 `../deepseek-harness/`，再：① 文件存在性；② 行号 ≤ 文件行数；③（可选）引用前后的符号名在目标行 ±6 行内出现。第 ③ 条可把上面的漂移基本抓出来（本文件的漂移清单就是用这个思路找的）。注意 `docs/` 里裸 `src/...` 指本插件、`packages/...` 指主仓，正则会误抓长路径尾段，需加「前一字符不是 `/`」的边界。

**谁修**：本仓。

**验收标准**：存在一个可运行的引用校验脚本，跑一遍能列出所有漂移；重编后脚本为零（或只剩已标注的历史引用，如 `probe.ts`）。

### BL-14 容器级 `D:/workspace/github/dsh/AGENTS.md` 不在任何 git 仓库里

**优先级**：P2

**现象**：容器根 `D:/workspace/github/dsh/` 不是 git 仓库（`git rev-parse --show-toplevel` 报 `fatal: not a git repository`）。它下面的 `AGENTS.md`（跨两仓的协调说明、publish/release 流程）因此**没有版本管理**——改了没人 review、丢了不可恢复。

**证据**：在容器根跑 `git rev-parse --show-toplevel` → 失败；该目录下无 `.git`。

**影响**：容器级约定（尤其是 release 流程与只读约束）的一次误改不可追溯。

**修法草案（可选）**：
- 把 `AGENTS.md` 纳入两个子仓之一（例如 `dsh-loop-engine/docs/` 下备份一份并注明容器级才是权威），或
- 在容器根初始化一个仅跟踪 `AGENTS.md`/`RELEASE-CHECKLIST.md` 的仓（改变容器结构，需用户同意），或
- 接受现状，文档里注明「容器级文件无版本管理，改动请同步备份」。

**谁修**：容器维护者 / 用户（不在两个仓库内）。

**验收标准**：决定处置并记录；若纳入版本管理，`AGENTS.md` 有可追溯历史。

### BL-15 客户端 `SessionEngineCache` 在 React StrictMode 下会多发一次取值

**优先级**：P2

**现象**：`watch` 只在「**该会话的第一个 watcher**」出现时触发 `refresh`（`src/client/session-engine.ts:575-586`），而 `refresh` 对「同一会话已有读取在途」是**并进**而不是重发（`:602-606`）。React StrictMode（仅开发模式）会 mount → cleanup → mount，第二次 mount 时 `listeners.size` 又归零、又被当成「第一个 watcher」，于是**可能**再发一次取值（若第一次已落地）。另一个刻意口径：单个界面重挂、而另一个界面仍订阅同一会话时，`listeners.size > 0`，**不**重取（`:565-570` 的注释、`docs/architecture.md:380`）。

**影响**：仅开发模式的重复请求，有界、无 UI 错误。生产模式不触发。

**修法草案**：若在意，可用一个短时去抖（同一会话 N ms 内的重复 `refresh` 合并）；否则维持现状并把它记为「已知、有界、需要时再调」。

**谁修**：本仓。

**验收标准**：决定「调/不调」；若调，`tests/session-engine-cache.spec.ts` 补一条覆盖重复 watch 的用例。

### BL-16 `.superpowers/sdd/**` 里仍是旧探针的描述

**优先级**：P2

**现象**：`.superpowers/sdd/progress.md` 记录的是「Pi model selection」那轮实现，其中大量内容（`piCatalogHolder`、`pickModel()`、`pi --list-models` 探针）**与新事实不符**——探针与字段此后已全部删除。该目录被 `.superpowers/sdd/.gitignore`（内容 `*`）忽略，所以不进版本库、也不被常规搜索命中。

**证据**：`.superpowers/sdd/.gitignore:1`（`*`）；`git ls-files .superpowers` 为空；`.superpowers/sdd/progress.md` 全文；相关现状见 `docs/proposals/per-session-model-for-hosted-engines.md:24`、`docs/engine-pi.md:165`。

**影响**：接手的人若翻到这份 ledger，会以为探针还在。是「废弃笔记未被清理」的典型。

**修法草案**：在该目录顶部（或每份 ledger 头部）加一句「**已废弃，仅历史记录**」；或直接删除 `progress.md` 与其旧 diff（它们已被 git 历史与 `docs/superpowers/plans/` 覆盖）。

**谁修**：本仓。

**验收标准**：`.superpowers/sdd/**` 里的旧描述要么被标记废弃、要么删除；不会与 `docs/` 冲突。

## 五、依赖主仓的两条提案

> 两条都**不阻塞本仓运行**（现状各有绕行方案），但影响真实体验。提交为 GitHub issue，落地与否由主仓决定。

### BL-17 允许仓外插件追加一条自有 `ignorable` 会话事件（`append-ignorable-events`）

**优先级**：P2

**提案**：`docs/proposals/append-ignorable-events.md`——让插件能把「这个会话跑哪个引擎」写进**会话日志**（一条插件自有的 `ignorable` 事件），而不是侧车文件。

**上游不做时的现状与代价**：引擎事实只能落在**侧车文件** `$DSH_HOME/.loop-engine/engines.json`（`src/session-engine-store.ts`），成为「会话已有的东西的第二份真相来源」——对会话列表、fork、压缩、日志上传都不可见，自带迁移/GC 问题。没有侧车记录的会话回退到 **agent preset**（`loop-engine-<engine>`，`src/agent-preset-ids.ts:121`），而 preset 在会话启动时被 harness 冻结（`AgentPresets.select()` 以 `agent-preset/locked` 拒绝）。提案里给了已发布的 `0.1.5-rc.2` 产物上的实测错误串（`SessionFormatUnsupportedError`）。

**证据/现状**：`docs/proposals/append-ignorable-events.md` 全文（尤其「现状」的 5 条实测）；本仓侧车路径 `src/session-engine-store.ts`。

**谁修**：主仓。

**验收标准**：上游（或本仓自建）能向日志追加插件自有 `ignorable` 事件、且冷读不被拒；本仓的引擎记录随后可迁回日志。

### BL-18 让 `AgentFactory` 能在一条已有会话上原地交接 agent（`harness-agent-handover`）

**优先级**：P2

**提案**：`docs/proposals/harness-agent-handover.md`——把「把一条活会话交给另一个 agent」从「私有闭包 + 内部类」变成可表达的操作，覆盖 **in-process ↔ hosted 两个方向**。

**上游不做时的现状与代价**：托管引擎**之间**已能原地换手（`RouterLoop` 把同一个 `Session` 对象交给继任者，`src/driver-core/session-lifetime.ts` 的 `retire`/`swap`）；但**只要一边是 in-process 就无解**（`AgentLoop` 既不交出活会话、也不接受不是它创建的会话）。现状做法是：写记录 → 释放该会话的 agent → 回包 `reload: true` → 浏览器重载页面 → 宿主按记录重建。代价：切到/切出 in-process **必须重载整页**、会话短暂变冷（`session/disposed` → `api-session/removed`），体验不如托管引擎之间。

**证据/现状**：`docs/proposals/harness-agent-handover.md` 全文；`docs/architecture.md:474`（重载路径与理由）；`src/router-loop.ts`（`move`/`release`）。

**谁修**：主仓。

**验收标准**：上游提供「交出/接管活会话」的接缝后，in-process ↔ hosted 的切换不再需要页面重载（本仓改用原地换手），且不产生 `session/disposed`。

## 建议的推进顺序（按依赖，不按编号）

1. **BL-01 ~ BL-04（P0 真机验证）**：四条相互独立，可并行；每条验完把结论回写本文件。它们是所有后续「透传增强」的前提——若某条验不过，先按该条的退路收缩范围。
2. **BL-08（header 诚实性）**：改动集中在四个 `modelLabel` + 一处宿主消费链路，是 BL-09/BL-10 的共同上游（模型座位与日志的正名都以它为前提）。先做它，再做 BL-09 的预检。
3. **BL-09（model 预检）**：在 BL-08 把真实模型写进 header 之后，预检才有准确的输入；主仓 `routeServed` 的收紧可并行提交 issue。
4. **BL-11（codex 文案/行为）**：纯诚实性修正，可与 2/3 并行、随手做。
5. **BL-13（文档引用重编）**：独立工程任务，最好在 1~4 都落地、行号再次变动**之后**跑一次，避免重复劳动。
6. **BL-05 / BL-06 / BL-07**（取舍与契约）：BL-07 的「钉测试」建议随下一次主仓升级一起做；BL-05/BL-06 是决定与文档任务，穿插进行。
7. **BL-10 / BL-12 / BL-15 / BL-16**（P2 收敛）：各自独立，按精力插入。
8. **BL-14**（容器版本管理）需要用户介入，随时可提。
9. **BL-17 / BL-18**（主仓提案）：与上面并行提交 issue，落地后回头做本仓的迁移；不做则维持各条写明的现状与代价。
