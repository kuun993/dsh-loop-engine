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
export {};
//# sourceMappingURL=types.js.map