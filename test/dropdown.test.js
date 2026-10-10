/**
 * Dropdown component tests.
 *
 * The panel's dropdown replaced a native `<select>`, whose popup list is drawn by Chromium/OS and
 * cannot be themed. A hand-written control is only an improvement if it keeps the behaviour users
 * already had, so these tests drive the real component through a minimal React-shaped runtime and
 * assert the interaction contract: open, choose, keyboard navigation, Escape, disabled state, and
 * focus return.
 *
 * What is deliberately NOT tested: the CSS. No DOM or layout engine is available in this deployment
 * (no jsdom, no React), so appearance is checked only as "which tokens are referenced" in the
 * separate stylesheet test — the part that would otherwise silently break.
 */

import assert from "node:assert/strict";
import "./setup.js";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A minimal React-shaped runtime: real hook storage, real re-render on state change, and effects
 * that run after the render that requested them.
 *
 * It exists because this deployment has no React to install and the component's logic is worth
 * driving for real. Only the four APIs the component uses are implemented.
 *
 * @returns the runtime.
 */
function createRuntime() {
  let current = undefined;
  let queue = [];
  /** The element most recently focused through the runner, so tests can assert focus return. */
  let focused = undefined;

  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
    },
    useState(initial) {
      // Capture the owning instance in the closure: a state setter runs from an event handler,
      // which fires long after the render that created it has returned, so it cannot read a
      // render-time `current`. Rebinding it to the instance keeps `setState` working then.
      const instance = current;
      const hook = instance.hooks[instance.index] ?? (instance.hooks[instance.index] = {});
      instance.index += 1;
      if (!("value" in hook)) hook.value = typeof initial === "function" ? initial() : initial;
      const setState = (next) => {
        const value = typeof next === "function" ? next(hook.value) : next;
        if (Object.is(value, hook.value)) return;
        hook.value = value;
        instance.render();
      };
      return [hook.value, setState];
    },
    useRef(initial) {
      const instance = current;
      const hook = instance.hooks[instance.index] ?? (instance.hooks[instance.index] = { ref: { current: initial } });
      instance.index += 1;
      return hook.ref;
    },
    useEffect(effect, deps) {
      const instance = current;
      const hook = instance.hooks[instance.index] ?? (instance.hooks[instance.index] = {});
      instance.index += 1;
      const previous = hook.deps;
      const changed = previous === undefined
        || deps === undefined
        || deps.length !== previous.length
        || deps.some((value, index) => !Object.is(value, previous[index]));
      if (changed) {
        hook.deps = deps;
        queue.push({ hook, effect });
      }
    },
    // The panel memoizes its reload callback, and that memoization is load-bearing: `useEffect`
    // depends on the callback's identity, so returning a fresh function each render would re-issue
    // the request on every render — and because this runner flushes effects synchronously, that is an
    // unbounded recursion rather than a slow loop. React returns the same function while the deps are
    // unchanged; so does this.
    useCallback(fn, deps) {
      const instance = current;
      const hook = instance.hooks[instance.index] ?? (instance.hooks[instance.index] = {});
      instance.index += 1;
      const previous = hook.deps;
      const changed = previous === undefined
        || deps === undefined
        || deps.length !== previous.length
        || deps.some((value, index) => !Object.is(value, previous[index]));
      if (changed) {
        hook.deps = deps;
        hook.value = fn;
      }
      return hook.value;
    },
  };

  return {
    React,
    /**
     * Mount a component.
     * @param Component - the component function.
     * @param props - props to pass.
     * @returns a handle exposing the current tree plus a re-render.
     */
    mount(Component, props) {
      const instance = {
        hooks: [],
        index: 0,
        tree: undefined,
        render() {
          instance.index = 0;
          queue = [];
          const previous = current;
          current = instance;
          try {
            instance.tree = Component(props);
          } finally {
            current = previous;
          }
          // A real reconciler assigns refs to the mounted element; the runner mirrors that, or the
          // component's `rootRef.current` would stay null and its outside-press check would never
          // see a container.
          attachRefs(instance.tree);
          const pending = queue;
          queue = [];
          for (const item of pending) {
            item.hook.cleanup?.();
            const cleanup = item.effect();
            item.hook.cleanup = typeof cleanup === "function" ? cleanup : undefined;
          }
          return instance.tree;
        },
      };
      instance.render();
      return instance;
    },
    /** The element the component last focused, for asserting focus return. */
    focused: () => focused,
  };

  /**
   * Assign every `props.ref` in a tree to the element carrying it, and give each element the two
   * DOM methods the component calls: `focus()` on the trigger and `contains()` on the container.
   * A real DOM provides both; the runner has to, or the component's correct calls would throw here.
   *
   * @param node - subtree root.
   * @param parent - the containing element, for `contains`.
   */
  function attachRefs(node, parent = undefined) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (typeof node.focus !== "function") node.focus = () => { focused = node; };
    if (typeof node.contains !== "function") {
      node.contains = (candidate) => candidate === node || descendantOf(node, candidate);
    }
    node.ownerDocument = { activeElement: undefined };
    const ref = node.props?.ref;
    if (ref !== null && typeof ref === "object") ref.current = node;
    const children = Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children];
    for (const child of children) attachRefs(child, node);
  }

  /** Whether `candidate` sits anywhere under `root` in the tree the runner produced. */
  function descendantOf(root, candidate) {
    const children = Array.isArray(root.props?.children) ? root.props.children.flat(Infinity) : [root.props?.children];
    for (const child of children) {
      if (child === candidate) return true;
      if (child !== null && typeof child === "object" && descendantOf(child, candidate)) return true;
    }
    return false;
  }
}

