var module = { exports: {} }; var exports = module.exports; window.__ModuleLoader__.load({ id: "dsh-loop-engine", factory: (require) => {
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/LoopEngineSection.tsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var ENGINE_OPTIONS = [
  { value: "in-process", key: "engineInProcess" },
  { value: "claude-code", key: "engineClaudeCode" },
  { value: "codex", key: "engineCodex" },
  { value: "pi", key: "enginePi" }
];
function engineLabelKey(engine) {
  switch (engine) {
    case "claude-code":
      return "engineClaudeCode";
    case "codex":
      return "engineCodex";
    case "pi":
      return "enginePi";
    default:
      return "engineInProcess";
  }
}
var shell = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  maxWidth: 720,
  color: "var(--dsw-alias-label-primary)"
};
var titleStyle = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600
};
var intro = {
  margin: 0,
  fontSize: 13,
  color: "var(--dsw-alias-label-tertiary)"
};
var trigger = {
  appearance: "none",
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  width: "fit-content",
  minWidth: 200,
  padding: "9px 12px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 10,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  fontSize: 13,
  cursor: "pointer"
};
var triggerDisabled = { ...trigger, opacity: 0.5, cursor: "default" };
var notice = {
  margin: 0,
  fontSize: 12,
  color: "var(--dsw-alias-label-secondary)"
};
var error = {
  margin: 0,
  fontSize: 13,
  color: "var(--dsw-alias-state-error-primary)"
};
var toggleRow = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "var(--dsw-alias-label-primary)",
  cursor: "pointer"
};
var toggleCheckbox = {
  width: 16,
  height: 16,
  accentColor: "var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))",
  cursor: "pointer"
};
var confirmBody = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--dsw-alias-label-secondary)"
};
function LoopEngineSection(props) {
  const { controller, useSnapshot, t } = props;
  const { status, engine, showInComposer, writable } = useSnapshot((snapshot) => snapshot);
  const [open, setOpen] = (0, import_react.useState)(false);
  const [pending, setPending] = (0, import_react.useState)(null);
  const navId = (0, import_react.useId)();
  const triggerRef = (0, import_react.useRef)(null);
  if (status === "unavailable") {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { "aria-labelledby": navId, style: shell, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { id: navId, style: titleStyle, children: t("nav") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: intro, children: t("description") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", style: error, children: t("unavailable") })
    ] });
  }
  const disabled = status === "saving" || !writable;
  const label = t(engineLabelKey(engine));
  const onSelect = (next) => {
    setOpen(false);
    const value = next;
    if (value === engine) return;
    setPending(value);
  };
  const confirmSwitch = () => {
    const value = pending;
    setPending(null);
    if (value !== null) {
      void controller.setEngine(value).then((landed) => {
        if (landed) window.location.reload();
      });
    }
  };
  const cancelSwitch = () => {
    setPending(null);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { "aria-labelledby": navId, style: shell, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { id: navId, style: titleStyle, children: t("nav") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: intro, children: t("description") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      import_dsh_client_ui_primitives.Menu,
      {
        open,
        onClose: () => {
          setOpen(false);
        },
        items: ENGINE_OPTIONS.map((option) => ({ id: option.value, label: t(option.key) })),
        selectedId: engine,
        onSelect,
        align: "start",
        portal: true,
        getAnchorRect: () => triggerRef.current?.getBoundingClientRect() ?? null,
        anchor: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "button",
          {
            type: "button",
            ref: triggerRef,
            "aria-haspopup": "menu",
            "aria-expanded": open,
            disabled,
            style: disabled ? triggerDisabled : trigger,
            onClick: () => {
              setOpen(!open);
            },
            children: [
              label,
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 })
            ]
          }
        )
      }
    ),
    status === "saving" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: notice, children: t("saving") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: notice, children: t("switchNotice") }),
    engine === "claude-code" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: notice, children: t("claudeModelNotice") }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: toggleRow, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "checkbox",
          checked: showInComposer,
          disabled,
          style: toggleCheckbox,
          onChange: (event) => {
            void controller.setShowInComposer(event.currentTarget.checked);
          }
        }
      ),
      t("showInComposerLabel")
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      import_dsh_client_ui_primitives.Modal,
      {
        open: pending !== null,
        onClose: cancelSwitch,
        title: t("confirmTitle"),
        footer: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: cancelSwitch, children: t("cancelAction") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", onClick: confirmSwitch, children: t("confirmAction") })
        ] }),
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: confirmBody, children: t("confirmBody") })
      }
    )
  ] });
}

