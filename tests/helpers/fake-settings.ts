/**
 * Shared stand-ins for the two settings-shaped things a host composition now
 * supplies, both of which the harness's real implementations own and this
 * package does not depend on:
 *
 *  - the profile-backed settings SERVICE (`ctx.settings`,
 *    `@deepseek-ai/dsh-settings` as of the profile-entry model), which the
 *    plugin reads through two structural interfaces only:
 *    `SettingsMutator` (`mutate`, optional `describe`) for the roster default,
 *    and the descriptor's `base` layer for the deployment's composed default
 *    model;
 *  - the plugin's OWN live Config fields (`engine`, `showInComposer`), which the
 *    running plugin reads through their references (`config.engine.get()`) and
 *    which a committed edit signals with a `settings/document-updated` event.
 *
 * The service is provided on the calling context (`ctx.provide('settings', …)`),
 * so a test that needs it to detach can run the returned disposer.
 *
 * @module tests/helpers/fake-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { LoopEngineId } from '../../src/agent-preset-ids.ts'
import { LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL, LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../../src/namespace.ts'
import { LEGACY_HARNESS } from './harness-generation.ts'

/** One settings namespace's layers, as the plugin reads them. */
export interface FakeSection {
  /** Resolved value (`base`, then the registered value, then any seeded user layer). */
  value: Record<string, unknown>
  /** The composition's own layer, when the host declared one. */
  base?: Record<string, unknown>
}

/** Structural stand-in for the profile-backed settings service. */
export interface FakeSettings {
  /** Register this instance's page policy; the plugin's own row is a no-op here. */
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
  /** One descriptor per registered namespace (the roster attach check and `base` read). */
  describe(): { ns: string; value: unknown; base?: unknown }[]
  /** Apply path ops to a namespace's value; rejects when it is not registered. */
  mutate(ns: string, ops: readonly SettingsPathOp[]): Promise<void>
  /** Merge a patch into a namespace's value; rejects when it is not registered. */
  update(ns: string, patch: Record<string, unknown>): Promise<void>
  /**
   * 0.1.5: attach a settings section the shell drives. Registers the namespace
   * with `entry` as its base, hands the consumer a source thunk, then fires
   * `onChange` once (the attach notification the real provider emits).
   */
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: Record<string, unknown>,
    hooks: { setSource: (current: () => unknown) => void; onChange: () => void },
  ): void
  /**
   * 0.1.5: commit a value into an installed section and fire its `onChange`,
   * the way a user edit reaches the plugin.
   */
  commitSection(ns: string, patch: Record<string, unknown>): void
  /** Test-only: seed/inspect a namespace's layers. */
  register(ns: string, init?: { value?: Record<string, unknown>; base?: Record<string, unknown> }): FakeSection
  /** The registered sections, addressed by namespace. */
  sections: Map<string, FakeSection>
  /** Unregister the service from the context (a profile reload dropping it). */
  dispose(): void
}

/** Read one namespace's resolved value, or undefined before it registers. */
export function sectionValue(settings: FakeSettings, ns: string): Record<string, unknown> | undefined {
  return settings.sections.get(ns)?.value
}

/** Read one field of a namespace's resolved value. */
export function sectionField<T>(settings: FakeSettings, ns: string, field: string): T | undefined {
  return sectionValue(settings, ns)?.[field] as T | undefined
}

/**
 * Install the settings service on `ctx`.
 *
 * @param ctx - the context the service belongs to.
 * @param seeds - per-namespace user layers merged over whatever a later
 *   `register` declares (how a test pre-answers "the deployment had chosen X").
 * @returns the service, with a `dispose` that unregisters it.
 */
