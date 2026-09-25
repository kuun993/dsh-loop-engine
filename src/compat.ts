/**
 * Runtime harness-generation probe. One released build must serve the 0.1.5
 * line (`0.1.5-rc.1` … `0.1.5-rc.3`, all sharing the OLD settings API) and the
 * 0.1.7 line (`0.1.7-rc.1`), which rewrote the settings host and client and
 * turned the agent-creation announcement async. The differences are not
 * version strings but API SHAPES, so the switch is a structural probe of the
 * imported module rather than a semver parse: `@deepseek-ai/dsh-settings`
 * exported a named `SettingsProvider` class on the 0.1.5 line, and the 0.1.7
 * rewrite deleted it in favour of `SettingsForms` plus per-entry volatile
 * Config fields.
 *
 * The probe resolves to whichever `@deepseek-ai/dsh-settings` the running
 * profile actually provides. It is host-side only: the browser bundle must not
 * import host packages, so `src/client/*` never imports this module.
 *
 * @module dsh-loop-engine/compat
 */

import * as dshSettings from '@deepseek-ai/dsh-settings'

/**
 * Whether the running harness predates the profile-backed settings rewrite
 * (the 0.1.5 line). `true` selects the legacy settings host/client, the
 * synchronous agent-creation announcement, and the legacy tool-result message
 * introspection.
 */
export const LEGACY_HARNESS: boolean = 'SettingsProvider' in (dshSettings as object)
