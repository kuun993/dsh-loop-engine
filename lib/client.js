var module = { exports: {} }; var exports = module.exports; window.__ModuleLoader__.load({ id: "@vidge/dsh-loop-engine", factory: (require) => {
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

// ../deepseek-harness/node_modules/.pnpm/zustand@4.4.7_@types+react@18.3.31_immer@10.2.0_react@18.3.1/node_modules/zustand/esm/vanilla.mjs
var import_meta = {};
var createStoreImpl = (createState) => {
  let state;
  const listeners = /* @__PURE__ */ new Set();
  const setState = (partial, replace) => {
    const nextState = typeof partial === "function" ? partial(state) : partial;
    if (!Object.is(nextState, state)) {
      const previousState = state;
      state = (replace != null ? replace : typeof nextState !== "object" || nextState === null) ? nextState : Object.assign({}, state, nextState);
      listeners.forEach((listener) => listener(state, previousState));
    }
  };
  const getState = () => state;
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const destroy = () => {
    if ((import_meta.env ? import_meta.env.MODE : void 0) !== "production") {
      console.warn(
        "[DEPRECATED] The `destroy` method will be unsupported in a future version. Instead use unsubscribe function returned by subscribe. Everything will be garbage-collected if store is garbage-collected."
      );
    }
    listeners.clear();
  };
  const api = { setState, getState, subscribe, destroy };
  state = createState(setState, getState, api);
  return api;
};
var createStore = (createState) => createState ? createStoreImpl(createState) : createStoreImpl;

// ../deepseek-harness/node_modules/.pnpm/zustand@4.4.7_@types+react@18.3.31_immer@10.2.0_react@18.3.1/node_modules/zustand/esm/middleware.mjs
var subscribeWithSelectorImpl = (fn) => (set2, get, api) => {
  const origSubscribe = api.subscribe;
  api.subscribe = (selector, optListener, options) => {
    let listener = selector;
    if (optListener) {
      const equalityFn = (options == null ? void 0 : options.equalityFn) || Object.is;
      let currentSlice = selector(api.getState());
      listener = (state) => {
        const nextSlice = selector(state);
        if (!equalityFn(currentSlice, nextSlice)) {
          const previousSlice = currentSlice;
          optListener(currentSlice = nextSlice, previousSlice);
        }
      };
      if (options == null ? void 0 : options.fireImmediately) {
        optListener(currentSlice, currentSlice);
      }
    }
    return origSubscribe(listener);
  };
  const initialState = fn(set2, get, api);
  return initialState;
};
var subscribeWithSelector = subscribeWithSelectorImpl;

// ../deepseek-harness/node_modules/.pnpm/immer@10.2.0/node_modules/immer/dist/immer.mjs
var NOTHING = /* @__PURE__ */ Symbol.for("immer-nothing");
var DRAFTABLE = /* @__PURE__ */ Symbol.for("immer-draftable");
var DRAFT_STATE = /* @__PURE__ */ Symbol.for("immer-state");
var errors = true ? [
  // All error codes, starting by 0:
  function(plugin) {
    return `The plugin for '${plugin}' has not been loaded into Immer. To enable the plugin, import and call \`enable${plugin}()\` when initializing your application.`;
  },
  function(thing) {
    return `produce can only be called on things that are draftable: plain objects, arrays, Map, Set or classes that are marked with '[immerable]: true'. Got '${thing}'`;
  },
  "This object has been frozen and should not be mutated",
  function(data) {
    return "Cannot use a proxy that has been revoked. Did you pass an object from inside an immer function to an async process? " + data;
  },
  "An immer producer returned a new value *and* modified its draft. Either return a new value *or* modify the draft.",
  "Immer forbids circular references",
  "The first or second argument to `produce` must be a function",
  "The third argument to `produce` must be a function or undefined",
  "First argument to `createDraft` must be a plain object, an array, or an immerable object",
  "First argument to `finishDraft` must be a draft returned by `createDraft`",
  function(thing) {
    return `'current' expects a draft, got: ${thing}`;
  },
  "Object.defineProperty() cannot be used on an Immer draft",
  "Object.setPrototypeOf() cannot be used on an Immer draft",
  "Immer only supports deleting array indices",
  "Immer only supports setting array indices and the 'length' property",
  function(thing) {
    return `'original' expects a draft, got: ${thing}`;
  }
  // Note: if more errors are added, the errorOffset in Patches.ts should be increased
  // See Patches.ts for additional errors
] : [];
function die(error2, ...args) {
  if (true) {
    const e = errors[error2];
    const msg = typeof e === "function" ? e.apply(null, args) : e;
    throw new Error(`[Immer] ${msg}`);
  }
  throw new Error(
    `[Immer] minified error nr: ${error2}. Full error at: https://bit.ly/3cXEKWf`
  );
}
var getPrototypeOf = Object.getPrototypeOf;
function isDraft(value) {
  return !!value && !!value[DRAFT_STATE];
}
function isDraftable(value) {
  if (!value)
    return false;
  return isPlainObject(value) || Array.isArray(value) || !!value[DRAFTABLE] || !!value.constructor?.[DRAFTABLE] || isMap(value) || isSet(value);
}
var objectCtorString = Object.prototype.constructor.toString();
var cachedCtorStrings = /* @__PURE__ */ new WeakMap();
function isPlainObject(value) {
  if (!value || typeof value !== "object")
    return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype)
    return true;
  const Ctor = Object.hasOwnProperty.call(proto, "constructor") && proto.constructor;
  if (Ctor === Object)
    return true;
  if (typeof Ctor !== "function")
    return false;
  let ctorString = cachedCtorStrings.get(Ctor);
  if (ctorString === void 0) {
    ctorString = Function.toString.call(Ctor);
    cachedCtorStrings.set(Ctor, ctorString);
  }
  return ctorString === objectCtorString;
}
function each(obj, iter, strict = true) {
  if (getArchtype(obj) === 0) {
    const keys = strict ? Reflect.ownKeys(obj) : Object.keys(obj);
    keys.forEach((key) => {
      iter(key, obj[key], obj);
    });
  } else {
    obj.forEach((entry, index) => iter(index, entry, obj));
  }
}
function getArchtype(thing) {
  const state = thing[DRAFT_STATE];
  return state ? state.type_ : Array.isArray(thing) ? 1 : isMap(thing) ? 2 : isSet(thing) ? 3 : 0;
}
function has(thing, prop) {
  return getArchtype(thing) === 2 ? thing.has(prop) : Object.prototype.hasOwnProperty.call(thing, prop);
}
function set(thing, propOrOldValue, value) {
  const t = getArchtype(thing);
  if (t === 2)
    thing.set(propOrOldValue, value);
  else if (t === 3) {
    thing.add(value);
  } else
    thing[propOrOldValue] = value;
}
function is(x, y) {
  if (x === y) {
    return x !== 0 || 1 / x === 1 / y;
  } else {
    return x !== x && y !== y;
  }
}
function isMap(target) {
  return target instanceof Map;
}
function isSet(target) {
  return target instanceof Set;
}
function latest(state) {
  return state.copy_ || state.base_;
}
function shallowCopy(base, strict) {
  if (isMap(base)) {
    return new Map(base);
  }
  if (isSet(base)) {
    return new Set(base);
  }
  if (Array.isArray(base))
    return Array.prototype.slice.call(base);
  const isPlain = isPlainObject(base);
  if (strict === true || strict === "class_only" && !isPlain) {
    const descriptors = Object.getOwnPropertyDescriptors(base);
    delete descriptors[DRAFT_STATE];
    let keys = Reflect.ownKeys(descriptors);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const desc = descriptors[key];
      if (desc.writable === false) {
        desc.writable = true;
        desc.configurable = true;
      }
      if (desc.get || desc.set)
        descriptors[key] = {
          configurable: true,
          writable: true,
          // could live with !!desc.set as well here...
          enumerable: desc.enumerable,
          value: base[key]
        };
    }
    return Object.create(getPrototypeOf(base), descriptors);
  } else {
    const proto = getPrototypeOf(base);
    if (proto !== null && isPlain) {
      return { ...base };
    }
    const obj = Object.create(proto);
    return Object.assign(obj, base);
  }
}
function freeze(obj, deep = false) {
  if (isFrozen(obj) || isDraft(obj) || !isDraftable(obj))
    return obj;
  if (getArchtype(obj) > 1) {
    Object.defineProperties(obj, {
      set: dontMutateMethodOverride,
      add: dontMutateMethodOverride,
      clear: dontMutateMethodOverride,
      delete: dontMutateMethodOverride
    });
  }
  Object.freeze(obj);
  if (deep)
    Object.values(obj).forEach((value) => freeze(value, true));
  return obj;
}
function dontMutateFrozenCollections() {
  die(2);
}
var dontMutateMethodOverride = {
  value: dontMutateFrozenCollections
};
function isFrozen(obj) {
  if (obj === null || typeof obj !== "object")
    return true;
  return Object.isFrozen(obj);
}
var plugins = {};
function getPlugin(pluginKey) {
  const plugin = plugins[pluginKey];
  if (!plugin) {
    die(0, pluginKey);
  }
  return plugin;
}
var currentScope;
function getCurrentScope() {
  return currentScope;
}
function createScope(parent_, immer_) {
  return {
    drafts_: [],
    parent_,
    immer_,
    // Whenever the modified draft contains a draft from another scope, we
    // need to prevent auto-freezing so the unowned draft can be finalized.
    canAutoFreeze_: true,
    unfinalizedDrafts_: 0
  };
}
function usePatchesInScope(scope, patchListener) {
  if (patchListener) {
    getPlugin("Patches");
    scope.patches_ = [];
    scope.inversePatches_ = [];
    scope.patchListener_ = patchListener;
  }
}
function revokeScope(scope) {
  leaveScope(scope);
  scope.drafts_.forEach(revokeDraft);
  scope.drafts_ = null;
}
function leaveScope(scope) {
  if (scope === currentScope) {
    currentScope = scope.parent_;
  }
}
function enterScope(immer2) {
  return currentScope = createScope(currentScope, immer2);
}
function revokeDraft(draft) {
  const state = draft[DRAFT_STATE];
  if (state.type_ === 0 || state.type_ === 1)
    state.revoke_();
  else
    state.revoked_ = true;
}
function processResult(result, scope) {
  scope.unfinalizedDrafts_ = scope.drafts_.length;
  const baseDraft = scope.drafts_[0];
  const isReplaced = result !== void 0 && result !== baseDraft;
  if (isReplaced) {
    if (baseDraft[DRAFT_STATE].modified_) {
      revokeScope(scope);
      die(4);
    }
    if (isDraftable(result)) {
      result = finalize(scope, result);
      if (!scope.parent_)
        maybeFreeze(scope, result);
    }
    if (scope.patches_) {
      getPlugin("Patches").generateReplacementPatches_(
        baseDraft[DRAFT_STATE].base_,
        result,
        scope.patches_,
        scope.inversePatches_
      );
    }
  } else {
    result = finalize(scope, baseDraft, []);
  }
  revokeScope(scope);
  if (scope.patches_) {
    scope.patchListener_(scope.patches_, scope.inversePatches_);
  }
  return result !== NOTHING ? result : void 0;
}
function finalize(rootScope, value, path) {
  if (isFrozen(value))
    return value;
  const useStrictIteration = rootScope.immer_.shouldUseStrictIteration();
  const state = value[DRAFT_STATE];
  if (!state) {
    each(
      value,
      (key, childValue) => finalizeProperty(rootScope, state, value, key, childValue, path),
      useStrictIteration
    );
    return value;
  }
  if (state.scope_ !== rootScope)
    return value;
  if (!state.modified_) {
    maybeFreeze(rootScope, state.base_, true);
    return state.base_;
  }
  if (!state.finalized_) {
    state.finalized_ = true;
    state.scope_.unfinalizedDrafts_--;
    const result = state.copy_;
    let resultEach = result;
    let isSet2 = false;
    if (state.type_ === 3) {
      resultEach = new Set(result);
      result.clear();
      isSet2 = true;
    }
    each(
      resultEach,
      (key, childValue) => finalizeProperty(
        rootScope,
        state,
        result,
        key,
        childValue,
        path,
        isSet2
      ),
      useStrictIteration
    );
    maybeFreeze(rootScope, result, false);
    if (path && rootScope.patches_) {
      getPlugin("Patches").generatePatches_(
        state,
        path,
        rootScope.patches_,
        rootScope.inversePatches_
      );
    }
  }
  return state.copy_;
}
function finalizeProperty(rootScope, parentState, targetObject, prop, childValue, rootPath, targetIsSet) {
  if (childValue == null) {
    return;
  }
  if (typeof childValue !== "object" && !targetIsSet) {
    return;
  }
  const childIsFrozen = isFrozen(childValue);
  if (childIsFrozen && !targetIsSet) {
    return;
  }
  if (childValue === targetObject)
    die(5);
  if (isDraft(childValue)) {
    const path = rootPath && parentState && parentState.type_ !== 3 && // Set objects are atomic since they have no keys.
    !has(parentState.assigned_, prop) ? rootPath.concat(prop) : void 0;
    const res = finalize(rootScope, childValue, path);
    set(targetObject, prop, res);
    if (isDraft(res)) {
      rootScope.canAutoFreeze_ = false;
    } else
      return;
  } else if (targetIsSet) {
    targetObject.add(childValue);
  }
  if (isDraftable(childValue) && !childIsFrozen) {
    if (!rootScope.immer_.autoFreeze_ && rootScope.unfinalizedDrafts_ < 1) {
      return;
    }
    if (parentState && parentState.base_ && parentState.base_[prop] === childValue && childIsFrozen) {
      return;
    }
    finalize(rootScope, childValue);
    if ((!parentState || !parentState.scope_.parent_) && typeof prop !== "symbol" && (isMap(targetObject) ? targetObject.has(prop) : Object.prototype.propertyIsEnumerable.call(targetObject, prop)))
      maybeFreeze(rootScope, childValue);
  }
}
function maybeFreeze(scope, value, deep = false) {
  if (!scope.parent_ && scope.immer_.autoFreeze_ && scope.canAutoFreeze_) {
    freeze(value, deep);
  }
}
function createProxyProxy(base, parent) {
  const isArray = Array.isArray(base);
  const state = {
    type_: isArray ? 1 : 0,
    // Track which produce call this is associated with.
    scope_: parent ? parent.scope_ : getCurrentScope(),
    // True for both shallow and deep changes.
    modified_: false,
    // Used during finalization.
    finalized_: false,
    // Track which properties have been assigned (true) or deleted (false).
    assigned_: {},
    // The parent draft state.
    parent_: parent,
    // The base state.
    base_: base,
    // The base proxy.
    draft_: null,
    // set below
    // The base copy with any updated values.
    copy_: null,
    // Called by the `produce` function.
    revoke_: null,
    isManual_: false
  };
  let target = state;
  let traps = objectTraps;
  if (isArray) {
    target = [state];
    traps = arrayTraps;
  }
  const { revoke, proxy } = Proxy.revocable(target, traps);
  state.draft_ = proxy;
  state.revoke_ = revoke;
  return proxy;
}
var objectTraps = {
  get(state, prop) {
    if (prop === DRAFT_STATE)
      return state;
    const source = latest(state);
    if (!has(source, prop)) {
      return readPropFromProto(state, source, prop);
    }
    const value = source[prop];
    if (state.finalized_ || !isDraftable(value)) {
      return value;
    }
    if (value === peek(state.base_, prop)) {
      prepareCopy(state);
      return state.copy_[prop] = createProxy(value, state);
    }
    return value;
  },
  has(state, prop) {
    return prop in latest(state);
  },
  ownKeys(state) {
    return Reflect.ownKeys(latest(state));
  },
  set(state, prop, value) {
    const desc = getDescriptorFromProto(latest(state), prop);
    if (desc?.set) {
      desc.set.call(state.draft_, value);
      return true;
    }
    if (!state.modified_) {
      const current2 = peek(latest(state), prop);
      const currentState = current2?.[DRAFT_STATE];
      if (currentState && currentState.base_ === value) {
        state.copy_[prop] = value;
        state.assigned_[prop] = false;
        return true;
      }
      if (is(value, current2) && (value !== void 0 || has(state.base_, prop)))
        return true;
      prepareCopy(state);
      markChanged(state);
    }
    if (state.copy_[prop] === value && // special case: handle new props with value 'undefined'
    (value !== void 0 || prop in state.copy_) || // special case: NaN
    Number.isNaN(value) && Number.isNaN(state.copy_[prop]))
      return true;
    state.copy_[prop] = value;
    state.assigned_[prop] = true;
    return true;
  },
  deleteProperty(state, prop) {
    if (peek(state.base_, prop) !== void 0 || prop in state.base_) {
      state.assigned_[prop] = false;
      prepareCopy(state);
      markChanged(state);
    } else {
      delete state.assigned_[prop];
    }
    if (state.copy_) {
      delete state.copy_[prop];
    }
    return true;
  },
  // Note: We never coerce `desc.value` into an Immer draft, because we can't make
  // the same guarantee in ES5 mode.
  getOwnPropertyDescriptor(state, prop) {
    const owner = latest(state);
    const desc = Reflect.getOwnPropertyDescriptor(owner, prop);
    if (!desc)
      return desc;
    return {
      writable: true,
      configurable: state.type_ !== 1 || prop !== "length",
      enumerable: desc.enumerable,
      value: owner[prop]
    };
  },
  defineProperty() {
    die(11);
  },
  getPrototypeOf(state) {
    return getPrototypeOf(state.base_);
  },
  setPrototypeOf() {
    die(12);
  }
};
var arrayTraps = {};
each(objectTraps, (key, fn) => {
  arrayTraps[key] = function() {
    arguments[0] = arguments[0][0];
    return fn.apply(this, arguments);
  };
});
arrayTraps.deleteProperty = function(state, prop) {
  if (isNaN(parseInt(prop)))
    die(13);
  return arrayTraps.set.call(this, state, prop, void 0);
};
arrayTraps.set = function(state, prop, value) {
  if (prop !== "length" && isNaN(parseInt(prop)))
    die(14);
  return objectTraps.set.call(this, state[0], prop, value, state[0]);
};
function peek(draft, prop) {
  const state = draft[DRAFT_STATE];
  const source = state ? latest(state) : draft;
  return source[prop];
}
function readPropFromProto(state, source, prop) {
  const desc = getDescriptorFromProto(source, prop);
  return desc ? `value` in desc ? desc.value : (
    // This is a very special case, if the prop is a getter defined by the
    // prototype, we should invoke it with the draft as context!
    desc.get?.call(state.draft_)
  ) : void 0;
}
function getDescriptorFromProto(source, prop) {
  if (!(prop in source))
    return void 0;
  let proto = getPrototypeOf(source);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc)
      return desc;
    proto = getPrototypeOf(proto);
  }
  return void 0;
}
function markChanged(state) {
  if (!state.modified_) {
    state.modified_ = true;
    if (state.parent_) {
      markChanged(state.parent_);
    }
  }
}
function prepareCopy(state) {
  if (!state.copy_) {
    state.copy_ = shallowCopy(
      state.base_,
      state.scope_.immer_.useStrictShallowCopy_
    );
  }
}
var Immer2 = class {
  constructor(config) {
    this.autoFreeze_ = true;
    this.useStrictShallowCopy_ = false;
    this.useStrictIteration_ = true;
    this.produce = (base, recipe, patchListener) => {
      if (typeof base === "function" && typeof recipe !== "function") {
        const defaultBase = recipe;
        recipe = base;
        const self = this;
        return function curriedProduce(base2 = defaultBase, ...args) {
          return self.produce(base2, (draft) => recipe.call(this, draft, ...args));
        };
      }
      if (typeof recipe !== "function")
        die(6);
      if (patchListener !== void 0 && typeof patchListener !== "function")
        die(7);
      let result;
      if (isDraftable(base)) {
        const scope = enterScope(this);
        const proxy = createProxy(base, void 0);
        let hasError = true;
        try {
          result = recipe(proxy);
          hasError = false;
        } finally {
          if (hasError)
            revokeScope(scope);
          else
            leaveScope(scope);
        }
        usePatchesInScope(scope, patchListener);
        return processResult(result, scope);
      } else if (!base || typeof base !== "object") {
        result = recipe(base);
        if (result === void 0)
          result = base;
        if (result === NOTHING)
          result = void 0;
        if (this.autoFreeze_)
          freeze(result, true);
        if (patchListener) {
          const p = [];
          const ip = [];
          getPlugin("Patches").generateReplacementPatches_(base, result, p, ip);
          patchListener(p, ip);
        }
        return result;
      } else
        die(1, base);
    };
    this.produceWithPatches = (base, recipe) => {
      if (typeof base === "function") {
        return (state, ...args) => this.produceWithPatches(state, (draft) => base(draft, ...args));
      }
      let patches, inversePatches;
      const result = this.produce(base, recipe, (p, ip) => {
        patches = p;
        inversePatches = ip;
      });
      return [result, patches, inversePatches];
    };
    if (typeof config?.autoFreeze === "boolean")
      this.setAutoFreeze(config.autoFreeze);
    if (typeof config?.useStrictShallowCopy === "boolean")
      this.setUseStrictShallowCopy(config.useStrictShallowCopy);
    if (typeof config?.useStrictIteration === "boolean")
      this.setUseStrictIteration(config.useStrictIteration);
  }
  createDraft(base) {
    if (!isDraftable(base))
      die(8);
    if (isDraft(base))
      base = current(base);
    const scope = enterScope(this);
    const proxy = createProxy(base, void 0);
    proxy[DRAFT_STATE].isManual_ = true;
    leaveScope(scope);
    return proxy;
  }
  finishDraft(draft, patchListener) {
    const state = draft && draft[DRAFT_STATE];
    if (!state || !state.isManual_)
      die(9);
    const { scope_: scope } = state;
    usePatchesInScope(scope, patchListener);
    return processResult(void 0, scope);
  }
  /**
   * Pass true to automatically freeze all copies created by Immer.
   *
   * By default, auto-freezing is enabled.
   */
  setAutoFreeze(value) {
    this.autoFreeze_ = value;
  }
  /**
   * Pass true to enable strict shallow copy.
   *
   * By default, immer does not copy the object descriptors such as getter, setter and non-enumrable properties.
   */
  setUseStrictShallowCopy(value) {
    this.useStrictShallowCopy_ = value;
  }
  /**
   * Pass false to use faster iteration that skips non-enumerable properties
   * but still handles symbols for compatibility.
   *
   * By default, strict iteration is enabled (includes all own properties).
   */
  setUseStrictIteration(value) {
    this.useStrictIteration_ = value;
  }
  shouldUseStrictIteration() {
    return this.useStrictIteration_;
  }
  applyPatches(base, patches) {
    let i;
    for (i = patches.length - 1; i >= 0; i--) {
      const patch = patches[i];
      if (patch.path.length === 0 && patch.op === "replace") {
        base = patch.value;
        break;
      }
    }
    if (i > -1) {
      patches = patches.slice(i + 1);
    }
    const applyPatchesImpl = getPlugin("Patches").applyPatches_;
    if (isDraft(base)) {
      return applyPatchesImpl(base, patches);
    }
    return this.produce(
      base,
      (draft) => applyPatchesImpl(draft, patches)
    );
  }
};
function createProxy(value, parent) {
  const draft = isMap(value) ? getPlugin("MapSet").proxyMap_(value, parent) : isSet(value) ? getPlugin("MapSet").proxySet_(value, parent) : createProxyProxy(value, parent);
  const scope = parent ? parent.scope_ : getCurrentScope();
  scope.drafts_.push(draft);
  return draft;
}
function current(value) {
  if (!isDraft(value))
    die(10, value);
  return currentImpl(value);
}
function currentImpl(value) {
  if (!isDraftable(value) || isFrozen(value))
    return value;
  const state = value[DRAFT_STATE];
  let copy;
  let strict = true;
  if (state) {
    if (!state.modified_)
      return state.base_;
    state.finalized_ = true;
    copy = shallowCopy(value, state.scope_.immer_.useStrictShallowCopy_);
    strict = state.scope_.immer_.shouldUseStrictIteration();
  } else {
    copy = shallowCopy(value, true);
  }
  each(
    copy,
    (key, childValue) => {
      set(copy, key, currentImpl(childValue));
    },
    strict
  );
  if (state) {
    state.finalized_ = false;
  }
  return copy;
}
var immer = new Immer2();
var produce = immer.produce;