// src/client/LoopEngineBadge.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var pill = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 999,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-secondary)",
  fontSize: 12,
  lineHeight: "18px",
  whiteSpace: "nowrap"
};
function LoopEngineBadge(props) {
  const { useSnapshot, t } = props;
  const { status, engine } = useSnapshot((state) => state);
  if (status !== "ready") return null;
  const label = t(
    engine === "claude-code" ? "engineClaudeCode" : engine === "codex" ? "engineCodex" : engine === "pi" ? "enginePi" : "engineInProcess"
  );
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: pill, title: t("description"), children: [
    t("nav"),
    " \xB7 ",
    label
  ] });
}

// src/client/LoopEngineComposerSelect.tsx
var import_react2 = require("react");
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime3 = require("react/jsx-runtime");
var ENGINE_OPTIONS2 = [
  { value: "in-process", key: "engineInProcess" },
  { value: "claude-code", key: "engineClaudeCode" },
  { value: "codex", key: "engineCodex" },
  { value: "pi", key: "enginePi" }
];
function engineLabelKey2(engine) {
  switch (engine) {
    case "claude-code":
      return "engineClaudeCode";
    case "codex":
      return "engineCodex";
    case "pi":
      return "enginePi";
    default:
      return "engineInProcess";
  }
}
var trigger2 = {
  appearance: "none",
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 10,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  fontSize: 12,
  lineHeight: "20px",
  whiteSpace: "nowrap",
  cursor: "pointer"
};
var triggerDisabled2 = { ...trigger2, opacity: 0.5, cursor: "default" };
var confirmBody2 = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--dsw-alias-label-secondary)"
};
function LoopEngineComposerSelect(props) {
  const { controller, useSnapshot, t } = props;
  const { status, engine, showInComposer, writable } = useSnapshot((snapshot) => snapshot);
  const [open, setOpen] = (0, import_react2.useState)(false);
  const [pending, setPending] = (0, import_react2.useState)(null);
  const triggerRef = (0, import_react2.useRef)(null);
  if (status !== "ready" || !showInComposer) return null;
  const disabled = !writable;
  const label = t(engineLabelKey2(engine));
  const title = engine === "claude-code" ? t("claudeModelNotice") : t("description");
  const onSelect = (next) => {
    setOpen(false);
    const value = next;
    if (value === engine) return;
    setPending(value);
  };
  const confirmSwitch = () => {
    const value = pending;
    setPending(null);
    if (value !== null) {
      void controller.setEngine(value).then((landed) => {
        if (landed) window.location.reload();
      });
    }
  };
  const cancelSwitch = () => {
    setPending(null);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      import_dsh_client_ui_primitives2.Menu,
      {
        open,
        onClose: () => {
          setOpen(false);
        },
        items: ENGINE_OPTIONS2.map((option) => ({ id: option.value, label: t(option.key) })),
        selectedId: engine,
        onSelect,
        align: "start",
        portal: true,
        getAnchorRect: () => triggerRef.current?.getBoundingClientRect() ?? null,
        anchor: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
          "button",
          {
            type: "button",
            ref: triggerRef,
            "aria-haspopup": "menu",
            "aria-expanded": open,
            disabled,
            style: disabled ? triggerDisabled2 : trigger2,
            title,
            onClick: () => {
              setOpen(!open);
            },
            children: [
              label,
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.IconChevronDownOutline14, { size: 14 })
            ]
          }
        )
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      import_dsh_client_ui_primitives2.Modal,
      {
        open: pending !== null,
        onClose: cancelSwitch,
        title: t("confirmTitle"),
        footer: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.Button, { variant: "outline", onClick: cancelSwitch, children: t("cancelAction") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives2.Button, { variant: "primary", onClick: confirmSwitch, children: t("confirmAction") })
        ] }),
        children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { style: confirmBody2, children: t("confirmBody") })
      }
    )
  ] });
}

