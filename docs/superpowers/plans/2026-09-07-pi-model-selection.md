# Pi 模型选择实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让运行在 Pi loop engine 上的会话，能通过 dsh 原生 `/model` 弹层与 composer 模型位切换 Pi 的推理模型，且该选择真实驱动 Pi 子进程的 `--model`。

**Architecture:** 挂载 Pi 引擎时 spawn `pi --list-models` 探针并缓存模型清单；把该清单注入 Pi 的 provider 路由占位 adapter 使 `/model` 目录显示 Pi 模型；PiAgent 在 `spawnSpec()` 读会话日志最新的 `model/selection` 事件覆写 `config.model`，argv 变化触发 RPC 子进程 respawn。改动全部在 dsh-loop-engine 内，不碰主仓 harness。

**Tech Stack:** TypeScript, Vitest, Cordis 插件 (dsh-loop-engine), 子进程 spawn `pi --list-models`, 会话日志事件读取。

## Global Constraints

- 所有 `@deepseek-ai/*` 依赖保持 external（构建外化），不在插件内新增对 harness 包的 peer 依赖。
- Pi 引擎 provider 路由 label 恒为 `'pi'`（`engine-pi/agent.ts` 的 `PROVIDER`）。
- 模型 id 形态：`provider/model` 全名（如 `anthropic/claude-sonnet-4-6`），`--model` 原生接受该形态。
- `listModels` 返回的 `LlmModelInfo`：`provider: 'pi'`、`id` 与 `name` 都是 `provider/model` 全名。
- `HostedEngineRouteAdapter.stream()` 必须继续抛 `HOSTED_ENGINE_ROUTE`；`listModels` 是可注入的基线覆写。
- `selectModel` host 侧对 `pi` 占位路由放行（已验定：继承的 `resolveModel` 返回合法、无 reasoning 的模型信息，不抛 `model-unavailable`）。
- 探针**失败不报错**：返回空数组，`/model` 显示"无可选模型"，引擎照常工作。
- 测试覆盖率：`src/engine-pi/**` 逐文件 100%（`src/client` 除外）。新增分支要么测到、要么按既有惯例标注 `/* v8 ignore */` 理由。
- TDD：每个任务先写 failing test，再实现，再验通过，最后 commit。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/engine-pi/probe.ts` | spawn `pi --list-models` 并解析表格 → `PiModelEntry[]` | Create |
| `src/provider-route.ts` | adapter 支持注入 `listModels` 源 | Modify |
| `src/engine-pi/agent.ts` | `spawnSpec` 读 `model/selection` 事件覆写 `config.model` | Modify |
| `src/engine-pi/loop.ts` | `Config` 增 `piCatalogHolder`；构造时探针写入 holder | Modify |
| `src/index.ts` | `piCatalogHolder` + `mountProviderRoute`/`mountPi` 接线桥接 | Modify |
| `tests/engine-pi/probe.spec.ts` | 探针解析测试 | Create |
| `tests/engine-pi/agent.spec.ts` | spawnSpec 读事件覆写测试 | Modify |
| `tests/provider-route.spec.ts` | adapter 注入 listModels 测试 | Modify |
| `docs/engine-pi.md` | 文档 | Modify |

---

### Task 1: 探针模块 — spawn `pi --list-models` 并解析表格

**Files:**
- Create: `src/engine-pi/probe.ts`
- Test: `tests/engine-pi/probe.spec.ts`

**Interfaces:**
- Produces:
  - `export interface PiModelEntry { readonly provider: string; readonly model: string }`
  - `export async function probePiModels(bin: string, spawn: (spec: PiSpawnSpec) => PiProcess): Promise<readonly PiModelEntry[]>`
  - `export function parsePiModelList(output: string): PiModelEntry[]`

- [ ] **Step 1: Write the failing test**

Create `tests/engine-pi/probe.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { parsePiModelList, probePiModels } from '../../src/engine-pi/probe.ts'
import type { PiProcess, PiSpawnSpec } from '../../src/engine-pi/rpc/client.ts'
import type { PiModelEntry } from '../../src/engine-pi/probe.ts'

