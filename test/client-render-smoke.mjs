// Render smoke for the browser bundle: a tiny React stand-in with real state and
// effects, so the panels are actually BUILT (not just parsed).
//
// Why this exists: `groups.map is not a function` shipped once — the skills panel
// mixed a state object up with an array and crashed the whole slot on render, which
// took the page blank. Every other test here stops at "the bundle parsed and
// registered its slots", so nothing caught it. Building the trees does.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const bundle = await readFile(join(process.cwd(), "client", "client.js"), "utf8");

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };

const element = (type, props, children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) });

let hookSlots = [];
let hookIndex = 0;
let rerender = false;
// The panel always opens on MCP; the skills tab is where the page blanked once, so
// the smoke forces it: a component+index key may override the initial state.
let currentComponentKey = "";
// Effects fire on the FIRST pass of each instance only: a re-render must see the
// state its own fetch produced, not restart the fetch (which would re-enter the
// loading branch forever).
let effectsEnabled = false;
const stateOverrides = {};
const React = {
  Fragment: "Fragment",
  createElement(type, props, ...children) { return element(type, props, children); },
  useState(initial) {
    const at = hookIndex++;
    const overrideKey = currentComponentKey + ":" + at;
    if (hookSlots[at] === undefined) {
      hookSlots[at] = { value: Object.prototype.hasOwnProperty.call(stateOverrides, overrideKey)
        ? stateOverrides[overrideKey]
        : (typeof initial === "function" ? initial() : initial) };
    }
    const slot = hookSlots[at];
    return [slot.value, (next) => {
      const value = typeof next === "function" ? next(slot.value) : next;
      if (value !== slot.value) { slot.value = value; rerender = true; }
    }];
  },
  useEffect(fn) { if (effectsEnabled) fn(); },
  useLayoutEffect(fn) { if (effectsEnabled) fn(); },
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useRef(value) { return { current: value }; },
};

const registered = [];
globalThis.window = { __ModuleLoader__: { load(module) { globalThis.__module = module; } } };
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.includes("/session-caps")) {
    return json({
      ok: true, session: "sess-1", live: true,
      mcp: [
        { name: "reqable", source: "registry", owner: "", tier: "on-demand", transport: "stdio", toolCount: 46, enabled: true },
        { name: "sequential", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 1, enabled: false },
        { name: "box-a", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: true },
        { name: "box-b", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: false },
        { name: "box-c", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: true },
        { name: "box-d", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: false },
        { name: "box-e", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: false },
      ],
      skills: [
        { name: "web-search", description: "", provider: "filesystem", readonly: false, enabled: true },
        { name: "agent-notes", description: "", provider: "agent-notes", readonly: true, enabled: false },
      ],
    });
  }
  if (path.includes("/workspace-defaults")) return json({ ok: true, workspace: "/work/demo", mcp: ["reqable"], skills: [] });
  if (path.includes("/skill-groups")) return json({ ok: true, groups: [{ id: "g1", name: "前端", order: 0 }], members: { "web-search": "g1" } });
  if (path.includes("/skills/import")) {
    return json({ ok: true, target: "/tmp/skills", cwd: "", warning: "", sources: [{ id: "user-agents", label: "~/.agents/skills", dir: "/h/.agents/skills", exists: true, skills: [{ name: "pebrel-runtime", dir: "/h/.agents/skills/pebrel-runtime", description: "fixture", blocked: false }] }] });
  }
  if (path.includes("/skills")) {
    return json({
      ok: true,
      workspaces: [{ id: "w1", title: "demo", path: "/work/demo" }],
      skills: [
        { name: "web-search", description: "搜索", path: "/a/web-search/SKILL.md", directory: "/a", provider: "filesystem", modelInvocable: true, userInvocable: true, readonly: false, origin: { kind: "system", key: "system", label: "系统", provider: "filesystem", package: null, runtime: false } },
        { name: "agent-notes", description: "笔记", path: "/b/agent-notes/SKILL.md", directory: "/b", provider: "agent-notes", modelInvocable: true, userInvocable: true, readonly: true, origin: { kind: "plugin", key: "agent-notes", label: "agent-notes", provider: "agent-notes", package: "@acme/agent-notes", runtime: false } },
      ],
    });
  }
  if (path.includes("/mcp")) return json({ entries: [], native: { supported: true, entries: [] } });
  return json({ ok: true, customRecursiveDirs: [] });
};