/**
 * Load the client bundle and return its exports, with the runtime injected as `react`.
 * @param React - the runtime to expose as the `react` module.
 * @returns the bundle's export object.
 */
async function loadClient(React) {
  const source = await readFile(join(here, "..", "client.js"), "utf8");
  let registration;
  const listeners = [];
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
    head: { appendChild() {} },
    addEventListener: (type, handler) => listeners.push({ type, handler, capture: true }),
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex((item) => item.type === type && item.handler === handler);
      if (index !== -1) listeners.splice(index, 1);
    },
  };
  const windowStub = {
    location: { origin: "http://127.0.0.1" },
    __ModuleLoader__: { load(entry) { registration = entry; } },
  };

  new Function("window", "document", source)(windowStub, documentStub);
  assert.ok(registration, "the bundle must register with the module loader");
  assert.equal(registration.id, "dsh-task-memory");

  return {
    exports: registration.factory((name) => {
      if (name === "react") return React;
      throw new Error(`unexpected require('${name}')`);
    }),
    listeners,
  };
}

/** Flatten children into an array, dropping empty slots. */
function kids(children) {
  const flat = Array.isArray(children) ? children.flat(Infinity) : [children];
  return flat.filter((child) => child !== null && child !== undefined && child !== false && child !== "");
}

/** Find the first node matching a predicate. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of kids(node.props?.children)) {
    const hit = find(child, predicate);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Find every node matching a predicate. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  for (const child of kids(node.props?.children)) findAll(child, predicate, found);
  return found;
}

const byTag = (tag) => (node) => node?.type === tag;
const byClass = (name) => (node) => typeof node?.props?.className === "string"
  && node.props.className.split(/\s+/).includes(name);

/** Text content of a subtree, for asserting what a user would read. */
function textOf(node) {
  if (typeof node === "string") return node;
  if (node === null || node === undefined || typeof node !== "object") return "";
  return kids(node.props?.children).map(textOf).join("");
}

const OPTIONS = [
  { value: "a", label: "甲" },
  { value: "b", label: "乙" },
  { value: "c", label: "丙" },
];

/**
 * Mount the dropdown.
 * @param value - current value.
 * @param options - option list.
 * @param extra - extra props.
 * @returns the runtime instance, the exported component, and a call recorder.
 */
async function setup(value, options = OPTIONS, extra = {}) {
  const runtime = createRuntime();
  const { exports } = await loadClient(runtime.React);
  const calls = [];
  const instance = runtime.mount(exports.Dropdown, {
    value,
    options,
    onChange: (next) => calls.push(next),
    ...extra,
  });
  const click = (node) => {
    assert.ok(node, "the node to click must exist");
    node.props.onClick?.({ preventDefault() {}, stopPropagation() {} });
    instance.render();
  };
  const press = (node, key) => {
    assert.ok(node, "the node to type into must exist");
    node.props.onKeyDown?.({ key, preventDefault() {}, stopPropagation() {} });
    instance.render();
  };
  return { instance, runtime, calls, click, press, tree: () => instance.tree };
}

