/**
 * The dsh endpoint, protocol, and credential a hosted engine is handed when a
 * session selects a REAL dsh model — the second half of the model handover
 * whose first half (`session-model.ts`) only carries the model name.
 *
 * A hosted engine owns its model natively, and today it also owns the endpoint
 * and the credential: each CLI keeps its own provider table. That is why
 * "handing over a dsh model" used to mean "the engine can find that model name
 * in its own configuration". This module answers the other question — what
 * `baseURL`, wire protocol, and credential does the session's selection name in
 * dsh's own settings — so each driver can point its engine at dsh's endpoint.
 *
 * The two reads are the host's own seams, deliberately:
 *
 *  - the provider → settings address mapping comes from the llm registry's
 *    configurable-provider directory (`LlmRuntime.listConfigurableProviders`,
 *    `packages/llm/llm/src/types.ts` `LlmConfigurableProvider`). That directory
 *    is the authoritative answer to "which namespace, at which path, configures
 *    provider X": `llm-pi-ai` maps a route to `['providers', route]` under
 *    `llm-pi-ai`, `llm-deepseek` maps its one route to the whole `llm-deepseek`
 *    section. Reading the directory rather than hardcoding namespaces is what
 *    keeps this plugin from inventing a mapping the deployment did not make.
 *  - the credential is resolved through the credentials seam, because the
 *    profile stores an `apiKeyEnv` NAME and its value lives in the harness's
 *    credential store, never in the process environment
 *    (`packages/bundle/base/cordis.patch.yml`).
 *
 * Both reads are reads of ANOTHER plugin's private namespace, and no contract in
 * the harness guarantees their shape. Every step is therefore defensive: a shape
 * this module does not recognize resolves to `undefined` (the engine keeps its
 * own configuration, exactly today's behavior) and one warning, never a throw
 * and never a guess. The warning names the provider and the model, never a
 * credential.
 *
 * What counts as "recognized" is deliberately narrow: a non-empty `baseURL` and
 * a resolvable credential. The wire protocol is handed over when the deployment
 * declares one, but its absence does NOT refuse the handover — see
 * {@link resolveModelHandover} and {@link SHIPPED_ROUTE_APIS}.
 *
 * @module dsh-loop-engine/driver-core/model-handover
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionModelOverride } from './session-model.ts'

/**
 * The endpoint facts one hosted engine needs to speak to the dsh model a session
 * selected: the model id, the base URL, dsh's wire protocol name for it, and the
 * resolved credential value.
 *
 * The protocol is carried verbatim (`llm-pi-ai` values such as
 * `anthropic-messages`, `openai-completions`, `openai-responses`), because each
 * engine translates it into its own vocabulary — and an engine whose protocol
 * the endpoint does not speak is left to fail loud on its own request rather
 * than being silently given a different endpoint.
 */
export interface DshModelHandover {
  /** Provider route the selection named (the engine's provider key). */
  readonly provider: string
  /** Provider-owned model id the selection named. */
  readonly model: string
  /** Endpoint base as dsh configured it. */
  readonly baseURL: string
  /**
   * dsh's wire protocol name for this endpoint, when the deployment declares
   * one (or {@link SHIPPED_ROUTE_APIS} knows it for a shipped route). `undefined`
   * is a normal answer, not a failure: engines that need a protocol degrade the
   * way each one documents, and engines that do not (`claude-code`) ignore it.
   */
  readonly api: string | undefined
  /** The resolved credential value; never logged, never evented. */
  readonly apiKey: string
}

/**
 * Wire protocols of provider routes whose ADAPTER owns the wire, so the settings
 * section never carries an `api` for them.
 *
 * A route like `deepseek-official` is registered by the harness's own adapter
 * plugin, and that adapter's settings schema has no `api` field at all — the
 * wire is a property of the code that speaks to the endpoint, not something the
 * operator configures or a user declares. Reading the profile therefore finds
 * `baseURL` and `apiKeyEnv` but never a protocol, and refusing the handover over
 * that would leave the engine free to send dsh's model id to ITS OWN endpoint
 * (the misleading failure this table exists to prevent).
 *
 * The entry is verified, not guessed: the harness's DeepSeek adapter posts to
 * `{baseURL}/chat/completions` (`packages/llm/llm-deepseek/src/adapter.ts:651`,
 * "OpenAI-compatible"), which is exactly OpenAI Chat Completions. Re-verify
 * before adding a route here — a wrong entry is a silently wrong protocol.
 */
