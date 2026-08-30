var __knownSymbol = (name2, symbol) => (symbol = Symbol[name2]) ? symbol : /* @__PURE__ */ Symbol.for("Symbol." + name2);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __using = (stack, value, async) => {
  if (value != null) {
    if (typeof value !== "object" && typeof value !== "function") __typeError("Object expected");
    var dispose, inner;
    if (async) dispose = value[__knownSymbol("asyncDispose")];
    if (dispose === void 0) {
      dispose = value[__knownSymbol("dispose")];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") __typeError("Object not disposable");
    if (inner) dispose = function() {
      try {
        inner.call(this);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    stack.push([async, dispose, value]);
  } else if (async) {
    stack.push([async]);
  }
  return value;
};
var __callDispose = (stack, error, hasError) => {
  var E = typeof SuppressedError === "function" ? SuppressedError : function(e, s, m, _) {
    return _ = Error(m), _.name = "SuppressedError", _.error = e, _.suppressed = s, _;
  };
  var fail = (e) => error = hasError ? new E(e, error, "An error was suppressed during disposal") : (hasError = true, e);
  var next = (it) => {
    while (it = stack.pop()) {
      try {
        var result = it[1] && it[1].call(it[2]);
        if (it[0]) return Promise.resolve(result).then(next, (e) => (fail(e), next()));
      } catch (e) {
        fail(e);
      }
    }
    if (hasError) throw error;
  };
  return next();
};

// src/index.ts
import { mkdirSync, readFileSync as readFileSync3, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile as readFile4, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname as dirname4, join as join8 } from "node:path";
import z5 from "@deepseek-ai/schemastery";
// installSettingsSection removed — harness uses ctx.settings.installSection()
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

// src/engine-claude/loop.ts
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { emitAgentEvent } from "@deepseek-ai/dsh-agent";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { SessionPreparation } from "@deepseek-ai/dsh-session";

// src/engine-claude/agent.ts
import { Inbox, agentEvents } from "@deepseek-ai/dsh-agent";
import { LlmError, createAssistantMessage, createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { createScope } from "@deepseek-ai/dsh-scope";
import { canonicalHeader } from "@deepseek-ai/dsh-session";
import { query as officialQuery } from "@anthropic-ai/claude-agent-sdk";

// src/engine-claude/mapping.ts
import {
  ToolCallId,
  createToolResultMessage
} from "@deepseek-ai/dsh-llm";
function stringifyToolInput(input) {
  try {
    return JSON.stringify(input) ?? "null";
  } catch {
    return "[unserializable tool input]";
  }
}
function mapAssistantMessage(message) {
  const content = [];
  const toolCalls = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "tool_use": {
        const callId = ToolCallId(block.id);
        content.push({
          type: "tool-call",
          id: callId,
          name: block.name,
          arguments: stringifyToolInput(block.input)
        });
        toolCalls.push({
          callId,
          name: block.name,
          arguments: stringifyToolInput(block.input)
        });
        break;
      }
      case "thinking":
        content.push({ type: "reasoning", text: block.thinking });
        break;
      default:
        break;
    }
  }
  const usage = message.usage === void 0 ? void 0 : mapUsage(message.usage);
  return {
    content,
    toolCalls,
    usage,
    model: message.model
  };
}
function mapToolResults(message) {
  const content = typeof message.content === "string" ? [] : message.content;
  const results = [];
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    results.push(createToolResultMessage({
      callId: ToolCallId(block.tool_use_id),
      content: toolResultContent(block.content),
      isError: block.is_error === true
    }));
  }
  return results;
}
function toolResultContent(content) {
  const blocks = [];
  if (typeof content === "string") {
    blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const candidate = block;
      if (candidate === null || candidate.type !== "text") continue;
      if (typeof candidate.text !== "string") continue;
      blocks.push({ type: "text", text: candidate.text });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "(no content)" });
  return blocks;
}
function mapUsage(usage) {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...usage.cache_read_input_tokens == null ? {} : { cacheReadTokens: usage.cache_read_input_tokens },
    ...usage.cache_creation_input_tokens == null ? {} : { cacheWriteTokens: usage.cache_creation_input_tokens }
  };
}
function mapStreamEvent(event, toolCalls) {
  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block;
      if (block.type === "text") {
        return [{ type: "block-start", index: event.index, blockType: "text" }];
      }
      if (block.type === "thinking") {
        return [{ type: "block-start", index: event.index, blockType: "reasoning" }];
      }
      if (block.type === "tool_use") {
        toolCalls.set(event.index, { callId: ToolCallId(block.id), name: block.name });
        return [{ type: "block-start", index: event.index, blockType: "tool-call" }];
      }
      return [];
    }
    case "content_block_delta": {
      const delta = event.delta;
      if (delta.type === "text_delta") {
        return [{ type: "text-delta", index: event.index, text: delta.text }];
      }
      if (delta.type === "thinking_delta") {
        return [{ type: "reasoning-delta", index: event.index, text: delta.thinking }];
      }
      if (delta.type === "input_json_delta") {
        const call = toolCalls.get(event.index);
        return [{
          type: "tool-call-delta",
          index: event.index,
          id: call?.callId ?? ToolCallId(`call-${event.index}`),
          ...call === void 0 ? {} : { name: call.name },
          argumentsDelta: delta.partial_json
        }];
      }
      return [];
    }
    default:
      return [];
  }
}

// src/driver-core/prompt.ts
var OMITTED_IMAGE_TEXT = "[image omitted: the driver does not transcribe images; read the file when a path is available]";
function frame(tag, body) {
  return `<${tag}>
${body}
</${tag}>`;
}
function renderAssistantBlocks(blocks) {
  const sections = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        sections.push(block.text);
        break;
      case "tool-call":
        sections.push(`[tool call: ${block.name}(${block.arguments})]`);
        break;
      case "image":
        sections.push(OMITTED_IMAGE_TEXT);
        break;
      default:
        break;
    }
  }
  return sections.join("\n\n");
}
function renderToolResult(message) {
  const block = message.content[0];
  const body = block.content.map((child) => {
    switch (child.type) {
      case "text":
        return child.text;
      case "image":
        return OMITTED_IMAGE_TEXT;
      default:
        return "";
    }
  }).filter((section) => section !== "").join("\n\n");
  const tag = block.isError === true ? "tool-result-error" : "tool-result";
  return frame(tag, body || "(no content)");
}
function serializeHistory(messages) {
  const sections = [];
  for (const message of messages) {
    switch (message.role) {
      case "assistant": {
        const body = renderAssistantBlocks(message.content);
        if (body !== "") sections.push(frame("assistant", body));
        break;
      }
      case "user": {
        const user = message;
        if (user.source.kind === "tool") {
          sections.push(renderToolResult(user));
        } else {
          const body = user.content.map((block) => {
            switch (block.type) {
              case "text":
                return block.text;
              case "image":
                return OMITTED_IMAGE_TEXT;
              default:
                return "";
            }
          }).filter((section) => section !== "").join("\n\n");
          sections.push(frame("user", body || "(no content)"));
        }
        break;
      }
      default:
        break;
    }
  }
  return sections.join("\n\n");
}

// src/driver-core/permission-knobs.ts
var SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
var APPROVAL_POLICIES = ["ask", "never"];
function sessionSandboxMode(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "sandbox/mode") continue;
    const mode = event.data.mode;
    return SANDBOX_MODES.includes(mode) ? mode : void 0;
  }
  return void 0;
}
function sessionApprovalPolicy(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "approval/policy") continue;
    const policy = event.data.policy;
    return APPROVAL_POLICIES.includes(policy) ? policy : void 0;
  }
  return void 0;
}

// src/engine-claude/permission.ts
function resolveSessionPermission(events) {
  if (sessionSandboxMode(events) === "danger-full-access") return { kind: "bypass" };
  if (sessionApprovalPolicy(events) === "ask") return { kind: "ask" };
  return { kind: "deny" };
}
var REASON_INPUT_CAP = 200;
function approvalReason(toolName, input) {
  const excerpt = JSON.stringify(input);
  const bounded = excerpt.length > REASON_INPUT_CAP ? `${excerpt.slice(0, REASON_INPUT_CAP - 3)}...` : excerpt;
  return `Claude Code requests permission to run ${toolName}: ${bounded}`;
}

// src/engine-claude/sdk.ts
import { scrubbedParentEnv as scrubbedParentEnv2 } from "@deepseek-ai/dsh-subprocess";

// src/engine-claude/process.ts
import { EventEmitter } from "node:events";
import {
  scrubbedParentEnv
} from "@deepseek-ai/dsh-subprocess";
function thrown(value) {
  return value instanceof Error ? value : new Error(String(value));
}
function sdkEnvironmentOverlay(env) {
  const overlay = { ...env };
  for (const name2 of Object.keys(scrubbedParentEnv())) {
    if (!(name2 in env)) overlay[name2] = void 0;
  }
  return overlay;
}
function claudeSpawnSpec(options, graceMs) {
  if (options.cwd === void 0 || options.cwd.length === 0) {
    throw new Error("agent-loop-claude-code: SDK spawn request omitted its workspace");
  }
  return {
    argv: [options.command, ...options.args],
    cwd: options.cwd,
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    graceMs,
    signal: options.signal,
    env: sdkEnvironmentOverlay(options.env)
  };
}
var ManagedClaudeCodeProcess = class {
  /**
   * Project a managed process with piped stdin and stdout.
   * @param child - shared handle that remains the process-tree authority.
   */
  constructor(child) {
    this.child = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.events.on("error", () => {
    });
    void child.done.then(
      (outcome) => {
        this.outcomeValue = outcome;
        this.events.emit("exit", outcome.exitCode, outcome.signal);
      },
      (error) => {
        this.events.emit("error", thrown(error));
      }
    );
  }
  child;
  stdin;
  stdout;
  events = new EventEmitter();
  outcomeValue;
  killRequested = false;
  /** Whether the SDK has requested managed tree termination. */
  get killed() {
    return this.killRequested;
  }
  /** Direct-child exit code, or null while running or after signal exit. */
  get exitCode() {
    return this.outcomeValue?.exitCode ?? null;
  }
  /** Direct-child terminating signal, if any. */
  get signalCode() {
    return this.outcomeValue?.signal ?? null;
  }
  /** Exact managed-process outcome after exit, or undefined while running. */
  get outcome() {
    return this.outcomeValue;
  }
  /**
   * Route the SDK's termination request to the tree-scoped process owner.
   * @param _signal - SDK-selected signal; the shared seam owns its escalation ladder.
   * @returns false only after exit or a previous termination request.
   */
  kill(_signal) {
    if (this.killRequested || this.outcomeValue !== void 0) {
      return false;
    }
    this.killRequested = true;
    this.child.terminate();
    return true;
  }
  /** Register a persistent process lifecycle listener. */
  on(event, listener) {
    this.events.on(event, listener);
  }
  /** Register a one-shot process lifecycle listener. */
  once(event, listener) {
    this.events.once(event, listener);
  }
  /** Remove a process lifecycle listener. */
  off(event, listener) {
    this.events.off(event, listener);
  }
};

// src/engine-claude/sdk.ts
var DEFAULT_PERMISSION_MODE = "dontAsk";
var DEFAULT_DISPOSE_GRACE_MS = 3e3;
var UNATTENDED_DIALOG_KINDS = ["refusal_fallback_prompt"];
function unattendedDiagnostic(mode, kind, answer, why) {
  return `claude-code: ${kind} ${answer} (mode ${mode}): ${why}`;
}
var INHERITED_LLM_ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_USE_VERTEX",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID"
];
function inheritedLlmCredentials() {
  const creds = {};
  for (const key of INHERITED_LLM_ENV_KEYS) {
    const value = process.env[key];
    if (value !== void 0) creds[key] = value;
  }
  return creds;
}
function claudeQueryOptions(spec, controller) {
  const report = spec.onUnattended ?? (() => {
  });
  const forward = spec.onToolPermission;
  return {
    abortController: controller,
    cwd: spec.cwd,
    env: {
      ...scrubbedParentEnv2(),
      ...inheritedLlmCredentials(),
      ...spec.env
    },
    // Emit `stream_event` partial messages so the loop can forward token
    // deltas to the dsh session as `assistant/chunk` events (the web surface
    // streams those). Without it the SDK yields only complete `assistant`
    // messages, so the surface renders each response all at once.
    includePartialMessages: true,
    persistSession: true,
    disallowedTools: spec.permissionMode === "plan" ? ["AskUserQuestion", "ExitPlanMode"] : ["AskUserQuestion"],
    permissionMode: spec.permissionMode,
    ...spec.model === void 0 ? {} : { model: spec.model },
    ...spec.maxTurns === void 0 ? {} : { maxTurns: spec.maxTurns },
    ...spec.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {
      canUseTool: forward === void 0 ? () => {
        report(unattendedDiagnostic(
          spec.permissionMode,
          "tool permission",
          "denied",
          "the Claude Code driver does not request human approval"
        ));
        return Promise.resolve({
          behavior: "deny",
          message: "This unattended Claude Code driver cannot request human approval."
        });
      } : async (toolName, input, { signal }) => {
        const verdict = await forward(toolName, input, signal);
        return verdict === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The dsh user rejected this action." };
      }
    },
    onElicitation: () => {
      report(unattendedDiagnostic(
        spec.permissionMode,
        "MCP elicitation",
        "declined",
        "the driver does not collect interactive MCP input"
      ));
      return Promise.resolve({ action: "decline" });
    },
    onUserDialog: () => {
      report(unattendedDiagnostic(
        spec.permissionMode,
        "user dialog",
        "cancelled",
        "the driver does not render blocking dialogs"
      ));
      return Promise.resolve({ behavior: "cancelled" });
    },
    supportedDialogKinds: UNATTENDED_DIALOG_KINDS,
    spawnClaudeCodeProcess: (options) => {
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs));
      return new ManagedClaudeCodeProcess(child);
    }
  };
}

// src/driver-core/skill-inject.ts
var SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
function isSkillName(name2) {
  return SKILL_NAME_RE.test(name2);
}
function escapeText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function escapeAttr(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
function renderSkillContent(skill) {
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    "<skill_resources>",
    skill.resourceBase !== void 0 && skill.resourceBase.kind === "directory" ? `Base directory for this skill: ${escapeText(skill.resourceBase.path)}. Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.` : `Resources for this skill are managed by provider "${escapeText(skill.provider)}". Load referenced resources only as needed.`,
    "</skill_resources>",
    "",
    "<skill_instructions>",
    skill.content,
    "</skill_instructions>",
    "</skill_content>"
  ].join("\n");
}
function invokedSkillNames(messages) {
  const names = [];
  for (const message of messages) {
    if (message.source.kind !== "user") continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name2 = match[2];
        if (name2 !== void 0 && !names.includes(name2)) names.push(name2);
      }
    }
  }
  return names;
}