test("the bundle exposes the dropdown and registers both slots", async () => {
  const runtime = createRuntime();
  const { exports } = await loadClient(runtime.React);
  assert.equal(typeof exports.Dropdown, "function");

  const registered = [];
  const context = {
    effect: (factory) => factory(),
    slots: {
      inject: (name, register) => register(),
      register: (options, Component) => { registered.push({ options, Component }); },
    },
  };
  exports.apply(context);
  assert.deepEqual(registered.map((entry) => entry.options.name),
    ["sidebar.panellist", "main", "settings.section"]);
  // The sidebar entry and the page must share one key, or the layout cannot pair them.
  assert.equal(registered[0].options.id, registered[1].options.key);
  // The settings section carries its own id and a label the settings list can render.
  assert.equal(registered[2].options.id, "task-memory");
  assert.equal(typeof registered[2].options.label, "function");
  assert.match(registered[2].options.label(), /记忆/);
  assert.equal(typeof exports.SettingsSection, "function");
});

test("renders a real button trigger and starts closed", async () => {
  const { tree } = await setup("b");
  const trigger = find(tree(), byTag("button"));
  assert.ok(trigger, "the trigger is a button, not a div");
  assert.equal(trigger.props["aria-haspopup"], "listbox");
  assert.equal(trigger.props["aria-expanded"], false);
  assert.equal(find(tree(), byClass("tm-dd-menu")), undefined, "the list must start closed");
  assert.match(textOf(trigger), /乙/, "the trigger shows the current label");
});

test("clicking the trigger opens the list and marks the selected option", async () => {
  const { click, tree } = await setup("b");
  click(find(tree(), byClass("tm-dd-trigger")));

  assert.equal(find(tree(), byClass("tm-dd-trigger")).props["aria-expanded"], true);
  const menu = find(tree(), byClass("tm-dd-menu"));
  assert.ok(menu, "clicking opens the list");
  assert.equal(menu.props.role, "listbox");

  const options = findAll(tree(), byClass("tm-dd-item"));
  assert.equal(options.length, 3);
  const selected = options.filter((option) => option.props["aria-selected"] === true);
  assert.equal(selected.length, 1);
  assert.match(textOf(selected[0]), /乙/);
  assert.equal(findAll(tree(), byClass("tm-dd-item-active")).length, 1, "one row carries the cursor");
});

test("choosing an option reports it once, closes the list, and returns focus to the trigger", async () => {
  const { click, calls, tree, runtime } = await setup("a");
  const trigger = find(tree(), byClass("tm-dd-trigger"));
  click(trigger);
  click(findAll(tree(), byClass("tm-dd-item"))[1]);

  assert.deepEqual(calls, ["b"], "the new value is reported exactly once");
  assert.equal(find(tree(), byClass("tm-dd-menu")), undefined, "the list closes after choosing");
  // The element focused is the one the ref held when choosing, which is the tree node the runner
  // produced; comparing identity against a later render would compare across a re-render.
  assert.equal(runtime.focused()?.props?.className?.includes("tm-dd-trigger"), true,
    "focus returns to the trigger, so keyboard use continues from where it was");
});

test("re-choosing the current value does not fire onChange', ", async () => {
  const { click, calls, tree } = await setup("a");
  click(find(tree(), byClass("tm-dd-trigger")));
  click(findAll(tree(), byClass("tm-dd-item"))[0]);

  assert.deepEqual(calls, [], "selecting the value already in effect must not re-report it");
  assert.equal(find(tree(), byClass("tm-dd-menu")), undefined);
});

