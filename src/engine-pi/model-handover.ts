/**
 * Pi's dialect for a dsh endpoint: a self-built agent directory plus the argv
 * flags that point the `pi --mode rpc` child at dsh's model.
 *
 * Pi resolves a model through its own agent directory — `models.json` under
 * `PI_CODING_AGENT_DIR` (or `~/.pi` when unset) — and its custom-provider schema
 * has no `apiKeyEnv`: a provider's credential is either a literal `apiKey` in
 * that file or the CLI's own `--api-key`. There is no `PI_*` variable for a base
 * URL either. So the only automatic way to hand pi a dsh endpoint is to give it
 * an agent directory THIS PLUGIN owns, containing a `models.json` that declares
 * the dsh provider, and to point `PI_CODING_AGENT_DIR` at it.
 *
 * The user's `~/.pi` is deliberately never written or read: the plugin owns a
 * separate directory under the OS temp dir, one per distinct endpoint, created
 * 0700 with a 0600 file because it carries the credential. The cost is real and
 * documented: redirecting the agent directory means the child no longer sees the
 * user's own `~/.pi` skills/auth/theme. That is the trade the deployment makes
 * by selecting a real dsh model on pi.
 *
 * pi's provider schema requires a wire protocol (`api`) AND requires that pi
 * itself has an implementation for the one it is given, so this is the one
 * engine whose dialect has to judge the protocol rather than pass it along:
 * {@link resolvePiApi} answers "is this a protocol pi can speak", and the driver
 * drops a protocol-less handover or refuses an unspeakable one before either
 * reaches here. What does reach here is written in pi's own spelling
 * ({@link PI_API_ALIASES}) instead of dsh's raw string.
 *
 * @module dsh-loop-engine/engine-pi/model-handover
 */

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DshModelHandover } from '../driver-core/model-handover.ts'

/** Root under the OS temp dir holding one plugin-owned agent directory per endpoint. */
const AGENT_ROOT = join(tmpdir(), 'dsh-loop-engine-pi-agent')

/** Directories already materialized this process, so a per-step read never re-writes one. */
const materialized = new Set<string>()

/**
 * Remove every agent directory this process created, at exit. Synchronous on
 * purpose: an `exit` handler cannot await, and a lingering copy of a credential
 * file is worth blocking the last few milliseconds for.
 */
/* v8 ignore start -- runs only at real process exit, which a test does not reach */
process.once('exit', () => {
  for (const dir of materialized) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A directory the OS already cleaned is not an error.
    }
  }
  materialized.clear()
})
/* v8 ignore stop */

/**
 * The wire protocols pi itself implements, read from the `Api` union of pi-ai
 * and pi's own `docs/custom-provider.md` as shipped with the pinned
 * `@earendil-works/pi-coding-agent@0.84.3`.
 *
 * A `models.json` provider whose `api` is outside this set is not a degradation
 * pi can absorb: it fails every turn with `No API provider registered for api:
 * <value>` and never dials the endpoint (verified against that version, for a
 * value pi does not know and for pi's own `anthropic-messages` spelling, which
 * really did connect). The driver therefore validates against this set before it
 * spawns a child, rather than writing a document pi refuses.
 *
 * Re-read the union when the pin moves: a spelling pi ADDS is a handover this
 * plugin currently refuses (harmless, but a needless refusal), and one pi
 * RENAMES silently becomes a refusal too.
 */
const PI_APIS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'mistral-conversations',
  'google-generative-ai',
  'google-vertex',
  'bedrock-converse-stream',
])

/**
 * dsh (or third-party) spelling → the pi spelling that names the SAME wire.
 *
 * `anthropic` is in no dsh route's own vocabulary — `llm-pi-ai` declares
 * `anthropic-messages` — so a provider plugin that writes it is describing an
 * Anthropic-Messages-compatible endpoint, which is the one wire pi names
 * `anthropic-messages`. Verified against pi 0.84.3: `api: "anthropic"` is
 * refused outright (`No API provider registered for api: anthropic`, identical to
 * a deliberately bogus value), while `anthropic-messages` is accepted and
 * actually dials the endpoint.
 *
 * An entry here is a claim about which wire an endpoint speaks, not a
 * convenience: it decides the protocol pi will speak to the user's endpoint. Each
 * value must be one of {@link PI_APIS}, and adding a row means re-verifying the
 * claim against a real endpoint of that kind before trusting it.
 */
const PI_API_ALIASES: Record<string, string> = {
  anthropic: 'anthropic-messages',
}