describe('parsePiModelList', () => {
  it('parses the provider/model columns of the aligned table', () => {
    const output = [
      'provider   model                                   context  max-out  thinking  images',
      'anthropic  claude-sonnet-4-6                       1M       128K     yes       yes',
      'deepseek   deepseek-v4-pro                         1M       384K     yes       no',
      'meicloud   6dd28e9b/custom_openai/deepseek-v4-flash-0731-aliyun-tokenplan-chenbk7  1M  384K  yes  no',
      '',
    ].join('\n')
    const entries = parsePiModelList(output)
    expect(entries).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
      {
        provider: 'meicloud',
        model: '6dd28e9b/custom_openai/deepseek-v4-flash-0731-aliyun-tokenplan-chenbk7',
      },
    ])
  })

  it('skips the header row and blank lines', () => {
    const entries = parsePiModelList('provider   model\nanthropic  claude-opus-4-7\n')
    expect(entries).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-7' }])
  })

  it('returns an empty array for an empty or header-only stream', () => {
    expect(parsePiModelList('')).toEqual([])
    expect(parsePiModelList('provider   model\n')).toEqual([])
  })
})

describe('probePiModels', () => {
  it('spawns pi --list-models, reads stdout, and parses it', async () => {
    const spawn = vi.fn((): PiProcess => {
      const process: PiProcess = {
        stdin: { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream,
        stdout: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        stderr: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        onExit: (handler: (code: number | null) => void) => { void handler(0) },
        terminate: vi.fn(),
      }
      // Drive data + end/close so the collector settles.
      const handlers = new Map<string, (arg: unknown) => void>()
      ;(process.stdout as unknown as {
        on: (event: string, cb: (arg?: unknown) => void) => void
      }).on = (event: string, cb: (arg?: unknown) => void) => {
        if (event === 'data') handlers.set('data', cb as (arg: unknown) => void)
        if (event === 'end' || event === 'close') handlers.set('end', cb as (arg: unknown) => void)
      }
      // collectStdout subscribes before the probe awaits exit; feed it now.
      queueMicrotask(() => {
        handlers.get('data')?.('provider   model\n')
        handlers.get('data')?.('anthropic  claude-opus-4-7\n')
        handlers.get('end')?.(undefined)
      })
      return process
    })

    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-7' }])

    const spec = spawn.mock.calls[0]![0] as PiSpawnSpec
    expect(spec.argv).toContain('/abs/path/pi')
    expect(spec.argv).toContain('--list-models')
    expect(spec.argv).toContain('--mode')
    expect(spec.argv).toContain('rpc')
    expect(spec.argv).not.toContain(process.execPath) // node prefix added by piSubprocessSpec, not here
    expect(spec.env).toEqual({})
  })

  it('returns an empty array when the probe fails (non-zero exit) without throwing', async () => {
    const spawn = vi.fn((): PiProcess => {
      const process: PiProcess = {
        stdin: { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream,
        stdout: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        stderr: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        onExit: (handler: (code: number | null) => void) => { void handler(1) },
        terminate: vi.fn(),
      }
      return process
    })

    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toEqual([])
  })

  it('returns an empty array when the child emits nothing before exit', async () => {
    const spawn = vi.fn((): PiProcess => {
      const process: PiProcess = {
        stdin: { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream,
        stdout: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        stderr: { on: vi.fn(), setEncoding: vi.fn() } as unknown as NodeJS.ReadableStream,
        onExit: (handler: (code: number | null) => void) => { void handler(0) },
        terminate: vi.fn(),
      }
      // No 'data' events, but emit 'end' so the collector settles with ''.
      const close = new Map<string, (arg: unknown) => void>()
      ;(process.stdout as unknown as { on: (e: string, cb: (arg?: unknown) => void) => void }).on =
        (event: string, cb: (arg?: unknown) => void) => {
          if (event === 'end' || event === 'close') close.set('end', cb as (arg: unknown) => void)
        }
      queueMicrotask(() => { close.get('end')?.(undefined) })
      return process
    })

    const models = await probePiModels('/abs/path/pi', spawn)
    expect(models).toEqual([])
  })
})
```

> 注意：`probePiModels` 是异步的 —— 它等待子进程退出（`onExit` 回调）并等 stdout 流结束（`end`/`close`）后读取已累积文本。测试中的 `onExit` 与 `data`/`end` 在微任务里分发性触发；真实实现用 `Promise` 驱动，勿同步 resolve。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/engine-pi/probe.spec.ts`
Expected: FAIL with "Cannot find module '../../src/engine-pi/probe.ts'"

- [ ] **Step 3: Write minimal implementation**

Create `src/engine-pi/probe.ts`:

```ts
import type { PiProcess, PiSpawnSpec } from './rpc/client.ts'

/** One discoverable Pi model: the raw two-part identity `pi` exposes. */
export interface PiModelEntry {
  readonly provider: string
  readonly model: string
}

/** Wait for a Pi child to exit, resolving with its exit code. */
function waitForExit(process: PiProcess): Promise<number> {
  return new Promise<number>((resolve) => {
    process.onExit((code) => resolve(code ?? 0))
  })
}

/** Collect the child's full stdout, resolving once the stream ends. */
function collectStdout(process: PiProcess): Promise<string> {
  return new Promise<string>((resolve) => {
    let text = ''
    if (process.stdout.on === undefined) {
      resolve('')
      return
    }
    // Subscribe to data AND end; a child that never ends would hang the probe,
    // so we also settle on 'close'. The `PiProcess.stdout` readonly surface is
    // narrow here, so we reach the event methods through a structural cast.
    const out = process.stdout as unknown as {
      on(event: string, cb: (...args: unknown[]) => void): void
      setEncoding(enc: string): void
    }
    out.setEncoding('utf8')
    out.on('data', (data: string) => { text += data })
    out.on('end', () => { resolve(text) })
    out.on('close', () => { resolve(text) })
  })
}

/**
 * Parse the output of `pi --list-models`: a column-aligned table whose first
 * two columns are `provider` and `model`. The header row and blank lines are
 * skipped; long model ids simply occupy more columns. Splitting on 2+ spaces
 * yields provider and model in the first two fields regardless of alignment.
 */
export function parsePiModelList(output: string): PiModelEntry[] {
  const entries: PiModelEntry[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    // The header row ("provider  model  ...") has no two-space-separated
    // provider/model pair — skip any line whose first field is a column title.
    const match = /^(\S+)\s{2,}(\S+)/.exec(trimmed)
    if (match === null) continue
    const provider = match[1]!
    if (provider === 'provider') continue // header
    entries.push({ provider, model: match[2]! })
  }
  return entries
}

/**
 * Spawn `pi --list-models` and return the parsed model entries. Failures
 * (non-zero exit, no stdout, spawn throw) resolve to an empty array so the
 * catalog stays advisory and a probe glitch never breaks the engine mount.
 * @param bin - the Pi CLI entrypoint (from `piCliEntrypoint()`); becomes spec.argv[0].
 * @param spawn - the process-spawn adapter; `piSubprocessSpec` prepends the node
 *   prefix, so spec.argv must NOT carry it.
 */
export async function probePiModels(
  bin: string,
  spawn: (spec: PiSpawnSpec) => PiProcess,
): Promise<readonly PiModelEntry[]> {
  const spec: PiSpawnSpec = {
    argv: [bin, '--mode', 'rpc', '--list-models'],
    cwd: process.cwd(),
    env: {},
  }
  let process: PiProcess
  try {
    process = spawn(spec)
  } catch {
    return []
  }
  const stdoutPromise = collectStdout(process)
  const exitCode = await waitForExit(process)
  if (exitCode !== 0) return []
  const stdout = await stdoutPromise
  return parsePiModelList(stdout)
}
```

> **argv 契约（务必遵守）：** `probePiModels(bin, spawn)` 的 `spec.argv[0]` 是 Pi CLI bin 路径（由调用方经 `piCliEntrypoint()` 传入）。`spawn` 按 Task 4 `piSubprocessSpec` 的方式在 argv 前加 `process.execPath`。因此 spec 内不重复加 node 前缀。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/engine-pi/probe.spec.ts`
Expected: PASS (all describe blocks green)

- [ ] **Step 5: Commit**

```bash
git add src/engine-pi/probe.ts tests/engine-pi/probe.spec.ts
git commit -m "feat(engine-pi): probe discoverable models via pi --list-models"
```

---

### Task 2: adapter 支持注入模型清单源

**Files:**
- Modify: `src/provider-route.ts` (module exports + `HostedEngineRouteAdapter.listModels`)
- Modify: `tests/provider-route.spec.ts`

**Interfaces:**
- Consumes: `PiModelEntry` from `src/engine-pi/probe.ts`
- Produces:
  - `export interface HostedEngineRouteAdapterOptions { readonly listModels?: () => readonly PiModelEntry[] }`
  - `HostedEngineRouteAdapter` constructor 第二参数 `options?: HostedEngineRouteAdapterOptions`
  - `HostedEngineRouteAdapter.prototype.listModels(provider: string): Promise<readonly LlmModelInfo[]>`

- [ ] **Step 1: Write the failing test**

Append to `tests/provider-route.spec.ts` this describe block:

```ts
import { HostedEngineRouteAdapter, HOSTED_PROVIDER_ROUTES } from '../src/provider-route.ts'
import type { PiModelEntry } from '../src/engine-pi/probe.ts'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

describe('HostedEngineRouteAdapter with a model catalog source', () => {
  it('advertises the injected Pi models under the pi provider group', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const llm = ctx.get('llm') as LlmRuntime
    const catalog = (): readonly PiModelEntry[] => [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
    ]
    const release = llm.registerAdapter(
      ['pi'],
      new HostedEngineRouteAdapter('pi', { listModels: catalog }),
    )

    const models = await llm.listModels('pi')
    expect(models.map(m => m.provider)).toEqual(['pi', 'pi'])
    expect(models.map(m => m.id)).toEqual([
      'anthropic/claude-sonnet-4-6',
      'deepseek/deepseek-v4-pro',
    ])
    expect(models.map(m => m.name)).toEqual([
      'anthropic/claude-sonnet-4-6',
      'deepseek/deepseek-v4-pro',
    ])
    // A provider-group with non-empty models appears in the catalog.
    expect(llm.listProviders()).toContainEqual({ id: 'pi', name: 'pi' })

    release()
    await ctx.fiber.dispose()
  })

  it('returns an empty catalog when no source is injected', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const llm = ctx.get('llm') as LlmRuntime
    const release = llm.registerAdapter(['pi'], new HostedEngineRouteAdapter('pi'))
    await expect(llm.listModels('pi')).resolves.toEqual([])
    release()
    await ctx.fiber.dispose()
  })

  it('still fails loud when a model query reaches the placeholder', () => {
    const adapter = new HostedEngineRouteAdapter('pi', {
      listModels: () => [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
    })
    const options = undefined as unknown as GenerateOptions
    expect(() => adapter.stream(options)).toThrow('provider "pi" is a hosted loop engine route, not a model endpoint')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/provider-route.spec.ts`
Expected: FAIL — TypeScript/compile error (constructor takes 1 arg, no `listModels`).

- [ ] **Step 3: Write minimal implementation**

Edit `src/provider-route.ts`. Add the import of `LlmModelInfo` type and `PiModelEntry`, extend the constructor, and override `listModels`:

```ts
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { LoopEngineId } from './settings.ts'
import type { PiModelEntry } from './engine-pi/probe.ts'
import { PROVIDER as CLAUDE_CODE_PROVIDER } from './engine-claude/agent.ts'
import { PROVIDER as CODEX_PROVIDER } from './engine-codex/agent.ts'
import { PROVIDER as PI_PROVIDER } from './engine-pi/agent.ts'
import { PROVIDER as KIMI_PROVIDER } from './engine-kimi/agent.ts'

/** Injectable catalog source a hosted engine route can advertise over the placeholder. */
export interface HostedEngineRouteAdapterOptions {
  /**
   * Optional model catalog generator. When present, `listModels` advertises
   * these entries under this route's provider label; when absent, the catalog
   * stays empty (the default, "engine owns its models" behavior).
   */
  readonly listModels?: () => readonly PiModelEntry[]
}
```

Then update the class:

```ts
export class HostedEngineRouteAdapter extends LlmAdapter {
  /**
   * @param label - the provider route label this placeholder serves.
   * @param options - optional catalog source; omit for an empty catalog.
   */
  constructor(
    private readonly label: string,
    private readonly options: HostedEngineRouteAdapterOptions = {},
  ) {
    super()
  }

  /** Advertise the injected Pi models (if any) under this route's provider label. */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = this.options.listModels?.() ?? []
    return catalog.map(entry => ({
      provider: this.label,
      id: `${entry.provider}/${entry.model}`,
      name: `${entry.provider}/${entry.model}`,
    }))
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `provider "${this.label}" is a hosted loop engine route, not a model endpoint`,
      'HOSTED_ENGINE_ROUTE',
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/provider-route.spec.ts`
Expected: PASS (all blocks green, including the pre-existing `HostedEngineRouteAdapter` suite).

- [ ] **Step 5: Commit**

```bash
git add src/provider-route.ts tests/provider-route.spec.ts
git commit -m "feat(provider-route): allow an injected model catalog on the hosted route adapter"
```

---

### Task 3: `spawnSpec` 读会话 `model/selection` 事件覆写 `config.model`

**Files:**
- Modify: `src/engine-pi/agent.ts` (add `dynamicModel()` helper + edit `spawnSpec`)
- Modify: `tests/engine-pi/agent.spec.ts`

**Interfaces:**
- Consumes: existing `this.session: Session`, `this.config.model: string | undefined`, `SessionEvent` types.
- Produces:
  - `private dynamicModel(): string | undefined` — returns the `model` field of the last `model/selection` event, or `undefined`.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-pi/agent.spec.ts` inside the `PiAgent deployment pinning` describe (or a new describe near it):

```ts
describe('PiAgent session model selection override', () => {
  it('uses the last model/selection event model over the pinned config model', async () => {
    const ctx = await harness({ model: 'deployment-pinned' })
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-s'),
        meta: { cwd: process.cwd() },
      })
      // Simulate a harness session.selectModel by appending a model/selection event.
      agent.session.append('model/selection', {
        provider: 'pi',
        model: 'anthropic/claude-sonnet-4-6',
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const argv = mock.created[0]?.spec.argv as string[]
      expect(argv).toContain('--model')
      expect(argv).toContain('anthropic/claude-sonnet-4-6')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the pinned config model when no selection event exists', async () => {
    const ctx = await harness({ model: 'pi-deployment-model' })
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-empty-s'),
        meta: { cwd: process.cwd() },
      })
      agent.followup(message('go'))
      await agent.whenIdle()

      const argv = mock.created[0]?.spec.argv as string[]
      expect(argv).toContain('--model')
      expect(argv).toContain('pi-deployment-model')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prefers the most recent model/selection event over an earlier one', async () => {
    const ctx = await harness()
    try {
      mock.eventsYield.mockReturnValue(okStream('ok'))
      const { agent } = await ctx.agents.create({
        sessionId: SessionId('model-sel-latest-s'),
        meta: { cwd: process.cwd() },
      })
      agent.session.append('model/selection', { provider: 'pi', model: 'old/model' })
      agent.session.append('model/selection', { provider: 'pi', model: 'new/model' })
      agent.followup(message('go'))
      await agent.whenIdle()

      const argv = mock.created[0]?.spec.argv as string[]
      expect(argv).toContain('new/model')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/engine-pi/agent.spec.ts`
Expected: FAIL — `spawnSpec` still uses `config.model` exclusively, so the first case (`anthropic/claude-sonnet-4-6`) fails (actual argv contains `deployment-pinned`).

- [ ] **Step 3: Write minimal implementation**

Edit `src/engine-pi/agent.ts`. Add a helper and wire it into `spawnSpec`:

```ts
  /**
   * The harness Session's web-side model selection, if any was stored. The
   * durable `model/selection` event carries `{ provider, model, ... }`; when a
   * user picked a model via `/model`, this is the newest pick, and it overrides
   * the deployment config (which stays the fallback). Returns `undefined` when
   * no selection was stored, so the deployment config governs.
   */
  private dynamicModel(): string | undefined {
    for (const event of [...this.session.snapshotEvents()].reverse()) {
      if (event.type !== 'model/selection') continue
      const data = event.data as { provider?: string; model?: string } | undefined
      const model = data?.model
      if (typeof model === 'string' && model.length > 0) return model
    }
    return undefined
  }
```

Then edit `spawnSpec` (lines 470-493) to use `dynamicModel()`:

```ts
  /** Build the `pi --mode rpc` argv/cwd/env for one step's child process. */
  private spawnSpec(cwd: string): PiSpawnSpec {
    const argv: string[] = []
    const model = this.dynamicModel() ?? this.config.model
    if (this.config.provider !== undefined) argv.push('--provider', this.config.provider)
    if (model !== undefined && this.config.thinkingLevel !== undefined) {
      argv.push('--model', `${model}:${this.config.thinkingLevel}`)
    } else if (model !== undefined) {
      argv.push('--model', model)
    } else if (this.config.thinkingLevel !== undefined) {
      argv.push('--model', `:${this.config.thinkingLevel}`)
    }
    const permission = this.queryPermission()
    if (permission.tools.length > 0) argv.push(TOOLS_FLAG, permission.tools.join(','))
    return {
      argv: [
        this.bin,
        '--mode', 'rpc',
        '--no-session',
        ...argv,
      ],
      cwd,
      env: this.config.env,
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/engine-pi/agent.spec.ts`
Expected: PASS (all existing + new blocks green; the pre-existing `records the pinned model in the request header` test still passes because it runs before the selection event exists).

> 注意：新增三个分支（`model` 非 undefined 且 thinkingLevel 分支等）若未触发覆盖率边界，按既有惯例对不可达分支补 `/* v8 ignore */` 理由；`agent.ts` 已有的 `v8 ignore` 模式可参考。

- [ ] **Step 5: Commit**

```bash
git add src/engine-pi/agent.ts tests/engine-pi/agent.spec.ts
git commit -m "feat(engine-pi): honor the session model/selection event in the spawn argv"
```

---

### Task 4: 挂载接线 — PiLoop 内部探针 + 共享 catalog holder 注入 adapter

**Files:**
- Modify: `src/index.ts` (`apply` scope: `piCatalogHolder` + `mountProviderRoute` options + `mountPi` constructor arg)
- Modify: `src/engine-pi/loop.ts` (`Config` gains `piCatalogHolder`)
- Test: `tests/engine-pi/loop.spec.ts` + manual integration note. No isolated unit test forces a real `pi --list-models` spawn.

**Interfaces:**
- Consumes: `probePiModels(bin, spawn)` (Task 1), `HostedEngineRouteAdapterOptions` (Task 2), `PiModelEntry` (Task 1).
- Produces: the wiring that threads a shared, mutable Pi catalog holder from the mount into both the route adapter's `listModels` source and `PiLoop`'s constructor.

**Key design:** `mountProviderRoute` runs BEFORE `mountPi` (index.ts:613-617), and the probe is async. So the catalog is exposed through a **shared mutable holder** owned by the `apply` scope. `PiLoop`'s constructor runs the probe and writes the result into that holder; the route adapter's `listModels` reads the same holder through a live closure. `ResolvedConfig` is NOT modified (PiLoop never reads the catalog — only the adapter does; `PiAgent.spawnSpec` reads `model/selection` via Task 3), so no dead field.

- [ ] **Step 1: Write the failing test in `loop.spec.ts`**

Append a describe block to `tests/engine-pi/loop.spec.ts`:

```ts
describe('PiLoop catalog probe', () => {
  it('writes the pi --list-models probe result into the shared holder when present', async () => {
    const handle = fakeHandle()
    // Simulation: the probe child's stdout carries a table, then exits 0.
    const spawn = vi.fn((spec: unknown) => {
      const sub = spec as { argv: string[] }
      if (sub.argv.includes('--list-models')) {
        const events: Array<{ 'data'?: string }> = []
        const stdout = new Readable({
          read: () => {},
          // Manually push+end to feed the collector before exit resolves.
        })
        queueMicrotask(() => {
          stdout.push('provider   model\n')
          stdout.push('anthropic  claude-opus-4-7\n')
          stdout.push(null)
        })
        return {
          pid: 1,
          stdin: new Writable({ write: (_c, _e, cb) => { cb() } }),
          stdout,
          stderr: new Readable({ read: () => {} }),
          collected: {},
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate: vi.fn(),
          waitForExit: vi.fn(async () => true),
        } as SubprocessHandle
      }
      return handle
    })
    const ctx = await loopCtx(spawn)
    try {
      const holder: { entries: readonly PiModelEntry[] } = { entries: [] }
      const loop = new PiLoop(ctx, { piCatalogHolder: holder })
      // The probe is async; give the microtask queue a beat to flush.
      await Promise.resolve()
      expect(holder.entries).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-7' }])
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
        argv: expect.arrayContaining(['--list-models', '--mode', 'rpc']),
      }))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the holder empty when no holder is provided (probe is skipped)', async () => {
    const spawn = vi.fn(() => fakeHandle())
    const ctx = await loopCtx(spawn)
    try {
      const loop = new PiLoop(ctx, {})
      await Promise.resolve()
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
```

> `probePiModels.waitForExit` awaits the process's `onExit`; the mock's `done` is `Promise.resolve({exitCode: 0})`, and the underlying `piSubprocessSpec` gets `process.execPath` prefixed — the assertion uses `arrayContaining` rather than strict equality so the node-prefix detail stays out of the test's focus. `PiModelEntry` needs importing in the spec.

- [ ] **Step 2: Add a shared holder in `apply` scope**

In `src/index.ts`, near the other `apply`-scope state (after `skillDisposer`, ~line 304), add:

```ts
  /** Cached Pi model catalog from `pi --list-models`, shared by the Pi route adapter.
   * Populated asynchronously by `PiLoop`'s constructor; the route adapter reads it
   * through a live closure, so the probe need not finish before the mount returns. */
  const piCatalogHolder: { entries: readonly PiModelEntry[] } = { entries: [] }
```

And import `PiModelEntry` at the top of `src/index.ts`:

```ts
import type { PiModelEntry } from './engine-pi/probe.ts'
```

- [ ] **Step 3: Run the loop test to verify it fails**

Run: `pnpm vitest run tests/engine-pi/loop.spec.ts`
Expected: FAIL — `PiLoop` does not yet accept `piCatalogHolder`, so `new PiLoop(ctx, { piCatalogHolder: holder })` is a type/behavior error (the probe never runs; `holder.entries` stays `[]`).

- [ ] **Step 4: Thread the holder into `mountProviderRoute`**

Update `mountProviderRoute` (index.ts:366) to pass the Pi catalog source when the engine is `pi`:

```ts
  const mountProviderRoute = (engine: LoopEngineId, attempt = 0): void => {
    if (engine === 'in-process') return
    if (routeEngine === engine && routeHandle !== undefined) return
    CLEAR_ROUTE_RETRY()
    const label = HOSTED_PROVIDER_ROUTES[engine]
    const llm = ctx.get('llm') as LlmRegistry | undefined
    if (llm === undefined) {
      if (attempt < ROUTE_ATTEMPTS) {
        routeRetry = setTimeout(() => { mountProviderRoute(engine, attempt + 1) }, ROUTE_RETRY_MS)
      }
      return
    }
    try {
      const options = engine === 'pi' ? { listModels: () => piCatalogHolder.entries } : undefined
      routeHandle = llm.registerAdapter([label], new HostedEngineRouteAdapter(label, options))
      routeEngine = engine
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('already registered')) {
        ctx.logger.warn(`loop-engine: provider route "${label}" is already served by another adapter`)
        return
      }
      ctx.logger.error(`loop-engine: provider route "${label}" registration failed: ${String(error)}`)
    }
  }
```

> `() => piCatalogHolder.entries` is a live read: after `PiLoop` writes into `piCatalogHolder.entries` (Step 5), the adapter's next `listModels` call sees the populated list.

- [ ] **Step 5: `PiLoop` receives the holder and writes the probe result into it**

Edit `src/engine-pi/loop.ts`. Add to the `Config` interface:

```ts
  /** Shared Pi model catalog holder; the loop writes its `pi --list-models` probe result here. */
  piCatalogHolder?: { entries: readonly PiModelEntry[] }
```

Import `PiModelEntry` and `probePiModels` at the top of `loop.ts`:

```ts
import type { PiModelEntry } from './probe.ts'
import { probePiModels } from './probe.ts'
```

In the constructor body, after `this.spawn` is assigned (line 189), add:

```ts
    // Probe discoverable Pi models once per mount and publish into the shared
    // holder so the route adapter /model directory reflects the catalog. Failure
    // leaves the holder empty (advisory): /model shows "no models", engine runs.
    const holder = config.piCatalogHolder
    if (holder !== undefined) {
      void probePiModels(this.bin, (spec) => this.spawn(spec))
        .then((models) => { holder.entries = [...models] })
        .catch(() => { holder.entries = [] })
    }
```

> `this.bin` is the resolved Pi CLI entrypoint (`piCliEntrypoint()`); `this.spawn` wraps `piSubprocessSpec` (which prepends `process.execPath`), so the spec argv must NOT carry it. This matches Task 1's `probePiModels(bin, spawn)` contract.

- [ ] **Step 6: `mountPi` passes the holder in**

Update `mountPi` (index.ts:570-580):

```ts
  const mountPi = (): void => {
    const skills = ctx.get('skills') as SkillsService | undefined
    if (skills !== undefined) {
      skillDisposer = skills.registerProvider(control => new PiSkillProvider(control))
    }
    hostFactory('pi', () => ctx.plugin(PiLoop, {
      ...piConfig(config),
      piCatalogHolder,
    }))
  }
```

- [ ] **Step 7: Commit**

```bash
git add src/engine-pi/probe.ts src/engine-pi/loop.ts src/index.ts tests/engine-pi/probe.spec.ts tests/engine-pi/loop.spec.ts
git commit -m "feat(engine-pi): wire the pi --list-models probe into the route and loop"
```

- [ ] **Step 8: 集成验证（手动）**

```bash
# 构建并跑全部相关测试
pnpm vitest run tests/engine-pi tests/provider-route.spec.ts
Expected: PASS

# 手动冒烟：用真实会话启动 pi 引擎，打开 /model 确认出现模型组，切换后驱动 spawn --model 反映新值
```

> 暂不开真实的 `pi` 会话测试；设计已确认 host `selectModel` 放行，`/model` 目录经 adapter `listModels` 显示。若手动冒烟发现 adapter 未接线成功，回查 `mountProviderRoute` 传的 `options.listModels` 是否指向填充后的 holder。

---

### Task 5: 文档更新

**Files:**
- Modify: `docs/engine-pi.md` (配置项一览 + `--model` 动态来源 + 探针流程)
- Modify: `docs/proposals/model-selection-disable.md` (标注与 Pi 的关系)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `docs/engine-pi.md` §8 配置项一览**

Add two rows to the config table (第 8 节):

```markdown
| `modelCatalog` | `listModels` | 探针缓存（`pi --list-models` 结果）；adapter 据此显示 /model 目录 |
| `model`（动态覆写） | `model` | `spawnSpec` 优先读会话 `model/selection` 事件，其次此配置 |
```

And in the `--model` 拼接规则（第 8 节），补一句：

> 新增：`spawnSpec` 计算 `--model` 时，先取本会话日志最新 `model/selection` 事件的 `model`（用户经 `/model` 选择），其次才回退到部署配置的 `model`。`model/selection` 为空或缺失时用配置值。

- [ ] **Step 2: Update `docs/engine-pi.md` 新增探针小节**

在第 8 节后加：

```markdown
## 8.1 模型探针（pi --list-models）

PiLoop 挂载时 spawn `pi --list-models`（RPC 模式，无会话）一次，解析其列对齐表格前两列（`provider` / `model`）得到模型清单，缓存进 `ResolvedConfig.listModels`。provider 路由占位 adapter 的 `listModels` 据此把模型目录暴露给 dsh 的 `/model` 弹层（每个条目的 `id`/`name` 为 `provider/model` 全名，`provider` 字段为 `'pi'`）。探针失败：目录为空、引擎照常工作。
```

- [ ] **Step 3: 更新提案文档**

In `docs/proposals/model-selection-disable.md`, append a note near the top:

```markdown
> **Pi 除外：** 本提案针对 claude-code 引擎"模型选择不生效"。Pi 引擎已改为让模型选择生效（见 `docs/superpowers/specs/2026-09-07-pi-model-selection-design.md`）：其 `/model` 目录由 `pi --list-models` 探针填充，选择经 `model/selection` 事件写入 spawn `--model`。claude-code / codex / kimi 仍保持本提案描述的"原生决定、不可选"行为。
```

- [ ] **Step 4: Commit**

```bash
git add docs/engine-pi.md docs/proposals/model-selection-disable.md
git commit -m "docs(engine-pi): document model probing and session-selection override"
```

---

## Self-Review

**1. Spec coverage:**
- 探针模块（spec §方法 1/2）→ Task 1。
- adapter `listModels` 注入（spec §改动 3）→ Task 2。
- `spawnSpec` 读 `model/selection` 覆写（spec §改动 4）→ Task 3。
- 挂载接线 + 探针缓存（spec §改动 2/3、决策 3）→ Task 4。
- 文档（spec §改动 5）→ Task 5。
- 不做的事：不解析 context/max-out/thinking/images（spec §不做）→ 每处 `listModels` 只映射 `id/name`，符合。
- 风险验定（spec §边界首条）→ 已在 Global Constraints 明确，Task 2 测试覆盖空目录/有目录两种 adapter 行为。

**2. Placeholder scan:** 无 TBD/TODO/占位。Task 4 第 3 步有一处实现决策注记，但它给出了**明确的执行决策**（探针移入 PiLoop 构造），非占位。每个代码步骤给出完整代码。

**3. Type consistency:**
- `PiModelEntry`（Task 1 定义）→ Task 2 adapter 用；字段 `provider`/`model` 一致。
- `HostedEngineRouteAdapterOptions.listModels: () => readonly PiModelEntry[]`（Task 2）→ Task 4 `piModelCatalog` 同型。
- `ResolvedConfig.listModels`（Task 4 types.ts）→ `resolveConfig` 填充，返回值同 `() => readonly PiModelEntry[]`。
- `probePiModels(spawn: (spec) => PiProcess)`（Task 1）→ Task 4 调用。
- `dynamicModel(): string | undefined`（Task 3）→ `spawnSpec` 用，字段名 `model` 与 `model/selection` 事件 `data.model` 一致。

**4. 已知限制（如实标注而非隐藏）：** Task 4 的探针接线有"实现决策"注记，因为 `probePiModels` 当前签名要求调用方提供 spawn 函数，而确切的 spawn argv 前缀（`process.execPath` 前缀是否加）依赖实际接线途径。实现时以"PiLoop 构造内探针、复用 `this.spawn`/bin"为最终方案。