test("a click outside closes the list, and a click inside does not", async () => {
  const runtime = createRuntime();
  const { exports, listeners } = await loadClient(runtime.React);
  const instance = runtime.mount(exports.Dropdown, { value: "a", options: OPTIONS, onChange: () => {} });

  const trigger = () => find(instance.tree, byClass("tm-dd-trigger"));
  const open = () => {
    trigger().props.onClick?.({ preventDefault() {} });
    instance.render();
  };

  open();
  assert.ok(find(instance.tree, byClass("tm-dd-menu")), "the list is open");

  const outside = listeners.find((item) => item.type === "pointerdown");
  assert.ok(outside, "an outside-press listener must be attached while open");
  assert.equal(outside.capture, true, "the listener runs in the capture phase");

  // A press inside the component keeps the list open: the component asks its container element
  // whether it contains the event target, and the runner's elements answer that from the real tree.
  const insideNode = find(instance.tree, byClass("tm-dd-item"));
  assert.ok(insideNode, "an option element to press");
  outside.handler({ target: insideNode });
  instance.render();
  assert.ok(find(instance.tree, byClass("tm-dd-menu")), "pressing inside must not close the list");

  // A press on something outside the component closes it.
  outside.handler({ target: { outside: true } });
  instance.render();
  assert.equal(find(instance.tree, byClass("tm-dd-menu")), undefined, "pressing outside closes the list");
});

test("keyboard: arrows open and move, Enter chooses", async () => {
  const { press, calls, tree } = await setup("a");
  const trigger = () => find(tree(), byClass("tm-dd-trigger"));

  press(trigger(), "ArrowDown");
  assert.ok(find(tree(), byClass("tm-dd-menu")), "ArrowDown opens the list");

  // The cursor seeds on the current value ('a'); two steps down lands on 'c'.
  press(trigger(), "ArrowDown");
  press(trigger(), "ArrowDown");
  const active = findAll(tree(), byClass("tm-dd-item-active"));
  assert.equal(active.length, 1);
  assert.match(textOf(active[0]), /丙/);

  press(trigger(), "Enter");
  assert.deepEqual(calls, ["c"]);
  assert.equal(find(tree(), byClass("tm-dd-menu")), undefined);
});

test("keyboard: arrows wrap at both ends", async () => {
  const { press, tree } = await setup("a");
  const trigger = () => find(tree(), byClass("tm-dd-trigger"));
  press(trigger(), "ArrowDown");

  press(trigger(), "ArrowUp"); // a -> wraps to c
  assert.match(textOf(find(tree(), byClass("tm-dd-item-active"))), /丙/);

  press(trigger(), "ArrowDown"); // c -> wraps back to a
  assert.match(textOf(find(tree(), byClass("tm-dd-item-active"))), /甲/);
});

test("keyboard: Escape closes without choosing", async () => {
  const { click, press, calls, tree } = await setup("a");
  click(find(tree(), byClass("tm-dd-trigger")));
  press(find(tree(), byClass("tm-dd-trigger")), "Escape");

  assert.equal(find(tree(), byClass("tm-dd-menu")), undefined, "Escape closes the list");
  assert.deepEqual(calls, [], "Escape must not change the value");
});

test("a disabled trigger cannot open the list", async () => {
  const { click, tree } = await setup("", [], { disabled: true });
  const trigger = find(tree(), byClass("tm-dd-trigger"));
  assert.equal(trigger.props.disabled, true);
  click(trigger);
  assert.equal(find(tree(), byClass("tm-dd-menu")), undefined);
});

test("an empty option list says so instead of showing an empty popup", async () => {
  const { click, tree } = await setup("", []);
  click(find(tree(), byClass("tm-dd-trigger")));
  assert.match(textOf(find(tree(), byClass("tm-dd-menu"))), /没有可选项/);
});

/**
 * Mount the real panel against a stubbed panel API.
 *
 * The mode switch lives in the browser: choosing a tier has to move the date pickers onto that
 * tier's window. Asserting the host's payload alone cannot see that wiring, so the component itself
 * is driven here — the same reason `Dropdown` is driven rather than grepped.
 *
 * @param payload - what `/api/task-memory/cards` answers with.
 * @returns the mounted instance, the runtime, and a reader for the requests the panel made.
 */
async function mountPanel(payload) {
  const runtime = createRuntime();
  const { exports } = await loadClient(runtime.React);
  const requested = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    requested.push(target);
    const body = target.includes("/workspaces")
      ? { ok: true, workspaces: [{ id: "1", path: "D:\\AI", title: "测试", cards: 1 }] }
      : { ok: true, ...payload };
    return {
      ok: true,
      status: 200,
      async json() { return body; },
    };
  };
  const instance = runtime.mount(exports.Panel, {});
  // The panel loads its workspace list in an effect; let those promises settle, then re-render so the
  // list request (and its modeRanges) is issued.
  await settle(instance);
  return { instance, runtime, requested };
}

