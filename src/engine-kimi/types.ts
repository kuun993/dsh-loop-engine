/**
 * Public types of the Kimi Code loop driver. Types only — no runtime code.
 *
 * Kimi Code (`kimi`) has no host approval callback ("runs with the permissions
 * of the user"), and its non-interactive `-p` surface already auto-approves tool
 * calls. It also exposes no `--tools` pruning flag in `-p` mode, so there is no
 * per-driver permission lever to pin. The driver therefore spawns the whole
 * `kimi -p` child through the dsh subprocess seam — the only available privilege
 * boundary — and the sandbox stance follows the session's durable permission
 * knobs as the subprocess provider resolves them (default read-only).
 *
 * @module dsh-loop-engine/engine-kimi/types
 */

/** Driver configuration after defaults and load-time validation. */
export interface ResolvedConfig {
  /** Model alias the `kimi` child is launched with (`--model`); Kimi native config owns the model when omitted. */
  readonly model: string | undefined
  /** Explicit environment entries layered over the credential-scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Kimi CLI executable; `'kimi'` resolves through PATH when not pinned to an absolute path. */
  readonly bin: string
}
