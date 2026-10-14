/**
 * Browser adapter for the plugin's fixed-command CLI setup Remote.
 * @module dsh-loop-engine/client/cli-setup
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CliId, CliInstallJob, CliLaunchResult, CliRestartPreparation, CliStatus } from '../cli-setup.ts'

const PACKAGE = 'dsh-loop-engine'
const NAMESPACE = 'cliSetup'
const CLI_IDS: readonly CliId[] = ['claude', 'codex', 'pi', 'kimi']

interface Schema<T> {
  parse(value: unknown): T
}

interface Codec<T> {
  readonly mode: 'strict'
  readonly typeSymbol: string
  readonly schema: Schema<T>
  readonly create: () => Schema<T>
}

interface RemoteDescriptor {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly invocation: { readonly kind: 'direct' }
  readonly parameters: readonly {
    readonly name: string
    readonly wire: string
    readonly source: 'json'
    readonly codec: Codec<unknown>
  }[]
  readonly result: Codec<unknown>
}

export interface CliSetupRemoteFace {
  status(): Promise<RemoteResult<CliStatus[]>>
  validate(request: { cli: CliId }): Promise<RemoteResult<CliStatus>>
  launch(request: { cli: CliId }): Promise<RemoteResult<CliLaunchResult>>
  startInstall(request: { cli: CliId }): Promise<RemoteResult<CliInstallJob>>
  jobStatus(request: { jobId: string }): Promise<RemoteResult<CliInstallJob>>
  prepareRestart(): Promise<RemoteResult<CliRestartPreparation>>
}

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

export interface CliSetupSnapshot {
  readonly loading: boolean
  readonly statuses: Readonly<Partial<Record<CliId, CliStatus>>>
  readonly jobs: Readonly<Partial<Record<CliId, CliInstallJob>>>
  readonly launching: CliId | null
  readonly restartBusy: boolean
  readonly restartPreparation: CliRestartPreparation | null
  readonly error: string | null
}

function parseCliId(value: unknown): CliId {
  if (typeof value === 'string' && (CLI_IDS as readonly string[]).includes(value)) return value as CliId
  throw new TypeError('Unknown CLI id')
}

function parseStatus(value: unknown): CliStatus {
  const item = value as Partial<CliStatus> | null
  if (item === null || item === undefined) throw new TypeError('Invalid CLI status')
  const cli = parseCliId(item.cli)
  if (typeof item.installed !== 'boolean'
    || !(item.executable === null || typeof item.executable === 'string')
    || !(item.version === null || typeof item.version === 'string')
    || !(['not-checked', 'passed', 'failed'] as const).includes(item.validation as CliStatus['validation'])
    || !(item.message === null || typeof item.message === 'string')
    || item.login !== 'manual') throw new TypeError('Invalid CLI status fields')
  return item as CliStatus & { cli: typeof cli }
}

function parseStatuses(value: unknown): CliStatus[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid CLI status roster')
  return value.map(parseStatus)
}

function parseLaunchResult(value: unknown): CliLaunchResult {
  const item = value as Partial<CliLaunchResult> | null
  if (item === null || item === undefined || typeof item.executable !== 'string') {
    throw new TypeError('Invalid CLI launch result')
  }
  return { cli: parseCliId(item.cli), executable: item.executable }
}

function unwrapRemoteResult<T>(value: unknown): T {
  const result = value as Partial<RemoteResult<T>> | null | undefined
  if (result?.ok === true && 'value' in result) return result.value as T
  if (result?.ok === false) {
    const message = typeof result.error?.message === 'string' ? result.error.message : 'CLI setup request failed.'
    throw new Error(message)
  }
  throw new TypeError('Invalid CLI Remote result')
}

function parseJob(value: unknown): CliInstallJob {
  const item = value as Partial<CliInstallJob> | null
  if (item === null || item === undefined) throw new TypeError('Invalid CLI install job')
  const cli = parseCliId(item.cli)
  if (typeof item.id !== 'string' || item.id.length === 0
    || !(['running', 'succeeded', 'failed'] as const).includes(item.state as CliInstallJob['state'])
    || typeof item.output !== 'string'
    || !(item.error === null || typeof item.error === 'string')
    || typeof item.startedAt !== 'number'
    || !(item.finishedAt === null || typeof item.finishedAt === 'number')) {
    throw new TypeError('Invalid CLI install job fields')
  }
  return item as CliInstallJob & { cli: typeof cli }
}

function parseRestartPreparation(value: unknown): CliRestartPreparation {
  const item = value as Partial<CliRestartPreparation> | null
  if (item === null || item === undefined || typeof item.launcherPath !== 'string' || typeof item.message !== 'string'
    || !Array.isArray(item.installed) || !Array.isArray(item.missing)) throw new TypeError('Invalid restart preparation')
  return {
    launcherPath: item.launcherPath,
    message: item.message,
    installed: item.installed.map(parseCliId),
    missing: item.missing.map(parseCliId),
  }
}

function codec<T>(method: string, side: 'request' | 'result', schema: Schema<T>): Codec<T> {
  return {
    mode: 'strict',
    typeSymbol: `${PACKAGE}#${NAMESPACE}/${method}:${side}`,
    schema,
    create: () => schema,
  }
}

function descriptor(method: string, request: Schema<unknown> | undefined, result: Schema<unknown>): RemoteDescriptor {
  return {
    id: `${PACKAGE}#${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: request === undefined ? [] : [{
      name: 'request', wire: 'request', source: 'json', codec: codec(method, 'request', request),
    }],
    result: codec(method, 'result', result),
  }
}

const cliRequest: Schema<{ cli: CliId }> = {
  parse(value: unknown) { return { cli: parseCliId((value as { cli?: unknown } | null)?.cli) } },
}
const jobRequest: Schema<{ jobId: string }> = {
  parse(value: unknown) {
    const jobId = (value as { jobId?: unknown } | null)?.jobId
    if (typeof jobId !== 'string' || jobId.length === 0) throw new TypeError('jobId must be non-empty')
    return { jobId }
  },
}
const statusSchema: Schema<CliStatus> = { parse: parseStatus }
const statusesSchema: Schema<CliStatus[]> = { parse: parseStatuses }
const launchSchema: Schema<CliLaunchResult> = { parse: parseLaunchResult }
const jobSchema: Schema<CliInstallJob> = { parse: parseJob }
const restartPreparationSchema: Schema<CliRestartPreparation> = { parse: parseRestartPreparation }

export const CLI_SETUP_REMOTE_DESCRIPTORS: readonly RemoteDescriptor[] = [
  descriptor('status', undefined, statusesSchema),
  descriptor('validate', cliRequest, statusSchema),
  descriptor('launch', cliRequest, launchSchema),
  descriptor('startInstall', cliRequest, jobSchema),
  descriptor('jobStatus', jobRequest, jobSchema),
  descriptor('prepareRestart', undefined, restartPreparationSchema),
]

type Listener = (snapshot: CliSetupSnapshot) => void

/** Small observable facade consumed by the settings cards. */
export class CliSetupClient {
  private remote: CliSetupRemoteFace | undefined
  private snapshot: CliSetupSnapshot = { loading: true, statuses: {}, jobs: {}, launching: null, restartBusy: false, restartPreparation: null, error: null }
  private readonly listeners = new Set<Listener>()
  private readonly pollers = new Map<CliId, ReturnType<typeof setInterval>>()
  private disposed = false