/** Let queued microtasks run, then re-render until no new effect fires. */
async function settle(instance) {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    instance.render();
  }
}

/** The currently rendered date inputs, as `{from, to}` values. */
function dates(tree) {
  const inputs = findAll(tree, (node) => node?.props?.type === "date");
  return { from: inputs[0]?.props?.value, to: inputs[1]?.props?.value };
}

/**
 * The mode dropdown element, found by the label the panel gives it.
 *
 * The runner does not expand function components, so a `Dropdown` element is still an element here
 * with its props intact — and `onChange` is exactly the glue under test: "when the control reports a
 * new mode, do the date pickers follow?". That the control calls `onChange` on a real choice is
 * covered by the dropdown tests above.
 *
 * @param tree - the rendered tree.
 * @returns the element's props.
 */
function modeProps(tree) {
  const element = findAll(tree, (node) => node?.props?.ariaLabel === "档位筛选")[0];
  assert.ok(element, "the panel must render a 档位筛选 dropdown");
  return element.props;
}

/** The workspace dropdown's props, to prove the two controls stay independent. */
function workspaceProps(tree) {
  const element = findAll(tree, (node) => node?.props?.ariaLabel === "选择工作区")[0];
  assert.ok(element, "the panel must render a workspace dropdown");
  return element.props;
}

test("switching the filter mode moves the date range onto that tier's window", async () => {
  // The windows the host computes. The panel must apply them verbatim rather than re-deriving them.
  const modeRanges = {
    default: { from: "2026-10-03", to: "2026-10-10" },
    all: { from: "", to: "" },
    recent: { from: "2026-10-03", to: "2026-10-10" },
    past: { from: "2026-09-10", to: "2026-10-02" },
    old: { from: "2026-07-12", to: "2026-09-09" },
    ancient: { from: "2025-10-10", to: "2026-07-11" },
    forgotten: { from: "", to: "2025-10-09" },
  };
  const { instance, requested } = await mountPanel({
    cards: [], total: 0, shown: 0, days: [],
    defaultTiers: ["recent"], dateBounds: { from: "", to: "" }, modeRanges,
  });

  assert.deepEqual(dates(instance.tree), { from: "2026-10-03", to: "2026-10-10" },
    "the opening view shows the default tier's window, not the whole span");

  // The whole point of the feature: 仅之前 must move the pickers onto that tier, not leave them
  // spanning everything, or the two filters contradict each other and the list comes back empty.
  modeProps(instance.tree).onChange("past");
  instance.render();
  assert.deepEqual(dates(instance.tree), { from: "2026-09-10", to: "2026-10-02" },
    "切换档位必须把日期移到该档位的窗口");

  // And the request the panel then issues carries both, so host and browser agree on the slice.
  await settle(instance);
  const last = requested.at(-1);
  assert.match(last, /tiers=past/);
  assert.match(last, /from=2026-09-10/);
  assert.match(last, /to=2026-10-02/);
});

test("全时段 clears the date restriction instead of pinning the observed span", async () => {
  const modeRanges = {
    default: { from: "2026-10-03", to: "2026-10-10" },
    all: { from: "", to: "" },
    recent: { from: "2026-10-03", to: "2026-10-10" },
    past: { from: "2026-09-10", to: "2026-10-02" },
    old: { from: "2026-07-12", to: "2026-09-09" },
    ancient: { from: "2025-10-10", to: "2026-07-11" },
    forgotten: { from: "", to: "2025-10-09" },
  };
  const { instance } = await mountPanel({
    cards: [], total: 0, shown: 0, days: [],
    defaultTiers: ["recent"], dateBounds: { from: "2026-10-09", to: "2026-10-10" }, modeRanges,
  });

  const button = findAll(instance.tree, (node) => node?.type === "button")
    .find((node) => textOf(node) === "全时段");
  assert.ok(button, "there must be a 全时段 control");
  button.props.onClick?.({ preventDefault() {} });
  instance.render();

  // A card with no usable date is dropped by any range, so "everything" must mean no range at all.
  assert.deepEqual(dates(instance.tree), { from: "", to: "" });
});

