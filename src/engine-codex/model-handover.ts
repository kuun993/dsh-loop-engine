/**
 * Codex's dialect for a dsh endpoint: the `codex app-server` configuration
 * overrides and environment that point it at dsh's model.
 *
 * Codex resolves a custom endpoint through `model_providers.<id>` in its own
 * `config.toml` (`base_url`, `wire_api`, and an `env_key` naming the variable
 * the credential is read from), and `codex app-server` accepts those as `-c
 * key=value` overrides — so the handover needs no edit of `~/.codex`. The
 * credential travels in the child's environment under {@link CODEX_DSH_API_KEY_ENV},
 * which the `env_key` names.
 *
 * Codex speaks only OpenAI's wires (`responses` or `chat`). A dsh protocol with
 * no codex equivalent (Anthropic Messages) is NOT guessed: `wire_api` is
 * omitted, so codex uses its own default wire against dsh's base URL and fails
 * loud on the request — the honest outcome, since the plugin cannot make codex
 * speak a protocol it does not implement.
 *
 * @module dsh-loop-engine/engine-codex/model-handover
 */

import type { DshModelHandover } from '../driver-core/model-handover.ts'

/** Provider id codex is configured with when dsh's endpoint is handed over. */
export const CODEX_DSH_PROVIDER = 'dsh'

/** Environment variable codex reads the handed-over credential from. */
export const CODEX_DSH_API_KEY_ENV = 'DSH_LOOP_ENGINE_API_KEY'

/**
 * Codex `wire_api` for one dsh wire protocol. Only the two OpenAI wires codex
 * implements appear; Anthropic Messages is deliberately absent so the override
 * omits `wire_api` rather than asserting a wire that endpoint does not serve.
 */
const CODEX_WIRE_APIS: Record<string, string> = {
  'openai-responses': 'responses',
  'openai-completions': 'chat',
}

/** Quote one value as a TOML basic string for a codex `-c` override. */
function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** The `codex app-server` argv/env that hand one dsh endpoint over. */
export interface CodexModelConfig {
  /** `-c` overrides to append to the `app-server` subcommand. */
  readonly argv: string[]
  /** Environment the child needs to read the endpoint's credential. */
  readonly env: Record<string, string>
}

/**
 * Translate one dsh endpoint handover into codex's `-c` overrides and the
 * environment carrying the credential.
 *
 * The provider id ({@link CODEX_DSH_PROVIDER}) is a plugin-owned name: it exists
 * only in this child's command line, so it cannot collide with a provider the
 * user configured, and the model itself is still handed over as the thread's own
 * `model` param.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the argv entries and environment to spawn the app-server with.
 */
export function codexModelConfig(handover: DshModelHandover): CodexModelConfig {
  const wire = CODEX_WIRE_APIS[handover.api]
  const profile = [
    `base_url=${tomlString(handover.baseURL)}`,
    ...wire === undefined ? [] : [`wire_api=${tomlString(wire)}`],
    `env_key=${tomlString(CODEX_DSH_API_KEY_ENV)}`,
  ].join(',')
  return {
    argv: [
      '-c', `model_provider=${tomlString(CODEX_DSH_PROVIDER)}`,
      '-c', `model_providers.${CODEX_DSH_PROVIDER}={${profile}}`,
    ],
    env: { [CODEX_DSH_API_KEY_ENV]: handover.apiKey },
  }
}