// src/engine-claude/agent.ts
var PROVIDER = "claude-code";
var NATIVE_MODEL_LABEL = "claude-code-native";
function failureCode(subtype) {
  switch (subtype) {
    case "error_during_execution":
    case "error_max_turns":
    case "error_max_budget_usd":
    case "error_max_structured_output_retries":
      return `CLAUDE_CODE_${subtype.toUpperCase()}`;
    default:
      return "CLAUDE_CODE_ERROR";
  }
}
var ClaudeCodeAgent = class {
  constructor(loopCtx, id, options, session, config) {
    this.loopCtx = loopCtx;
    this.id = id;
    this.options = options;
    this.session = session;
    this.config = config;
    this.dispatch = agentEvents(loopCtx, this);
    this.inbox = new Inbox(session, {
      inserted: (message) => {
        this.dispatch.emit("agent/inbox/inserted", { message });
      },
      discarded: (message) => {
        this.dispatch.emit("agent/inbox/discarded", { message });
      },
      claimed: (message, turn) => {
        this.dispatch.emit("agent/inbox/claimed", { message, turn });
      }
    });
    const lastTurn = session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
    this.phase = { kind: "idle", lastTurn };
    this.scope = createScope(loopCtx, this);
    this.ctx = this.scope.ctx.extend({ agent: this });
  }
  loopCtx;
  id;
  options;
  session;
  config;
  inbox;
  phase;
  activityDone = Promise.resolve();
  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  scope;
  ctx;
  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  dispatch;
  /** Whether this loop instance has appended its initial/resume request anchor. */
  requestHeaderLogged = false;
  get status() {
    return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running";
  }
  /** Commit a phase and publish its externally visible status transition. */
  setPhase(next) {
    const previousStatus = this.status;
    this.phase = next;
    const status = this.status;
    if (status !== previousStatus) {
      this.dispatch.emit("agent/status", { status });
    }
  }
  send(message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
    const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
    this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
    if (wakeup) this.wakeDriver(wakingAfterAbort);
  }
  /**
   * Queue a message for the next turn and wake the driver.
   * @param input - the user message to deliver.
   */
  followup(input) {
    this.send(input, "next-turn", true);
  }
  /**
   * Queue a message for the running step and wake the driver.
   * @param input - the user message to deliver.
   */
  steer(input) {
    this.send(input, "next-step", true);
  }
  /**
   * Queue a message for the running step without waking the driver.
   * @param input - the user message to deliver.
   */
  inject(input) {
    this.send(input, "next-step", false);
  }
  cancel(cause, options = {}) {
    if (!options.keepInbox) {
      this.inbox.clear();
      if (this.phase.kind !== "idle") this.phase.wakeRequested = false;
    }
    if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
  }
  /**
   * Run a maintenance job while the agent is idle.
   * @param job - the maintenance operation, receiving the phase abort signal.
   * @returns the maintenance result.
   */
  runMaintenance(job) {
    if (this.phase.kind !== "idle") throw new Error(`agent "${this.id}" already has active work`);
    const done = Promise.withResolvers();
    const maintenance = {
      kind: "maintenance",
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false
    };
    this.setPhase(maintenance);
    this.activityDone = done.promise;
    return (async () => {
      try {
        return await job(maintenance.abort.signal);
      } finally {
        this.setPhase({ kind: "idle", lastTurn: maintenance.lastTurn });
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver();
        done.resolve();
      }
    })();
  }
  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  wakeDriver(wakeAfterAbort = false) {
    if (this.phase.kind !== "idle") {
      const reason = this.phase.abort.signal.reason;
      if (reason?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort)) {
        this.phase.wakeRequested = true;
      }
      return;
    }
    const driver = Promise.withResolvers();
    this.activityDone = driver.promise;
    this.setPhase({
      kind: "running",
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false
    });
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
  }
  async whenIdle() {
    let activity;
    do {
      await (activity = this.activityDone);
    } while (activity !== this.activityDone);
  }
  /** Report one failure at its live boundary, then preserve it for driver containment. */
  throwError(error) {
    const turn = this.phase.kind === "running" ? this.phase.turn : this.phase.lastTurn;
    const step = this.phase.kind === "running" ? this.phase.step : 0;
    this.dispatch.emit("agent/error", { turn, step, error });
    throw error;
  }
  async kick() {
    try {
      while (await this.turn()) {
      }
    } catch (_error) {
    } finally {
      if (this.phase.kind === "running") {
        const { turn, wakeRequested } = this.phase;
        this.setPhase({ kind: "idle", lastTurn: turn });
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver();
      }
    }
  }
  async preStep(target, position) {
    if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
    const signal = this.phase.abort.signal;
    const claimed = this.inbox.claim(target, position.turn);
    const decision = await this.dispatch.waterfall(
      "agent/pre-step",
      { messages: claimed, ...position, signal },
      () => Promise.resolve({ kind: "enter", messages: claimed })
    );
    signal.throwIfAborted();
    if (decision.kind === "reject") return decision;
    const injected = await this.injectSkills(decision.messages, signal);
    signal.throwIfAborted();
    return injected !== decision.messages ? { kind: "enter", messages: [...injected] } : { ...decision };
  }
  /**
   * Scan the step's user messages for `/name` skill gestures, load each
   * matching skill, and inject the rendered skill content into the message
   * batch.  This mirrors what dsh-tool-skill does for the in-process engine.
   * @param messages - the current step's message batch.
   * @param signal - cancellation signal (aborted loads are silently dropped).
   * @returns the original batch when no skill was invoked, or an extended
   *   batch with injected skill-content messages appended.
   */
  async injectSkills(messages, signal) {
    const names = invokedSkillNames(messages);
    if (names.length === 0) return messages;
    const skills = this.loopCtx.get("skills");
    if (skills === void 0) return messages;
    const cwd = this.session.header.cwd;
    const injections = [];
    for (const name2 of names) {
      if (!isSkillName(name2)) continue;
      let skill;
      try {
        skill = await skills.get(name2, { signal, scope: this, ...cwd === void 0 ? {} : { cwd } });
      } catch {
        continue;
      }
      if (skill === void 0 || !skill.invocation.userInvocable) continue;
      if (signal.aborted) return messages;
      injections.push(createUserMessage({
        content: [{ type: "text", text: renderSkillContent(skill) }],
        source: { kind: "skill-invocation", name: name2, form: "instructions" }
      }));
    }
    return injections.length > 0 ? [...messages, ...injections] : messages;
  }
  /**
   * Resolve the native permission handling for one query. A deployment-pinned
   * mode wins outright; otherwise the session's durable dsh permission knobs
   * decide per query (mid-session preset switches included): full access
   * bypasses native checks, an `ask` policy forwards each native permission
   * request to the dsh approval seam, and anything else fails closed with the
   * unattended deny-all stance.
   * @returns the permission fields of the query spec.
   */
  queryPermission() {
    if (this.config.permissionMode !== void 0) return { permissionMode: this.config.permissionMode };
    const permission = resolveSessionPermission(this.session.events);
    if (permission.kind === "bypass") return { permissionMode: "bypassPermissions" };
    if (permission.kind === "ask") {
      const approval = this.loopCtx.get("approval");
      if (approval !== void 0) {
        return {
          permissionMode: "default",
          onToolPermission: async (toolName, input, signal) => {
            const outcome = await approval.request({
              agent: this,
              toolName,
              reason: approvalReason(toolName, input),
              signal
            });
            return outcome === "allowed-once" ? "allow" : "deny";
          }
        };
      }
    }
    return { permissionMode: DEFAULT_PERMISSION_MODE };
  }
  /** Open one turn before claiming its first proposed step. */
  async turn() {
    if (this.phase.kind !== "running") {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`));
    }
    const phase = this.phase;
    const { signal } = phase.abort;
    signal.throwIfAborted();
    const turn = phase.turn + 1;
    try {
      this.session.append("turn/start", { turn });
    } catch (error) {
      this.throwError(error);
    }
    phase.turn = turn;
    let turnEnds = null;
    let target = "next-turn";
    try {
      while (true) {
        signal.throwIfAborted();
        const step = phase.step + 1;
        const decision = await this.preStep(target, { turn, step });
        if (decision.kind === "reject") {
          turnEnds = { kind: "blocked" };
          return false;
        }
        if (turnEnds && decision.messages.length === 0) break;
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: "completed" };
          return false;
        }
        signal.throwIfAborted();
        this.session.append("step/start", { turn, step });
        phase.step = step;
        try {
          for (const message of decision.messages) {
            this.session.append("user/message", message, { surfaceOp: "append" });
          }
          const stepEnd = await this.step();
          if (turnEnds === null) turnEnds = stepEnd;
        } finally {
          this.session.append("step/end", { turn, step });
        }
        signal.throwIfAborted();
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial("agent/turn-stopping", { turn, signal });
          signal.throwIfAborted();
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break;
        target = "next-step";
      }
    } catch (error) {
      if (signal.aborted) {
        turnEnds = { kind: "aborted", reason: signal.reason };
        throw error;
      }
      turnEnds = {
        kind: "error",
        error: error instanceof LlmError ? error.failure : { message: errorChain(error), code: "UNKNOWN" }
      };
      this.throwError(error);
    } finally {
      try {
        this.session.append("turn/end", { turn, reason: turnEnds });
      } catch (error) {
        this.throwError(error);
      }
    }
    if (!this.inbox.hasPending) return false;
    phase.abort = new AbortController();
    phase.wakeRequested = false;
    phase.step = 0;
    return true;
  }
  /** Model label recorded in the request header for one lifecycle. */
  modelLabel() {
    return this.config.model ?? NATIVE_MODEL_LABEL;
  }
  /** Append the request header snapshot once per loop instance. */
  assertRequestHeader() {
    if (this.requestHeaderLogged) return;
    const header = canonicalHeader({
      config: { provider: PROVIDER, model: this.modelLabel() }
    });
    const baseline = this.session.requestHeader();
    this.session.append("request/header", {
      header,
      reason: baseline === void 0 ? "initial" : "resume"
    });
    this.requestHeaderLogged = true;
  }
  /** Run one Claude Code query for the current step and map its transcript into the session log. */
  async step() {
    if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": step outside running phase`);
    const { turn, step, abort: { signal } } = this.phase;
    signal.throwIfAborted();
    const cwd = this.session.header.cwd;
    if (cwd === void 0 || cwd.length === 0) {
      throw new Error(`agent "${this.id}": no working directory \u2014 start the session with cwd metadata`);
    }
    const history = this.session.deriveMessages();
    const prompt = serializeHistory(history);
    if (prompt.length === 0) {
      throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`);
    }
    this.assertRequestHeader();
    signal.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason instanceof Error ? signal.reason : new Error(`agent "${this.id}" query aborted`));
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    const diagnostics = [];
    try {
      const options = claudeQueryOptions({
        cwd,
        ...this.queryPermission(),
        env: this.config.env,
        disposeGraceMs: this.config.disposeGraceMs,
        ...this.config.model === void 0 ? {} : { model: this.config.model },
        ...this.config.maxTurns === void 0 ? {} : { maxTurns: this.config.maxTurns },
        spawn: (spec) => this.loopCtx.subprocess.spawn(spec),
        onUnattended: (line) => {
          diagnostics.push(line);
        }
      }, controller);
      const query = officialQuery({ prompt, options });
      let finished = false;
      const chunkSeqs = [];
      const toolCalls = /* @__PURE__ */ new Map();
      const reasoningByIndex = /* @__PURE__ */ new Map();
      let pendingUsage;
      signal.throwIfAborted();
      for await (const message of query) {
        signal.throwIfAborted();
        switch (message.type) {
          case "stream_event": {
            for (const chunk of mapStreamEvent(message.event, toolCalls)) {
              chunkSeqs.push(this.session.append("assistant/chunk", { turn, step, chunk }).seq);
              if (chunk.type === "reasoning-delta") {
                reasoningByIndex.set(chunk.index, (reasoningByIndex.get(chunk.index) ?? "") + chunk.text);
              }
            }
            break;
          }
          case "assistant": {
            const mapped = mapAssistantMessage(message.message);
            const isReasoningOnly = mapped.content.length > 0 && mapped.content.every((block) => block.type === "reasoning");
            if (isReasoningOnly) {
              const reasoning = mapped.content;
              reasoningByIndex.clear();
              reasoning.forEach((block, index) => {
                reasoningByIndex.set(index, block.text);
              });
              pendingUsage = mapped.usage;
              break;
            }
            let content = mapped.content;
            if (reasoningByIndex.size > 0 && !content.some((block) => block.type === "reasoning")) {
              const synthesized = [...reasoningByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => ({ type: "reasoning", text }));
              content = [...synthesized, ...content];
            }
            if (content.length > 0) {
              reasoningByIndex.clear();
              const usage = mapped.usage ?? pendingUsage;
              pendingUsage = void 0;
              this.session.append("assistant/message", {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: { provider: PROVIDER, model: mapped.model }
                }),
                ...usage === void 0 ? {} : { usage }
              }, {
                surfaceOp: "append",
                // Link the durable message to the chunks that streamed it, so
                // replay can reconstruct the partial exactly as shown.
                ...chunkSeqs.length === 0 ? {} : { sourceEventSeqs: chunkSeqs }
              });
            }
            for (const call of mapped.toolCalls) {
              this.session.append("tool/call", {
                turn,
                step,
                callId: call.callId,
                name: call.name,
                arguments: call.arguments
              });
            }
            break;
          }
          case "user": {
            for (const result of mapToolResults(message.message)) {
              this.session.append("tool/result", { turn, step, message: result }, { surfaceOp: "append" });
            }
            break;
          }
          case "result": {
            if (reasoningByIndex.size > 0) {
              const trailing = [...reasoningByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => ({ type: "reasoning", text }));
              reasoningByIndex.clear();
              this.session.append("assistant/message", {
                turn,
                step,
                message: createAssistantMessage({
                  content: trailing,
                  source: { provider: PROVIDER, model: NATIVE_MODEL_LABEL }
                }),
                ...pendingUsage === void 0 ? {} : { usage: pendingUsage }
              }, { surfaceOp: "append" });
              pendingUsage = void 0;
            }
            if (message.subtype === "success") {
              finished = true;
            } else {
              const summary = message.errors[0] ?? `claude code query failed (${message.subtype})`;
              throw new LlmError(summary, failureCode(message.subtype));
            }
            break;
          }
          default:
            break;
        }
      }
      if (!finished) {
        throw new LlmError(
          `agent "${this.id}": claude-code query ended without a result message`,
          "CLAUDE_CODE_NO_RESULT"
        );
      }
      return { kind: "completed" };
    } finally {
      signal.removeEventListener("abort", cancel);
      controller.abort();
      for (const line of diagnostics) this.ctx.logger.warn("%s", line);
    }
  }
};

// src/driver-core/ownership.ts
var FIBER_STATE_FAILED = 3;
var FIBER_STATE_DISPOSED = 4;
var FIBER_STATE_UNLOADING = 5;
var INACTIVE_STATES = /* @__PURE__ */ new Set([
  FIBER_STATE_UNLOADING,
  FIBER_STATE_DISPOSED,
  FIBER_STATE_FAILED
]);
var FactoryOwnership = class {
  constructor(fiber) {
    this.fiber = fiber;
  }
  fiber;
  accepting = true;
  teardown = new AbortController();
  inactive = Promise.withResolvers();
  liveAgents = /* @__PURE__ */ new Set();
  startupTasks = /* @__PURE__ */ new Set();
  /** Aborts (reason: `agent loop is not active` error) when factory teardown begins. */
  get signal() {
    return this.teardown.signal;
  }
  isActive() {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state);
  }
  /** Track one live agent's shared teardown until it has run. */
  track(dispose) {
    this.liveAgents.add(dispose);
    return () => {
      this.liveAgents.delete(dispose);
    };
  }
  /** Join config startup work that begins before an agent exists. */
  trackStartup(job) {
    this.startupTasks.add(job);
    const forget = () => {
      this.startupTasks.delete(job);
    };
    void job.then(forget, forget);
  }
  /** Join one public create/resume continuation; factory dispose awaits its settlement. */
  trackWrapper(job) {
    this.trackStartup(job.then(() => void 0, () => void 0));
  }
  async dispose() {
    this.accepting = false;
    this.teardown.abort(new Error("agent loop is not active"));
    this.inactive.resolve();
    await Promise.all([
      ...[...this.liveAgents].map((dispose) => dispose()),
      ...this.startupTasks
    ]);
  }
};
async function raceAbort(operation, signal, id) {
  const toAbortError = () => {
    return signal.reason instanceof Error ? signal.reason : new Error(`agent "${id}" creation aborted`, { cause: signal.reason });
  };
  if (signal.aborted) throw toAbortError();
  const aborted = Promise.withResolvers();
  const listener = () => {
    aborted.reject(toAbortError());
  };
  signal.addEventListener("abort", listener, { once: true });
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
async function raceAbortCall(operation, signal, id, releaseAbandoned) {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(`agent "${id}" creation aborted`, { cause: signal.reason });
  }
  const pending = Promise.resolve().then(operation);
  try {
    return await raceAbort(pending, signal, id);
  } catch (error) {
    if (signal.aborted && releaseAbandoned !== void 0) {
      void pending.then(releaseAbandoned, () => void 0);
    }
    throw error;
  }
}

// src/engine-claude/loop.ts
var CLAUDE_CODE_PERMISSION_MODES = [
  "dontAsk",
  "acceptEdits",
  "auto",
  "plan",
  "bypassPermissions"
];
var Config = z.object({
  permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES]),
  env: z.dict(z.string()).default({}),
  model: z.string(),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  maxTurns: z.number().step(1).min(1)
});
function resolveConfig(config) {
  const disposeGraceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
  if (!Number.isFinite(disposeGraceMs) || disposeGraceMs <= 0) {
    throw new Error("agent-loop-claude-code: disposeGraceMs must be a positive finite number");
  }
  if (disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `agent-loop-claude-code: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`
    );
  }
  return {
    permissionMode: config.permissionMode,
    env: config.env ?? {},
    model: config.model,
    disposeGraceMs,
    maxTurns: config.maxTurns
  };
}
var ClaudeCodeLoop = class extends Service {
  /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
  static inject = ["agents", "sessions", "systemPrompt", "subprocess"];
  /** Validated configuration owned by the loop plugin. */
  config;
  ownership;
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  runtime;
  constructor(ctx, config) {
    super(ctx, "agentLoopClaudeCode");
    this.config = resolveConfig(config);
    this.ownership = new FactoryOwnership(ctx.fiber);
    this.runtime = { ctx };
    ctx.effect(() => () => this.ownership.dispose(), "agentLoopClaudeCode.transactions()");
    ctx.effect(() => ctx.agents.setFactory(this), "agentLoopClaudeCode.setFactory()");
    ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
    ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
    ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd);
  }
  /**
   * Construct the driver, scope, and one memoized reverse teardown for a new
   * agent. The teardown is registered with the factory and the owner fiber
   * BEFORE publication, so a mid-setup unload rolls everything back; `signal`
   * fuses caller cancellation with lifecycle teardown for setup awaits.
   */
  /* jscpd:ignore-start -- ownership/transaction machinery mirrors the default agent-loop factory; depending on agent-loop is forbidden. */
  prepare(ownerCtx, id, options, session, callerSignal) {
    ownerCtx.fiber.assertActive();
    if (!this.ownership.isActive()) throw new Error("agent loop is not active");
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error ? callerSignal.reason : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason });
    }
    const loopCtx = this.runtime.ctx;
    const abort = new AbortController();
    const onCallerAbort = () => {
      abort.abort(callerSignal?.reason instanceof Error ? callerSignal.reason : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }));
    };
    const onFactoryTeardown = () => {
      abort.abort(this.ownership.signal.reason);
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    this.ownership.signal.addEventListener("abort", onFactoryTeardown, { once: true });
    let machine;
    let detachSession;
    let detachAgent;
    let disposing;
    const machineReady = Promise.withResolvers();
    const dispose = (ownerTriggered = false) => disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`));
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.ownership.signal.removeEventListener("abort", onFactoryTeardown);
      try {
        if (machine === void 0) await machineReady.promise;
        if (machine !== void 0) {
          machine.cancel({ kind: "disposed" });
          await machine.whenIdle();
          await machine.scope.dispose();
        }
      } finally {
        try {
          detachAgent?.();
          detachSession?.();
        } finally {
          untrack();
          if (!ownerTriggered) await unfollowOwner();
        }
      }
    })();
    const untrack = this.ownership.track(dispose);
    let unfollowOwner;
    try {
      unfollowOwner = ownerCtx.effect(() => () => {
        if (disposing !== void 0) return;
        abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
        return dispose(true);
      }, `agentLoopClaudeCode.lifecycle(${id})`);
    } catch (error) {
      untrack();
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.ownership.signal.removeEventListener("abort", onFactoryTeardown);
      throw error;
    }
    const assertLive = () => {
      if (!abort.signal.aborted) return;
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason));
    };
    try {
      const agent = machine = new ClaudeCodeAgent(loopCtx, id, options, session, this.config);
      machineReady.resolve();
      assertLive();
      return {
        agent,
        signal: abort.signal,
        publish: (source) => {
          assertLive();
          detachSession = agent.ctx.sessions.enter(session);
          detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent);
          agent.ctx.sessions.announce(session);
          assertLive();
          loopCtx.agents.announce(agent);
          assertLive();
          emitAgentEvent(loopCtx, agent, "agent/session-start", { source });
          assertLive();
          return { agent, dispose };
        },
        dispose
      };
    } catch (error) {
      machineReady.resolve();
      void dispose();
      throw error;
    }
  }
  /** Prepare one Agent around an acquired Session, run setup, and publish it. */
  async setupAndPublish(ownerCtx, id, preparation, agentOptions, setup, signal, source) {
    var _stack = [];
    try {
      const ownedPreparation = __using(_stack, preparation);
      const session = ownedPreparation.session;
      const prepared = this.prepare(ownerCtx, id, agentOptions, session, signal);
      try {
        const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id);
        setupCommit?.commit();
        return prepared.publish(source);
      } catch (error) {
        await prepared.dispose();
        throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  /**
   * Create an agent and session under one caller-supplied identity, owned by
   * the accessing fiber.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx, options) {
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === void 0 ? {} : { seed: options.seed },
      ...options.meta === void 0 ? {} : { meta: options.meta }
    }));
    const published = this.setupAndPublish(
      ownerCtx,
      options.sessionId,
      preparation,
      options.agentOptions ?? {},
      options.setup,
      options.signal,
      "startup"
    );
    this.ownership.trackWrapper(published);
    return published;
  }
  /**
   * Resume an owned agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx, options) {
    const persistence = this.runtime.ctx.get("sessionPersistence");
    if (persistence === void 0) {
      throw new Error("cannot resume: session persistence is not configured (load a dsh-session-persistence backend)");
    }
    return this.resumeWith(ownerCtx, persistence, options);
  }
  /** Resume through an explicit persistence handle. */
  async resumeWith(ownerCtx, persistence, options) {
    const id = options.resumeSessionId;
    let preparation;
    try {
      const ownerAbort = new AbortController();
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
      }, `agentLoopClaudeCode.resume-load(${id})`);
      const fused = AbortSignal.any([
        ...options.signal === void 0 ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal
      ]);
      try {
        preparation = await raceAbortCall(
          () => persistence.prepare(id, fused),
          fused,
          id,
          (abandoned) => {
            abandoned[Symbol.dispose]();
          }
        );
      } finally {
        await unfollowOwner();
      }
      ownerCtx.fiber.assertActive();
      if (!this.ownership.isActive()) throw new Error("agent loop is not active");
      return await this.setupAndPublish(
        ownerCtx,
        id,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        "resume"
      );
    } finally {
      preparation?.[Symbol.dispose]();
    }
  }
};

