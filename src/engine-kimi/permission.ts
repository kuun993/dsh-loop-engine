/**
 * Tool-approval mapping for the `kimi acp` driver.
 *
 * Kimi's ACP adapter surfaces tool/permission decisions as the reverse-RPC
 * `session/request_permission`, which the client must answer. The dsh harness
 * has no interactive approval callback in the unattended runtime, so the fold
 * mirrors the codex/Pi bridges: an `ask` approval policy degrades to a denial
 * (the only safe answer when no human is present), and anything else
 * (`never`, or knob-less) auto-approves the tool. A full-access sandbox mode
 * also auto-approves; a `workspace-write` stance is still auto-approved here
 * because Kimi's own permission gating (`--permission`/session policy) is what
 * bounds the tool — the ACP approval is the host's gate, and the dsh
 * `approval/policy` knob is its signal.
 *
 * @module dsh-loop-engine/engine-kimi/permission
 */

import type { PermissionEvent } from '../driver-core/permission-knobs.ts'
import { sessionApprovalPolicy } from '../driver-core/permission-knobs.ts'

/**
 * Whether the driver should answer `session/request_permission` with approval for
 * one query. An `ask` policy denies (fail-closed — no human is present in the
 * unattended runtime); anything else (`never`, or knob-less) auto-approves. The
 * sandbox stance is not consulted: Kimi's own tool policy bounds what a tool does,
 * and the ACP approval is the host's gate, signalled by `approval/policy`.
 * @param events - the durable session log.
 * @returns whether tool requests are approved.
 */
export function resolveToolApproval(events: readonly PermissionEvent[]): boolean {
  return sessionApprovalPolicy(events) !== 'ask'
}
