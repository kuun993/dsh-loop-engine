/**
 * Kimi Code's dialect for a dsh endpoint: the `KIMI_MODEL_*` environment
 * variables of Kimi's own built-in env-model path.
 *
 * Kimi Code (the `kimi acp` child) reads these four variables while loading its
 * configuration (`applyEnvModelConfig`, kimi's own `config/env-model.ts`): when
 * `KIMI_MODEL_NAME` is set it defines one provider and one model alias from the
 * quartet and points `defaultModel` at that alias. That is what makes a dsh
 * model the child's default WITHOUT touching `~/.kimi-code/config.toml` — the
 * whole handover is environment.
 *
 * The one translation is the provider `type` Kimi understands
 * (`kimi` | `anthropic` | `openai`) versus dsh's wire-protocol name. A dsh
 * protocol with no equivalent in that set is NOT guessed: the variable is
 * omitted, so Kimi falls back to its own `kimi` default against dsh's base URL
 * and fails loud on the request if that endpoint does not speak it.
 *
 * @module dsh-loop-engine/engine-kimi/model-handover
 */

import type { DshModelHandover } from '../driver-core/model-handover.ts'

/**
 * Kimi provider `type` for one dsh wire protocol. Only the protocols Kimi's
 * env-model path can express appear: everything OpenAI-shaped is `openai`
 * (Kimi has no separate Responses type), and Anthropic Messages is only ever
 * the `/v1/messages` wire kimi's `anthropic` type speaks.
 */
const KIMI_PROVIDER_TYPES: Record<string, string> = {
  'anthropic-messages': 'anthropic',
  'openai-completions': 'openai',
  'openai-responses': 'openai',
}

/**
 * Translate one dsh endpoint handover into the environment entries that point
 * the `kimi acp` child at it.
 *
 * The credential value is carried in the child's environment (the only place a
 * spawner outside this process can read it) and never returned anywhere else —
 * no caller logs this object.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the `KIMI_MODEL_*` entries to layer over the child's environment.
 */
export function kimiModelEnv(handover: DshModelHandover): Record<string, string> {
  const type = handover.api === undefined ? undefined : KIMI_PROVIDER_TYPES[handover.api]
  return {
    KIMI_MODEL_NAME: handover.model,
    KIMI_MODEL_API_KEY: handover.apiKey,
    KIMI_MODEL_BASE_URL: handover.baseURL,
    ...type === undefined ? {} : { KIMI_MODEL_PROVIDER_TYPE: type },
  }
}
