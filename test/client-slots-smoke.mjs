// Client slot contract: the bundle is plain JS with no bundler and no JSX, so it
// can be loaded here with a fake window/document and a minimal React shim. What
// this guards is the part no other test can see — that the plugin registers the
// host's sidebar seats with the ids the host expects, lazily, panel before row,
// and that a host without those seats still gets the settings section.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = await readFile(join(root, "client", "client.js"), "utf8");

const PANEL_ID = "skill-mcp-manager";
const failed = [];

function loadBundle() {
  const loaded = [];
  const fakeWindow = {
    __ModuleLoader__: {
      load(module) {
        loaded.push(module);
      },
    },
  };
  const fakeDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild() {} },
  };
  // The factory only runs at load time to build components; hooks are never
  // called until something renders, so the shim only needs createElement.
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const run = new Function("window", "document", code);
  run(fakeWindow, fakeDocument);
  if (loaded.length !== 1) throw new Error("expected exactly one __ModuleLoader__.load call, got " + loaded.length);
  const mod = loaded[0];
  if (typeof mod.factory !== "function") throw new Error("module has no factory");
  return mod.factory((id) => (id === "react" ? react : {}));
}

function makeCtx({ panels = true } = {}) {
  const injected = [];
  const registered = [];
  const disposers = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name);
        if ((name === "main" || name === "sidebar.panellist") && !panels) {
          // A host that does not declare the seat never calls back.
          return () => {};
        }
        const result = callback();
        return typeof result === "function" ? result : () => {};
      },
      register(options, component) {
        registered.push({ options, component, at: registered.length });
        const dispose = () => {
          disposers.push(options.name + ":" + (options.id ?? options.key));
        };
        return dispose;
      },
    },
    effect(fn) {
      fn();
    },
    inject(names, callback) {
      injected.push("service:" + names.join(","));
      callback({ layout: makeLayout() });
    },
  };
  return { ctx, injected, registered, disposers };
}

function makeLayout() {
  const layout = {
    selected: undefined,
    panelInfo: { getSnapshot: () => ({ activePanelId: layout.selected }) },
    selectPanel(id) {
      layout.selected = id;
      layout.selectedCalls = (layout.selectedCalls ?? 0) + 1;
    },
  };
  return layout;
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

// 1) the bundle loads and exposes the plugin shape the host expects.
const plugin = loadBundle();
if (plugin.name !== "dsh-skill-mcp-manager") failed.push("unexpected plugin name: " + plugin.name);
if (!Array.isArray(plugin.inject) || plugin.inject.join(",") !== "slots") failed.push("inject should be ['slots']");

// 2) with the sidebar seats declared: settings section, overlay, main panel, row.
{
  const { ctx, injected, registered, disposers } = makeCtx();
  plugin.apply(ctx);
  const byName = (name) => registered.filter((entry) => entry.options.name === name);
  const settings = byName("settings.section");
  const overlay = byName("shell.overlay");
  const main = byName("main");
  const rows = byName("sidebar.panellist");

  if (settings.length !== 1 || settings[0].options.id !== "capability") failed.push("settings.section/capability missing");
  if (overlay.length !== 1 || overlay[0].options.id !== "capability-legacy-sessions") failed.push("shell.overlay seat missing");
  if (main.length !== 1) failed.push("main panel not registered (got " + main.length + ")");
  if (main[0] !== undefined && main[0].options.key !== PANEL_ID) failed.push("main panel key should be " + PANEL_ID + ", got " + main[0].options.key);
  if (rows.length !== 1) failed.push("sidebar.panellist row not registered (got " + rows.length + ")");
  if (rows[0] !== undefined) {
    const options = rows[0].options;
    if (options.id !== PANEL_ID) failed.push("row id should be " + PANEL_ID + ", got " + options.id);
    if (options.label !== "能力库") failed.push("row label should be 能力库, got " + JSON.stringify(options.label));
    if (typeof options.order !== "number") failed.push("row order must be a number");
  }

  // The two seats are declared by the host, so they must be reached through
  // slots.inject — registering them directly throws on hosts without the seats.
  if (!injected.includes("main")) failed.push("main seat was not injected");
  if (!injected.includes("sidebar.panellist")) failed.push("sidebar.panellist seat was not injected");
  if (!injected.some((name) => name.startsWith("service:layout"))) failed.push("layout service was not injected");

  // Panel before row: a row whose panel is missing would select nothing.
  if (main[0] !== undefined && rows[0] !== undefined && !(main[0].at < rows[0].at)) {
    failed.push("main panel must be registered before the sidebar row");
  }

  // The row renders the icon the sidebar expects (an element taking owner.size).
  if (rows[0] !== undefined) {
    // The row renders an element whose type is the icon component; render it
    // once more to reach the svg it produces.
    const renderIcon = (owner) => {
      const element = rows[0].component(owner);
      if (typeof element?.type !== "function") return undefined;
      return element.type(element.props);
    };
    const icon = renderIcon({ size: 16 });
    if (icon?.type !== "svg") failed.push("sidebar row should render an svg icon, got " + String(icon?.type));
    if (icon?.props.width !== 16) failed.push("icon should honour owner.size (width=" + String(icon?.props.width) + ")");
    const fallback = renderIcon({});
    if (fallback?.props.width !== 16) failed.push("icon should default to 16px");
  }

  // The page renders the shared manager, not a second copy of the UI.
  if (main[0] !== undefined) {
    const element = main[0].component({});
    const page = typeof element?.type === "function" ? element.type(element.props) : element;
    const shells = findAll(page, (node) => node.props?.className === "smx-page");
    if (shells.length !== 1) failed.push("panel should render one .smx-page shell, got " + shells.length);
  }

  // Disposing while the page is open must leave the panel first, then drop the
  // seats — otherwise the host keeps showing an empty main area.
  {
    const active = makeLayout();
    let captured = null;
    const ctx = {
      slots: {
        inject(name, callback) {
          const result = callback();
          const cleanup = typeof result === "function" ? result : () => {};
          if (name === "main") captured = cleanup;
          return cleanup;
        },
        register() {
          return () => {};
        },
      },
      inject(names, callback) {
        callback({ layout: active });
      },
    };
    plugin.apply(ctx);
    active.selected = PANEL_ID;
    if (typeof captured !== "function") failed.push("sidebar seats did not return a disposer");
    else captured();
    if (active.selected !== null) failed.push("dispose should leave the panel (selectPanel(null)), got " + JSON.stringify(active.selected));
  }
}

// 3) a host without the seats: nothing throws, the settings entry survives.
{
  const { ctx, registered } = makeCtx({ panels: false });
  try {
    plugin.apply(ctx);
  } catch (error) {
    failed.push("apply threw on a host without sidebar seats: " + (error?.message ?? error));
  }
  if (!registered.some((entry) => entry.options.name === "settings.section")) {
    failed.push("settings.section must still register on a host without sidebar seats");
  }
  if (registered.some((entry) => entry.options.name === "main" || entry.options.name === "sidebar.panellist")) {
    failed.push("no sidebar seat should be registered when the host does not declare them");
  }
}

if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("CLIENT SLOTS SMOKE FAILED");
  process.exit(1);
}
console.log("CLIENT SLOTS SMOKE PASSED");