const SHIPPED_ROUTE_APIS: Record<string, string> = {
  'deepseek-official': 'openai-completions',
}

/**
 * One entry of the host llm registry's configurable-provider directory
 * (`LlmConfigurableProvider`), narrowed to the address fields this module reads.
 */
export interface ConfigurableProviderAddress {
  /** Provider route key the entry activates when configured. */
  readonly provider: string
  /** User-settings namespace whose section configures this provider. */
  readonly settingsNs: string
  /** Path from that section root to this provider's profile; empty when the section IS the profile. */
  readonly settingsPath: readonly string[]
}

/**
 * The host llm registry (`ctx.llm`), as this module uses it.
 *
 * `listConfigurableProviders` is optional: a minimal profile may serve the
 * registry without the directory, and an older harness may predate it. A
 * missing directory is "cannot map", not an error — the engine keeps its own
 * configuration.
 */
export interface LlmDirectoryService {
  /** Every provider route an adapter can activate through configuration. */
  listConfigurableProviders?(): readonly ConfigurableProviderAddress[]
}

/** The host settings service (`ctx.settings`), as this module uses it. */
export interface SettingsReader {
  /** Read one registered namespace's resolved value. */
  get?(ns: string): unknown
}

/** The host credentials seam (`ctx.credentials`), as this module uses it. */
export interface CredentialsService {
  /** Resolve one reference (an environment-variable NAME) to its current value. */
  resolve(ref: string): Promise<{ readonly value: string } | undefined>
}

/** The three profile fields this module reads out of a provider's settings section. */
interface ProviderProfile {
  readonly baseURL: string
  /** dsh's wire protocol name, when the profile declares one. */
  readonly api: string | undefined
  /** Credential reference (environment-variable name), when the profile names one. */
  readonly apiKeyEnv: string | undefined
}

/**
 * Warning keys already emitted, per context: a session that selects an
 * unresolvable model resolves it on EVERY step, and the user should read the
 * reason once rather than once per request.
 */
const warned = new WeakMap<Context, Set<string>>()

/** Emit one warning per distinct key, so a per-step read warns once. */
function warnOnce(ctx: Context, key: string, message: string): void {
  let seen = warned.get(ctx)
  if (seen === undefined) {
    seen = new Set<string>()
    warned.set(ctx, seen)
  }
  if (seen.has(key)) return
  seen.add(key)
  ctx.logger.warn(message)
}

/**
 * The registry entry that maps a provider route to its settings address, or
 * `undefined` when the registry is absent, exposes no directory, or declares no
 * such route.
 */
function settingsAddress(
  ctx: Context,
  provider: string,
): ConfigurableProviderAddress | undefined {
  const llm = ctx.get('llm') as LlmDirectoryService | undefined
  return llm?.listConfigurableProviders?.().find(entry => entry.provider === provider)
}

/**
 * Read one provider's endpoint fields from its dsh settings section, walking the
 * registry's own path and validating every shape. `undefined` means "not a
 * shape this module can hand over", which the caller reports and falls back on.
 *
 * Only `baseURL` is required: it is the one fact without which there is no
 * endpoint to hand over. `api` describes the WIRE, and a route whose adapter
 * owns that wire has no such field — a missing protocol is answered by the
 * caller, not treated as an unusable profile.
 */