// ../deepseek-harness/packages/client/store/src/index.ts
function notifySubscribers(listeners, label, ...args) {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch (error2) {
      console.error(`${label} subscriber failed:`, error2);
    }
  }
}
function rafBatch(notify) {
  const schedule = typeof requestAnimationFrame === "function" ? (fn) => {
    requestAnimationFrame(() => {
      fn();
    });
  } : (fn) => {
    queueMicrotask(fn);
  };
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      notify();
    });
  };
}
function createSnapshotStore(init, opts) {
  const withSelector = subscribeWithSelector(() => init);
  const api = createStore()(withSelector);
  if (opts?.persist) attachPersistence(api, opts.persist.name);
  let subscribe = (fn) => api.subscribe(() => {
    notifySubscribers([fn], "[client-store]");
  });
  if (opts?.flush === "raf") {
    const listeners = /* @__PURE__ */ new Set();
    const flush = rafBatch(() => {
      notifySubscribers(listeners, "[client-store]");
    });
    api.subscribe(flush);
    subscribe = (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    };
  }
  return {
    getSnapshot: () => api.getState(),
    subscribe: (fn) => subscribe(fn),
    update: (mutator) => {
      api.setState(produce(api.getState(), (draft) => {
        mutator(draft);
      }), true);
    },
    set: (next) => {
      api.setState(devFreeze(next), true);
    }
  };
}
function attachPersistence(api, name) {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(name);
    if (raw !== null) {
      api.setState(devFreeze(JSON.parse(raw)), true);
    }
  } catch (error2) {
    console.error(`snapshot store '${name}' rehydration failed:`, error2);
  }
  api.subscribe((state) => {
    try {
      localStorage.setItem(name, JSON.stringify(state));
    } catch (error2) {
      console.error(`snapshot store '${name}' persistence failed:`, error2);
    }
  });
}
function devFreeze(value) {
  if (false) return value;
  return freeze(value, true);
}

// src/client/store.ts
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
  store = createSnapshotStore({
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
