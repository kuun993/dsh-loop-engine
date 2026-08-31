// src/settings.ts
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
var LOOP_ENGINE_IDS = ["in-process", "claude-code", "codex", "pi"];
var LOOP_ENGINE_SETTINGS_SCHEMA = z.object({
  engine: z.union([z.const("in-process"), z.const("claude-code"), z.const("codex"), z.const("pi")]).default("in-process"),
  showInComposer: z.boolean().default(true)
});

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
var EMPTY_FLOW_SEQ_RE = /^[ \t]*\[\][ \t]*$/;
function isEmptyFlowSeqDocument(text) {
  let sawEmptySeq = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!sawEmptySeq && EMPTY_FLOW_SEQ_RE.test(line)) {
      sawEmptySeq = true;
      continue;
    }
    return false;
  }
  return sawEmptySeq;
}
function stripEmptyFlowSeq(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => EMPTY_FLOW_SEQ_RE.test(line));
  if (at === -1) return text;
  lines.splice(at, 1);
  return lines.join("\n");
}
function applyManagedBlock(text, engine) {
  const block = renderManagedBlock(engine);
  const span = managedSpan(text);
  if (!span.present) {
    if (block === "") return text;
    const base = ensureTrailingNewline(
      isEmptyFlowSeqDocument(text) ? stripEmptyFlowSeq(text).trimEnd() : text
    );
    return `${base}
${block}`;
  }
  if (block === "") {
    return span.tail.startsWith("\n") ? `${span.head}${span.tail.slice(1)}` : `${span.head}${span.tail}`;
  }
  return `${span.head}${span.blankBefore ? "\n" : ""}${block}${span.tail}`;
}

// src/invariant.ts
var PACKAGE_NAME = "dsh-loop-engine";
var name = "loop-engine-invariant";
var inject = ["invariants"];
var install = (ctx, fail) => {
  void ctx;
  const seed = "# dsh profile patch layer\n";
  for (const engine of LOOP_ENGINE_IDS) {
    const applied = applyManagedBlock(seed, engine);
    const reborn = applyManagedBlock(applied, currentEngineOf(applied));
    if (reborn !== applied) fail(`managed-block round trip for ${engine} is not a fixed point`);
    if (engine === "in-process" && applied !== seed) fail("in-process engine must leave the file text unchanged");
    if (engine !== "in-process" && currentEngineOf(renderManagedBlock(engine)) !== engine) fail(`${engine} block must read back as the ${engine} engine`);
  }
};
var apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=invariant.js.map