// src/engine-codex/loop.ts
import { Service as Service2 } from "@deepseek-ai/cordis";
import z2 from "@deepseek-ai/schemastery";
import { emitAgentEvent as emitAgentEvent2 } from "@deepseek-ai/dsh-agent";
import { SessionPreparation as SessionPreparation2 } from "@deepseek-ai/dsh-session";

// src/engine-codex/agent.ts
import { Inbox as Inbox2, agentEvents as agentEvents2 } from "@deepseek-ai/dsh-agent";
import { LlmError as LlmError2, createAssistantMessage as createAssistantMessage2, createUserMessage as createUserMessage2, errorChain as errorChain2 } from "@deepseek-ai/dsh-llm";
import { createScope as createScope2 } from "@deepseek-ai/dsh-scope";
import { canonicalHeader as canonicalHeader2 } from "@deepseek-ai/dsh-session";

// src/engine-codex/permission.ts
var DEFAULT_CODEX_PERMISSION = {
  sandboxMode: "read-only",
  approvalPolicy: "never"
};
function resolveSessionPermission2(events) {
  if (sessionSandboxMode(events) === "danger-full-access") {
    return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
  }
  if (sessionApprovalPolicy(events) === "ask") {
    return { sandboxMode: "workspace-write", approvalPolicy: "on-request" };
  }
  return DEFAULT_CODEX_PERMISSION;
}

// src/engine-codex/appserver/client.ts
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
var require2 = createRequire(import.meta.url);
function codexCliEntrypoint() {
  return join(dirname(require2.resolve("@openai/codex/package.json")), "bin", "codex.js");
}
var AppServerClient = class _AppServerClient {
  process;
  rl;
  reqId = 1;
  pending = /* @__PURE__ */ new Map();
  notificationHandler;
  stderrHandler;
  disposed = false;
  /** Whether this client was disposed or its server process exited. */
  get closed() {
    return this.disposed;
  }
  /** Create a client by spawning `codex app-server`. */
  constructor(process2) {
    this.process = process2;
    this.rl = createInterface({ input: process2.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    process2.stderr.on("data", (chunk) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        this.stderrHandler?.(line);
      }
    });
    process2.on("exit", () => {
      this.disposed = true;
      const err = new Error("codex app-server process exited unexpectedly");
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });
  }
  /** Spawn the pinned app-server dependency and initialize the client. */
  static async create() {
    const proc = spawn(process.execPath, [codexCliEntrypoint(), "app-server"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new _AppServerClient(proc);
    await client.initialize();
    return client;
  }
  /** Set the notification handler for streaming events. */
  onNotification(handler) {
    this.notificationHandler = handler;
  }
  /** Set the stderr handler for server log lines. */
  onStderr(handler) {
    this.stderrHandler = handler;
  }
  /** Send the initialize handshake. */
  async initialize() {
    const params = {
      clientInfo: {
        name: "dsh-loop-engine",
        title: null,
        version: "0.1.1-rc.2"
      },
      capabilities: { experimentalApi: true, requestAttestation: false }
    };
    return this.request("initialize", params);
  }
  /** Create a new thread. */
  async threadStart(params) {
    return this.request("thread/start", params);
  }
  /** Resume an existing thread. */
  async threadResume(params) {
    return this.request("thread/resume", params);
  }
  /** Start a turn with the given input. */
  async turnStart(params) {
    return this.request("turn/start", params);
  }
  /** Interrupt an active turn. */
  async turnInterrupt(params) {
    return this.request("turn/interrupt", params);
  }
  /** Dispose the client and kill the server process. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rl.close();
    this.process.stdin?.end();
    this.process.kill();
  }
  /** Send a JSON-RPC request and wait for the response. */
  request(method, params) {
    if (this.disposed) {
      return Promise.reject(new Error("app-server client is disposed"));
    }
    const id = this.reqId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve4, reject) => {
      this.pending.set(id, { resolve: resolve4, reject });
      this.process.stdin.write(JSON.stringify(msg) + "\n");
    });
  }
  /** Handle one line of stdout from the server. */
  handleLine(line) {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.id !== void 0) {
      const pending = this.pending.get(obj.id);
      if (pending) {
        this.pending.delete(obj.id);
        if (obj.error) {
          pending.reject(new Error(obj.error.message));
        } else {
          pending.resolve(obj.result);
        }
      }
    }
    if (obj.method !== void 0) {
      this.notificationHandler?.(obj.method, obj.params);
    }
  }
};

// src/engine-codex/appserver/thread.ts
var AppServerThread = class _AppServerThread {
  constructor(client, threadId) {
    this.client = client;
    this.threadId = threadId;
  }
  client;
  threadId;
  /** Create a new thread on the app-server. */
  static async create(client, params) {
    const result = await client.threadStart(params);
    return new _AppServerThread(client, result.thread.id);
  }
  /**
   * Start a turn and stream its events as an async generator.
   * The generator ends when the turn completes or an error occurs.
   */
  async *turn(input, options) {
    const { signal, params } = options;
    const queue = [];
    const earlyNotifications = [];
    let resolve4;
    let done = false;
    let turnError;
    let turnId;
    const notificationHandler = (method, rawParams) => {
      if (done) return;
      const params2 = rawParams;
      if (params2.threadId !== this.threadId) return;
      if (turnId === void 0) {
        earlyNotifications.push([method, rawParams]);
        return;
      }
      let event;
      switch (method) {
        case "item/started": {
          const p = params2;
          if (p.turnId !== turnId) return;
          event = { kind: "item-started", itemType: p.item.type, itemId: p.item.id };
          break;
        }
        case "item/agentMessage/delta": {
          const p = params2;
          if (p.turnId !== turnId) return;
          event = { kind: "agent-delta", itemId: p.itemId, delta: p.delta };
          break;
        }
        case "item/reasoning/summaryTextDelta": {
          const p = params2;
          if (p.turnId !== turnId) return;
          event = { kind: "reasoning-summary-delta", itemId: p.itemId, delta: p.delta, summaryIndex: p.summaryIndex };
          break;
        }
        case "item/reasoning/textDelta": {
          const p = params2;
          if (p.turnId !== turnId) return;
          event = { kind: "reasoning-text-delta", itemId: p.itemId, delta: p.delta, contentIndex: p.contentIndex };
          break;
        }
        case "item/plan/delta": {
          const p = params2;
          if (p.turnId !== turnId) return;
          event = { kind: "plan-delta", itemId: p.itemId, delta: p.delta };
          break;
        }
        case "item/completed": {
          const p = params2;
          if (p.turnId !== turnId) return;
          event = { kind: "item-completed", item: p.item };
          break;
        }
        case "turn/completed": {
          const p = params2;
          if (p.threadId !== this.threadId) return;
          event = { kind: "turn-completed", turn: p.turn };
          done = true;
          break;
        }
        case "thread/tokenUsage/updated": {
          const p = params2;
          if (p.turnId !== turnId) return;
          event = { kind: "token-usage", usage: p.tokenUsage };
          break;
        }
        case "error": {
          const p = params2;
          if (p.turnId !== turnId) return;
          event = { kind: "error", error: p.error, willRetry: p.willRetry };
          done = true;
          turnError = new Error(p.error.message);
          break;
        }
      }
      if (event) {
        queue.push(event);
        resolve4?.();
      }
    };
    this.client.onNotification(notificationHandler);
    let turnResult;
    try {
      turnResult = await this.client.turnStart({
        threadId: this.threadId,
        input,
        ...params
      });
    } catch (error) {
      this.client.onNotification(noopNotificationHandler);
      throw error;
    }
    turnId = turnResult.turn.id;
    for (const [method, rawParams] of earlyNotifications) notificationHandler(method, rawParams);
    earlyNotifications.length = 0;
    yield { kind: "turn-started", turnId };
    const abortHandler = () => {
      if (!done) {
        done = true;
        turnError = signal?.reason instanceof Error ? signal.reason : new Error("turn aborted");
        void this.client.turnInterrupt({ threadId: this.threadId, turnId }).catch(() => {
        });
      }
      resolve4?.();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      while (true) {
        if (done && queue.length === 0) break;
        if (queue.length > 0) {
          yield queue.shift();
        } else {
          await new Promise((r) => {
            resolve4 = r;
          });
          resolve4 = void 0;
        }
      }
      if (turnError) throw turnError;
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      this.client.onNotification(noopNotificationHandler);
    }
  }
};
function noopNotificationHandler() {
}

// src/engine-codex/appserver/mapping.ts
import { ToolCallId as ToolCallId2, createToolResultMessage as createToolResultMessage2 } from "@deepseek-ai/dsh-llm";
function mapUsage2(usage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...usage.cachedInputTokens !== void 0 ? { cacheReadTokens: usage.cachedInputTokens } : {},
    ...usage.reasoningOutputTokens !== void 0 ? { reasoningTokens: usage.reasoningOutputTokens } : {}
  };
}
function mapCommandExecution(item) {
  return {
    call: {
      callId: ToolCallId2(item.id),
      name: "command_execution",
      arguments: JSON.stringify({ command: item.command ?? "" })
    },
    result: createToolResultMessage2({
      callId: ToolCallId2(item.id),
      content: [{ type: "text", text: item.aggregatedOutput ?? "" }],
      isError: (item.exitCode ?? 0) !== 0 || item.status === "failed"
    })
  };
}
function mapFileChange(item) {
  return {
    call: {
      callId: ToolCallId2(item.id),
      name: "apply_patch",
      arguments: JSON.stringify(item.changes ?? [])
    },
    result: createToolResultMessage2({
      callId: ToolCallId2(item.id),
      content: [{ type: "text", text: `patch ${item.status ?? "completed"}` }],
      isError: item.status === "failed"
    })
  };
}
function mapMcpToolCall(item) {
  const name2 = item.server !== void 0 && item.tool !== void 0 ? `${item.server}/${item.tool}` : "mcp_tool_call";
  const isError = item.error !== void 0 && item.error !== null;
  return {
    call: {
      callId: ToolCallId2(item.id),
      name: name2,
      arguments: JSON.stringify(item.arguments ?? {})
    },
    result: createToolResultMessage2({
      callId: ToolCallId2(item.id),
      content: isError ? [{ type: "text", text: item.error?.message ?? "tool call failed" }] : [{ type: "text", text: JSON.stringify(item.result?.content ?? []) }],
      isError
    })
  };
}