/**
 * The protocol to declare in `models.json`: pi's own spelling for one dsh
 * protocol, with an alias ({@link PI_API_ALIASES}) translated into it and a
 * spelling pi already knows passed through unchanged.
 *
 * Idempotent — a pi spelling is never an alias key — which is what lets the
 * driver stamp the resolution onto the handover it carries onward while
 * `models.json` still lands on the very same pi spelling.
 */
function piApiSpelling(api: string): string {
  return PI_API_ALIASES[api] ?? api
}

/**
 * What pi can be told about one handover's wire protocol.
 *
 * A discriminated answer rather than an `api: string | undefined`, because the
 * driver treats the two negative cases differently: no protocol at all is
 * dropped, while a protocol pi does not speak is REFUSED — dropping the second
 * one would leave the user's dsh model selection standing while pi quietly ran
 * its OWN default model, the misleading failure this driver exists not to
 * produce (the driver's gate is `PiAgent.supportedHandover`, `agent.ts`).
 */
export type PiApiResolution =
  | { readonly kind: 'absent' }
  | { readonly kind: 'supported'; readonly api: string }
  | { readonly kind: 'unsupported' }

/**
 * Judge one handover's wire protocol against pi's own vocabulary.
 * @param api - dsh's protocol name for the endpoint, or `undefined` when neither
 *   the provider's settings section nor a shipped-route entry declares one.
 * @returns `absent` for no protocol, `supported` (carrying the pi spelling to
 *   use) for one pi speaks, `unsupported` for anything else.
 */
export function resolvePiApi(api: string | undefined): PiApiResolution {
  if (api === undefined) return { kind: 'absent' }
  const spelling = piApiSpelling(api)
  return PI_APIS.has(spelling) ? { kind: 'supported', api: spelling } : { kind: 'unsupported' }
}

/**
 * A handover whose wire protocol pi can speak — i.e. one that came through
 * {@link resolvePiApi}.
 *
 * The type is the point: {@link piAgentDir} materializes an endpoint pi will be
 * pointed at, and pi rejects a provider whose `api` is missing or unknown, so a
 * protocol-less handover has no business reaching this module's write path.
 * Narrowing `api` to a required string makes that a compile-time obligation at
 * every call site instead of a runtime check the writer would have to fail on.
 */
export interface PiSupportedHandover extends DshModelHandover {
  /** The endpoint's wire protocol, in pi's own vocabulary. */
  readonly api: string
}

/**
 * The agent directory for one handover, materialized on first use.
 *
 * The directory name is a hash of the endpoint facts, so two sessions on the
 * same provider/model share one directory and a changed endpoint gets its own;
 * `models.json` declares exactly the provider pi is told to use (`--provider`)
 * and the one model it is told to run (`--model`), keyed the way pi's own
 * schema reads it (`baseUrl`/`api`/`apiKey`/`models`).
 * @param handover - the resolved dsh endpoint for the session's selection, whose
 *   protocol {@link resolvePiApi} already accepted.
 * @returns the absolute path to hand the child as `PI_CODING_AGENT_DIR`.
 */
export function piAgentDir(handover: PiSupportedHandover): string {
  const dir = join(
    AGENT_ROOT,
    createHash('sha256')
      .update(JSON.stringify({
        provider: handover.provider,
        baseURL: handover.baseURL,
        api: handover.api,
        apiKey: handover.apiKey,
        model: handover.model,
      }))
      .digest('hex')
      .slice(0, 32),
  )
  if (!materialized.has(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(dir, 'models.json'),
      `${JSON.stringify(modelsDocument(handover), null, 2)}\n`,
      { mode: 0o600 },
    )
    materialized.add(dir)
  }
  return dir
}

/**
 * The `models.json` document declaring one dsh provider with one model on it.
 *
 * The protocol is written in PI's spelling, never dsh's raw string: a provider
 * plugin may name the same wire differently (`anthropic` for the wire pi calls
 * `anthropic-messages`), and pi resolves `api` against its own registry of
 * implementations, so an untranslated value is a child that fails every turn
 * instead of one that talks to the endpoint dsh resolved.
 */
function modelsDocument(handover: PiSupportedHandover): Record<string, unknown> {
  return {
    providers: {
      [handover.provider]: {
        baseUrl: handover.baseURL,
        api: piApiSpelling(handover.api),
        apiKey: handover.apiKey,
        models: [{ id: handover.model, name: handover.model }],
      },
    },
  }
}