  /** Read the latest immutable-ish snapshot. */
  getSnapshot = (): CliSetupSnapshot => this.snapshot

  /** Subscribe to a replacement snapshot. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Attach the host Remote and load the current state. */
  attach(remote: CliSetupRemoteFace | undefined): void {
    this.remote = remote
    if (remote === undefined) {
      this.update({ loading: false, error: 'CLI setup Remote is unavailable.' })
      return
    }
    void this.load()
  }

  /** Load all CLI states. */
  async load(): Promise<void> {
    const remote = this.remote
    if (remote === undefined || this.disposed) return
    this.update({ loading: true, error: null })
    try {
      const statuses = parseStatuses(unwrapRemoteResult(await remote.status()))
      const next: Partial<Record<CliId, CliStatus>> = {}
      for (const status of statuses) next[status.cli] = status
      this.update({ loading: false, statuses: next, error: null })
    } catch (error) {
      this.update({ loading: false, error: this.errorText(error) })
    }
  }

  /** Run the fixed version check. */
  async validate(cli: CliId): Promise<void> {
    const remote = this.remote
    if (remote === undefined || this.disposed) return
    this.update({ error: null })
    try {
      this.setStatus(parseStatus(unwrapRemoteResult(await remote.validate({ cli }))))
    } catch (error) {
      this.update({ error: this.errorText(error) })
    }
  }