// src/engine-codex/agent.ts
var PROVIDER2 = "codex";
var NATIVE_MODEL_LABEL2 = "codex-native";
var CodexAgent = class {
  constructor(loopCtx, id, options, session, config) {
    this.loopCtx = loopCtx;
    this.id = id;
    this.options = options;
    this.session = session;
    this.config = config;
    this.dispatch = agentEvents2(loopCtx, this);
    this.inbox = new Inbox2(session, {
      inserted: (message) => {
        this.dispatch.emit("agent/inbox/inserted", { message });
      },
      discarded: (message) => {
        this.dispatch.emit("agent/inbox/discarded", { message });
      },
      claimed: (message, turn) => {
        this.dispatch.emit("agent/inbox/claimed", { message, turn });
      }
    });
    const lastTurn = session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
    this.phase = { kind: "idle", lastTurn };
    this.scope = createScope2(loopCtx, this);
    this.ctx = this.scope.ctx.extend({ agent: this });
    this.scope.ctx.effect(() => () => {
      this.appServer?.dispose();
      this.appServer = void 0;
    }, "codex.appServerClient()");
  }
  loopCtx;
  id;
  options;
  session;
  config;
  inbox;
  phase;
  activityDone = Promise.resolve();
  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  scope;
  ctx;
  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  dispatch;
  /** Whether this loop instance has appended its initial/resume request anchor. */
  requestHeaderLogged = false;
  /** Lazily created app-server client, reused across steps and released on scope teardown. */
  appServer;
  /** Return the cached app-server client, spawning one on first use or after a dead process. */
  async appServerClient() {
    if (this.appServer !== void 0 && !this.appServer.closed) return this.appServer;
    this.appServer = await AppServerClient.create();
    return this.appServer;
  }
  get status() {
    return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running";
  }
  /** Commit a phase and publish its externally visible status transition. */
  setPhase(next) {
    const previousStatus = this.status;
    this.phase = next;
    const status = this.status;
    if (status !== previousStatus) {
      this.dispatch.emit("agent/status", { status });
    }
  }
  send(message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
    const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
    this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
    if (wakeup) this.wakeDriver(wakingAfterAbort);
  }
  /**
   * Queue a message for the next turn and wake the driver.
   * @param input - the user message to deliver.
   */
  followup(input) {
    this.send(input, "next-turn", true);
  }
  /**
   * Queue a message for the running step and wake the driver.
   * @param input - the user message to deliver.
   */
  steer(input) {
    this.send(input, "next-step", true);
  }
  /**
   * Queue a message for the running step without waking the driver.
   * @param input - the user message to deliver.
   */
  inject(input) {
    this.send(input, "next-step", false);
  }
  cancel(cause, options = {}) {
    if (!options.keepInbox) {
      this.inbox.clear();
      if (this.phase.kind !== "idle") this.phase.wakeRequested = false;
    }
    if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
  }
  /**
   * Run a maintenance job while the agent is idle.
   * @param job - the maintenance operation, receiving the phase abort signal.
   * @returns the maintenance result.
   */
  runMaintenance(job) {
    if (this.phase.kind !== "idle") throw new Error(`agent "${this.id}" already has active work`);
    const done = Promise.withResolvers();
    const maintenance = {
      kind: "maintenance",
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false
    };
    this.setPhase(maintenance);
    this.activityDone = done.promise;
    return (async () => {
      try {
        return await job(maintenance.abort.signal);
      } finally {
        this.setPhase({ kind: "idle", lastTurn: maintenance.lastTurn });
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver();
        done.resolve();
      }
    })();
  }
  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  wakeDriver(wakeAfterAbort = false) {
    if (this.phase.kind !== "idle") {
      const reason = this.phase.abort.signal.reason;
      if (reason?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort)) {
        this.phase.wakeRequested = true;
      }
      return;
    }
    const driver = Promise.withResolvers();
    this.activityDone = driver.promise;
    this.setPhase({
      kind: "running",
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false
    });
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
  }
  async whenIdle() {
    let activity;
    do {
      await (activity = this.activityDone);
    } while (activity !== this.activityDone);
  }
  /** Report one failure at its live boundary, then preserve it for driver containment. */
  throwError(error) {
    const turn = this.phase.kind === "running" ? this.phase.turn : this.phase.lastTurn;
    const step = this.phase.kind === "running" ? this.phase.step : 0;
    this.dispatch.emit("agent/error", { turn, step, error });
    throw error;
  }
  async kick() {
    try {
      while (await this.turn()) {
      }
    } catch (_error) {
    } finally {
      if (this.phase.kind === "running") {
        const { turn, wakeRequested } = this.phase;
        this.setPhase({ kind: "idle", lastTurn: turn });
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver();
      }
    }
  }
  async preStep(target, position) {
    if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
    const signal = this.phase.abort.signal;
    const claimed = this.inbox.claim(target, position.turn);
    const decision = await this.dispatch.waterfall(
      "agent/pre-step",
      { messages: claimed, ...position, signal },
      () => Promise.resolve({ kind: "enter", messages: claimed })
    );
    signal.throwIfAborted();
    if (decision.kind === "reject") return decision;
    const injected = await this.injectSkills(decision.messages, signal);
    signal.throwIfAborted();
    return injected !== decision.messages ? { kind: "enter", messages: [...injected] } : { ...decision };
  }
  /**
   * Scan the step's user messages for `/name` skill gestures, load each
   * matching skill, and inject the rendered skill content into the message
   * batch.  This mirrors what dsh-tool-skill does for the in-process engine.
   * @param messages - the current step's message batch.
   * @param signal - cancellation signal (aborted loads are silently dropped).
   * @returns the original batch when no skill was invoked, or an extended
   *   batch with injected skill-content messages appended.
   */
  async injectSkills(messages, signal) {
    const names = invokedSkillNames(messages);
    if (names.length === 0) return messages;
    const skills = this.loopCtx.get("skills");
    if (skills === void 0) return messages;
    const cwd = this.session.header.cwd;
    const injections = [];
    for (const name2 of names) {
      if (!isSkillName(name2)) continue;
      let skill;
      try {
        skill = await skills.get(name2, { signal, scope: this, ...cwd === void 0 ? {} : { cwd } });
      } catch {
        continue;
      }
      if (skill === void 0 || !skill.invocation.userInvocable) continue;
      if (signal.aborted) return messages;
      injections.push(createUserMessage2({
        content: [{ type: "text", text: renderSkillContent(skill) }],
        source: { kind: "skill-invocation", name: name2, form: "instructions" }
      }));
    }
    return injections.length > 0 ? [...messages, ...injections] : messages;
  }
  /**
   * Resolve the declarative permission stance for one query. Deployment-pinned
   * fields win per field; anything unpinned follows the session's durable dsh
   * permission knobs, re-folded per query so mid-session preset switches take
   * effect on the next step.
   * @returns the permission fields of the query spec.
   */
  queryPermission() {
    const fold = resolveSessionPermission2(this.session.events);
    return {
      sandboxMode: this.config.sandboxMode ?? fold.sandboxMode,
      approvalPolicy: this.config.approvalPolicy ?? fold.approvalPolicy
    };
  }
  /** Open one turn before claiming its first proposed step. */
  async turn() {
    if (this.phase.kind !== "running") {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`));
    }
    const phase = this.phase;
    const { signal } = phase.abort;
    signal.throwIfAborted();
    const turn = phase.turn + 1;
    try {
      this.session.append("turn/start", { turn });
    } catch (error) {
      this.throwError(error);
    }
    phase.turn = turn;
    let turnEnds = null;
    let target = "next-turn";
    try {
      while (true) {
        signal.throwIfAborted();
        const step = phase.step + 1;
        const decision = await this.preStep(target, { turn, step });
        if (decision.kind === "reject") {
          turnEnds = { kind: "blocked" };
          return false;
        }
        if (turnEnds && decision.messages.length === 0) break;
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: "completed" };
          return false;
        }
        signal.throwIfAborted();
        this.session.append("step/start", { turn, step });
        phase.step = step;
        try {
          for (const message of decision.messages) {
            this.session.append("user/message", message, { surfaceOp: "append" });
          }
          const stepEnd = await this.step();
          if (turnEnds === null) turnEnds = stepEnd;
        } finally {
          this.session.append("step/end", { turn, step });
        }
        signal.throwIfAborted();
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial("agent/turn-stopping", { turn, signal });
          signal.throwIfAborted();
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break;
        target = "next-step";
      }
    } catch (error) {
      if (signal.aborted) {
        turnEnds = { kind: "aborted", reason: signal.reason };
        throw error;
      }
      turnEnds = {
        kind: "error",
        error: error instanceof LlmError2 ? error.failure : { message: errorChain2(error), code: "UNKNOWN" }
      };
      this.throwError(error);
    } finally {
      try {
        this.session.append("turn/end", { turn, reason: turnEnds });
      } catch (error) {
        this.throwError(error);
      }
    }
    if (!this.inbox.hasPending) return false;
    phase.abort = new AbortController();
    phase.wakeRequested = false;
    phase.step = 0;
    return true;
  }
  /** Model label recorded in the request header for one lifecycle. */
  modelLabel() {
    return this.config.model ?? NATIVE_MODEL_LABEL2;
  }
  /** Append the request header snapshot once per loop instance. */
  assertRequestHeader() {
    if (this.requestHeaderLogged) return;
    const header = canonicalHeader2({
      config: { provider: PROVIDER2, model: this.modelLabel() }
    });
    const baseline = this.session.requestHeader();
    this.session.append("request/header", {
      header,
      reason: baseline === void 0 ? "initial" : "resume"
    });
    this.requestHeaderLogged = true;
  }
  /** Run one Codex thread for the current step and map its transcript into the session log. */
  async step() {
    if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": step outside running phase`);
    const { turn, step, abort: { signal } } = this.phase;
    signal.throwIfAborted();
    const cwd = this.session.header.cwd;
    if (cwd === void 0 || cwd.length === 0) {
      throw new Error(`agent "${this.id}": no working directory \u2014 start the session with cwd metadata`);
    }
    const history = this.session.deriveMessages();
    const prompt = serializeHistory(history);
    if (prompt.length === 0) {
      throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`);
    }
    this.assertRequestHeader();
    signal.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason instanceof Error ? signal.reason : new Error(`agent "${this.id}" query aborted`));
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const permission = this.queryPermission();
      const client = await this.appServerClient();
      const threadParams = {
        cwd,
        sandbox: permission.sandboxMode,
        approvalPolicy: permission.approvalPolicy,
        ...this.config.model === void 0 ? {} : { model: this.config.model }
      };
      const thread = await AppServerThread.create(client, threadParams);
      const input = [{ type: "text", text: prompt }];
      const events = thread.turn(input, {
        signal: controller.signal,
        params: {
          approvalPolicy: permission.approvalPolicy,
          ...this.config.model === void 0 ? {} : { model: this.config.model }
        }
      });
      let finished = false;
      const pendingReasoning = [];
      const pendingReasoningSeqs = [];
      const textSeqs = [];
      let held;
      let reasoningBlockStarted = false;
      let textBlockStarted = false;
      let textBlockIndex = 0;
      const emitChunk = (chunk) => this.session.append("assistant/chunk", { turn, step, chunk }).seq;
      const flushHeld = (usage) => {
        if (held === void 0) return;
        this.session.append("assistant/message", {
          turn,
          step,
          message: createAssistantMessage2({
            content: held.content,
            source: { provider: PROVIDER2, model: this.modelLabel() }
          }),
          ...usage === void 0 ? {} : { usage }
        }, {
          surfaceOp: "append",
          // Link the durable message to the chunks that streamed it, so replay
          // can reconstruct the partial exactly as shown.
          sourceEventSeqs: held.refs
        });
        held = void 0;
      };
      const flushReasoning = (usage) => {
        if (pendingReasoning.length === 0) return;
        flushHeld();
        held = {
          content: pendingReasoning.map((text) => ({ type: "reasoning", text })),
          refs: [...pendingReasoningSeqs]
        };
        pendingReasoning.length = 0;
        pendingReasoningSeqs.length = 0;
        flushHeld(usage);
      };
      signal.throwIfAborted();
      for await (const event of events) {
        signal.throwIfAborted();
        switch (event.kind) {
          case "turn-started":
            break;
          case "item-started": {
            if (event.itemType === "agentMessage") {
              textBlockStarted = false;
              textBlockIndex = pendingReasoning.length;
            }
            break;
          }
          case "agent-delta": {
            if (!textBlockStarted) {
              textBlockStarted = true;
              textSeqs.push(emitChunk({ type: "block-start", index: textBlockIndex, blockType: "text" }));
            }
            textSeqs.push(emitChunk({ type: "text-delta", index: textBlockIndex, text: event.delta }));
            break;
          }
          case "reasoning-summary-delta":
          case "reasoning-text-delta":
          case "plan-delta": {
            const index = pendingReasoning.length;
            if (!reasoningBlockStarted) {
              reasoningBlockStarted = true;
              pendingReasoningSeqs.push(emitChunk({ type: "block-start", index, blockType: "reasoning" }));
            }
            pendingReasoningSeqs.push(emitChunk({ type: "reasoning-delta", index, text: event.delta }));
            break;
          }
          case "item-completed": {
            const item = event.item;
            if (item.type === "reasoning") {
              const summary = item.summary;
              const content = item.content;
              const text = summary?.join("\n") ?? content?.join("\n") ?? "";
              pendingReasoning.push(text);
              reasoningBlockStarted = false;
            } else if (item.type === "agentMessage") {
              flushHeld();
              held = {
                content: [
                  ...pendingReasoning.map((text) => ({ type: "reasoning", text })),
                  { type: "text", text: item.text ?? "" }
                ],
                refs: [...pendingReasoningSeqs, ...textSeqs]
              };
              pendingReasoning.length = 0;
              pendingReasoningSeqs.length = 0;
              textSeqs.length = 0;
              reasoningBlockStarted = false;
              textBlockStarted = false;
            } else if (item.type === "commandExecution") {
              flushReasoning();
              flushHeld();
              const activity = mapCommandExecution(item);
              this.session.append("tool/call", {
                turn,
                step,
                callId: activity.call.callId,
                name: activity.call.name,
                arguments: activity.call.arguments
              });
              this.session.append("tool/result", { turn, step, message: activity.result }, { surfaceOp: "append" });
            } else if (item.type === "fileChange") {
              flushReasoning();
              flushHeld();
              const activity = mapFileChange(item);
              this.session.append("tool/call", {
                turn,
                step,
                callId: activity.call.callId,
                name: activity.call.name,
                arguments: activity.call.arguments
              });
              this.session.append("tool/result", { turn, step, message: activity.result }, { surfaceOp: "append" });
            } else if (item.type === "mcpToolCall") {
              flushReasoning();
              flushHeld();
              const activity = mapMcpToolCall(item);
              this.session.append("tool/call", {
                turn,
                step,
                callId: activity.call.callId,
                name: activity.call.name,
                arguments: activity.call.arguments
              });
              this.session.append("tool/result", { turn, step, message: activity.result }, { surfaceOp: "append" });
            }
            break;
          }
          case "turn-completed": {
            const usage = event.turn.usage ? mapUsage2(event.turn.usage) : void 0;
            if (pendingReasoning.length > 0) flushReasoning(usage);
            else flushHeld(usage);
            finished = true;
            break;
          }
          case "error":
            flushReasoning();
            flushHeld();
            throw new LlmError2(event.error.message, "CODEX_ERROR");
          /* v8 ignore next -- AppServerEvent is a closed union; no unknown kinds */
          default:
            break;
        }
      }
      flushReasoning();
      flushHeld();
      if (!finished) {
        throw new LlmError2(
          `agent "${this.id}": codex query ended without a completed turn`,
          "CODEX_NO_RESULT"
        );
      }
      return { kind: "completed" };
    } finally {
      signal.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
};

// src/engine-codex/loop.ts
var CODEX_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access"
];
var CODEX_APPROVAL_POLICIES = [
  "never",
  "on-request",
  "on-failure",
  "untrusted"
];
var Config2 = z2.object({
  sandboxMode: z2.union([...CODEX_SANDBOX_MODES]),
  approvalPolicy: z2.union([...CODEX_APPROVAL_POLICIES]),
  env: z2.dict(z2.string()).default({}),
  model: z2.string()
});
function resolveConfig2(config) {
  return {
    sandboxMode: config.sandboxMode,
    approvalPolicy: config.approvalPolicy,
    env: config.env ?? {},
    model: config.model
  };
}
var CodexLoop = class extends Service2 {
  /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
  static inject = ["agents", "sessions", "systemPrompt"];
  /** Validated configuration owned by the loop plugin. */
  config;
  ownership;
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  runtime;
  constructor(ctx, config) {
    super(ctx, "agentLoopCodex");
    this.config = resolveConfig2(config);
    this.ownership = new FactoryOwnership(ctx.fiber);
    this.runtime = { ctx };
    ctx.effect(() => () => this.ownership.dispose(), "agentLoopCodex.transactions()");
    ctx.effect(() => ctx.agents.setFactory(this), "agentLoopCodex.setFactory()");
    ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
    ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
    ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd);
  }
  /**
   * Construct the driver, scope, and one memoized reverse teardown for a new
   * agent. The teardown is registered with the factory and the owner fiber
   * BEFORE publication, so a mid-setup unload rolls everything back; `signal`
   * fuses caller cancellation with lifecycle teardown for setup awaits.
   */
  /* jscpd:ignore-start -- ownership/transaction machinery mirrors the Claude Code loop factory. */
  prepare(ownerCtx, id, options, session, callerSignal) {
    ownerCtx.fiber.assertActive();
    if (!this.ownership.isActive()) throw new Error("agent loop is not active");
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error ? callerSignal.reason : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason });
    }
    const loopCtx = this.runtime.ctx;
    const abort = new AbortController();
    const onCallerAbort = () => {
      abort.abort(callerSignal?.reason instanceof Error ? callerSignal.reason : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }));
    };
    const onFactoryTeardown = () => {
      abort.abort(this.ownership.signal.reason);
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    this.ownership.signal.addEventListener("abort", onFactoryTeardown, { once: true });
    let machine;
    let detachSession;
    let detachAgent;
    let disposing;
    const machineReady = Promise.withResolvers();
    const dispose = (ownerTriggered = false) => disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`));
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.ownership.signal.removeEventListener("abort", onFactoryTeardown);
      try {
        if (machine === void 0) await machineReady.promise;
        if (machine !== void 0) {
          machine.cancel({ kind: "disposed" });
          await machine.whenIdle();
          await machine.scope.dispose();
        }
      } finally {
        try {
          detachAgent?.();
          detachSession?.();
        } finally {
          untrack();
          if (!ownerTriggered) await unfollowOwner();
        }
      }
    })();
    const untrack = this.ownership.track(dispose);
    let unfollowOwner;
    try {
      unfollowOwner = ownerCtx.effect(() => () => {
        if (disposing !== void 0) return;
        abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
        return dispose(true);
      }, `agentLoopCodex.lifecycle(${id})`);
    } catch (error) {
      untrack();
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.ownership.signal.removeEventListener("abort", onFactoryTeardown);
      throw error;
    }
    const assertLive = () => {
      if (!abort.signal.aborted) return;
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason));
    };
    try {
      const agent = machine = new CodexAgent(loopCtx, id, options, session, this.config);
      machineReady.resolve();
      assertLive();
      return {
        agent,
        signal: abort.signal,
        publish: (source) => {
          assertLive();
          detachSession = agent.ctx.sessions.enter(session);
          detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent);
          agent.ctx.sessions.announce(session);
          assertLive();
          loopCtx.agents.announce(agent);
          assertLive();
          emitAgentEvent2(loopCtx, agent, "agent/session-start", { source });
          assertLive();
          return { agent, dispose };
        },
        dispose
      };
    } catch (error) {
      machineReady.resolve();
      void dispose();
      throw error;
    }
  }
  /** Prepare one Agent around an acquired Session, run setup, and publish it. */
  async setupAndPublish(ownerCtx, id, preparation, agentOptions, setup, signal, source) {
    var _stack = [];
    try {
      const ownedPreparation = __using(_stack, preparation);
      const session = ownedPreparation.session;
      const prepared = this.prepare(ownerCtx, id, agentOptions, session, signal);
      try {
        const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id);
        setupCommit?.commit();
        return prepared.publish(source);
      } catch (error) {
        await prepared.dispose();
        throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  /**
   * Create an agent and session under one caller-supplied identity, owned by
   * the accessing fiber.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx, options) {
    const preparation = SessionPreparation2.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === void 0 ? {} : { seed: options.seed },
      ...options.meta === void 0 ? {} : { meta: options.meta }
    }));
    const published = this.setupAndPublish(
      ownerCtx,
      options.sessionId,
      preparation,
      options.agentOptions ?? {},
      options.setup,
      options.signal,
      "startup"
    );
    this.ownership.trackWrapper(published);
    return published;
  }
  /**
   * Resume an owned agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx, options) {
    const persistence = this.runtime.ctx.get("sessionPersistence");
    if (persistence === void 0) {
      throw new Error("cannot resume: session persistence is not configured (load a dsh-session-persistence backend)");
    }
    return this.resumeWith(ownerCtx, persistence, options);
  }
  /** Resume through an explicit persistence handle. */
  async resumeWith(ownerCtx, persistence, options) {
    const id = options.resumeSessionId;
    let preparation;
    try {
      const ownerAbort = new AbortController();
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
      }, `agentLoopCodex.resume-load(${id})`);
      const fused = AbortSignal.any([
        ...options.signal === void 0 ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal
      ]);
      try {
        preparation = await raceAbortCall(
          () => persistence.prepare(id, fused),
          fused,
          id,
          (abandoned) => {
            abandoned[Symbol.dispose]();
          }
        );
      } finally {
        await unfollowOwner();
      }
      ownerCtx.fiber.assertActive();
      if (!this.ownership.isActive()) throw new Error("agent loop is not active");
      return await this.setupAndPublish(
        ownerCtx,
        id,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        "resume"
      );
    } finally {
      preparation?.[Symbol.dispose]();
    }
  }
};

