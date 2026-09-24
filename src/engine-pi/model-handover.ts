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
 * The agent directory for one handover, materialized on first use.
 *
 * The directory name is a hash of the endpoint facts, so two sessions on the
 * same provider/model share one directory and a changed endpoint gets its own;
 * `models.json` declares exactly the provider pi is told to use (`--provider`)
 * and the one model it is told to run (`--model`), keyed the way pi's own
 * schema reads it (`baseUrl`/`api`/`apiKey`/`models`).
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the absolute path to hand the child as `PI_CODING_AGENT_DIR`.
 */
export function piAgentDir(handover: DshModelHandover): string {
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

/** The `models.json` document declaring one dsh provider with one model on it. */
function modelsDocument(handover: DshModelHandover): Record<string, unknown> {
  return {
    providers: {
      [handover.provider]: {
        baseUrl: handover.baseURL,
        api: handover.api,
        apiKey: handover.apiKey,
        models: [{ id: handover.model, name: handover.model }],
      },
    },
  }
}