// src/client/store.ts
var import_client = require("@deepseek-ai/dsh-client-runtime/client");
function decodeLoopEngine(section) {
  if (typeof section !== "object" || section === null || Array.isArray(section)) return void 0;
  const { engine, showInComposer } = section;
  if (engine !== "in-process" && engine !== "claude-code" && engine !== "codex" && engine !== "pi") {
    return void 0;
  }
  return { engine, showInComposer: showInComposer !== false };
}
var LoopEngineStore = class {
  /**
   * @param scope - the loop engine settings namespace scope.
   */
  constructor(scope) {
    this.scope = scope;
  }
  scope;
  /** uSES-safe state source shared by the registered settings section. */
  store = (0, import_client.createSnapshotStore)({
    status: "loading",
    engine: "in-process",
    showInComposer: true,
    writable: false,
    error: null
  });
  following;
  saving = false;
  /** Begin following the bound scope and publish its current answer. */
  load() {
    this.following ??= this.scope.subscribe(() => {
      this.derive();
    });
    this.derive();
  }
  /**
   * Persist the selected engine. Success is judged against the snapshot the
   * write left behind, so a refused write reports error after its recovery.
   * @param engine - the engine to select for future Agent turns.
   * @returns whether the write landed.
   */
  async setEngine(engine) {
    this.saving = true;
    this.store.update((state) => {
      state.status = "saving";
      state.error = null;
    });
    try {
      await this.scope.set("engine", engine);
    } finally {
      this.saving = false;
    }
    this.derive();
    const { engine: settled } = this.store.getSnapshot();
    const landed = settled === engine;
    if (!landed) {
      this.store.update((state) => {
        state.status = "unavailable";
        state.error = "the loop engine selection did not persist";
      });
    }
    return landed;
  }
  /**
   * Persist whether the composer shows the engine picker. Success is judged
   * against the snapshot the write left behind, so a refused write reports
   * error after its recovery. Unlike {@link setEngine}, landing does not reload
   * the page — the toggle only changes composer visibility.
   * @param show - whether the chat page composer reveals the engine picker.
   * @returns whether the write landed.
   */
  async setShowInComposer(show) {
    this.saving = true;
    this.store.update((state) => {
      state.status = "saving";
      state.error = null;
    });
    try {
      await this.scope.set("showInComposer", show);
    } finally {
      this.saving = false;
    }
    this.derive();
    const { showInComposer: settled } = this.store.getSnapshot();
    const landed = settled === show;
    if (!landed) {
      this.store.update((state) => {
        state.status = "unavailable";
        state.error = "the loop engine display setting did not persist";
      });
    }
    return landed;
  }
  /** Stop following the scope. */
  dispose() {
    this.following?.();
    this.following = void 0;
  }
  derive() {
    if (this.saving) return;
    const scope = this.scope.getSnapshot();
    switch (scope.status) {
      case "loading":
        this.store.update((state) => {
          state.status = "loading";
          state.error = null;
        });
        return;
      case "unavailable":
        this.store.update((state) => {
          state.status = "unavailable";
          state.engine = "in-process";
          state.showInComposer = true;
          state.error = null;
        });
        return;
      case "ready": {
        const engine = scope.value?.engine ?? "in-process";
        const showInComposer = scope.value?.showInComposer ?? true;
        this.store.update((state) => {
          state.status = "ready";
          state.engine = engine;
          state.showInComposer = showInComposer;
          state.writable = scope.writable;
          state.error = null;
        });
        return;
      }
      default: {
        const exhaustive = scope.status;
        throw new Error(`unexpected loop engine scope status: ${String(exhaustive)}`);
      }
    }
  }
};