// src/engine-pi/loop.ts
import { readFileSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
import { Service as Service3 } from "@deepseek-ai/cordis";
import z3 from "@deepseek-ai/schemastery";
import { emitAgentEvent as emitAgentEvent3 } from "@deepseek-ai/dsh-agent";
import { SessionPreparation as SessionPreparation3 } from "@deepseek-ai/dsh-session";

// src/engine-pi/agent.ts
import { Inbox as Inbox3, agentEvents as agentEvents3 } from "@deepseek-ai/dsh-agent";
import { ToolCallId as ToolCallId4, LlmError as LlmError3, createAssistantMessage as createAssistantMessage3, createUserMessage as createUserMessage3, errorChain as errorChain3 } from "@deepseek-ai/dsh-llm";
import { createScope as createScope3 } from "@deepseek-ai/dsh-scope";
import { canonicalHeader as canonicalHeader3 } from "@deepseek-ai/dsh-session";

// src/engine-pi/permission.ts
var DEFAULT_PI_PERMISSION = {
  sandboxMode: "read-only",
  tools: ["read", "grep", "find", "ls"]
};
var WORKSPACE_WRITE_TOOLS = ["read", "grep", "find", "ls", "write", "edit"];
var FULL_ACCESS_TOOLS = [];
function toolsForSandbox(mode) {
  switch (mode) {
    case "danger-full-access":
      return FULL_ACCESS_TOOLS;
    case "workspace-write":
      return WORKSPACE_WRITE_TOOLS;
    default:
      return DEFAULT_PI_PERMISSION.tools;
  }
}
function resolveSessionPermission3(events) {
  if (sessionSandboxMode(events) === "danger-full-access") {
    return { sandboxMode: "danger-full-access", tools: FULL_ACCESS_TOOLS };
  }
  if (sessionApprovalPolicy(events) === "ask") {
    return { sandboxMode: "read-only", tools: DEFAULT_PI_PERMISSION.tools };
  }
  if (sessionSandboxMode(events) === "workspace-write") {
    return { sandboxMode: "workspace-write", tools: WORKSPACE_WRITE_TOOLS };
  }
  return DEFAULT_PI_PERMISSION;
}

// src/engine-pi/rpc/client.ts
import { spawn as spawn2 } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
function defaultSpawn(spec) {
  const child = spawn2(process.execPath, [...spec.argv], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  return fromChildProcess(child);
}
function fromChildProcess(child) {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (handler) => {
      child.once("exit", handler);
    },
    terminate: () => child.kill()
  };
}
var PiRpcClient = class _PiRpcClient {
  /** Mount a client over an already-spawned Pi RPC process. */
  constructor(process2) {
    this.process = process2;
    this.process.stdout.on("data", (chunk) => this.feed(chunk));
    this.process.stderr.on("data", this.onStderr);
    this.process.onExit(() => {
      this.disposed = true;
      const err = new Error("pi RPC process exited unexpectedly");
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.eventWake?.();
    });
  }
  process;
  reqId = 1;
  pending = /* @__PURE__ */ new Map();
  eventBuffer = [];
  eventWake;
  eventHandler;
  disposed = false;
  decoder = new StringDecoder("utf8");
  buffer = "";
  onStderr = (chunk) => {
    void this.consumeStderr(chunk);
  };
  /** Whether this client was disposed or its process exited. */
  get closed() {
    return this.disposed;
  }
  /**
   * Create a client, spawning the Pi RPC child through the supplied capability
   * (or the default node-runtime spawn when none is given).
   * @param spec - the Pi CLI argv/cwd/env the child should run with.
   * @param spawn - optional process-spawn capability (the subprocess seam);
   *   absent falls back to the plain node child spawn.
   * @returns the connected client.
   */
  static create(spec, spawn3) {
    const process2 = spawn3 === void 0 ? defaultSpawn(spec) : spawn3(spec);
    return new _PiRpcClient(process2);
  }
  /** Register the event dispatch handler. */
  onEvent(handler) {
    this.eventHandler = handler;
  }
  /** Drop any events still buffered from a previous step (stateless per-step sessions). */
  clearEvents() {
    this.eventBuffer.length = 0;
  }
  /** Start a fresh Pi session. */
  async newSession() {
    const command = { type: "new_session" };
    return this.request(command);
  }
  /** Prompt the agent and await the acceptance response. */
  async prompt(message, options = {}) {
    const command = { type: "prompt", message, ...options };
    return this.request(command);
  }
  /** Abort the current agent operation. */
  async abort() {
    const command = { type: "abort" };
    return this.request(command);
  }
  /** Query session stats. */
  async getSessionStats() {
    const command = { type: "get_session_stats" };
    return this.request(command);
  }
  /** Send a command without awaiting its response (fire-and-forget). */
  send(command) {
    if (this.disposed) return;
    this.process.stdin.write(`${JSON.stringify(command)}
`);
  }
  /**
   * Send a command and await the correlated response. Assigns a fresh `id`
   * when the command carries none, so responses always round-trip.
   */
  async request(command) {
    if (this.disposed) throw new Error("pi RPC client is disposed");
    const id = command.id ?? this.reqId++;
    const wire = { ...command, id };
    return new Promise((resolve4, reject) => {
      this.pending.set(id, { resolve: resolve4, reject });
      this.process.stdin.write(`${JSON.stringify(wire)}
`);
    });
  }
  /**
   * Consume every buffered event as an async generator, waking as fresh lines
   * arrive. The caller bounds the iteration by a terminal event; unmatched
   * lines stay buffered for a later iteration.
   */
  async *events() {
    while (true) {
      if (this.eventBuffer.length > 0) {
        yield this.eventBuffer.shift();
        continue;
      }
      if (this.disposed) return;
      await new Promise((resolve4) => {
        this.eventWake = resolve4;
      });
      this.eventWake = void 0;
    }
  }
  /** Dispose the client and request child termination. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.process.terminate();
    const err = new Error("pi RPC client is disposed");
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    this.eventWake?.();
  }
  /** Feed one chunk of stdout into the framing state machine. */
  feed(chunk) {
    if (this.disposed) return;
    const text = typeof chunk === "string" ? this.buffer + chunk : this.buffer + this.decoder.write(chunk);
    this.buffer = text;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.dispatch(line);
    }
  }
  /** Dispatch one parsed line to the pending map or the event queue. */
  dispatch(line) {
    if (line.trim().length === 0) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.type === "response") {
      if (obj.id !== void 0) {
        const pending = this.pending.get(obj.id);
        if (pending !== void 0) {
          this.pending.delete(obj.id);
          if (obj.success) pending.resolve(obj);
          else pending.reject(new Error(obj.error ?? `pi RPC command "${obj.command ?? ""}" failed`));
        }
      }
      return;
    }
    const event = obj;
    this.eventHandler?.(event);
    this.eventBuffer.push(event);
    this.eventWake?.();
  }
  /** Drain decoded stderr bytes (no-op consumer keeps the pipe flowing). */
  consumeStderr(_chunk) {
  }
};

// src/engine-pi/rpc/mapping.ts
import {
  ToolCallId as ToolCallId3,
  createToolResultMessage as createToolResultMessage3
} from "@deepseek-ai/dsh-llm";
function mapUsage3(usage) {
  return {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    ...usage.cacheRead !== void 0 && usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite !== void 0 && usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
  };
}
function resultText(content) {
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "object" && block !== null) {
        const text = block.text;
        return typeof text === "string" ? text : "";
      }
      return "";
    }).filter((segment) => segment !== "").join("\n\n");
  }
  if (typeof content === "object" && content !== null) {
    const nested = content.content;
    const text = content.text;
    if (typeof text === "string") return text;
    if (nested !== void 0) return resultText(nested);
  }
  return "";
}
function mapToolResult(ev) {
  return createToolResultMessage3({
    callId: ToolCallId3(ev.toolCallId),
    content: [{ type: "text", text: resultText(ev.result) || "(no content)" }],
    isError: ev.isError
  });
}