new Function("window", "document", "require", "globalThis", bundle)(
  globalThis.window,
  { addEventListener() {}, removeEventListener() {}, head: { appendChild() {} }, createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {} }), querySelector: () => null, querySelectorAll: () => [], body: { appendChild() {} } },
  (id) => (id === "react" ? React : {}),
  globalThis,
);

const module = globalThis.__module;
check(module !== undefined && typeof module.factory === "function", "the bundle must register a module factory");

const ctx = {
  slots: {
    inject(_name, callback) { callback(); return () => {}; },
    register(options, component) { registered.push({ options, component }); return () => {}; },
  },
  inject() { return () => {}; },
  effect() { return () => {}; },
};
module.factory((id) => (id === "react" ? React : {})).apply(ctx);

const panel = registered.find((item) => item.options.name === "main" && item.options.key === "skill-mcp-manager");
const view = registered.find((item) => item.options.name === "conversation.view" && item.options.id === "capability");
check(panel !== undefined, "the sidebar panel must be registered");
check(view !== undefined, "the conversation view must be registered");

// A micro-renderer: it INVOKES function components (the real test) instead of only
// walking the top-level element. Each instance keeps its own hook slots so a
// setState during an effect can re-run just that component.
const instances = new Map();
let path = [];
let currentInstance = null;

function slotsFor(key) {
  let instance = instances.get(key);
  if (instance === undefined) { instance = { slots: [], dirty: true, passes: 0 }; instances.set(key, instance); }
  return instance;
}

function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (depth > 14) return node;
  if (typeof node.type === "function") {
    const key = (node.type.name || "anon") + "@" + path.join(".");
    const instance = slotsFor(key);
    let tree = null;
    for (let pass = 0; pass < 4; pass += 1) {
      hookSlots = instance.slots;
      hookIndex = 0;
      currentComponentKey = node.type.name || "anon";
      effectsEnabled = instance.passes === 0;
      rerender = false;
      path.push(node.type.name || "anon");
      try {
        tree = node.type(node.props);
      } catch (error) {
        failed.push((node.type.name || "component") + " threw on render: " + String(error?.message ?? error));
        path.pop();
        return null;
      }
      path.pop();
      instance.passes += 1;
      if (!rerender) break;
    }
    if (tree === null || tree === undefined) return null;
    path.push(node.type.name || "anon");
    const expanded = expand(tree, depth + 1);
    path.pop();
    return expanded;
  }
  const children = (node.children ?? []).map((child, index) => {
    path.push(String(index));
    const result = expand(child, depth + 1);
    path.pop();
    return result;
  });
  return { type: node.type, props: node.props, children: children.filter((child) => child !== null && child !== undefined && child !== false) };
}

function renderComponent(label, component, props, retain = false) {
  if (!retain) instances.clear();
  path = [];
  try {
    return expand(element(component, props, []));
  } catch (error) {
    failed.push(label + " threw while expanding: " + String(error?.message ?? error));
    return null;
  }
}

function countNodes(tree) {
  if (tree === null || tree === undefined || typeof tree !== "object") return 0;
  let total = 1;
  for (const child of tree.children ?? []) total += countNodes(child);
  return total;
}

