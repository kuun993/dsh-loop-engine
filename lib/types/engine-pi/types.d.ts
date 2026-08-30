/**
 * Public types of the Pi loop driver. Types only — no runtime code.
 *
 * Pi carries no native permission system ("runs with the permissions of the
 * user"), so the declarative stance this driver resolves is a sandbox mode plus
 * the tool set the process is allowed to use; the rest of the driver then
 * either wraps the whole `pi --mode rpc` child in the dsh subprocess sandbox or
 * prunes its `--tools` accordingly.
 *
 * @module dsh-loop-engine/engine-pi/types
 */
/** Pi sandbox stances the driver can resolve, mapped from the dsh session knobs. */
export type PiSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/** Driver configuration after defaults and load-time validation. */
export interface ResolvedConfig {
    /** Pinned sandbox mode; `undefined` follows the session's dsh permission knobs per query. */
    readonly sandboxMode: PiSandboxMode | undefined;
    /** LLM provider the `pi` RPC process is launched with (`--provider`). */
    readonly provider: string | undefined;
    /** Model pattern the `pi` RPC process is launched with (`--model`). */
    readonly model: string | undefined;
    /** Thinking/reasoning level for the model (`--model <id>:<level>` or set at runtime). */
    readonly thinkingLevel: string | undefined;
    /** Explicit environment entries layered over the credential-scrubbed parent environment. */
    readonly env: Record<string, string>;
}
//# sourceMappingURL=types.d.ts.map