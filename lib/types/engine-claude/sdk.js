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
 * Backend-selecting env keys, grouped because the CLI resolves them by
 * precedence rather than by merging: with `CLAUDE_CODE_USE_BEDROCK` set, an
 * `ANTHROPIC_BASE_URL` pointing at a relay is ignored outright, and a model the
 * relay serves comes back as "not available on your bedrock deployment".
 *
 * So exactly one group is forwarded and the rest are actively removed. Order
 * is the `auto` precedence: a relay is a deliberate local choice, so it wins
 * over ambient cloud credentials that a login may have left behind.
 */
const BACKEND_ENV_GROUPS = [
    {
        /**
         * Native protocol against an explicit endpoint — typically a local relay,
         * where AUTH_TOKEN is often a placeholder.
         */
        id: 'relay',
        selector: 'ANTHROPIC_BASE_URL',
        keys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    },
    {
        /** Bedrock, direct or behind a corporate gateway. */
        id: 'bedrock',
        selector: 'CLAUDE_CODE_USE_BEDROCK',
        keys: [
            'CLAUDE_CODE_USE_BEDROCK',
            'ANTHROPIC_BEDROCK_BASE_URL',
            'AWS_BEARER_TOKEN_BEDROCK',
            // A gateway terminating TLS with a private CA, or rejecting HTTP/2,
            // hangs without these rather than failing loudly.
            'AWS_BEDROCK_FORCE_HTTP1',
            'AWS_ACCESS_KEY_ID',
            'AWS_SECRET_ACCESS_KEY',
            'AWS_SESSION_TOKEN',
            'AWS_REGION',
            'AWS_DEFAULT_REGION',
            'AWS_PROFILE',
        ],
    },
    {
        /** Vertex. */
        id: 'vertex',
        selector: 'CLAUDE_CODE_USE_VERTEX',
        keys: ['CLAUDE_CODE_USE_VERTEX', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID'],
    },
    {
        /** Direct Anthropic with no explicit endpoint. */
        id: 'anthropic',
        selector: 'ANTHROPIC_API_KEY',
        keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    },
];
/**
 * Env keys forwarded regardless of backend: model routing, transport, and
 * chatter suppression. None of these select a backend, so no group owns them.
 *
 * The proxy trio survives scrubbedParentEnv() on its own (it matches no
 * sensitive pattern) and is listed for readability — one table describing
 * everything the child needs to reach a provider.
 */
const SHARED_ENV_KEYS = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'DISABLE_NON_ESSENTIAL_MODEL_CALLS',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
];
/**
 * Re-inherit the credentials and routing the CLI needs, forwarding exactly one
 * backend so a second cannot take precedence over the intended endpoint.
 *
 * @param backend - the deployment's choice; `auto` takes the first configured.
 * @returns env entries to lay over the scrubbed parent environment.
 */
function inheritedLlmCredentials(backend) {
    const creds = {};
    const take = (key) => {
        const value = process.env[key];
        if (value !== undefined)
            creds[key] = value;
    };
    const chosen = backend === 'auto'
        ? BACKEND_ENV_GROUPS.find((group) => process.env[group.selector] !== undefined)
        : BACKEND_ENV_GROUPS.find((group) => group.id === backend);
    for (const key of chosen?.keys ?? [])
        take(key);
    for (const key of SHARED_ENV_KEYS)
        take(key);
    return creds;
}
/**
 * Compose the child environment: the scrubbed parent, minus every backend the
 * caller did not select, plus the selected backend's credentials and routing,
 * with the deployment's explicit entries last.
 *
 * The subtraction matters. scrubbedParentEnv() only drops secrets, so plain
 * selectors like `CLAUDE_CODE_USE_BEDROCK` reach the child on their own and
 * outrank a relay's `ANTHROPIC_BASE_URL` — leaving the CLI on the wrong
 * backend even though nothing re-inherited it.
 *
 * @param spec - the query spec carrying the deployment's env overlay.
 * @returns the child environment.
 */
function claudeChildEnv(spec) {
    const selected = inheritedLlmCredentials(spec.backend ?? 'auto');
    const env = { ...scrubbedParentEnv() };
    for (const group of BACKEND_ENV_GROUPS) {
        for (const key of group.keys) {
            if (!(key in selected))
                delete env[key];
        }
    }
    return { ...env, ...selected, ...spec.env };
}
/**
 * Describe the backend the child will actually run on.
 *
 * A misrouted child fails far from its cause: with nothing configured the CLI
 * falls back to its own login state and reports "Not logged in", and with the
 * wrong backend it reports a model that is "not available". Neither names the
 * environment, so state the resolved routing up front.
 *
 * @param env - the composed child environment.
 * @param backend - the deployment's choice.
 * @returns a one-line diagnostic, or undefined when routing is unambiguous.
 */
export function backendDiagnostic(env, backend) {
    const active = BACKEND_ENV_GROUPS.find((group) => env[group.selector] !== undefined);
    if (active === undefined) {
        return `claude-code: no provider backend configured (backend ${backend}); `
            + 'the CLI will fall back to its own login state. Set ANTHROPIC_BASE_URL '
            + 'for a relay, or CLAUDE_CODE_USE_BEDROCK/CLAUDE_CODE_USE_VERTEX, via the '
            + "plugin's `env` config or the environment dsh was launched from.";
    }
    if (backend === 'auto' && active.id !== BACKEND_ENV_GROUPS[0].id) {
        return `claude-code: routing to ${active.id} (backend auto)`;
    }
    return undefined;
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
    const childEnv = claudeChildEnv(spec);
    const routing = backendDiagnostic(childEnv, spec.backend ?? 'auto');
    if (routing !== undefined)
        report(routing);
    return {
        abortController: controller,
        cwd: spec.cwd,
        env: childEnv,
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