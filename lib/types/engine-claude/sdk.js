/**
 * One Claude Agent SDK query: options assembly, process seam projection, and
 * the headless interaction policy. The driver runs exactly one query per dsh
 * step; this module owns no session state.
 *
 * @module dsh-loop-engine/engine-claude/sdk
 */
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';
import { ManagedClaudeCodeProcess, claudeSpawnSpec } from "./process.js";
/** Native lock-down mode fixed for every query unless deployment overrides it. */
export const DEFAULT_PERMISSION_MODE = 'dontAsk';
/** Grace in milliseconds for Claude Code process-tree termination. */
export const DEFAULT_DISPOSE_GRACE_MS = 3000;
/** A non-interactive submission can auto-deny or accept edits, but never blocks. */
const UNATTENDED_DIALOG_KINDS = ['refusal_fallback_prompt'];
/**
 * Diagnose one auto-answered interaction in headless mode.
 * @param mode - permission mode in force.
 * @param kind - what the interaction was.
 * @param answer - what the driver did.
 * @param why - reason the driver cannot forward the interaction.
 * @returns a stable one-line diagnostic.
 */
export function unattendedDiagnostic(mode, kind, answer, why) {
    return `claude-code: ${kind} ${answer} (mode ${mode}): ${why}`;
}
/**
 * LLM credential env vars that scrubbedParentEnv() strips (they match
 * KEY/TOKEN/SECRET) but the Claude Code CLI needs to authenticate.
 * Explicitly re-inheriting them lets the CLI reuse whatever provider
 * the dsh host is already authenticated against (Bedrock, Vertex, etc.)
 * without requiring a separate `claude login`.
 */
const INHERITED_LLM_ENV_KEYS = [
    'CLAUDE_CODE_USE_BEDROCK',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_PROFILE',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'CLAUDE_CODE_USE_VERTEX',
    'CLOUD_ML_REGION',
    'ANTHROPIC_VERTEX_PROJECT_ID',
];
function inheritedLlmCredentials() {
    const creds = {};
    for (const key of INHERITED_LLM_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined)
            creds[key] = value;
    }
    return creds;
}
/**
 * Build the fixed official SDK options for one step's query.
 * @param spec - workspace, environment, process seam, and disposal policy.
 * @param controller - per-query cancellation owner.
 * @returns the options for one stateless query.
 */
export function claudeQueryOptions(spec, controller) {
    const report = spec.onUnattended ?? (() => { });
    const forward = spec.onToolPermission;
    return {
        abortController: controller,
        cwd: spec.cwd,
        env: {
            ...scrubbedParentEnv(),
            ...inheritedLlmCredentials(),
            ...spec.env,
        },
        // Emit `stream_event` partial messages so the loop can forward token
        // deltas to the dsh session as `assistant/chunk` events (the web surface
        // streams those). Without it the SDK yields only complete `assistant`
        // messages, so the surface renders each response all at once.
        includePartialMessages: true,
        persistSession: true,
        disallowedTools: spec.permissionMode === 'plan'
            ? ['AskUserQuestion', 'ExitPlanMode']
            : ['AskUserQuestion'],
        permissionMode: spec.permissionMode,
        ...spec.model === undefined ? {} : { model: spec.model },
        ...spec.maxTurns === undefined ? {} : { maxTurns: spec.maxTurns },
        ...spec.permissionMode === 'bypassPermissions'
            ? { allowDangerouslySkipPermissions: true }
            : {
                canUseTool: forward === undefined
                    ? () => {
                        report(unattendedDiagnostic(spec.permissionMode, 'tool permission', 'denied', 'the Claude Code driver does not request human approval'));
                        return Promise.resolve({
                            behavior: 'deny',
                            message: 'This unattended Claude Code driver cannot request human approval.',
                        });
                    }
                    : async (toolName, input, { signal }) => {
                        const verdict = await forward(toolName, input, signal);
                        return verdict === 'allow'
                            ? { behavior: 'allow', updatedInput: input }
                            : { behavior: 'deny', message: 'The dsh user rejected this action.' };
                    },
            },
        onElicitation: () => {
            report(unattendedDiagnostic(spec.permissionMode, 'MCP elicitation', 'declined', 'the driver does not collect interactive MCP input'));
            return Promise.resolve({ action: 'decline' });
        },
        onUserDialog: () => {
            report(unattendedDiagnostic(spec.permissionMode, 'user dialog', 'cancelled', 'the driver does not render blocking dialogs'));
            return Promise.resolve({ behavior: 'cancelled' });
        },
        supportedDialogKinds: UNATTENDED_DIALOG_KINDS,
        spawnClaudeCodeProcess: (options) => {
            const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs));
            return new ManagedClaudeCodeProcess(child);
        },
    };
}
//# sourceMappingURL=sdk.js.map