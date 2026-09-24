/**
 * The dsh provider seams a real composition provides, faked for the hosted-engine
 * driver specs: an llm registry directory that maps `meicloud` to a `llm-pi-ai`
 * profile, the settings section holding that profile, and a credential seam
 * answering its `apiKeyEnv`.
 *
 * `provideDshEndpoint` is the handover's happy path — every per-engine spec uses
 * it to assert what each engine's ENTRY POINT received (Claude Code's
 * `Options.env`, Pi's spawn spec, Kimi's child environment, Codex's `-c`). The
 * options below let a spec withhold one piece, which is how the "endpoint or
 * credential unresolvable → inject nothing and warn" behavior is exercised, and
 * the returned handle's `update` re-declares the endpoint mid-session, which is
 * how the per-step re-resolution is exercised.
 *
 * @module tests/helpers/dsh-model-endpoint
 */

import type { Context } from '@deepseek-ai/cordis'

/** The endpoint facts every driver spec asserts against. */
export const DSH_ENDPOINT = {
  provider: 'meicloud',
  model: 'deepseek-flash',
  baseURL: 'https://ai.example.com/litellm',
  api: 'anthropic-messages',
  apiKey: 'sk-dsh-secret',
  apiKeyEnv: 'MEICLOUD_API_KEY',
} as const

/** One knob per piece a spec may withhold, or change mid-session. */
export interface DshEndpointOptions {
  /** Wire protocol the profile declares. */
  api?: string
  /** Endpoint base the profile declares. */
  baseURL?: string
  /** Credential reference the profile declares. */
  apiKeyEnv?: string
  /** Credential value the seam answers; `null` makes the seam answer "no value". */
  apiKey?: string | null
  /** Whether to compose the credentials seam at all. */
  credentials?: boolean
}

/** Handle over the composed seams, for re-declaring the endpoint mid-test. */
export interface DshEndpointHandle {
  /** Replace the declared endpoint, as a settings reload would. */
  update(next: DshEndpointOptions): void
}

/**
 * Compose the dsh provider seams on a driver spec's context.
 * @param ctx - the harness context the driver resolves its endpoint from.
 * @param options - which pieces to declare, and which to withhold.
 * @returns a handle that can re-declare the endpoint for a later step.
 */
export function provideDshEndpoint(ctx: Context, options: DshEndpointOptions = {}): DshEndpointHandle {
  let current: DshEndpointOptions = options
  const apiKeyEnv = (): string => current.apiKeyEnv ?? DSH_ENDPOINT.apiKeyEnv
  ctx.provide('llm', {
    listConfigurableProviders: () => [{
      provider: DSH_ENDPOINT.provider,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', DSH_ENDPOINT.provider],
    }],
  })
  ctx.provide('settings', {
    get: (ns: string) => ns === 'llm-pi-ai'
      ? {
        providers: {
          [DSH_ENDPOINT.provider]: {
            apiKeyEnv: apiKeyEnv(),
            api: current.api ?? DSH_ENDPOINT.api,
            baseURL: current.baseURL ?? DSH_ENDPOINT.baseURL,
          },
        },
      }
      : undefined,
  })
  if (options.credentials !== false) {
    ctx.provide('credentials', {
      resolve: (ref: string) => {
        const value = current.apiKey === null ? undefined : current.apiKey ?? DSH_ENDPOINT.apiKey
        return Promise.resolve(ref === apiKeyEnv() && value !== undefined ? { value } : undefined)
      },
    })
  }
  return { update: (next) => { current = next } }
}