// src/engine-pi/agent.ts
var PROVIDER3 = "pi";
var NATIVE_MODEL_LABEL3 = "pi-native";
var TOOLS_FLAG = "--tools";
function specsEqual(a, b) {
  if (a === void 0) return false;
  return a.cwd === b.cwd && a.env === b.env && a.argv.length === b.argv.length && a.argv.every((value, index) => value === b.argv[index]);
}
var PiAgent = class {
  constructor(loopCtx, id, options, session, config, spawn3, bin) {
    this.loopCtx = loopCtx;
    this.id = id;
    this.options = options;
    this.session = session;
    this.config = config;
    this.spawn = spawn3;
    this.bin = bin;
    this.dispatch = agentEvents3(loopCtx, this);
    this.inbox = new Inbox3(session, {
      inserted: (message) => {
        this.dispatch.emit("agent/inbox/inserted", { message });
      },
      discarded: (message) => {
        this.dispatch.emit("agent/inbox/discarded", { message });
      },
      claimed: (message, turn) => {
        this.dispatch.emit("agent/inbox/claimed", { message, turn });
      }
    });
    const lastTurn = session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
    this.phase = { kind: "idle", lastTurn };
    this.scope = createScope3(loopCtx, this);
    this.ctx = this.scope.ctx.extend({ agent: this });
    this.scope.ctx.effect(() => () => {
      this.rpc?.dispose();
      this.rpc = void 0;
    }, "pi.rpcClient()");
  }
  loopCtx;
  id;
  options;
  session;
  config;
  spawn;
  bin;
  inbox;
  phase;
  activityDone = Promise.resolve();
  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  scope;
  ctx;
  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  dispatch;
  /** Whether this loop instance has appended its initial/resume request anchor. */
  requestHeaderLogged = false;
  /** Lazily created RPC client, reused across steps and released on scope teardown. */
  rpc;
  /** The spawn spec the cached client was built from; a change forces a respawn. */
  lastSpec;
  /** Return the cached RPC client, respawning when the spec or process changed. */
  async rpcClient(cwd) {
    const spec = this.spawnSpec(cwd);
    if (this.rpc !== void 0 && !this.rpc.closed && specsEqual(this.lastSpec, spec)) return this.rpc;
    this.rpc?.dispose();
    const client = PiRpcClient.create(spec, this.spawn);
    this.rpc = client;
    this.lastSpec = spec;
    return client;
  }
  get status() {
    return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running";
  }
  /** Commit a phase and publish its externally visible status transition. */
  setPhase(next) {
    const previousStatus = this.status;
    this.phase = next;
    const status = this.status;
    if (status !== previousStatus) {
      this.dispatch.emit("agent/status", { status });
    }
  }
  send(message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
    const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
    this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
    if (wakeup) this.wakeDriver(wakingAfterAbort);
  }
  /**
   * Queue a message for the next turn and wake the driver.
   * @param input - the user message to deliver.
   */
  followup(input) {
    this.send(input, "next-turn", true);
  }
  /**
   * Queue a message for the running step and wake the driver.
   * @param input - the user message to deliver.
   */
  steer(input) {
    this.send(input, "next-step", true);
  }
  /**
   * Queue a message for the running step without waking the driver.
   * @param input - the user message to deliver.
   */
  inject(input) {
    this.send(input, "next-step", false);
  }
  cancel(cause, options = {}) {
    if (!options.keepInbox) {
      this.inbox.clear();
      if (this.phase.kind !== "idle") this.phase.wakeRequested = false;
    }
    if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
  }
  /**
   * Run a maintenance job while the agent is idle.
   * @param job - the maintenance operation, receiving the phase abort signal.
   * @returns the maintenance result.
   */
  runMaintenance(job) {
    if (this.phase.kind !== "idle") throw new Error(`agent "${this.id}" already has active work`);
    const done = Promise.withResolvers();
    const maintenance = {
      kind: "maintenance",
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false
    };
    this.setPhase(maintenance);
    this.activityDone = done.promise;
    return (async () => {
      try {
        return await job(maintenance.abort.signal);
      } finally {
        this.setPhase({ kind: "idle", lastTurn: maintenance.lastTurn });
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver();
        done.resolve();
      }
    })();
  }
  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  wakeDriver(wakeAfterAbort = false) {
    if (this.phase.kind !== "idle") {
      const reason = this.phase.abort.signal.reason;
      if (reason?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort)) {
        this.phase.wakeRequested = true;
      }
      return;
    }
    const driver = Promise.withResolvers();
    this.activityDone = driver.promise;
    this.setPhase({
      kind: "running",
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false
    });
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
  }
  async whenIdle() {
    let activity;
    do {
      await (activity = this.activityDone);
    } while (activity !== this.activityDone);
  }
  /** Report one failure at its live boundary, then preserve it for driver containment. */
  throwError(error) {
    const turn = this.phase.kind === "running" ? this.phase.turn : this.phase.lastTurn;
    const step = this.phase.kind === "running" ? this.phase.step : 0;
    this.dispatch.emit("agent/error", { turn, step, error });
    throw error;
  }
  async kick() {
    try {
      while (await this.turn()) {
      }
    } catch (_error) {
    } finally {
      if (this.phase.kind === "running") {
        const { turn, wakeRequested } = this.phase;
        this.setPhase({ kind: "idle", lastTurn: turn });
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver();
      }
    }
  }
  async preStep(target, position) {
    if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
    const signal = this.phase.abort.signal;
    const claimed = this.inbox.claim(target, position.turn);
    const decision = await this.dispatch.waterfall(
      "agent/pre-step",
      { messages: claimed, ...position, signal },
      () => Promise.resolve({ kind: "enter", messages: claimed })
    );
    signal.throwIfAborted();
    if (decision.kind === "reject") return decision;
    const injected = await this.injectSkills(decision.messages, signal);
    signal.throwIfAborted();
    return injected !== decision.messages ? { kind: "enter", messages: [...injected] } : { ...decision };
  }
  /**
   * Scan the step's user messages for `/name` skill gestures, load each
   * matching skill, and inject the rendered skill content into the message
   * batch.  This mirrors what dsh-tool-skill does for the in-process engine.
   * @param messages - the current step's message batch.
   * @param signal - cancellation signal (aborted loads are silently dropped).
   * @returns the original batch when no skill was invoked, or an extended
   *   batch with injected skill-content messages appended.
   */
  async injectSkills(messages, signal) {
    const names = invokedSkillNames(messages);
    if (names.length === 0) return messages;
    const skills = this.loopCtx.get("skills");
    if (skills === void 0) return messages;
    const cwd = this.session.header.cwd;
    const injections = [];
    for (const name2 of names) {
      if (!isSkillName(name2)) continue;
      let skill;
      try {
        skill = await skills.get(name2, { signal, scope: this, ...cwd === void 0 ? {} : { cwd } });
      } catch {
        continue;
      }
      if (skill === void 0 || !skill.invocation.userInvocable) continue;
      if (signal.aborted) return messages;
      injections.push(createUserMessage3({
        content: [{ type: "text", text: renderSkillContent(skill) }],
        source: { kind: "skill-invocation", name: name2, form: "instructions" }
      }));
    }
    return injections.length > 0 ? [...messages, ...injections] : messages;
  }
  /**
   * Resolve the runtime permission stance for one query. Deployment-pinned
   * fields win; anything unpinned follows the session's durable dsh permission
   * knobs, re-folded per query so mid-session preset switches take effect on the
   * next step.
   * @returns the permission fields of the query spec.
   */
  queryPermission() {
    const fold = resolveSessionPermission3(this.session.events);
    const sandboxMode = this.config.sandboxMode ?? fold.sandboxMode;
    return {
      sandboxMode,
      tools: this.config.sandboxMode === void 0 ? fold.tools : toolsForSandbox(sandboxMode)
    };
  }
  /** Open one turn before claiming its first proposed step. */
  async turn() {
    if (this.phase.kind !== "running") {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`));
    }
    const phase = this.phase;
    const { signal } = phase.abort;
    signal.throwIfAborted();
    const turn = phase.turn + 1;
    try {
      this.session.append("turn/start", { turn });
    } catch (error) {
      this.throwError(error);
    }
    phase.turn = turn;
    let turnEnds = null;
    let target = "next-turn";
    try {
      while (true) {
        signal.throwIfAborted();
        const step = phase.step + 1;
        const decision = await this.preStep(target, { turn, step });
        if (decision.kind === "reject") {
          turnEnds = { kind: "blocked" };
          return false;
        }
        if (turnEnds && decision.messages.length === 0) break;
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: "completed" };
          return false;
        }
        signal.throwIfAborted();
        this.session.append("step/start", { turn, step });
        phase.step = step;
        try {
          for (const message of decision.messages) {
            this.session.append("user/message", message, { surfaceOp: "append" });
          }
          const stepEnd = await this.step();
          if (turnEnds === null) turnEnds = stepEnd;
        } finally {
          this.session.append("step/end", { turn, step });
        }
        signal.throwIfAborted();
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial("agent/turn-stopping", { turn, signal });
          signal.throwIfAborted();
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break;
        target = "next-step";
      }
    } catch (error) {
      if (signal.aborted) {
        turnEnds = { kind: "aborted", reason: signal.reason };
        throw error;
      }
      turnEnds = {
        kind: "error",
        error: error instanceof LlmError3 ? error.failure : { message: errorChain3(error), code: "UNKNOWN" }
      };
      this.throwError(error);
    } finally {
      try {
        this.session.append("turn/end", { turn, reason: turnEnds });
      } catch (error) {
        this.throwError(error);
      }
    }
    if (!this.inbox.hasPending) return false;
    phase.abort = new AbortController();
    phase.wakeRequested = false;
    phase.step = 0;
    return true;
  }
  /** Model label recorded in the request header for one lifecycle. */
  modelLabel() {
    return this.config.model ?? NATIVE_MODEL_LABEL3;
  }
  /** Append the request header snapshot once per loop instance. */
  assertRequestHeader() {
    if (this.requestHeaderLogged) return;
    const header = canonicalHeader3({
      config: { provider: PROVIDER3, model: this.modelLabel() }
    });
    const baseline = this.session.requestHeader();
    this.session.append("request/header", {
      header,
      reason: baseline === void 0 ? "initial" : "resume"
    });
    this.requestHeaderLogged = true;
  }
  /** Build the `pi --mode rpc` argv/cwd/env for one step's child process. */
  spawnSpec(cwd) {
    const argv = [];
    if (this.config.provider !== void 0) argv.push("--provider", this.config.provider);
    if (this.config.model !== void 0 && this.config.thinkingLevel !== void 0) {
      argv.push("--model", `${this.config.model}:${this.config.thinkingLevel}`);
    } else if (this.config.model !== void 0) {
      argv.push("--model", this.config.model);
    } else if (this.config.thinkingLevel !== void 0) {
      argv.push("--model", `:${this.config.thinkingLevel}`);
    }
    const permission = this.queryPermission();
    if (permission.tools.length > 0) argv.push(TOOLS_FLAG, permission.tools.join(","));
    return {
      argv: [
        this.bin,
        "--mode",
        "rpc",
        "--no-session",
        ...argv
      ],
      cwd,
      env: this.config.env
    };
  }
  /**
   * Run one Pi RPC query for the current step and map its event stream into the
   * session log. The step opens a fresh Pi session (`new_session`) and sends the
   * serialized session history as one prompt, then consumes events until the
   * agent settles. Like the Codex/Claude drivers, Pi owns its own system prompt
   * natively, so the dsh system-prompt assembly (which pulls dsh tool schemas
   * and `agent.ctx.tools`) is deliberately not run — the durable session log is
   * the sole source of model context.
   */
  async step() {
    if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": step outside running phase`);
    const { turn, step, abort: { signal } } = this.phase;
    signal.throwIfAborted();
    const cwd = this.session.header.cwd;
    if (cwd === void 0 || cwd.length === 0) {
      throw new Error(`agent "${this.id}": no working directory \u2014 start the session with cwd metadata`);
    }
    const history = this.session.deriveMessages();
    const prompt = serializeHistory(history);
    if (prompt.length === 0) {
      throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`);
    }
    this.assertRequestHeader();
    signal.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason instanceof Error ? signal.reason : new Error(`agent "${this.id}" query aborted`));
        void this.rpc?.abort().catch(() => void 0);
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const client = await this.rpcClient(cwd);
      signal.throwIfAborted();
      await client.newSession();
      client.clearEvents();
      await client.prompt(prompt);
      let finished = false;
      let settled = false;
      const chunkSeqs = [];
      let held;
      const startedText = /* @__PURE__ */ new Set();
      const startedReasoning = /* @__PURE__ */ new Set();
      const thinkingByIndex = /* @__PURE__ */ new Map();
      const emittedToolCalls = /* @__PURE__ */ new Set();
      let lastUsage;
      let assistantFlushed = false;
      const emitChunk = (chunk) => {
        const seq = this.session.append("assistant/chunk", { turn, step, chunk }).seq;
        chunkSeqs.push(seq);
        return seq;
      };
      const flushHeld = (usage) => {
        if (held === void 0) return;
        this.session.append("assistant/message", {
          turn,
          step,
          message: createAssistantMessage3({
            content: held.content,
            source: { provider: PROVIDER3, model: this.modelLabel() }
          }),
          ...usage === void 0 ? {} : { usage }
        }, {
          surfaceOp: "append",
          // Link the durable message to the chunks that streamed it, so replay
          // can reconstruct the partial exactly as shown.
          sourceEventSeqs: held.refs
        });
        held = void 0;
      };
      const ensureTextBlock = (index) => {
        if (startedText.has(index)) return;
        startedText.add(index);
        emitChunk({ type: "block-start", index, blockType: "text" });
      };
      const ensureReasoningBlock = (index) => {
        if (startedReasoning.has(index)) return;
        startedReasoning.add(index);
        emitChunk({ type: "block-start", index, blockType: "reasoning" });
      };
      const emitToolCall = (callId, name2, rawArguments) => {
        if (emittedToolCalls.has(callId)) return;
        emittedToolCalls.add(callId);
        const argumentsValue = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {});
        this.session.append("tool/call", {
          turn,
          step,
          callId: ToolCallId4(callId),
          name: name2,
          arguments: argumentsValue
        });
      };
      const contentOf = (message) => {
        let blocks = [];
        const content = Array.isArray(message.content) ? message.content : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
        for (const block of content) {
          if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "thinking") {
            blocks.push({ type: "reasoning", text: block.thinking });
          }
        }
        if (!blocks.some((block) => block.type === "reasoning") && thinkingByIndex.size > 0) {
          const folded = [...thinkingByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => ({ type: "reasoning", text }));
          blocks = [...folded, ...blocks];
        }
        return blocks;
      };
      signal.throwIfAborted();
      for await (const event of client.events()) {
        signal.throwIfAborted();
        switch (event.type) {
          case "agent_start":
          case "compaction_start":
          case "compaction_end":
          case "auto_retry_start":
          case "auto_retry_end":
          case "queue_update":
          case "bash_execution_update":
          case "extension_ui_request":
            break;
          case "message_start":
            if (event.message.role === "assistant") {
              chunkSeqs.length = 0;
              startedText.clear();
              startedReasoning.clear();
              thinkingByIndex.clear();
            }
            break;
          case "message_update": {
            if (event.usage !== void 0) lastUsage = mapUsage3(event.usage);
            const delta = event.assistantMessageEvent;
            switch (delta.type) {
              case "text_start":
              case "thinking_start":
                break;
              case "text_delta":
                ensureTextBlock(delta.contentIndex);
                emitChunk({ type: "text-delta", index: delta.contentIndex, text: delta.delta });
                break;
              case "thinking_delta":
                ensureReasoningBlock(delta.contentIndex);
                emitChunk({ type: "reasoning-delta", index: delta.contentIndex, text: delta.delta });
                thinkingByIndex.set(delta.contentIndex, (thinkingByIndex.get(delta.contentIndex) ?? "") + delta.delta);
                break;
              case "toolcall_start":
                break;
              case "toolcall_delta":
                break;
              case "toolcall_end":
                emitToolCall(delta.toolCall.id, delta.toolCall.name, delta.toolCall.arguments);
                break;
              case "text_end":
              case "thinking_end":
                break;
            }
            break;
          }
          case "message_end": {
            if (event.message.role === "assistant") {
              if (event.message.usage !== void 0) lastUsage = mapUsage3(event.message.usage);
              flushHeld();
              held = { content: contentOf(event.message), refs: [...chunkSeqs] };
              chunkSeqs.length = 0;
              flushHeld(lastUsage);
              assistantFlushed = true;
            }
            break;
          }
          case "tool_execution_start":
            emitToolCall(event.toolCallId, event.toolName, event.args);
            break;
          case "tool_execution_update":
            break;
          case "tool_execution_end":
            emitToolCall(event.toolCallId, event.toolName, void 0);
            this.session.append("tool/result", {
              turn,
              step,
              message: mapToolResult({ toolCallId: event.toolCallId, result: event.result, isError: event.isError })
            }, { surfaceOp: "append" });
            break;
          case "turn_end": {
            if (!assistantFlushed && event.message !== void 0) {
              if (event.message.usage !== void 0) lastUsage = mapUsage3(event.message.usage);
              held = { content: contentOf(event.message), refs: [...chunkSeqs] };
              chunkSeqs.length = 0;
            }
            for (const toolResult of event.toolResults ?? []) {
              this.appendToolResult(turn, step, toolResult);
            }
            flushHeld(lastUsage);
            finished = true;
            break;
          }
          case "agent_end":
            flushHeld(lastUsage);
            finished = true;
            if (!event.willRetry) settled = true;
            break;
          case "agent_settled":
            flushHeld(lastUsage);
            finished = true;
            settled = true;
            break;
        }
        if (settled) break;
      }
      flushHeld(lastUsage);
      if (!finished) {
        throw new LlmError3(
          `agent "${this.id}": pi query ended without an agent settle`,
          "PI_NO_RESULT"
        );
      }
      return { kind: "completed" };
    } finally {
      signal.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
  /** Append one Pi tool result to the durable log as a `tool/result` message. */
  appendToolResult(turn, step, toolResult) {
    const text = typeof toolResult.content === "string" ? toolResult.content : toolResult.content.map((block) => block.type === "text" ? block.text : "").filter((segment) => segment !== "").join("\n\n");
    this.session.append("tool/result", {
      turn,
      step,
      message: mapToolResult({
        toolCallId: toolResult.toolCallId,
        result: { content: [{ type: "text", text }] },
        isError: toolResult.isError === true
      })
    }, { surfaceOp: "append" });
  }
};

// src/engine-pi/loop.ts
var PI_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access"
];
var PI_DISPOSE_GRACE_MS = 3e3;
var Config3 = z3.object({
  sandboxMode: z3.union([...PI_SANDBOX_MODES]),
  provider: z3.string(),
  model: z3.string(),
  thinkingLevel: z3.string(),
  env: z3.dict(z3.string()).default({})
});
function resolveConfig3(config) {
  return {
    sandboxMode: config.sandboxMode,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    env: config.env ?? {}
  };
}
function piCliEntrypoint() {
  const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const root = dirname2(dirname2(fileURLToPath(mainUrl)));
  const pkg = JSON.parse(readFileSync(join2(root, "package.json"), "utf8"));
  const bin = pkg.bin;
  const rel = typeof bin === "string" ? bin : bin?.["pi"] ?? Object.values(bin ?? {})[0] ?? "bin/pi.js";
  return join2(root, rel);
}
function piSubprocessSpec(spec, graceMs) {
  return {
    // `spec.argv[0]` is the Pi CLI entrypoint; run it under the current node.
    argv: [process.execPath, ...spec.argv],
    cwd: spec.cwd,
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    graceMs,
    env: spec.env
  };
}
function fromSubprocess(handle) {
  const { stdin, stdout, stderr } = handle;
  if (stdin === void 0 || stdout === void 0 || stderr === void 0) {
    throw new Error("agent-loop-pi: spawned child must pipe stdin/stdout/stderr");
  }
  return {
    stdin,
    stdout,
    stderr,
    onExit: (handler) => {
      void handle.done.then(handler, handler);
    },
    terminate: () => handle.terminate()
  };
}
var PiLoop = class extends Service3 {
  /** Services the loop resolves through its own fiber; blessed identically to the package-level entry inject. */
  static inject = ["agents", "sessions", "systemPrompt", "subprocess"];
  /** Validated configuration owned by the loop plugin. */
  config;
  ownership;
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  runtime;
  /** Process-tree spawn capability handed to every agent, sandboxed by the subprocess seam. */
  spawn;
  /** Resolved Pi CLI entrypoint; `argv[0]` of every Pi RPC child. */
  bin;
  constructor(ctx, config) {
    super(ctx, "agentLoopPi");
    this.config = resolveConfig3(config);
    this.ownership = new FactoryOwnership(ctx.fiber);
    this.runtime = { ctx };
    this.bin = piCliEntrypoint();
    this.spawn = (spec) => fromSubprocess(this.runtime.ctx.subprocess.spawn(piSubprocessSpec(spec, PI_DISPOSE_GRACE_MS)));
    ctx.effect(() => () => this.ownership.dispose(), "agentLoopPi.transactions()");
    ctx.effect(() => ctx.agents.setFactory(this), "agentLoopPi.setFactory()");
    ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
    ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
    ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd);
  }
  /**
   * Construct the driver, scope, and one memoized reverse teardown for a new
   * agent. The teardown is registered with the factory and the owner fiber
   * BEFORE publication, so a mid-setup unload rolls everything back; `signal`
   * fuses caller cancellation with lifecycle teardown for setup awaits.
   */
  /* jscpd:ignore-start -- ownership/transaction machinery mirrors the Claude Code loop factory. */
  prepare(ownerCtx, id, options, session, callerSignal) {
    ownerCtx.fiber.assertActive();
    if (!this.ownership.isActive()) throw new Error("agent loop is not active");
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error ? callerSignal.reason : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason });
    }
    const loopCtx = this.runtime.ctx;
    const abort = new AbortController();
    const onCallerAbort = () => {
      abort.abort(callerSignal?.reason instanceof Error ? callerSignal.reason : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }));
    };
    const onFactoryTeardown = () => {
      abort.abort(this.ownership.signal.reason);
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    this.ownership.signal.addEventListener("abort", onFactoryTeardown, { once: true });
    let machine;
    let detachSession;
    let detachAgent;
    let disposing;
    const machineReady = Promise.withResolvers();
    const dispose = (ownerTriggered = false) => disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`));
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.ownership.signal.removeEventListener("abort", onFactoryTeardown);
      try {
        if (machine === void 0) await machineReady.promise;
        if (machine !== void 0) {
          machine.cancel({ kind: "disposed" });
          await machine.whenIdle();
          await machine.scope.dispose();
        }
      } finally {
        try {
          detachAgent?.();
          detachSession?.();
        } finally {
          untrack();
          if (!ownerTriggered) await unfollowOwner();
        }
      }
    })();
    const untrack = this.ownership.track(dispose);
    let unfollowOwner;
    try {
      unfollowOwner = ownerCtx.effect(() => () => {
        if (disposing !== void 0) return;
        abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
        return dispose(true);
      }, `agentLoopPi.lifecycle(${id})`);
    } catch (error) {
      untrack();
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.ownership.signal.removeEventListener("abort", onFactoryTeardown);
      throw error;
    }
    const assertLive = () => {
      if (!abort.signal.aborted) return;
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason));
    };
    try {
      const agent = machine = new PiAgent(loopCtx, id, options, session, this.config, this.spawn, this.bin);
      machineReady.resolve();
      assertLive();
      return {
        agent,
        signal: abort.signal,
        publish: (source) => {
          assertLive();
          detachSession = agent.ctx.sessions.enter(session);
          detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent);
          agent.ctx.sessions.announce(session);
          assertLive();
          loopCtx.agents.announce(agent);
          assertLive();
          emitAgentEvent3(loopCtx, agent, "agent/session-start", { source });
          assertLive();
          return { agent, dispose };
        },
        dispose
      };
    } catch (error) {
      machineReady.resolve();
      void dispose();
      throw error;
    }
  }
  /** Prepare one Agent around an acquired Session, run setup, and publish it. */
  async setupAndPublish(ownerCtx, id, preparation, agentOptions, setup, signal, source) {
    var _stack = [];
    try {
      const ownedPreparation = __using(_stack, preparation);
      const session = ownedPreparation.session;
      const prepared = this.prepare(ownerCtx, id, agentOptions, session, signal);
      try {
        const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id);
        setupCommit?.commit();
        return prepared.publish(source);
      } catch (error) {
        await prepared.dispose();
        throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  /**
   * Create an agent and session under one caller-supplied identity, owned by
   * the accessing fiber.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx, options) {
    const preparation = SessionPreparation3.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === void 0 ? {} : { seed: options.seed },
      ...options.meta === void 0 ? {} : { meta: options.meta }
    }));
    const published = this.setupAndPublish(
      ownerCtx,
      options.sessionId,
      preparation,
      options.agentOptions ?? {},
      options.setup,
      options.signal,
      "startup"
    );
    this.ownership.trackWrapper(published);
    return published;
  }
  /**
   * Resume an owned agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx, options) {
    const persistence = this.runtime.ctx.get("sessionPersistence");
    if (persistence === void 0) {
      throw new Error("cannot resume: session persistence is not configured (load a dsh-session-persistence backend)");
    }
    return this.resumeWith(ownerCtx, persistence, options);
  }
  /** Resume through an explicit persistence handle. */
  async resumeWith(ownerCtx, persistence, options) {
    const id = options.resumeSessionId;
    let preparation;
    try {
      const ownerAbort = new AbortController();
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
      }, `agentLoopPi.resume-load(${id})`);
      const fused = AbortSignal.any([
        ...options.signal === void 0 ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal
      ]);
      try {
        preparation = await raceAbortCall(
          () => persistence.prepare(id, fused),
          fused,
          id,
          (abandoned) => {
            abandoned[Symbol.dispose]();
          }
        );
      } finally {
        await unfollowOwner();
      }
      ownerCtx.fiber.assertActive();
      if (!this.ownership.isActive()) throw new Error("agent loop is not active");
      return await this.setupAndPublish(
        ownerCtx,
        id,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        "resume"
      );
    } finally {
      preparation?.[Symbol.dispose]();
    }
  }
};

