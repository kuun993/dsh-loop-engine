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
  showInComposer: boolean
  writable: boolean
  error: string | null
}

/** Narrow a wire section to the stored engine id and display toggle; an invalid one reads default. */
export function decodeLoopEngine(section: unknown): { engine: LoopEngineId; showInComposer: boolean } | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const { engine, showInComposer } = section as { engine?: unknown; showInComposer?: unknown }
  if (engine !== 'in-process' && engine !== 'claude-code' && engine !== 'codex' && engine !== 'pi' && engine !== 'kimi') {
    return undefined
  }
  // Absent or non-boolean reads true: the composer picker stays visible unless
  // the setting explicitly clears it.
  return { engine, showInComposer: showInComposer !== false }
}

/** Coordinates the settings-backed loop engine selection. */
export class LoopEngineStore {
  /** uSES-safe state source shared by the registered settings section. */
  readonly store: SnapshotStore<LoopEngineState> = createSnapshotStore<LoopEngineState>({
    status: 'loading', engine: 'in-process', showInComposer: true, writable: false, error: null,
  })

  private following: (() => void) | undefined
  private saving = false

  /**
   * @param scope - the loop engine settings namespace scope.
   */
  constructor(private readonly scope: SettingsScope<{ engine: LoopEngineId; showInComposer: boolean }>) {}

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

  /**
   * Persist whether the composer shows the engine picker. Success is judged
   * against the snapshot the write left behind, so a refused write reports
   * error after its recovery. Unlike {@link setEngine}, landing does not reload
   * the page — the toggle only changes composer visibility.
   * @param show - whether the chat page composer reveals the engine picker.
   * @returns whether the write landed.
   */
  async setShowInComposer(show: boolean): Promise<boolean> {
    this.saving = true
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    try {
      await this.scope.set('showInComposer', show)
    } finally {
      this.saving = false
    }
    this.derive()
    const { showInComposer: settled } = this.store.getSnapshot()
    const landed = settled === show
    if (!landed) {
      this.store.update((state) => {
        state.status = 'unavailable'
        state.error = 'the loop engine display setting did not persist'
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
          state.showInComposer = true
          state.error = null
        })
        return
      case 'ready': {
        const engine = scope.value?.engine ?? 'in-process'
        const showInComposer = scope.value?.showInComposer ?? true
        this.store.update((state) => {
          state.status = 'ready'
          state.engine = engine
          state.showInComposer = showInComposer
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