  /** Open the installed CLI in its own interactive PowerShell window. */
  async launch(cli: CliId): Promise<void> {
    const remote = this.remote
    if (remote === undefined || this.disposed) return
    this.update({ error: null, launching: cli })
    try {
      parseLaunchResult(unwrapRemoteResult(await remote.launch({ cli })))
      this.update({ launching: null })
    } catch (error) {
      this.update({ launching: null, error: this.errorText(error) })
    }
  }

  /** Start installation and begin bounded progress polling. */
  async startInstall(cli: CliId): Promise<void> {
    const remote = this.remote
    if (remote === undefined || this.disposed) return
    this.update({ error: null })
    try {
      const job = parseJob(unwrapRemoteResult(await remote.startInstall({ cli })))
      this.setJob(job)
      if (job.state === 'running') this.startPolling(cli, job.id)
      else await this.load()
    } catch (error) {
      this.update({ error: this.errorText(error) })
    }
  }

  /** Validate installed CLI versions and arrange a relaunch after normal DSH exit. */
  async prepareRestart(): Promise<void> {
    const remote = this.remote
    if (remote === undefined || this.disposed) return
    this.update({ error: null, restartBusy: true, restartPreparation: null })
    try {
      const result = parseRestartPreparation(unwrapRemoteResult(await remote.prepareRestart()))
      this.update({ restartBusy: false, restartPreparation: result })
      await this.load()
    } catch (error) {
      this.update({ restartBusy: false, error: this.errorText(error) })
    }
  }

  /** Dispose pollers and detach the Remote. */
  dispose(): void {
    this.disposed = true
    this.remote = undefined
    for (const timer of this.pollers.values()) clearInterval(timer)
    this.pollers.clear()
    this.listeners.clear()
  }

  private startPolling(cli: CliId, jobId: string): void {
    const existing = this.pollers.get(cli)
    if (existing !== undefined) clearInterval(existing)
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - startedAt > 11 * 60_000) {
        this.stopPolling(cli)
        this.update({ error: 'Installer status polling timed out.' })
        return
      }
      void this.poll(cli, jobId)
    }, 1200)
    this.pollers.set(cli, timer)
    void this.poll(cli, jobId)
  }

  private async poll(cli: CliId, jobId: string): Promise<void> {
    const remote = this.remote
    if (remote === undefined || this.disposed) return
    try {
      const job = parseJob(unwrapRemoteResult(await remote.jobStatus({ jobId })))
      this.setJob(job)
      if (job.state !== 'running') {
        this.stopPolling(cli)
        await this.load()
      }
    } catch (error) {
      this.stopPolling(cli)
      this.update({ error: this.errorText(error) })
    }
  }

  private stopPolling(cli: CliId): void {
    const timer = this.pollers.get(cli)
    if (timer !== undefined) clearInterval(timer)
    this.pollers.delete(cli)
  }

  private setStatus(status: CliStatus): void {
    this.update({ statuses: { ...this.snapshot.statuses, [status.cli]: status } })
  }

  private setJob(job: CliInstallJob): void {
    this.update({ jobs: { ...this.snapshot.jobs, [job.cli]: job } })
  }

  private update(patch: Partial<CliSetupSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener(this.snapshot)
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : 'CLI setup request failed.'
  }
}

/** Create and own the CLI setup client; the loop-engine Remote mounts both namespaces. */
export function createCliSetupClient(ctx: Context): CliSetupClient {
  const client = new CliSetupClient()
  ctx.effect(() => () => { client.dispose() }, 'loop-engine: CLI setup client lifecycle')
  return client
}