// src/settings.ts
import z4 from "@deepseek-ai/schemastery";
// settingsNamespace removed — harness accepts raw strings

// src/namespace.ts
var LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL = "agent-loop-engine";

// src/settings.ts
var LOOP_ENGINE_IDS = ["in-process", "claude-code", "codex", "pi"];
var LOOP_ENGINE_SETTINGS_SCHEMA = z4.object({
  engine: z4.union([z4.const("in-process"), z4.const("claude-code"), z4.const("codex"), z4.const("pi")]).default("in-process"),
  showInComposer: z4.boolean().default(true)
});
function loopEngineSettingsNamespace() {
  return LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL;
}

// src/patch-manager.ts
var MANAGED_BLOCK_BEGIN = "# -- dsh-loop-engine managed block: ";
var MANAGED_BLOCK_END = "# -- /dsh-loop-engine managed block --";
var END_MARKER_LINE = `${MANAGED_BLOCK_END}
`;
function renderManagedBlock(engine) {
  if (engine === "in-process") return "";
  return [
    `${MANAGED_BLOCK_BEGIN}${engine} --`,
    "- id: agent-loop",
    "  disabled: true",
    END_MARKER_LINE
  ].join("\n");
}
var BEGIN_MARKER_RE = /^# -- dsh-loop-engine managed block: (\S+) --$/m;
function currentEngineOf(text) {
  const engine = BEGIN_MARKER_RE.exec(text)?.[1];
  return LOOP_ENGINE_IDS.includes(engine ?? "") ? engine : "in-process";
}
function managedSpan(text) {
  const begin = text.indexOf(MANAGED_BLOCK_BEGIN);
  if (begin === -1) return { head: text, tail: "", present: false, blankBefore: false };
  const afterBegin = begin + MANAGED_BLOCK_BEGIN.length;
  const endAt = text.indexOf(MANAGED_BLOCK_END, afterBegin);
  const spanEnd = endAt === -1 ? text.length : endAt + END_MARKER_LINE.length;
  const before = text.slice(0, begin);
  const blankBefore = before.endsWith("\n\n");
  return {
    head: blankBefore ? before.slice(0, -1) : before,
    tail: text.slice(spanEnd),
    present: true,
    blankBefore
  };
}
function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}
`;
}
function applyManagedBlock(text, engine) {
  const block = renderManagedBlock(engine);
  const span = managedSpan(text);
  if (!span.present) {
    if (block === "") return text;
    const base = ensureTrailingNewline(text);
    return `${base}
