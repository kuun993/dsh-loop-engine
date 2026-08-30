/**
 * Pi RPC protocol type definitions. A minimal subset of the upstream
 * `pi --mode rpc` protocol, covering only what the driver needs: the commands
 * it sends (`new_session`, `prompt`, `abort`, `get_session_stats`), the
 * response envelope, and the streaming events it maps into the durable dsh
 * session log. Types only — no runtime code.
 *
 * The protocol is strict LF (`\n`) JSONL: records are delimited only by a bare
 * `\n` (a trailing `\r` is tolerated), and Unicode separators such as U+2028 /
 * U+2029 are ordinary characters inside JSON strings — so a generic line reader
 * that treats them as newlines is not compliant.
 *
 * @module dsh-loop-engine/engine-pi/rpc/types
 */
export {};
//# sourceMappingURL=types.js.map