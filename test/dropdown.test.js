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
