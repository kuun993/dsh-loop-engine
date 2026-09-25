/**
 * Loop engine selection store: a settings transport is the channel, and the
 * store publishes a render-safe snapshot plus the write path. The transport is
 * abstracted so one store follows either generation's client service — the
 * 0.1.7 `ConfigForm` for the plugin's own profile entry, or the 0.1.5
 * `SettingsScope` for its `agent-loop-engine` settings section.
 * @module dsh-loop-engine/client/store
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LoopEngineId } from '../agent-preset-ids.ts'
import type { LoopEngineSettings } from '../settings.ts'

/** State rendered by the loop engine section. */
export interface LoopEngineState {
  status: 'loading' | 'ready' | 'unavailable' | 'saving'
  engine: LoopEngineId
  showInComposer: boolean
  writable: boolean
  error: string | null
}

/** The render-relevant slice of a settings snapshot, shared by both generations' transports. */
export interface LoopEngineSettingsSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: LoopEngineSettings | undefined
  writable: boolean
}

/**
 * The settings channel the store follows. Satisfied by the 0.1.7 `ConfigForm`
 * and by the 0.1.5 `SettingsScope` (through a thin adapter in `./index.ts`); the
 * write's boolean is optional because the 0.1.5 scope reports acceptance only
 * through the snapshot it leaves behind.
 */
export interface LoopEngineSettingsTransport {
  /** @returns the current sync snapshot. */
  getSnapshot(): LoopEngineSettingsSnapshot
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing the listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Persist one field.
   * @param field - the field to write.
   * @param value - the value to write.
   * @returns whether the write was accepted, when the transport reports it.
   */
  set(field: 'engine' | 'showInComposer', value: unknown): Promise<boolean | void>
}

/**
 * Narrow a wire section to the stored engine id and display toggle; an invalid
 * one reads default. Used by the 0.1.5 `settingsScope.bind` decoder, whose scope
 * receives raw wire sections.
 * @param section - the wire section value.
 * @returns the decoded selection, or `undefined` when the section is unusable.
 */
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
   * @param transport - the settings channel the store follows.
   */
  constructor(private readonly transport: LoopEngineSettingsTransport) {}

  /** Begin following the transport and publish its current answer. */
  load(): void {
    this.following ??= this.transport.subscribe(() => { this.derive() })
    this.derive()
  }

  /**
   * Persist the selected engine. Success is the transport's accepted answer
   * (when it reports one) checked against the snapshot the write left behind,
   * so a refused write reports error after its recovery.
   * @param engine - the engine to select for future Agent turns.
   * @returns whether the write landed.
   */
  async setEngine(engine: LoopEngineId): Promise<boolean> {
    this.saving = true
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    let accepted: boolean | void = true
    try {
      accepted = await this.transport.set('engine', engine)
    } finally {
      this.saving = false
    }
    this.derive()
    const landed = accepted !== false && this.store.getSnapshot().engine === engine
    if (!landed) {
      this.store.update((state) => {
        state.status = 'unavailable'
        state.error = 'the loop engine selection did not persist'
      })
    }
    return landed
  }

  /**
   * Persist whether the composer shows the engine picker. Unlike
   * {@link setEngine}, landing does not reload the page — the toggle only
   * changes composer visibility.
   * @param show - whether the chat page composer reveals the engine picker.
   * @returns whether the write landed.
   */
  async setShowInComposer(show: boolean): Promise<boolean> {
    this.saving = true
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    let accepted: boolean | void = true
    try {
      accepted = await this.transport.set('showInComposer', show)
    } finally {
      this.saving = false
    }
    this.derive()
    const landed = accepted !== false && this.store.getSnapshot().showInComposer === show
    if (!landed) {
      this.store.update((state) => {
        state.status = 'unavailable'
        state.error = 'the loop engine display setting did not persist'
      })
    }
    return landed
  }

  /** Stop following the transport. */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.saving) return
    const snapshot = this.transport.getSnapshot()
    switch (snapshot.status) {
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
        const engine = snapshot.value?.engine ?? 'in-process'
        const showInComposer = snapshot.value?.showInComposer ?? true
        this.store.update((state) => {
          state.status = 'ready'
          state.engine = engine
          state.showInComposer = showInComposer
          state.writable = snapshot.writable
          state.error = null
        })
        return
      }
      default: {
        const exhaustive: never = snapshot.status
        throw new Error(`unexpected loop engine form status: ${String(exhaustive)}`)
      }
    }
  }
}