test("a mode with no window from the host leaves the range alone", async () => {
  // Defensive: an older host that does not send `modeRanges` must not produce empty pickers, and it
  // must not fall back to pinning the observed span either — any range drops a card whose date is
  // unknown, so the safe fallback is no restriction at all.
  const { instance } = await mountPanel({
    cards: [], total: 0, shown: 0, days: [],
    defaultTiers: ["recent"], dateBounds: { from: "2026-10-09", to: "2026-10-10" },
  });
  const before = dates(instance.tree);
  assert.deepEqual(before, { from: "", to: "" }, "no windows means no restriction, not the span");

  modeProps(instance.tree).onChange("past");
  instance.render();

  assert.deepEqual(dates(instance.tree), before, "没有窗口可套用时保持原样，而不是清空或猜测日期");
});

test("an empty result from a filter does not claim the workspace has no cards", async () => {
  // Switching to a tier that holds nothing is now a normal thing to do, and the old empty state told
  // the user their memory was empty while the workspace held 14 cards.
  const { instance } = await mountPanel({
    cards: [], total: 14, shown: 0, days: [],
    defaultTiers: ["recent"], dateBounds: { from: "2026-10-09", to: "2026-10-10" },
    modeRanges: { default: { from: "2026-09-01", to: "2026-09-01" } },
  });
  const empty = findAll(instance.tree, byClass("tm-empty")).map(textOf).join(" ");
  assert.match(empty, /当前筛选下没有卡片/, "must say the filter matched nothing");
  assert.match(empty, /共有 14 张卡/, "and must reassure that the cards still exist");
  assert.doesNotMatch(empty, /还没有任务记忆卡/, "must not claim the workspace is empty");
});

test("a genuinely empty workspace still says so", async () => {
  const { instance } = await mountPanel({
    cards: [], total: 0, shown: 0, days: [],
    defaultTiers: ["recent"], dateBounds: { from: "", to: "" },
    modeRanges: { default: { from: "", to: "" } },
  });
  const empty = findAll(instance.tree, byClass("tm-empty")).map(textOf).join(" ");
  assert.match(empty, /还没有任务记忆卡/);
  assert.match(empty, /会被自动记录/, "a new user needs to know how cards appear");
});

test("switching the filter mode does not touch the workspace selection", async () => {
  // Both are dropdowns in the same toolbar; a mode change must not be wired to the workspace state.
  const { instance } = await mountPanel({
    cards: [], total: 0, shown: 0, days: [],
    defaultTiers: ["recent"], dateBounds: { from: "", to: "" },
    modeRanges: { default: { from: "", to: "" }, all: { from: "", to: "" }, past: { from: "2026-09-10", to: "2026-10-02" } },
  });
  assert.equal(workspaceProps(instance.tree).value, "D:\\AI", "one workspace is selected");
  modeProps(instance.tree).onChange("past");
  instance.render();
  assert.equal(workspaceProps(instance.tree).value, "D:\\AI", "the workspace is unchanged");
});

test("the popup uses the host menu tokens and no literal colours", async () => {
  const source = await readFile(join(here, "..", "client.js"), "utf8");
  const css = /const CSS = `([\s\S]*?)`;/.exec(source)?.[1];
  assert.ok(css, "the stylesheet must be present");

  // The popup surface is exactly what made the native control stand out, so it must copy the
  // host's own menu recipe rather than approximate it.
  const menu = /\.tm-dd-menu\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(menu, /background:var\(--dsw-menu-surface-fill\)/, "host menu fill token");
  assert.match(menu, /backdrop-filter:var\(--dsw-menu-backdrop-filter\)/, "host blur token");
  assert.match(menu, /box-shadow:var\(--dsw-elevation-prominent\)/, "host elevation token");

  // The menu surface is translucent; without blur support it must fall back to an opaque surface.
  assert.match(css, /@supports not \(\(backdrop-filter/, "a no-blur fallback must exist");
  assert.match(css, /--dsw-alias-bg-layer-1/, "the fallback surface comes from a token");

  // No literal colours anywhere, or the panel stops following light/dark switching.
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, "no hard-coded hex colour");
  assert.equal(/\brgba?\(/.test(css), false, "no hard-coded rgb colour");

  // The control it replaced must be gone.
  assert.equal(/h\('select'|h\('option'/.test(source), false, "no native select may remain");
  assert.equal(/\.tm-select\b/.test(css), false, "the native-select style must be gone");
});
