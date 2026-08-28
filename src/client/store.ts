/**
 * Loop engine selection store: the durable settings scope is the transport,
 * and the store publishes a render-safe snapshot plus the write path.
 * @module dsh-loop-engine/client/store
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { LoopEngineId } from '../settings.ts'

/** State rendered by the loop engine section. */
export interface LoopEngineState {
  status: 'loading' | 'ready' | 'unavailable' | 'saving'
  engine: LoopEngineId
  writable: boolean
  error: string | null
}

/** Narrow a wire section to the stored engine id; an invalid one reads default. */
export function decodeLoopEngine(section: unknown): { engine: LoopEngineId } | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const engine = (section as { engine?: unknown }).engine
  return engine === 'in-process' || engine === 'claude-code' || engine === 'codex' || engine === 'pi'
    ? { engine }
    : undefined
}

/** Coordinates the settings-backed loop engine selection. */
export class LoopEngineStore {
  /** uSES-safe state source shared by the registered settings section. */
  readonly store: SnapshotStore<LoopEngineState> = createSnapshotStore<LoopEngineState>({
    status: 'loading', engine: 'in-process', writable: false, error: null,
  })

  private following: (() => void) | undefined
  private saving = false

  /**
   * @param scope - the loop engine settings namespace scope.
   */
  constructor(private readonly scope: SettingsScope<{ engine: LoopEngineId }>) {}

  /** Begin following the bound scope and publish its current answer. */
  load(): void {
    this.following ??= this.scope.subscribe(() => { this.derive() })
    this.derive()
  }

  /**
   * Persist the selected engine. Success is judged against the snapshot the
   * write left behind, so a refused write reports error after its recovery.
   * @param engine - the engine to select for future Agent turns.
   * @returns whether the write landed.
   */
  async setEngine(engine: LoopEngineId): Promise<boolean> {
    this.saving = true
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    try {
      await this.scope.set('engine', engine)
    } finally {
      this.saving = false
    }
    this.derive()
    const { engine: settled } = this.store.getSnapshot()
    const landed = settled === engine
    if (!landed) {
      this.store.update((state) => {
        state.status = 'unavailable'
        state.error = 'the loop engine selection did not persist'
      })
    }
    return landed
  }

  /** Stop following the scope. */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.saving) return
    const scope = this.scope.getSnapshot()
    switch (scope.status) {
      case 'loading':
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        return
      case 'unavailable':
        this.store.update((state) => {
          state.status = 'unavailable'
          state.engine = 'in-process'
          state.error = null
        })
        return
      case 'ready': {
        const engine = scope.value?.engine ?? 'in-process'
        this.store.update((state) => {
          state.status = 'ready'
          state.engine = engine
          state.writable = scope.writable
          state.error = null
        })
        return
      }
      default: {
        const exhaustive: never = scope.status
        throw new Error(`unexpected loop engine scope status: ${String(exhaustive)}`)
      }
    }
  }
}