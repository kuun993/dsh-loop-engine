/**
 * Unit tests for the SDK query-options assembly and the managed-process
 * projection seam.
 */

import { PassThrough } from 'node:stream'
import { describe, expect, it, type Mock, vi } from 'vitest'
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_PERMISSION_MODE,
  unattendedDiagnostic,
  claudeQueryOptions,
  type ClaudeCodeQuerySpec,
} from '../../src/engine/sdk.ts'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
  sdkEnvironmentOverlay,
} from '../../src/engine/process.ts'

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly settle: (outcome: SubprocessOutcome) => void
  readonly fail: (error: Error) => void
  readonly terminate: Mock<() => void>
}

function fakeChild(): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let resolveDone: (outcome: SubprocessOutcome) => void = () => {}
  let rejectDone: (error: Error) => void = () => {}
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const terminate = vi.fn<() => void>()
  return {
    handle: {
      pid: 4242,
      stdin,
      stdout,
      stderr: undefined,
      collected: {},
      done,
      terminate,
      waitForExit: vi.fn(async () => true),
    },
    settle: (outcome) => { resolveDone(outcome) },
    fail: (error) => { rejectDone(error) },
    terminate,
  }
}

function spec(overrides: Partial<ClaudeCodeQuerySpec> = {}): ClaudeCodeQuerySpec {
  return {
    cwd: process.cwd(),
    permissionMode: 'dontAsk',
    env: { DSH_TEST: '1' },
    disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    spawn: () => { throw new Error('unused') },
    ...overrides,
  }
}