function readProviderProfile(
  ctx: Context,
  address: ConfigurableProviderAddress,
): ProviderProfile | undefined {
  const settings = ctx.get('settings') as SettingsReader | undefined
  let node: unknown = settings?.get?.(address.settingsNs)
  for (const segment of address.settingsPath) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  if (node === null || typeof node !== 'object') return undefined
  const record = node as Record<string, unknown>
  const { baseURL, api, apiKeyEnv } = record
  if (typeof baseURL !== 'string' || baseURL.length === 0) return undefined
  return {
    baseURL,
    api: typeof api === 'string' && api.length > 0 ? api : undefined,
    apiKeyEnv: typeof apiKeyEnv === 'string' && apiKeyEnv.length > 0 ? apiKeyEnv : undefined,
  }
}

/**
 * Resolve one credential reference: the credentials seam first (the harness's
 * own plane), then the ambient environment as the fallback `llm-pi-ai` itself
 * uses when the seam is not composed. An empty value is absent either way — a
 * blank never masquerades as a configured secret.
 */
async function readApiKey(ctx: Context, apiKeyEnv: string | undefined): Promise<string | undefined> {
  if (apiKeyEnv === undefined) return undefined
  const credentials = ctx.get('credentials') as CredentialsService | undefined
  const stored = credentials === undefined ? undefined : (await credentials.resolve(apiKeyEnv))?.value
  if (stored !== undefined && stored.length > 0) return stored
  const ambient = process.env[apiKeyEnv]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}

/**
 * Resolve the session's own model selection into the endpoint triple a hosted
 * engine can dial, or `undefined` to leave the engine to its own configuration.
 *
 * `undefined` is the answer in exactly two situations: the selection names no
 * real dsh model ({@link SessionModelOverride} is already `undefined` for the
 * hosted seat), or a real model whose endpoint/credential dsh does not disclose
 * to this read — no `baseURL`, or no credential. Both warn once: they are
 * deployment-shape gaps the operator can see and fix, not a silent downgrade.
 *
 * The wire protocol is NOT such a gate. A profile that names no `api` still
 * hands over its endpoint (with `api: undefined`), because refusing would let
 * the engine send dsh's model id to the engine's OWN endpoint — a failure that
 * reads like an auth or model problem while the real one is "wrong endpoint".
 * Shipped routes whose adapter owns the wire are named in
 * {@link SHIPPED_ROUTE_APIS} so they hand over a real protocol; anything still
 * unknown degrades per engine, which is the engine's call to make.
 *
 * Called fresh on every step by each driver, so a model or provider picked
 * mid-conversation reaches the engine's next request rather than being frozen
 * when the agent was built.
 * @param ctx - the driver's context, carrying the llm/settings/credentials seams.
 * @param override - the session's dsh model selection, already judged by `sessionModelOverrideOf`.
 * @returns the resolvable endpoint triple, or undefined to inject nothing.
 */
export async function resolveModelHandover(
  ctx: Context,
  override: SessionModelOverride | undefined,
): Promise<DshModelHandover | undefined> {
  if (override === undefined) return undefined
  const address = settingsAddress(ctx, override.provider)
  if (address === undefined) {
    return refuse(ctx, override, `no llm registry route maps it to a settings namespace`)
  }
  const profile = readProviderProfile(ctx, address)
  if (profile === undefined) {
    return refuse(ctx, override, `the "${address.settingsNs}" settings section names no baseURL for it`)
  }
  const apiKey = await readApiKey(ctx, profile.apiKeyEnv)
  if (apiKey === undefined) {
    return refuse(ctx, override, 'no credential resolves for its apiKeyEnv')
  }
  return {
    provider: override.provider,
    model: override.model,
    baseURL: profile.baseURL,
    api: profile.api ?? SHIPPED_ROUTE_APIS[override.provider],
    apiKey,
  }
}

/**
 * Report one unresolvable handover and answer `undefined` to the caller, so a
 * driver reads as `?? keep the engine's own configuration` at the call site.
 * The message names the provider and the model only — never a credential, and
 * never the raw settings value.
 */
function refuse(ctx: Context, override: SessionModelOverride, reason: string): undefined {
  warnOnce(
    ctx,
    `${override.provider}/${override.model}:${reason}`,
    `loop-engine: the session selected the dsh model "${override.provider}/${override.model}", but its endpoint`
    + ` could not be resolved (${reason}); the engine keeps its own provider configuration`,
  )
  return undefined
}