// src/client/locales.ts
var zh = {
  nav: "\u5FAA\u73AF\u5F15\u64CE",
  description: "\u9009\u62E9\u9A71\u52A8\u4F1A\u8BDD\u7684 Agent \u6267\u884C\u5F15\u64CE\uFF0C\u5207\u6362\u5BF9\u540E\u7EED\u4F1A\u8BDD\u751F\u6548\u3002",
  engineInProcess: "\u8FDB\u7A0B\u5185\u5F15\u64CE\uFF08\u9ED8\u8BA4\uFF09",
  engineClaudeCode: "Claude Code CLI",
  engineCodex: "Codex CLI",
  enginePi: "Pi CLI",
  showInComposerLabel: "\u5728\u5BF9\u8BDD\u9875\u663E\u793A\u5F15\u64CE\u9009\u62E9\u5668",
  unavailable: "\u5FAA\u73AF\u5F15\u64CE\u8BBE\u7F6E\u4E0D\u53EF\u7528",
  switchNotice: "\u5207\u6362\u5F15\u64CE\u4F1A\u4E2D\u65AD\u5F53\u524D\u4F7F\u7528\u65E7\u5F15\u64CE\u8FD0\u884C\u4E2D\u7684\u4F1A\u8BDD\u3002",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  confirmTitle: "\u5207\u6362\u5FAA\u73AF\u5F15\u64CE\uFF1F",
  confirmBody: "\u5207\u6362\u4F1A\u4E2D\u65AD\u5F53\u524D\u4F7F\u7528\u65E7\u5F15\u64CE\u8FD0\u884C\u4E2D\u7684\u4F1A\u8BDD\uFF0C\u786E\u8BA4\u540E\u9875\u9762\u5C06\u81EA\u52A8\u5237\u65B0\uFF0C\u65B0\u5BF9\u8BDD\u4F7F\u7528\u65B0\u5F15\u64CE\u3002\u786E\u8BA4\u5207\u6362\u5417\uFF1F",
  confirmAction: "\u5207\u6362",
  cancelAction: "\u53D6\u6D88",
  claudeModelNotice: "\u5F53\u524D\u4F7F\u7528 Claude Code \u5F15\u64CE\uFF1A\u5B9E\u9645\u6A21\u578B\u7531 Claude Code \u539F\u751F\u51B3\u5B9A\uFF0C\u9875\u9762\u4E0A\u7684\u6A21\u578B\u9009\u62E9\u4E0D\u751F\u6548\u3002"
};
var en = {
  nav: "Loop engine",
  description: "Choose the agent execution engine that drives sessions; the switch applies to new turns.",
  engineInProcess: "In-process engine (default)",
  engineClaudeCode: "Claude Code CLI",
  engineCodex: "Codex CLI",
  enginePi: "Pi CLI",
  showInComposerLabel: "Show the engine selector in the chat page",
  unavailable: "Loop engine settings are unavailable",
  switchNotice: "Switching engines interrupts sessions currently running on the previous engine.",
  saving: "Saving\u2026",
  confirmTitle: "Switch loop engine?",
  confirmBody: "Switching interrupts sessions currently running on the previous engine; the page reloads after the switch and new turns use the new engine. Switch now?",
  confirmAction: "Switch",
  cancelAction: "Cancel",
  claudeModelNotice: "Claude Code engine active: the actual model is decided natively by Claude Code; the model selector in this session has no effect."
};

// src/namespace.ts
var LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL = "agent-loop-engine";

// src/client/index.ts
var NS = "settings.loop-engine";
var inject = ["slots", "locale", "settingsScope"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "loop-engine: copy dictionaries");
  const scope = ctx.settingsScope.bind({
    namespace: LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL,
    decode: decodeLoopEngine
  });
  const controller = new LoopEngineStore(scope);
  ctx.effect(() => {
    controller.load();
    return () => {
      controller.dispose();
    };
  }, "loop-engine: store lifecycle");
  const t = ctx.locale.bind(NS);
  const injected = () => ({
    controller,
    hooks: { snapshot: controller.store },
    t
  });
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "loop-engine",
    order: 30,
    label: () => t("nav"),
    inject: injected
  }, LoopEngineSection));
  ctx.inject(["slots", "conversation"], (scope2) => {
    const badgeInjected = () => ({
      hooks: { snapshot: controller.store },
      t
    });
    scope2.effect(() => {
      return scope2.slots.register({
        name: "conversation.session.header.actions",
        id: "loop-engine",
        // Static session context precedes interactive actions (agent-preset's
        // label sits at -10, so the engine chip leads the header).
        order: -20,
        locale: NS,
        inject: badgeInjected
      }, LoopEngineBadge);
    }, "loop-engine: session header engine badge");
  });
  ctx.inject(["slots", "conversation"], (scope2) => {
    const composerInjected = () => ({
      controller,
      hooks: { snapshot: controller.store },
      t
    });
    scope2.effect(() => {
      return scope2.slots.register({
        name: "conversation.input.right",
        id: "loop-engine",
        order: 0,
        locale: NS,
        inject: composerInjected
      }, LoopEngineComposerSelect);
    }, "loop-engine: composer engine select");
  });
}
return module.exports; } });
//# sourceMappingURL=client.js.map
