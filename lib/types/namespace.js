/**
 * Loop engine namespace literal: the one string both halves agree on, in a
 * module with no runtime imports so the browser bundle can import it without
 * dragging `dsh-settings` (a host-side service) into the client artifact.
 * @module dsh-loop-engine/namespace
 */
/** Settings namespace carrying the deployment's selected agent loop engine. */
export const LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL = 'agent-loop-engine';
//# sourceMappingURL=namespace.js.map