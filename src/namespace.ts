/**
 * Loop engine namespace literals: the strings both halves agree on, in a
 * module with no runtime imports so the browser bundle can import them without
 * dragging `dsh-settings` (a host-side service) into the client artifact.
 * @module dsh-loop-engine/namespace
 */

/**
 * Settings namespace carrying the deployment's selected agent loop engine on
 * the 0.1.7 line.
 *
 * Profile-backed settings are addressed by the composing entry id, so this
 * literal is the plugin's own profile entry id: the shipped `cordis.patch.yml`
 * inserts the entry as `loop-engine`, and the browser half passes the same
 * string to `ctx.configForms.get(...)`. A deployment that renames the entry id
 * must change this literal with it.
 */
export const LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL = 'loop-engine'

/**
 * Settings namespace carrying the same selection on the 0.1.5 line, where a
 * settings section is addressed by the namespace a provider registers rather
 * than by a composing entry id. This is the literal the pre-rewrite plugin
 * shipped; it is stable across the whole 0.1.5 line.
 */
export const LEGACY_LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL = 'agent-loop-engine'
