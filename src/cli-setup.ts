/**
 * Official Windows CLI installation and non-interactive version checks.
 * Browser callers can select a CLI id only; executable names, arguments,
 * installer URLs, environment values, and shell fragments stay server-owned.
 * @module dsh-loop-engine/cli-setup
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const CLI_IDS = ['claude', 'codex', 'pi', 'kimi'] as const
export type CliId = typeof CLI_IDS[number]
export type CliJobState = 'running' | 'succeeded' | 'failed'

export interface CliStatus {
  readonly cli: CliId
  readonly installed: boolean
  readonly executable: string | null
  readonly version: string | null
  readonly validation: 'not-checked' | 'passed' | 'failed'
  readonly message: string | null
  readonly login: 'manual'
}

export interface CliLaunchResult {
  readonly cli: CliId
  readonly executable: string
}

export interface CliInstallJob {
  readonly id: string
  readonly cli: CliId
  readonly state: CliJobState
  readonly output: string
  readonly error: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
}

export interface CliRestartPreparation {
  readonly launcherPath: string
  readonly installed: readonly CliId[]
  readonly missing: readonly CliId[]
  readonly message: string
}

interface MutableJob {
  id: string
  cli: CliId
  state: CliJobState
  output: string
  error: string | null
  startedAt: number
  finishedAt: number | null
  child: ChildProcess | undefined
  timer: NodeJS.Timeout | undefined
}

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const JOB_TTL_MS = 5 * 60_000
const JOB_TIMEOUT_MS = 10 * 60_000
const VALIDATE_TIMEOUT_MS = 20_000
const MAX_OUTPUT_CHARS = 8_000
const VERSION_ARGS = ['--version'] as const
const INSTALLER = {
  claude: "& (Get-Command npm.cmd -ErrorAction Stop).Source install -g @anthropic-ai/claude-code; exit $LASTEXITCODE",
  codex: "& (Get-Command npm.cmd -ErrorAction Stop).Source install -g @openai/codex@latest; exit $LASTEXITCODE",
  pi: "& (Get-Command npm.cmd -ErrorAction Stop).Source install -g --ignore-scripts @earendil-works/pi-coding-agent; exit $LASTEXITCODE",
  kimi: "$ErrorActionPreference = 'Stop'; Invoke-RestMethod -Uri 'https://code.kimi.com/kimi-code/install.ps1' | Invoke-Expression; if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }",
} satisfies Record<CliId, string>

function isCliId(value: unknown): value is CliId {
  return typeof value === 'string' && (CLI_IDS as readonly string[]).includes(value)
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function redactOutput(value: string): string {
  return value
    .replace(/(sk-ant-[A-Za-z0-9_-]{8,})/gi, '[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{16,})/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(-MAX_OUTPUT_CHARS)
}

function cliCandidates(cli: CliId): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const appData = process.env.APPDATA ?? (home === '' ? '' : join(home, 'AppData', 'Roaming'))
  const known = cli === 'kimi'
    ? home === '' ? [] : [join(home, '.kimi-code', 'bin', 'kimi.exe'), join(home, '.kimi-code', 'bin', 'kimi')]
    : appData === '' ? [] : [join(appData, 'npm', `${cli}.cmd`), join(appData, 'npm', `${cli}.exe`)]
  const pathCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => cli === 'kimi'
      ? [join(directory, 'kimi.exe'), join(directory, 'kimi.cmd'), join(directory, 'kimi')]
      : [join(directory, `${cli}.cmd`), join(directory, `${cli}.exe`), join(directory, cli)])
  return [...new Set([...known.filter((item) => item !== ''), ...pathCandidates])]
}

function findExecutable(cli: CliId): string | undefined {
  return cliCandidates(cli).find((candidate) => existsSync(candidate))
}

function userHome(): string | undefined {
  return process.env.USERPROFILE ?? process.env.HOME
}

function cliLaunchScript(executable: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Set-Location -LiteralPath $env:USERPROFILE",
    `$cli = ${powershellLiteral(executable)}`,
    "Write-Host ('Starting CLI: ' + $cli)",
    '& $cli',
    "if ($LASTEXITCODE -ne $null) { Write-Host ('CLI exited with code ' + $LASTEXITCODE) }",
  ].join('\r\n') + '\r\n'
}

function restartPaths(statuses: readonly CliStatus[]): { app: string; launcher: string; restart: string; additions: string[] } {
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData === undefined || localAppData === '') throw new Error('LOCALAPPDATA is unavailable.')
  const app = join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
  if (!existsSync(app)) throw new Error('The official DeepSeek Harness installation was not found.')
  const root = join(localAppData, 'DSH Official Launcher')
  const appData = process.env.APPDATA ?? (userHome() === undefined ? '' : join(userHome()!, 'AppData', 'Roaming'))
  const home = userHome() ?? ''
  const additions = [
    appData === '' ? '' : join(appData, 'npm'),
    home === '' ? '' : join(home, '.kimi-code', 'bin'),
    ...statuses.flatMap((status) => status.executable === null ? [] : [dirname(status.executable)]),
    ...(process.env.PATH ?? '').split(delimiter).filter((directory) => directory !== ''
      && (existsSync(join(directory, 'node.exe')) || existsSync(join(directory, 'npm.cmd')))),
  ].filter((path) => path !== '' && existsSync(path))
  const uniqueAdditions = [...new Map(additions.map((path) => [path.toLowerCase(), path])).values()]
  return {
    app,
    launcher: join(root, 'Launch Official DSH.ps1'),
    restart: join(root, 'Restart Official DSH.ps1'),
    additions: uniqueAdditions,
  }
}

function launcherScript(app: string, additions: readonly string[]): string {
  const pathPrefix = additions.map((path) => powershellLiteral(path)).join(" + ';' + ")
  return [
    "$ErrorActionPreference = 'Stop'",
    "if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }",
    additions.length === 0 ? "" : `$env:PATH = ${pathPrefix} + ';' + $env:PATH`,
    `$app = ${powershellLiteral(app)}`,
    "Start-Process -FilePath $app -WorkingDirectory (Split-Path -Parent $app)",
  ].filter(Boolean).join('\r\n') + '\r\n'
}

function restartScript(launcher: string): string {
  return [
    'param([Parameter(Mandatory = $true)][int]$ParentPid)',
    "$ErrorActionPreference = 'Stop'",
    '$deadline = (Get-Date).AddMinutes(30)',
    'while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }',
    'if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { exit 2 }',
    `& ${powershellLiteral(launcher)}`,
    'exit $LASTEXITCODE',
  ].join('\r\n') + '\r\n'
}

function terminateProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.unref()
  }
  child.kill()
}

function runPowerShell(script: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('CLI setup is currently supported only on Windows.'))
      return
    }
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { cwd: userHome(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      terminateProcessTree(child)
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds.`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: redactOutput(stdout), stderr: redactOutput(stderr) })
    })
  })
}

async function runVersion(executable: string): Promise<CommandResult> {
  const script = `& ${powershellLiteral(executable)} ${VERSION_ARGS[0]}; exit $LASTEXITCODE`
  return runPowerShell(script, VALIDATE_TIMEOUT_MS)
}

function asStatus(cli: CliId, values: Partial<CliStatus> = {}): CliStatus {
  return {
    cli,
    installed: values.installed ?? false,
    executable: values.executable ?? null,
    version: values.version ?? null,
    validation: values.validation ?? 'not-checked',
    message: values.message ?? null,
    login: 'manual',
  }
}

/** Owns fixed installers and their short-lived jobs. */
export class CliSetupManager {
  private readonly jobs = new Map<string, MutableJob>()
  private readonly activeByCli = new Map<CliId, string>()
  private disposed = false