function findText(tree, needle, out = []) {
  if (tree === null || tree === undefined || typeof tree !== "object") return out;
  for (const child of tree.children ?? []) {
    if (typeof child === "string") { if (child.includes(needle)) out.push(child); }
    else findText(child, needle, out);
  }
  return out;
}
// 1) the panel builds on BOTH tabs: the default (MCP) one, then the skills one,
//    which is where a state object was once used as an array and blanked the page.
for (const [tabLabel, override] of [["mcp", {}], ["skills", { "ManagerSection:0": "skills" }]]) {
  for (const key of Object.keys(stateOverrides)) delete stateOverrides[key];
  Object.assign(stateOverrides, override);
  hookSlots = [];
  const panelProps = panel.options.inject ? panel.options.inject() : {};
  renderComponent("ManagerSection/" + tabLabel + " (loading)", panel.component, panelProps);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = renderComponent("ManagerSection/" + tabLabel + " (loaded)", panel.component, panelProps, true);
  if (tree === null) continue;
  const nodes = countNodes(tree);
  console.log("panel nodes (" + tabLabel + "):", nodes);
  check(nodes > 20, "the panel must build a real tree on the " + tabLabel + " tab, got " + nodes + " nodes");
  check(findText(tree, "能力库").length > 0, "the panel must render its title (" + tabLabel + " tab)");
  if (tabLabel === "mcp") {
    check(findText(tree, "全部检测").length > 0, "the MCP tab must render its toolbar");
  } else {
    check(findText(tree, "新建分组").length > 0, "the skills tab must render the group tools");
    check(findText(tree, "导入本地技能").length > 0, "the skills tab must render the import button");
    check(findText(tree, "前端").length > 0, "the skills tab must render the custom group");
    check(findText(tree, "插件 · @acme/agent-notes").length > 0, "the skills tab must render the plugin group");
  }
}
// 2) the conversation view builds, then builds again with the fetched data —
//    the second pass is what exercises the loaded branch (groups, tiles, buttons).
{
  hookSlots = [];
  const props = view.options.inject ? view.options.inject("sess-1") : {};
  renderComponent("CapabilityView(loading)", view.component, props);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = renderComponent("CapabilityView(loaded)", view.component, props, true);
  if (tree !== null) {
    const nodes = countNodes(tree);
    console.log("view nodes:", nodes);
    check(nodes > 10, "the conversation view must build a real tree, got " + nodes + " nodes");
    check(findText(tree, "能力管理").length > 0, "the view must render its title");
    check(findText(tree, "MCP 服务器").length > 0, "the MCP section must be rendered");
    check(findText(tree, "我的 MCP 服务器").length > 0, "the registry group must be rendered");
    check(findText(tree, "插件 · @acme/box").length > 0, "a plugin group must be rendered");
    check(findText(tree, "全部开启").length >= 2, "both kinds need their own bulk switch, got " + findText(tree, "全部开启").length);
    check(findText(tree, "reqable").length > 0, "a registry tile must be rendered");
    console.log("view checks (folded defaults) done");
    // Plugin groups start folded (same rule as the library page): the header is there,
    // the cards are not — until the header is clicked.
    check(findText(tree, "插件 \u00b7 @acme/box").length > 0, "a plugin group header must still be rendered");
    check(findText(tree, "sequential").length === 0, "a folded plugin group must not render its cards");
    // Plugin groups render one-line rows with an overflow modal, and enabled rows first.
    check(findText(tree, "展开更多").length === 0, "a folded group must not offer the overflow button either");
    check(findText(tree, "系统").length > 0, "the 系统 group header must be rendered");
    check(findText(tree, "web-search").length > 0, "an open group must render its cards");
    check(findText(tree, "存为工作区默认").length > 0, "the workspace default must be saveable from the view");
    check(findText(tree, "清除默认").length > 0, "the workspace default must be clearable from the view");
    check(findText(tree, "新对话默认：").length > 0, "the view must show the workspace default state");
  }
}

// 3) an UNFOLDED plugin group renders one-line rows, enabled first, with the
//    overflow button instead of tiling every row onto the page.
{
  for (const key of Object.keys(stateOverrides)) delete stateOverrides[key];
  // openGroups is hook #4 (state, error, notice, busy, openGroups, more, preset).
  stateOverrides["CapabilityView:4"] = { "plugin:@acme/box": true };
  instances.clear();
  hookSlots = [];
  const props = view.options.inject ? view.options.inject("sess-1") : {};
  renderComponent("CapabilityView(loading)", view.component, props);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = renderComponent("CapabilityView(rows)", view.component, props, true);
  const texts = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    for (const child of node.children ?? []) {
      if (typeof child === "string") texts.push(child);
      else walk(child);
    }
  })(tree);
  const flat = texts.join(" | ");
  console.log("plugin rows:", texts.filter((t) => /^(box-|sequential)/.test(t)).join(","));
  check(flat.includes("展开更多"), "an overflowing plugin group must offer 展开更多, got: " + flat.slice(0, 200));
  const boxA = texts.indexOf("box-a");
  const boxC = texts.indexOf("box-c");
  const boxB = texts.indexOf("box-b");
  check(boxA !== -1 && boxB !== -1 && boxA < boxB, "switched-on rows must come first (box-a before box-b)");
  check(boxC !== -1 && boxC < boxB, "every switched-on row must precede the off ones");
  check(!texts.includes("sequential"), "a row beyond the limit must not be on the page (it lives in the modal)");
  const rowsOnPage = texts.filter((t) => /^(box-|sequential)/.test(t)).length;
  check(rowsOnPage === 5, "only the row limit stays on the page, got " + rowsOnPage);
  for (const key of Object.keys(stateOverrides)) delete stateOverrides[key];
}

if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("CLIENT RENDER SMOKE FAILED");
  process.exit(1);
}
console.log("CLIENT RENDER SMOKE PASSED");