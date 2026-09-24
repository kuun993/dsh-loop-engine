/**
 * Codex's dialect for a dsh endpoint: the `codex app-server` configuration
 * overrides and environment that point it at dsh's model.
 *
 * Codex resolves a custom endpoint through `model_providers.<id>` in its own
 * `config.toml` (`name`, `base_url`, `wire_api`, and an `env_key` naming the
 * variable the credential is read from), and `codex app-server` accepts those as
 * `-c key=value` overrides — so the handover needs no edit of `~/.codex`. The
 * credential travels in the child's environment under {@link CODEX_DSH_API_KEY_ENV},
 * which the `env_key` names.
 *
 * `name` is not optional in practice even though the CLI's own docs describe it
 * as display metadata: codex 0.149.1 (the version this plugin pins) refuses to
 * load a provider whose `name` is empty — "provider name must not be empty in
 * `model_providers`" — and that config error kills `app-server` on startup, which
 * the driver can only report as "process exited unexpectedly". Omitting it looked
 * correct and failed before any request was ever sent, so every override this
 * module builds carries it (verified against the pinned binary).
 *
 * Codex speaks only OpenAI's `responses` wire as of the version this plugin pins
 * (0.149.1 dropped `chat`). A dsh protocol with no codex equivalent (Anthropic
 * Messages, and now OpenAI Chat Completions) is NOT guessed: `wire_api` is
 * omitted, so codex falls back to its own default wire and fails loud on the
 * request — the honest outcome, since the plugin cannot make codex speak a
 * protocol it does not implement. That default is `responses` as of 0.149.1: the
 * request lands on `<baseURL>/responses`, which an Anthropic Messages or Chat
 * Completions endpoint does not serve.
 *
 * @module dsh-loop-engine/engine-codex/model-handover
 */

import type { DshModelHandover } from '../driver-core/model-handover.ts'

/** Provider id codex is configured with when dsh's endpoint is handed over. */
export const CODEX_DSH_PROVIDER = 'dsh'

/** Environment variable codex reads the handed-over credential from. */
export const CODEX_DSH_API_KEY_ENV = 'DSH_LOOP_ENGINE_API_KEY'

/**
 * Codex `wire_api` for one dsh wire protocol. Only `responses` remains: codex
 * 0.149.1 removed `chat` outright, so a `wire_api = "chat"` override is now a
 * FATAL config error — `app-server` refuses to start ("`wire_api = "chat"` is no
 * longer supported"), exactly like the empty `name` below. `openai-completions`
 * therefore has no codex equivalent any more and takes the omitted-`wire_api`
 * path with Anthropic Messages, rather than killing the process at startup.
 */
const CODEX_WIRE_APIS: Record<string, string> = {
  'openai-responses': 'responses',
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
 * `model` param. The provider's `name` repeats that id because codex rejects an
 * empty one at config load, before any request is made.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the argv entries and environment to spawn the app-server with.
 */
export function codexModelConfig(handover: DshModelHandover): CodexModelConfig {
  const wire = handover.api === undefined ? undefined : CODEX_WIRE_APIS[handover.api]
  const profile = [
    `name=${tomlString(CODEX_DSH_PROVIDER)}`,
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