  /** Read the current installation and launchability of one CLI. */
  async status(cli: CliId): Promise<CliStatus> {
    if (process.platform !== 'win32') return asStatus(cli, { message: 'CLI setup is currently supported only on Windows.' })
    const executable = findExecutable(cli)
    if (executable === undefined) return asStatus(cli, { message: 'Not installed.' })
    return asStatus(cli, { installed: true, executable })
  }

  /** Validate only by running the CLI's version flag; auth is deliberately not checked. */
  async validate(cli: CliId): Promise<CliStatus> {
    const current = await this.status(cli)
    if (!current.installed || current.executable === null) return current
    try {
      const result = await runVersion(current.executable)
      const version = result.stdout.trim().split(/\r?\n/, 1)[0] || null
      if (result.code !== 0 || version === null) {
        return asStatus(cli, {
          installed: true,
          executable: current.executable,
          validation: 'failed',
          message: (result.stderr || result.stdout || `Exit code ${result.code}`).trim(),
        })
      }
      return asStatus(cli, { installed: true, executable: current.executable, version, validation: 'passed' })
    } catch (error) {
      return asStatus(cli, {
        installed: true,
        executable: current.executable,
        validation: 'failed',
        message: error instanceof Error ? error.message : 'Version check failed.',
      })
    }
  }

