/**
 * Minimal structural shapes of the optional host registries the plugin
 * extends.
 *
 * Declared locally rather than imported from their packages: the plugin
 * depends on the SERVICE CONTRACTS it consumes only where the harness exposes
 * one (`dsh-agent`, `dsh-session`, …), and the command/skill registries are
 * read through `ctx.get` and may legitimately be absent in a minimal profile.
 * Keeping the shapes here means one definition shared by every consumer and no
 * peer dependency that a headless composition does not need.
 *
 * @module dsh-loop-engine/driver-core/host-servers
 */

import type { CommandDefinition } from '../commands.ts'
import type { SkillProvider, SkillProviderControl } from '../skills.ts'
import type { SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import type { HostedEngineRouteAdapter } from '../provider-route.ts'

/** The host command registry (`ctx.commands`), as this plugin uses it. */
export interface CommandsService {
  /** Register one definition in the calling context's scope layer. */
  register(def: CommandDefinition): () => void
}

/** The host skill registry (`ctx.skills`), as this plugin uses it. */
export interface SkillsService {
  /** Register a provider in the calling context's scope layer. */
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
}

/** The host preset roster (`ctx.agentPresets`), as this plugin uses it. */
export interface AgentPresetsService {
  /** The effective default preset id. */
  readonly defaultId: string
  /** Read one preset's composition text. */
  read(id: string): Promise<string>
}

/** The host settings service's mutation seam, as this plugin uses it. */
export interface SettingsMutator {
  /** Apply ops to one namespace. */
  mutate(ns: SettingsNamespace, ops: readonly SettingsPathOp[]): Promise<void>
  /** Registered namespaces, when the provider can enumerate them. */
  describe?(): SettingsDescriptorLike[]
}

/**
 * One registered settings namespace, as the host describes it
 * (`@deepseek-ai/dsh-settings` `SettingsDescriptor`). Only the two fields this
 * plugin reads are declared.
 */
export interface SettingsDescriptorLike {
  /** Namespace name. */
  readonly ns: string
  /**
   * The composition's own value for this namespace, before the user layer. It is
   * what a saved user-layer value overrode, which is why `model-selection-reset.ts`
   * reads it: the deployment's own configured default model is a real model it
   * can name when the saved default does not.
   */
  readonly base?: unknown
}

/** The host llm registry (`ctx.llm`), as this plugin uses it. */
export interface LlmRegistry {
  /** Register a placeholder adapter for one or more provider labels. */
  registerAdapter(providers: string[], adapter: HostedEngineRouteAdapter): () => void
}

/** The host session-projection registry (`ctx.sessionProjections`), as this plugin uses it. */
export interface SessionProjectionsService {
  /** Folded projection state of one session, or undefined when it never advanced. */
  stateOf(session: Session, key: 'turnBoundary'): TurnBoundaryFacts | undefined
  /** The same fold for the durable model selection (`model-selection-reset.ts`). */
  stateOf(session: Session, key: 'modelSelection'): ModelSelectionFacts | undefined
}

/**
 * One complete model selection as the host's `model/selection` event and its
 * projection carry it (`packages/api/session-controller/src/types.ts`,
 * `ModelSelection`).
 */
export interface SessionModelSelection {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  readonly reasoningEffort?: string
}

/**
 * The slice of the host's `modelSelection` projection state this plugin reads.
 * `lastUsed` is deliberately not declared: it is that fold's view of the newest
 * `request/header`, which the plugin reads from the session itself
 * (`Session.requestHeader()`) with the same result.
 */
export interface ModelSelectionFacts {
  /** Later selection not yet consumed by a matching recorded request, or null. */
  readonly pending: SessionModelSelection | null
}

/**
 * The turn-boundary facts this plugin reads. Mirrors `TurnBoundaryProjection`
 * in `@deepseek-ai/dsh-agent` without depending on that module's projection
 * registry augmentation, which a non-plugin consumer has no other reason to
 * pull into its program.
 */
export interface TurnBoundaryFacts {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: number | null
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number
}