export function installFakeSettings(
  ctx: Context,
  seeds: Record<string, Record<string, unknown>> = {},
): FakeSettings {
  const sections = new Map<string, FakeSection>()
  /** Installed 0.1.5 sections' change hooks, keyed by namespace. */
  const sectionHooks = new Map<string, () => void>()

  const service: FakeSettings = {
    sections,
    configure: () => () => {},
    describe: () => [...sections].map(([ns, section]) => ({
      ns,
      value: section.value,
      ...section.base === undefined ? {} : { base: section.base },
    })),
    async mutate(ns, ops) {
      const section = sections.get(ns)
      if (section === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
      for (const op of ops) {
        if (op.op === 'unset') {
          delete section.value[op.path[op.path.length - 1]!]
          continue
        }
        section.value[op.path[op.path.length - 1]!] = op.value
      }
    },
    async update(ns, patch) {
      const section = sections.get(ns)
      if (section === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
      Object.assign(section.value, patch)
    },
    register(ns, init) {
      const base = init?.base
      const section: FakeSection = {
        value: { ...(base ?? {}), ...(init?.value ?? {}), ...(seeds[ns] ?? {}) },
      }
      if (base !== undefined) section.base = { ...base }
      sections.set(ns, section)
      return section
    },
    installSection(_owner, ns, _schema, entry, hooks) {
      const section = service.register(ns, { base: entry })
      hooks.setSource(() => section.value)
      sectionHooks.set(ns, hooks.onChange)
      hooks.onChange()
    },
    commitSection(ns, patch) {
      const section = sections.get(ns)
      if (section === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
      Object.assign(section.value, patch)
      sectionHooks.get(ns)?.()
    },
    dispose: () => { dispose() },
  }

  const dispose = ctx.provide('settings', service as never)
  return service
}

/**
 * The plugin's own two live Config fields, as the profile's Loader supplies them.
 *
 * A committed edit is two things at once: the reference's new value and the
 * `settings/document-updated` event the plugin steers off. `setEngine` /
 * `setShowInComposer` do both, so a test drives the running plugin exactly the
 * way the settings shell does.
 */
export interface LiveLoopConfig {
  /** The references to hand `apply` as its `engine` / `showInComposer` config fields. */
  readonly config: {
    engine: { get(): LoopEngineId }
    showInComposer: { get(): boolean }
  }
  /** Commit a new default engine and notify the plugin. */
  setEngine(engine: LoopEngineId): void
  /** Commit a new composer-picker visibility and notify the plugin. */
  setShowInComposer(show: boolean): void
  /** The current default engine. */
  engine(): LoopEngineId
  /** The current composer-picker visibility. */
  showInComposer(): boolean
}

/**
 * Build the two references `apply` requires, plus the commit helpers.
 *
 * The commit path is generation-aware so one spec drives either harness: on the
 * 0.1.7 line the selection is the plugin's own live Config field, committed by
 * moving the reference and emitting `settings/document-updated`; on the 0.1.5
 * line it is the `agent-loop-engine` settings section, committed through the
 * provider's `onChange`. Pass the fake service to drive the legacy channel.
 *
 * @param ctx - the context the `settings/document-updated` event is emitted on.
 * @param initial - the profile's own composed values.
 * @param settings - the fake settings service, for the 0.1.5 settings-section channel.
 * @returns the live fields and their commit helpers.
 */
export function createLiveLoopConfig(
  ctx: Context,
  initial: { engine?: LoopEngineId; showInComposer?: boolean } = {},
  settings?: FakeSettings,
): LiveLoopConfig {
  let engine: LoopEngineId = initial.engine ?? 'in-process'
  let showInComposer = initial.showInComposer ?? true
  let revision = 0
  const legacySection = LEGACY_HARNESS && settings !== undefined ? settings : undefined
  const notify = (): void => {
    revision += 1
    ctx.emit(
      'settings/document-updated',
      LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL as SettingsNamespace,
      revision,
    )
  }
  const readEngine = (): LoopEngineId =>
    (legacySection?.sections.get(LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL)?.value.engine as LoopEngineId | undefined) ?? engine
  const readShowInComposer = (): boolean =>
    (legacySection?.sections.get(LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL)?.value.showInComposer as boolean | undefined) ?? showInComposer
  return {
    config: {
      engine: { get: readEngine },
      showInComposer: { get: readShowInComposer },
    },
    setEngine(next) {
      if (legacySection !== undefined) {
        legacySection.commitSection(LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL, { engine: next })
        return
      }
      engine = next
      notify()
    },
    setShowInComposer(next) {
      if (legacySection !== undefined) {
        legacySection.commitSection(LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL, { showInComposer: next })
        return
      }
      showInComposer = next
      notify()
    },
    engine: readEngine,
    showInComposer: readShowInComposer,
  }
}