  /** Write a per-user script and launch one detected CLI in its own interactive terminal. */
  async launch(cli: CliId): Promise<CliLaunchResult> {
    if (process.platform !== 'win32') throw new Error('CLI launch is currently supported only on Windows.')
    const executable = findExecutable(cli)
    if (executable === undefined) throw new Error(`${cli} is not installed.`)
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData === undefined || localAppData === '') throw new Error('LOCALAPPDATA is unavailable.')
    const launcherDirectory = join(localAppData, 'DSH Official Launcher', 'CLI')
    const launcherPath = join(launcherDirectory, `${cli}.ps1`)
    mkdirSync(launcherDirectory, { recursive: true })
    writeFileSync(launcherPath, cliLaunchScript(executable), { encoding: 'utf8' })
    // Electron's detached child has no console on Windows. Use cmd's `start`
    // builtin to create a separate console process, then run the PowerShell
    // launcher inside that console so the CLI TUI receives interactive stdin.
    const child = spawn('cmd.exe', [
      '/d', '/c', 'start', '', 'powershell.exe',
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', launcherPath,
    ], {
      cwd: userHome(), detached: true, windowsHide: true, stdio: 'ignore',
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
    return { cli, executable }
  }

  /** Read each CLI state without allowing one failed check to hide the others. */
  async statuses(): Promise<CliStatus[]> {
    return Promise.all(CLI_IDS.map(async (cli) => await this.status(cli)))
  }

  /** Validate installed CLIs, save a per-user official-app launcher, and queue restart after DSH exits. */
  async prepareRestart(): Promise<CliRestartPreparation> {
    if (process.platform !== 'win32') throw new Error('Restart preparation is currently supported only on Windows.')
    const statuses = await Promise.all(CLI_IDS.map(async (cli) => await this.validate(cli)))
    const installed = statuses.filter((status) => status.installed).map((status) => status.cli)
    const missing = statuses.filter((status) => !status.installed).map((status) => status.cli)
    const failed = statuses.filter((status) => status.installed && status.validation !== 'passed')
    if (failed.length > 0) {
      const details = failed.map((status) => `${status.cli}: ${status.message ?? 'version check failed'}`).join('; ')
      throw new Error(`Fix the failed CLI checks before restarting: ${details}`)
    }
    if (installed.length === 0) throw new Error('No installed CLI was found. Install at least one CLI before preparing the restart.')

    const paths = restartPaths(statuses)
    const script = launcherScript(paths.app, paths.additions)
    mkdirSync(dirname(paths.launcher), { recursive: true })
    writeFileSync(paths.launcher, script, { encoding: 'utf8' })
    writeFileSync(paths.restart, restartScript(paths.launcher), { encoding: 'utf8' })

    const helper = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', paths.restart, '-ParentPid', String(process.ppid),
    ], { cwd: userHome(), detached: true, windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      helper.once('spawn', resolve)
      helper.once('error', reject)
    })
    helper.unref()
    const absent = missing.length === 0 ? '' : ` Missing: ${missing.join(', ')}.`
    return {
      launcherPath: paths.launcher,
      installed,
      missing,
      message: `Environment validated. Exit DSH normally; the official app will reopen with the prepared CLI paths.${absent}`,
    }
  }

  /** Start one allowlisted official installer, reusing an active job for duplicate clicks. */
  startInstall(cli: CliId): CliInstallJob {
    if (this.disposed) throw new Error('CLI setup manager is closed.')
    if (process.platform !== 'win32') throw new Error('CLI setup is currently supported only on Windows.')
    const activeId = this.activeByCli.get(cli)
    if (activeId !== undefined) {
      const active = this.jobs.get(activeId)
      if (active !== undefined && active.state === 'running') return this.snapshot(active)
    }
    const job: MutableJob = {
      id: randomUUID(), cli, state: 'running', output: '', error: null,
      startedAt: Date.now(), finishedAt: null, child: undefined, timer: undefined,
    }
    this.jobs.set(job.id, job)
    this.activeByCli.set(cli, job.id)
    this.pruneJobs()
    void this.executeInstall(job)
    return this.snapshot(job)
  }

  /** Return an active or recently completed job snapshot. */
  job(jobId: string): CliInstallJob | undefined {
    this.pruneJobs()
    const job = this.jobs.get(jobId)
    return job === undefined ? undefined : this.snapshot(job)
  }

  /** Stop active child processes and expire all jobs when the owning plugin is disposed. */
  dispose(): void {
    this.disposed = true
    for (const job of this.jobs.values()) {
      if (job.timer !== undefined) clearTimeout(job.timer)
      if (job.state === 'running' && job.child !== undefined) terminateProcessTree(job.child)
    }
    this.jobs.clear()
    this.activeByCli.clear()
  }

  private async executeInstall(job: MutableJob): Promise<void> {
    try {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', INSTALLER[job.cli],
      ], { cwd: userHome(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      job.child = child
      const finish = (code: number, detail = ''): void => {
        if (job.state !== 'running') return
        if (job.timer !== undefined) clearTimeout(job.timer)
        job.timer = undefined
        job.child = undefined
        job.finishedAt = Date.now()
        job.state = code === 0 ? 'succeeded' : 'failed'
        job.error = code === 0 ? null : redactOutput(detail || `Installer exited with code ${code}.`)
        // The live output is only a progress tail. Keep only a sanitized failure
        // summary after termination; successful output and raw logs are dropped.
        job.output = ''
        this.activeByCli.delete(job.cli)
        this.pruneJobs()
      }
      const collect = (chunk: Buffer): void => { job.output = redactOutput(job.output + chunk.toString('utf8')) }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      job.timer = setTimeout(() => {
        if (job.child !== undefined) terminateProcessTree(job.child)
        finish(-1, 'Installer timed out after 10 minutes.')
      }, JOB_TIMEOUT_MS)
      child.once('error', (error) => finish(-1, error.message))
      child.once('close', (code) => finish(code ?? -1, job.output))
    } catch (error) {
      job.finishedAt = Date.now()
      job.state = 'failed'
      job.error = redactOutput(error instanceof Error ? error.message : 'Installer could not start.')
      this.activeByCli.delete(job.cli)
    }
  }

  private snapshot(job: MutableJob): CliInstallJob {
    return {
      id: job.id,
      cli: job.cli,
      state: job.state,
      output: job.output,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }
  }

  private pruneJobs(): void {
    const expiredBefore = Date.now() - JOB_TTL_MS
    for (const [id, job] of this.jobs) {
      if (job.state !== 'running' && job.finishedAt !== null && job.finishedAt < expiredBefore) this.jobs.delete(id)
    }
    while (this.jobs.size > 24) {
      const oldest = this.jobs.keys().next().value as string | undefined
      if (oldest === undefined) break
      const job = this.jobs.get(oldest)
      if (job?.state === 'running') break
      this.jobs.delete(oldest)
    }
  }
}