function sdkSpawnOptions(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    command: 'claude',
    args: ['--print', 'run'],
    cwd: process.cwd(),
    env: { PATH: '', CLAUDE_CODE_ENTRYPOINT: 'x' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('claudeQueryOptions', () => {
  it('defaults to the lock-down permission mode with disallowed interactive tools', () => {
    const options = claudeQueryOptions(spec(), new AbortController())
    expect(options.permissionMode).toBe('dontAsk')
    expect(options.persistSession).toBe(false)
    expect(options.includePartialMessages).toBe(true)
    expect(options.disallowedTools).toEqual(['AskUserQuestion'])
    expect(options.abortController).toBeInstanceOf(AbortController)
    expect(options.cwd).toBe(process.cwd())
    expect(options.env).toMatchObject({ DSH_TEST: '1' })
    expect('allowDangerouslySkipPermissions' in options).toBe(false)
  })

  it('maps plan mode to disallow both interactive tools', () => {
    const options = claudeQueryOptions(spec({ permissionMode: 'plan' }), new AbortController())
    expect(options.disallowedTools).toEqual(['AskUserQuestion', 'ExitPlanMode'])
    expect('allowDangerouslySkipPermissions' in options).toBe(false)
    expect(typeof options.canUseTool).toBe('function')
  })

  it('maps bypassPermissions to the dangerously-skip flag without a canUseTool hook', () => {
    const options = claudeQueryOptions(spec({ permissionMode: 'bypassPermissions' }), new AbortController())
    expect(options.allowDangerouslySkipPermissions).toBe(true)
    expect(options.canUseTool).toBeUndefined()
  })

  it('forwards permission requests to onToolPermission when provided', async () => {
    const seen: Array<[string, Record<string, unknown>]> = []
    const options = claudeQueryOptions(spec({
      permissionMode: 'default' as ClaudeCodeQuerySpec['permissionMode'],
      onToolPermission: (toolName, input) => {
        seen.push([toolName, input])
        return Promise.resolve(toolName === 'Bash' ? 'allow' : 'deny')
      },
    }), new AbortController())
    expect('allowDangerouslySkipPermissions' in options).toBe(false)
    const allowed = await options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' })
    expect(allowed).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    const denied = await options.canUseTool!('Write', { path: 'x' }, { signal: new AbortController().signal, toolUseID: 't2', requestId: 'r2' })
    expect(denied).toMatchObject({ behavior: 'deny', message: 'The dsh user rejected this action.' })
    expect(seen).toEqual([['Bash', { command: 'ls' }], ['Write', { path: 'x' }]])
  })

  it('auto-answers interactions without an onUnattended reporter', async () => {
    const options = claudeQueryOptions(spec(), new AbortController())
    const denied = await options.canUseTool!('Bash', {}, { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' })
    expect(denied).toMatchObject({ behavior: 'deny' })
    const dialog = await options.onUserDialog!({} as never, { signal: new AbortController().signal })
    expect(dialog).toEqual({ behavior: 'cancelled' })
  })

  it('reports each auto-answered interaction through onUnattended', async () => {
    const reports: string[] = []
    const options = claudeQueryOptions(spec({
      onUnattended: (line) => { reports.push(line) },
    }), new AbortController())
    const denied = await options.canUseTool!('Bash', {}, { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' })
    expect(denied).toMatchObject({ behavior: 'deny' })
    const elicitation = await options.onElicitation!({} as never, { signal: new AbortController().signal })
    expect(elicitation).toEqual({ action: 'decline' })
    const dialog = await options.onUserDialog!({} as never, { signal: new AbortController().signal })
    expect(dialog).toEqual({ behavior: 'cancelled' })
    expect(reports).toHaveLength(3)
    expect(reports[0]).toContain('mode dontAsk')
    expect(reports[1]).toContain('MCP elicitation')
    expect(reports[2]).toContain('user dialog')
  })

  it('spawns the Claude Code process through the shared process owner', () => {
    const child = fakeChild()
    const spawn = vi.fn<ClaudeCodeQuerySpec['spawn']>(() => child.handle)
    const options = claudeQueryOptions(spec({ spawn, disposeGraceMs: 1234 }), new AbortController())
    const managed = options.spawnClaudeCodeProcess!(sdkSpawnOptions())
    expect(managed).toBeInstanceOf(ManagedClaudeCodeProcess)
    expect(spawn).toHaveBeenCalledTimes(1)
    const request = spawn.mock.calls[0]![0]
    expect(request.argv).toEqual(['claude', '--print', 'run'])
    expect(request.cwd).toBe(process.cwd())
    expect(request.graceMs).toBe(1234)
    expect(request.stdio).toEqual({ stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  })

  it('lays deployed environment entries over the scrubbed parent environment', () => {
    const options = claudeQueryOptions(spec({ env: { EXTRA: 'yes' } }), new AbortController())
    expect(options.env?.EXTRA).toBe('yes')
  })
})

describe('unattendedDiagnostic', () => {
  it('renders a stable one-line diagnostic', () => {
    expect(unattendedDiagnostic('dontAsk', 'tool permission', 'denied', 'headless'))
      .toBe('claude-code: tool permission denied (mode dontAsk): headless')
  })
})

describe('claudeSpawnSpec', () => {
  it('requires a workspace', () => {
    expect(() => claudeSpawnSpec(sdkSpawnOptions({ cwd: '' }), 1000))
      .toThrow('omitted its workspace')
    expect(() => claudeSpawnSpec({ command: 'claude', args: [], env: {}, signal: new AbortController().signal }, 1000))
      .toThrow('omitted its workspace')
  })

  it('tombstones ambient names the SDK removed and forwards the signal', () => {
    const options = sdkSpawnOptions({ env: { PATH: '' } })
    const request = claudeSpawnSpec(options, 1000)
    expect(request.env).toMatchObject({ PATH: '' })
    expect(request.env!.HOME).toBeUndefined()
    expect(request.signal).toBe(options.signal)
  })
})

describe('sdkEnvironmentOverlay', () => {
  it('marks scrubbed ambient names absent from the SDK env as undefined', () => {
    const overlay = sdkEnvironmentOverlay({ PATH: '/bin' })
    for (const [name, value] of Object.entries(overlay)) {
      if (name === 'PATH') expect(value).toBe('/bin')
      else expect(value).toBeUndefined()
    }
  })
})

describe('ManagedClaudeCodeProcess', () => {
  it('projects the exit event from the managed outcome', async () => {
    const child = fakeChild()
    const managed = new ManagedClaudeCodeProcess(child.handle)
    const exit = vi.fn()
    managed.on('exit', exit)
    child.settle({ exitCode: 0, signal: null })
    await child.handle.done
    expect(exit).toHaveBeenCalledWith(0, null)
    expect(managed.exitCode).toBe(0)
    expect(managed.signalCode).toBeNull()
    expect(managed.outcome).toEqual({ exitCode: 0, signal: null })
    expect(managed.killed).toBe(false)
  })

  it('projects the error event when the handle rejects', async () => {
    const child = fakeChild()
    const managed = new ManagedClaudeCodeProcess(child.handle)
    const failure = vi.fn()
    managed.once('error', failure)
    const boom = new Error('spawn failed')
    child.fail(boom)
    await expect(child.handle.done).rejects.toBe(boom)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(failure).toHaveBeenCalledWith(boom)
  })

  it('routes kill once to the shared tree termination and then returns false', () => {
    const child = fakeChild()
    const managed = new ManagedClaudeCodeProcess(child.handle)
    expect(managed.kill('SIGTERM')).toBe(true)
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(managed.killed).toBe(true)
    expect(managed.kill('SIGTERM')).toBe(false)
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('returns false for kill after exit', async () => {
    const child = fakeChild()
    const managed = new ManagedClaudeCodeProcess(child.handle)
    child.settle({ exitCode: 1, signal: null })
    await child.handle.done
    expect(managed.kill('SIGKILL')).toBe(false)
    expect(child.terminate).not.toHaveBeenCalled()
  })

  it('removes registered listeners', () => {
    const child = fakeChild()
    const managed = new ManagedClaudeCodeProcess(child.handle)
    const listener = vi.fn()
    managed.on('exit', listener)
    managed.off('exit', listener)
    child.settle({ exitCode: 0, signal: null })
    expect(listener).not.toHaveBeenCalled()
  })

  it('reports a null exit code while the child is still running', () => {
    const child = fakeChild()
    const managed = new ManagedClaudeCodeProcess(child.handle)
    expect(managed.exitCode).toBeNull()
    expect(managed.signalCode).toBeNull()
    expect(managed.outcome).toBeUndefined()
  })
})

describe('permission-mode defaults', () => {
  it('exposes the fixed lock-down default', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('dontAsk')
  })
})