${block}`;
  }
  if (block === "") {
    return span.tail.startsWith("\n") ? `${span.head}${span.tail.slice(1)}` : `${span.head}${span.tail}`;
  }
  return `${span.head}${span.blankBefore ? "\n" : ""}${block}${span.tail}`;
}

// src/commands.ts
import { readdirSync, readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join3 } from "node:path";
import { createUserMessage as createUserMessage4 } from "@deepseek-ai/dsh-llm";
var COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
function forwardClaudeCodeCommand(name2) {
  return (invocation) => {
    invocation.agent.followup(createUserMessage4({
      content: [{ type: "text", text: `/${name2}${invocation.rawInput}` }],
      source: { kind: "user" }
    }));
    return { kind: "success" };
  };
}
function builtin(name2, description) {
  return { name: name2, description, handler: forwardClaudeCodeCommand(name2) };
}
var CLAUDE_CODE_COMMANDS = [
  builtin("help", "Show help about Claude Code commands"),
  builtin("compact", "Compact the conversation to reduce context usage"),
  builtin("clear", "Clear the conversation and start fresh"),
  builtin("review", "Review recent changes (git diff)"),
  builtin("explain", "Explain the selected code"),
  builtin("fix", "Fix issues in the code"),
  builtin("tests", "Add tests for the selected code")
];
function discoverUserSlashCommands() {
  let entries;
  try {
    entries = readdirSync(userCommandsDir(), { encoding: "utf8" });
  } catch {
    return [];
  }
  const definitions = [];
  const seen = new Set(CLAUDE_CODE_COMMANDS.map((command) => command.name));
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const name2 = entry.slice(0, -".md".length);
    if (!COMMAND_NAME.test(name2) || seen.has(name2)) continue;
    const path = join3(userCommandsDir(), entry);
    let raw;
    try {
      raw = readFileSync2(path, "utf8");
    } catch {
      continue;
    }
    const description = commandDescription(raw);
    if (description === void 0) continue;
    seen.add(name2);
    definitions.push({ name: name2, description, handler: forwardClaudeCodeCommand(name2) });
  }
  return definitions;
}
function userCommandsDir() {
  return join3(homedir(), ".claude", "commands");
}
function commandDescription(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return void 0;
  let body = trimmed;
  if (trimmed.startsWith("---\n")) {
    const closing = trimmed.indexOf("\n---");
    if (closing <= 0) return void 0;
    for (const line of trimmed.slice(4, closing).split("\n")) {
      const colon = line.indexOf(":");
      if (colon < 0 || line.slice(0, colon).trim() !== "description") continue;
      const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
      if (value.length > 0) return value;
    }
    body = trimmed.slice(closing + 4);
  }
  for (const line of body.split("\n")) {
    const candidate = line.trim();
    if (candidate.length === 0 || candidate.startsWith("#")) continue;
    return candidate.length > 120 ? `${candidate.slice(0, 119)}\u2026` : candidate;
  }
  return void 0;
}

// src/skills.ts
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join4, resolve } from "node:path";
var SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var PROVIDER_NAME = "claude-code";
var CLAUDE_CODE_RANK = 150;
var CLAUDE_CODE_USER_RANK = 160;
function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf("\n");
  if (firstLineEnd < 0) return void 0;
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, "");
  if (firstLine !== "---") return void 0;
  const start = firstLineEnd + 1;
  const closing = findClosingFrontmatter(raw, start);
  if (closing === void 0) return void 0;
  const yaml = raw.slice(start, closing.start);
  const data = {};
  const lines = yaml.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key.length === 0) continue;
    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      const block = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? "";
        if (next.trim().length > 0 && !/^[\s]/.test(next)) break;
        index += 1;
        if (next.trim().length > 0) block.push(next.trim());
      }
      data[key] = value.startsWith("|") ? block.join("\n") : block.join(" ");
      continue;
    }
    data[key] = unquote(value);
  }
  return { data, body: raw.slice(closing.bodyStart) };
}
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      return value.slice(1, -1);
    }
  }
  return value;
}
function findClosingFrontmatter(raw, start) {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
    }
    if (nextNewline < 0) return void 0;
    lineStart = nextNewline + 1;
  }
  return void 0;
}
function parseSkillFile(raw) {
  const parsed = parseFrontmatter(raw);
  if (parsed === void 0) return void 0;
  const name2 = stringField(parsed.data, "name");
  const description = stringField(parsed.data, "description");
  if (name2 === void 0 || description === void 0 || !SKILL_NAME.test(name2)) return void 0;
  const disableModelInvocation = booleanField(parsed.data, "disable-model-invocation");
  const userInvocable = booleanField(parsed.data, "user-invocable");
  const whenToUse = optionalString(parsed.data, "whenToUse");
  return {
    name: name2,
    description,
    ...whenToUse !== void 0 ? { whenToUse } : {},
    invocation: {
      modelInvocable: disableModelInvocation !== true,
      userInvocable: userInvocable !== false
    },
    content: parsed.body.trim()
  };
}
function stringField(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function optionalString(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function booleanField(data, key) {
  const value = data[key];
  if (typeof value !== "string") return void 0;
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  return void 0;
}
var ClaudeCodeSkillProvider = class {
  constructor(control) {
    this.control = control;
  }
  control;
  name = PROVIDER_NAME;
  async list(options) {
    const candidates = [];
    const cwd = options.cwd;
    if (cwd !== void 0) {
      const projectRoot = await findProjectRoot(resolve(cwd));
      await collectSkillsDir(join4(projectRoot, ".claude", "skills"), CLAUDE_CODE_RANK, candidates);
      await collectClaudeMd(projectRoot, candidates);
    }
    await collectSkillsDir(join4(homedir2(), ".claude", "skills"), CLAUDE_CODE_USER_RANK, candidates);
    if (this.control.signal.aborted) return [];
    return candidates;
  }
  async get(candidate, _options) {
    const locator = candidate.locator;
    try {
      const raw = await readFile(locator.path, { encoding: "utf8" });
      const parsed = parseSkillFile(raw);
      if (parsed === void 0) return void 0;
      return {
        name: parsed.name,
        description: parsed.description,
        ...parsed.whenToUse !== void 0 ? { whenToUse: parsed.whenToUse } : {},
        invocation: parsed.invocation,
        source: "custom",
        provider: this.name,
        content: parsed.content,
        path: locator.path,
        ...candidate.resourceBase !== void 0 ? { resourceBase: candidate.resourceBase } : {}
      };
    } catch {
      return void 0;
    }
  }
};
async function collectSkillsDir(skillsDir, rank, candidates) {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = join4(skillsDir, entry.name);
    const info = await stat(entryPath).catch(() => void 0);
    if (info === void 0) continue;
    if (info.isDirectory()) {
      const path = join4(entryPath, "SKILL.md");
      const skill2 = await tryParseSkill(path);
      if (skill2 === void 0) continue;
      candidates.push(toCandidate(skill2, path, rank, entryPath));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const skill = await tryParseSkill(entryPath);
    if (skill === void 0) continue;
    candidates.push(toCandidate(skill, entryPath, rank, skillsDir));
  }
}
async function collectClaudeMd(projectRoot, candidates) {
  const claudeMd = join4(projectRoot, "CLAUDE.md");
  try {
    const info = await stat(claudeMd);
    if (!info.isFile()) return;
    const skill = await tryParseSkill(claudeMd);
    if (skill !== void 0) {
      candidates.push(toCandidate(skill, claudeMd, CLAUDE_CODE_RANK, projectRoot));
    }
  } catch {
  }
}
function toCandidate(skill, path, rank, resourceBaseDir) {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse !== void 0 ? { whenToUse: skill.whenToUse } : {},
    invocation: skill.invocation,
    source: "custom",
    provider: PROVIDER_NAME,
    rank,
    locator: { kind: "file", path },
    path,
    resourceBase: { kind: "directory", path: resourceBaseDir }
  };
}
async function tryParseSkill(path) {
  try {
    const raw = await readFile(path, { encoding: "utf8" });
    return parseSkillFile(raw);
  } catch {
    return void 0;
  }
}
async function findProjectRoot(cwd) {
  let current = cwd;
  while (true) {
    try {
      await stat(join4(current, ".git"));
      return current;
    } catch {
    }
    const parent = resolve(current, "..");
    if (parent === current) return cwd;
    current = parent;
  }
}

// src/engine-codex/skills.ts
import { homedir as homedir3 } from "node:os";
import { join as join6 } from "node:path";

// src/driver-core/context-files.ts
import { readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { join as join5, resolve as resolve2 } from "node:path";
async function projectAncestors(cwd) {
  const root = await findProjectRoot(resolve2(cwd));
  const dirs = [];
  let current = resolve2(cwd);
  while (true) {
    dirs.push(current);
    if (current === root) return dirs;
    current = resolve2(current, "..");
  }
}
async function collectProjectContextFiles(cwd, policy) {
  const files = [];
  for (const dir of await projectAncestors(cwd)) {
    const chosen = await dirContextFile(dir, policy);
    if (chosen !== void 0) files.push(chosen);
  }
  return files;
}
async function dirContextFile(dir, policy) {
  if (policy.override !== void 0) {
    const override = join5(dir, policy.override);
    if (await pathExists(override)) return override;
  }
  for (const name2 of policy.primary) {
    const candidate = join5(dir, name2);
    if (await pathExists(candidate)) return candidate;
  }
  return void 0;
}
async function pathExists(path) {
  try {
    await stat2(path);
    return true;
  } catch {
    return false;
  }
}
async function readOptionalFile(path) {
  try {
    return await readFile2(path, { encoding: "utf8" });
  } catch {
    return void 0;
  }
}
async function anySourceNonEmpty(paths) {
  for (const path of paths) {
    const raw = await readOptionalFile(path);
    if (raw !== void 0 && raw.trim().length > 0) return true;
  }
  return false;
}
async function fileNonEmpty(path) {
  const raw = await readOptionalFile(path);
  return raw !== void 0 && raw.trim().length > 0;
}
async function readSources(paths) {
  const parts = [];
  for (const path of paths) {
    const raw = await readOptionalFile(path);
    if (raw !== void 0 && raw.trim().length > 0) parts.push(raw);
  }
  return parts.length > 0 ? parts.join("\n\n") : void 0;
}

// src/engine-codex/skills.ts
var PROVIDER_NAME2 = "codex";
var CODEX_PROJECT_RANK = 140;
var CODEX_USER_RANK = 160;
var CODEX_CONTEXT_POLICY = { primary: ["AGENTS.md"] };
var CodexSkillProvider = class {
  constructor(control) {
    this.control = control;
  }
  control;
  name = PROVIDER_NAME2;
  async list(options) {
    const candidates = [];
    const cwd = options.cwd;
    if (cwd !== void 0) {
      const paths = await collectProjectContextFiles(cwd, CODEX_CONTEXT_POLICY);
      if (await anySourceNonEmpty(paths)) candidates.push(this.agentsCandidate(paths, CODEX_PROJECT_RANK));
    }
    const userPath = join6(homedir3(), ".codex", "AGENTS.md");
    if (await fileNonEmpty(userPath)) candidates.push(this.agentsCandidate([userPath], CODEX_USER_RANK));
    if (this.control.signal.aborted) return [];
    return candidates;
  }
  async get(candidate, _options) {
    const locator = candidate.locator;
    const content = await readSources(locator.paths);
    if (content === void 0) return void 0;
    const first = locator.paths[0];
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: this.name,
      content,
      path: first,
      resourceBase: { kind: "file", path: first }
    };
  }
  /** One merged `agents-md` candidate for a ranked file set. */
  agentsCandidate(paths, rank) {
    const first = paths[0];
    return {
      name: "agents-md",
      description: "Codex project/user instructions (AGENTS.md)",
      invocation: { modelInvocable: true, userInvocable: true },
      source: "custom",
      provider: this.name,
      rank,
      locator: { kind: "agents-md", paths },
      path: first,
      resourceBase: { kind: "file", path: first }
    };
  }
};

// src/engine-pi/skills.ts
import { readdir as readdir2, readFile as readFile3, stat as stat3 } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname3, join as join7, resolve as resolve3 } from "node:path";
var PROVIDER_NAME3 = "pi";
var PI_AGENTS_PROJECT_RANK = 140;
var PI_SKILL_PROJECT_RANK = 150;
var PI_AGENTS_USER_RANK = 160;
var PI_SKILL_USER_RANK = 170;
var PI_CONTEXT_POLICY = {
  override: "AGENTS.override.md",
  primary: ["AGENTS.md", "CLAUDE.md"]
};
function piAgentDir() {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override !== void 0 && override.length > 0) return resolve3(override);
  return join7(homedir4(), ".pi", "agent");
}
var PiSkillProvider = class {
  constructor(control) {
    this.control = control;
  }
  control;
  name = PROVIDER_NAME3;
  async list(options) {
    const candidates = [];
    const cwd = options.cwd;
    if (cwd !== void 0) {
      const projectDirs = await projectAncestors(cwd);
      const contextPaths = await collectProjectContextFiles(cwd, PI_CONTEXT_POLICY);
      if (await anySourceNonEmpty(contextPaths)) candidates.push(this.agentsCandidate(contextPaths, PI_AGENTS_PROJECT_RANK));
      for (const dir of projectDirs) {
        await this.collectSkillsDir(join7(dir, ".pi", "skills"), PI_SKILL_PROJECT_RANK, candidates);
      }
    }
    const userAgentDir = piAgentDir();
    const userContext = join7(userAgentDir, "AGENTS.md");
    if (await fileNonEmpty(userContext)) candidates.push(this.agentsCandidate([userContext], PI_AGENTS_USER_RANK));
    await this.collectSkillsDir(join7(userAgentDir, "skills"), PI_SKILL_USER_RANK, candidates);
    if (this.control.signal.aborted) return [];
    return candidates;
  }
  async get(candidate, _options) {
    const locator = candidate.locator;
    if (locator.kind === "skill-file") {
      const parsed = await this.tryParse(locator.path);
      if (parsed === void 0) return void 0;
      return {
        name: parsed.name,
        description: parsed.description,
        ...parsed.whenToUse === void 0 ? {} : { whenToUse: parsed.whenToUse },
        invocation: parsed.invocation,
        source: candidate.source,
        provider: this.name,
        content: parsed.content,
        path: locator.path,
        resourceBase: { kind: "directory", path: dirname3(locator.path) }
      };
    }
    const content = await readSources(locator.paths);
    if (content === void 0) return void 0;
    const first = locator.paths[0];
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: this.name,
      content,
      path: first,
      resourceBase: { kind: "file", path: first }
    };
  }
  /** One merged `agents-md` candidate for a ranked file set. */
  agentsCandidate(paths, rank) {
    const first = paths[0];
    return {
      name: "agents-md",
      description: "Pi project/user instructions (AGENTS.md / CLAUDE.md)",
      invocation: { modelInvocable: true, userInvocable: true },
      source: "custom",
      provider: this.name,
      rank,
      locator: { kind: "agents-md", paths },
      path: first,
      resourceBase: { kind: "file", path: first }
    };
  }
  /** Collect every skill in one skills directory, both pi layouts. */
  async collectSkillsDir(skillsDir, rank, candidates) {
    let entries;
    try {
      entries = await readdir2(skillsDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = join7(skillsDir, entry.name);
      const info = await stat3(entryPath).catch(() => void 0);
      if (info === void 0) continue;
      if (info.isDirectory()) {
        const path = join7(entryPath, "SKILL.md");
        const parsed2 = await this.tryParse(path);
        if (parsed2 === void 0) continue;
        candidates.push(this.skillCandidate(parsed2, path, rank, entryPath));
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const parsed = await this.tryParse(entryPath);
      if (parsed === void 0) continue;
      candidates.push(this.skillCandidate(parsed, entryPath, rank, skillsDir));
    }
  }
  /** One parsed skill as a ranked candidate. */
  skillCandidate(skill, path, rank, resourceDir) {
    return {
      name: skill.name,
      description: skill.description,
      ...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse },
      invocation: skill.invocation,
      source: "custom",
      provider: this.name,
      rank,
      locator: { kind: "skill-file", path },
      path,
      resourceBase: { kind: "directory", path: resourceDir }
    };
  }
  /** Parse one SKILL.md file, or `undefined` when it is unreadable or invalid. */
  async tryParse(path) {
    try {
      const raw = await readFile3(path, { encoding: "utf8" });
      return parseSkillFile(raw);
    } catch {
      return void 0;
    }
  }
};

// src/index.ts
var name = "loop-engine";
var inject = [];
var MAX_MOUNT_ATTEMPTS = 40;
var MOUNT_RETRY_MS = 50;
var Config4 = z5.object({
  profile: z5.string(),
  patchFilename: z5.string(),
  patchPath: z5.string(),
  permissionMode: z5.union(CLAUDE_CODE_PERMISSION_MODES.map((mode) => z5.const(mode))),
  env: z5.dict(z5.string()),
  model: z5.string(),
  disposeGraceMs: z5.number(),
  maxTurns: z5.number(),
  sandboxMode: z5.union(CODEX_SANDBOX_MODES.map((mode) => z5.const(mode))),
  approvalPolicy: z5.union(CODEX_APPROVAL_POLICIES.map((policy) => z5.const(policy))),
  piProvider: z5.string(),
  piThinking: z5.string()
});
function resolvePatchPath(config) {
  if (config.patchPath !== void 0 && config.patchPath !== "") return config.patchPath;
  return join8(
    resolveDshHome(),
    "profiles",
    config.profile ?? "web",
    config.patchFilename ?? "cordis.patch.yml"
  );
}
function isMissing(error) {
  return error?.code === "ENOENT";
}
async function readPatchOrUndefined(path) {
  try {
    return await readFile4(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return void 0;
    throw error;
  }
}
async function writePatchFile(path, text) {
  await mkdir(dirname4(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}
function writePatchFileSync(path, text) {
  mkdirSync(dirname4(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}
async function syncManagedBlock(path, engine) {
  const current = await readPatchOrUndefined(path);
  if (current !== void 0 && currentEngineOf(current) === engine) return false;
  const next = applyManagedBlock(current ?? "", engine);
  await writePatchFile(path, next);
  return true;
}
function readPatchFileSync(path) {
  try {
    return readFileSync3(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}
function claudeCodeConfig(config) {
  return {
    ...config.permissionMode === void 0 ? {} : { permissionMode: config.permissionMode },
    ...config.env === void 0 ? {} : { env: config.env },
    ...config.model === void 0 ? {} : { model: config.model },
    ...config.disposeGraceMs === void 0 ? {} : { disposeGraceMs: config.disposeGraceMs },
    ...config.maxTurns === void 0 ? {} : { maxTurns: config.maxTurns }
  };
}
function codexConfig(config) {
  return {
    ...config.sandboxMode === void 0 ? {} : { sandboxMode: config.sandboxMode },
    ...config.approvalPolicy === void 0 ? {} : { approvalPolicy: config.approvalPolicy },
    ...config.env === void 0 ? {} : { env: config.env },
    ...config.model === void 0 ? {} : { model: config.model }
  };
}
function piConfig(config) {
  return {
    ...config.piProvider === void 0 ? {} : { provider: config.piProvider },
    ...config.model === void 0 ? {} : { model: config.model },
    ...config.piThinking === void 0 ? {} : { thinkingLevel: config.piThinking },
    ...config.env === void 0 ? {} : { env: config.env },
    ...config.sandboxMode === void 0 ? {} : { sandboxMode: config.sandboxMode }
  };
}
function apply(ctx, config) {
  const patchPath = resolvePatchPath(config);
  let fileEngine = currentEngineOf(readPatchFileSync(patchPath));
  let engineFiber;
  let mountedEngine;
  let commandDisposers;
  let skillDisposer;
  let mountAttempts = 0;
  let mountRetry;
  const CLEAR_RETRY = () => {
    if (mountRetry !== void 0) {
      clearTimeout(mountRetry);
      mountRetry = void 0;
    }
  };
  const cleanupEngineRegistrations = () => {
    if (commandDisposers !== void 0) {
      for (const dispose of commandDisposers) dispose();
      commandDisposers = void 0;
    }
    if (skillDisposer !== void 0) {
      skillDisposer();
      skillDisposer = void 0;
    }
  };
  const hostFactory = (engine, mount) => {
    if (engineFiber !== void 0) return;
    const fiber = mount();
    engineFiber = fiber;
    mountedEngine = engine;
    void fiber.then(() => void 0, (error) => {
      cleanupEngineRegistrations();
      engineFiber = void 0;
      mountedEngine = void 0;
      if (error instanceof Error && error.message.includes("an agent factory is already registered") && mountAttempts < MAX_MOUNT_ATTEMPTS) {
        mountAttempts += 1;
        mountRetry = setTimeout(() => {
          mountEngine(engine);
        }, MOUNT_RETRY_MS);
        return;
      }
      ctx.logger.error(`loop-engine: ${engine} factory failed to start: ${String(error)}`);
    });
  };
  const mountClaude = () => {
    if (engineFiber !== void 0) return;
    const commands = ctx.get("commands");
    if (commands !== void 0) {
      const disposers = [];
      for (const command of [...CLAUDE_CODE_COMMANDS, ...discoverUserSlashCommands()]) {
        try {
          disposers.push(commands.register(command));
        } catch (error) {
          ctx.logger.warn(`loop-engine: skip claude-code command /${command.name}: ${String(error)}`);
        }
      }
      commandDisposers = disposers;
    }
    const skills = ctx.get("skills");
    if (skills !== void 0) {
      skillDisposer = skills.registerProvider((control) => new ClaudeCodeSkillProvider(control));
    }
    hostFactory("claude-code", () => ctx.plugin(ClaudeCodeLoop, claudeCodeConfig(config)));
  };
  const mountCodex = () => {
    const skills = ctx.get("skills");
    if (skills !== void 0) {
      skillDisposer = skills.registerProvider((control) => new CodexSkillProvider(control));
    }
    hostFactory("codex", () => ctx.plugin(CodexLoop, codexConfig(config)));
  };
  const mountPi = () => {
    const skills = ctx.get("skills");
    if (skills !== void 0) {
      skillDisposer = skills.registerProvider((control) => new PiSkillProvider(control));
    }
    hostFactory("pi", () => ctx.plugin(PiLoop, piConfig(config)));
  };
  const mountEngine = (engine) => {
    if (engine === "claude-code") mountClaude();
    else if (engine === "codex") mountCodex();
    else if (engine === "pi") mountPi();
  };
  const unmountEngine = () => {
    const fiber = engineFiber;
    mountAttempts = 0;
    CLEAR_RETRY();
    cleanupEngineRegistrations();
    mountedEngine = void 0;
    if (fiber === void 0) return;
    engineFiber = void 0;
    void fiber.then((resolved) => {
      void resolved.dispose();
    }, () => void 0);
  };
  mountEngine(fileEngine);
  ctx.effect(() => () => CLEAR_RETRY(), "loop-engine: mount retry cleanup");
  let source;
  ctx.settings.installSection(ctx, "agent-loop-engine", LOOP_ENGINE_SETTINGS_SCHEMA, { engine: fileEngine, showInComposer: true }, {
    setSource: (current) => {
      source = current;
    },
    onChange: () => {
      const next = source().engine;
      if (next === fileEngine) return;
      if (mountedEngine !== next) {
        unmountEngine();
        mountEngine(next);
      }
      try {
        const updated = applyManagedBlock(readPatchFileSync(patchPath), next);
        writePatchFileSync(patchPath, updated);
        fileEngine = next;
      } catch (error) {
        ctx.logger.error(`loop-engine: managed block write failed: ${String(error)}`);
      }
    }
  });
}
export {
  Config4 as Config,
  apply,
  inject,
  name,
  resolvePatchPath,
  syncManagedBlock,
  writePatchFile,
  writePatchFileSync
};
//# sourceMappingURL=index.js.map