/** Plugin-owned management Remote for official CLI installation and validation. */
export class CliSetupRemote extends TypertRemoteService {
  private readonly manager: CliSetupManager

  constructor(ctx: Context, manager: CliSetupManager) {
    super(ctx, 'cliSetup')
    this.manager = manager
  }

  /** Current status for the fixed CLI roster. */
  @Remote('status')
  async status(): Promise<CliStatus[]> {
    return await this.manager.statuses()
  }

  /** Run the fixed version check for one known CLI. */
  @Remote('validate')
  async validate(request: { cli: string }): Promise<CliStatus> {
    if (!isCliId(request?.cli)) throw new RemoteError('gateway/bad-request', 'cli must be claude, codex, pi, or kimi', {})
    return await this.manager.validate(request.cli)
  }

  /** Open a detected CLI in its own interactive terminal. */
  @Remote('launch')
  async launch(request: { cli: string }): Promise<CliLaunchResult> {
    if (!isCliId(request?.cli)) throw new RemoteError('gateway/bad-request', 'cli must be claude, codex, pi, or kimi', {})
    try {
      return await this.manager.launch(request.cli)
    } catch (error) {
      throw new RemoteError('gateway/bad-request', error instanceof Error ? error.message : 'could not launch CLI', {})
    }
  }

  /** Start the official installer for one known CLI. */
  @Remote('startInstall')
  async startInstall(request: { cli: string }): Promise<CliInstallJob> {
    if (!isCliId(request?.cli)) throw new RemoteError('gateway/bad-request', 'cli must be claude, codex, pi, or kimi', {})
    try {
      return this.manager.startInstall(request.cli)
    } catch (error) {
      throw new RemoteError('gateway/bad-request', error instanceof Error ? error.message : 'could not start installer', {})
    }
  }

  /** Read progress for a known in-memory installer job. */
  @Remote('jobStatus')
  async jobStatus(request: { jobId: string }): Promise<CliInstallJob> {
    const jobId = request?.jobId
    if (typeof jobId !== 'string' || jobId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'jobId must be a non-empty string', {})
    }
    const job = this.manager.job(jobId)
    if (job === undefined) throw new RemoteError('gateway/bad-request', 'installer job is unknown or expired', {})
    return job
  }

  /** Verify installed CLIs and schedule the official app to reopen after this app exits. */
  @Remote('prepareRestart')
  async prepareRestart(): Promise<CliRestartPreparation> {
    try {
      return await this.manager.prepareRestart()
    } catch (error) {
      throw new RemoteError('gateway/bad-request', error instanceof Error ? error.message : 'could not prepare restart', {})
    }
  }
}
