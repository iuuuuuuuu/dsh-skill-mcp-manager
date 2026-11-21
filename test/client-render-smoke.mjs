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
        { name: "registry-stopped", source: "registry", tier: "disabled", transport: "stdio", enabled: false, globallyEnabled: false },
        { name: "sequential", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 1, enabled: false },
        { name: "box-a", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: true },
        { name: "box-b", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: false },
        { name: "box-c", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: true },
        { name: "box-d", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: false },
        { name: "box-e", source: "plugin", owner: "@acme/box", tier: "plugin", transport: "stdio", toolCount: 0, enabled: false },
      ],
      skills: [
        { name: "web-search", description: "记录设计决策", provider: "filesystem", readonly: false, enabled: true },
        { name: "agent-notes", description: "", provider: "agent-notes", readonly: true, enabled: false },
      ],
    });
  }
  if (path === "/skill-mcp-manager/settings") return json({ ok: true, inheritLibraryDefaults: false, customRecursiveDirs: [] });
  if (path.includes("/workspace-defaults")) return json({ ok: true, workspace: "/work/demo", mcp: ["reqable"], skills: [] });
  if (path.includes("/skill-groups")) return json({ ok: true, groups: [{ id: "g1", name: "前端", order: 0 }], members: { "web-search": "g1" } });
  if (path.includes("/skills/import")) {
    return json({ ok: true, target: "/tmp/skills", cwd: "", warning: "", sources: [{ id: "user-agents", label: "~/.agents/skills", dir: "/h/.agents/skills", exists: true, skills: [{ name: "pebrel-runtime", dir: "/h/.agents/skills/pebrel-runtime", description: "fixture", blocked: false }] }] });
  }
  if (path.includes("/skills/detail")) return json({ ok: true, name: "runtime-doc", provider: "runtime-doc", content: "# Runtime provider original content", description: "runtime fixture" });
  if (path.includes("/skills")) {
    return json({
      ok: true,
      workspaces: [{ id: "w1", title: "demo", path: "/work/demo" }],
      skills: [
        { name: "web-search", description: "搜索", path: "/a/web-search/SKILL.md", directory: "/a", provider: "filesystem", modelInvocable: true, userInvocable: true, readonly: false, origin: { kind: "system", key: "system", label: "系统", provider: "filesystem", package: null, runtime: false } },
        { name: "agent-notes", description: "笔记", path: "/b/agent-notes/SKILL.md", directory: "/b", provider: "agent-notes", modelInvocable: true, userInvocable: true, readonly: false, origin: { kind: "plugin", key: "agent-notes", label: "agent-notes", provider: "agent-notes", package: "@acme/agent-notes", runtime: false } },
        { name: "big-1", description: "一", path: "/c/1/SKILL.md", directory: "/c", provider: "big", modelInvocable: true, userInvocable: true, readonly: true, origin: { kind: "plugin", key: "big", label: "big", provider: "big", package: "@acme/big", runtime: false } },
        { name: "big-2", description: "二", path: "/c/2/SKILL.md", directory: "/c", provider: "big", modelInvocable: true, userInvocable: true, readonly: true, origin: { kind: "plugin", key: "big", label: "big", provider: "big", package: "@acme/big", runtime: false } },
        { name: "big-3", description: "三", path: "/c/3/SKILL.md", directory: "/c", provider: "big", modelInvocable: true, userInvocable: true, readonly: true, origin: { kind: "plugin", key: "big", label: "big", provider: "big", package: "@acme/big", runtime: false } },
        { name: "big-4", description: "四", path: "/c/4/SKILL.md", directory: "/c", provider: "big", modelInvocable: true, userInvocable: true, readonly: true, origin: { kind: "plugin", key: "big", label: "big", provider: "big", package: "@acme/big", runtime: false } },
        { name: "big-5", description: "五", path: "/c/5/SKILL.md", directory: "/c", provider: "big", modelInvocable: true, userInvocable: true, readonly: true, origin: { kind: "plugin", key: "big", label: "big", provider: "big", package: "@acme/big", runtime: false } },
        { name: "runtime-doc", description: "运行时文档", path: "", directory: "", provider: "runtime-doc", modelInvocable: true, readonly: true },
      ],
    });
  }
  if (path.includes("/mcp")) return json({ entries: [{ id: "registry-stopped", name: "registry-stopped", tier: "disabled", transport: "stdio", tools: [] }], native: { supported: true, entries: [{ id: "plugin-stopped", serverName: "plugin-stopped", owner: "fixture-plugin", enabled: false, transport: "stdio" }] } });
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
  if (depth > 30) throw new Error("render tree exceeded the smoke depth limit");
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
        // React passes nested elements via props.children; omitting it made every
        // Modal body disappear from this test, hiding loading-card regressions.
        tree = node.type({ ...node.props, children: node.children });
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
  const editCards = [];
  function collectEditCards(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.props?.className === "string" && node.props.className.split(" ").includes("smx-card")) editCards.push(node);
    for (const child of node.children || []) collectEditCards(child);
  }
  collectEditCards(tree);
  const ownEditCard = editCards.find((node) => findText(node, tabLabel === "mcp" ? "registry-stopped" : "web-search").length > 0);
  const pluginEditCard = editCards.find((node) => findText(node, tabLabel === "mcp" ? "plugin-stopped" : "agent-notes").length > 0);
  check(ownEditCard && findText(ownEditCard, "编辑").length === 1, "own capability card must offer editing: " + tabLabel);
  check(pluginEditCard && findText(pluginEditCard, "编辑").length === 0, "plugin capability must not offer editing, even at a writable path: " + tabLabel);
  if (tabLabel === "mcp") {
    check(findText(tree, "全部检测").length > 0, "the MCP tab must render its toolbar");
    check(findText(tree, "新增 MCP").length > 0, "the MCP tab must offer 新增 MCP");
    check(findText(tree, "2 个服务器").length > 0, "library MCP total must count registry AND plugin entries");
  } else {
    check(findText(tree, "新建分组").length > 0, "the skills tab must render the group tools");
    check(findText(tree, "导入本地技能").length > 0, "the skills tab must render the import button");
    check(findText(tree, "前端").length > 0, "the skills tab must render the custom group");
    check(findText(tree, "插件 · @acme/agent-notes").length > 0, "the skills tab must render the plugin group");
    // A plugin that ships five skills shows ONE row of cards plus 展开更多.
    check(findText(tree, "展开更多 5 个").length > 0, "an overflowing plugin group must offer 展开更多, got " + findText(tree, "展开更多").length);
    check(findText(tree, "big-5").length === 0, "the fifth card must stay out of the page until 展开更多");
    check(findText(tree, "big-3").length > 0, "the first row of cards stays on the page");
    check(findText(tree, "运行时技能，由插件管理").length > 0, "runtime skills must be described as provider-managed, not shipped files");
    check(findText(tree, "详情").length > 0, "runtime skills need a read-only detail action");
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
    check(findText(tree, "全局停用（先在能力库启用）").length > 0, "globally stopped cards must explain availability rather than disappear");
    check(findText(tree, "详情").length >= 2, "every card must offer 详情, got " + findText(tree, "详情").length);
    check(findText(tree, "记录设计决策").length > 0, "a skill card must show its description");
    console.log("view checks (folded defaults) done");
    // Plugin groups start folded (same rule as the library page): the header is there,
    // the cards are not — until the header is clicked.
    check(findText(tree, "插件 \u00b7 @acme/box").length > 0, "a plugin group header must still be rendered");
    const pluginCards = [];
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== "object") return;
      const cls = node.props?.className;
      if (typeof cls === "string" && cls.startsWith("smx-card") && !cls.includes("__")) pluginCards.push(cls);
      for (const child of node.children ?? []) walk(child);
    })(tree);
    check(pluginCards.every((cls) => !cls.includes("--row") && !cls.includes("--line")), "plugin cards must keep the standard card style, got " + JSON.stringify(pluginCards.slice(0, 4)));
    // Owner's rule: plugin groups are EXPANDED by default — their cards render, in the
    // same style as every other group's cards.
    check(findText(tree, "sequential").length > 0, "plugin groups must be expanded by default (their cards render)");
    // Plugin groups render one-line rows with an overflow modal, and enabled rows first.
    check(findText(tree, "展开更多").length === 0, "a folded group must not offer the overflow button either");
    check(findText(tree, "系统").length > 0, "the 系统 group header must be rendered");
    check(findText(tree, "web-search").length > 0, "an open group must render its cards");
    check(findText(tree, "存为工作区默认").length > 0, "the workspace default must be saveable from the view");
    check(findText(tree, "清除默认").length > 0, "the workspace default must be clearable from the view");
    check(findText(tree, "工作区预设：").length > 0 || findText(tree, "新会话默认在能力库设置").length > 0, "the view must show the workspace default state");
  }
}

// Runtime provider skill details are fetched by the actual card click handler.
{
  const nodes = (tree, predicate, result = []) => {
    if (!tree || typeof tree !== "object") return result;
    if (predicate(tree)) result.push(tree);
    for (const child of tree.children ?? []) nodes(child, predicate, result);
    return result;
  };
  for (const key of Object.keys(stateOverrides)) delete stateOverrides[key];
  stateOverrides["ManagerSection:0"] = "skills";
  const props = panel.options.inject ? panel.options.inject() : {};
  renderComponent("runtime detail initial", panel.component, props);
  await new Promise((resolve) => setTimeout(resolve, 30));
  let tree = renderComponent("runtime detail ready", panel.component, props, true);
  const card = nodes(tree, (node) => node.props["data-cap-name"] === "runtime-doc")[0];
  check(card !== undefined, "runtime skill must have its own library card");
  check(nodes(card, (node) => node.props.role === "switch").length === 0, "runtime card must not offer a filesystem model toggle");
  check(nodes(card, (node) => node.type === "button" && node.children.includes("删除")).length === 0, "runtime card must not offer directory deletion");
  const detail = nodes(card, (node) => node.type === "button" && node.children.includes("详情"))[0];
  if (detail) await detail.props.onClick();
  else check(false, "runtime detail click handler must exist");
  tree = renderComponent("runtime detail opened", panel.component, props, true);
  check(findText(tree, "# Runtime provider original content").length > 0, "runtime detail click must fetch and display the provider body");
  check(nodes(tree, (node) => node.props.role === "dialog").length === 1, "runtime skill detail must use the shared modal");
  delete stateOverrides["ManagerSection:0"];
}

// New-session preset: real control click, accepted persistence and a failed save.
{
  for (const key of Object.keys(stateOverrides)) delete stateOverrides[key];
  const previousFetch = globalThis.fetch;
  let flag = false, reject = false, writes = 0, selection = null, legacy = false;
  let provenance = true, fallback = true;
  const defaultMcp = [
    { name: "fixture-mcp", description: "fixture", available: true, source: "registry" },
    { name: "plugin-a", description: "First bridge", available: true, source: "plugin", owner: "@acme/mcp" },
    { name: "plugin-b", description: "Second bridge", available: true, source: "plugin", owner: "@acme/mcp" },
    { name: "unowned", description: "No owner", available: true, source: "plugin", owner: null },
    { name: "stopped", description: "Stopped", available: false, source: "registry" },
    { name: "missing", description: "Missing saved item", available: false, source: "missing" },
  ];
  const defaultSkills = [
    { name: "fixture-skill", description: "fixture", available: true, provider: "filesystem" },
    { name: "plugin-skill", description: "Notes", available: true, provider: "notes", origin: { kind: "plugin", key: "notes", package: "@acme/notes" } },
    { name: "runtime-skill", description: "Runtime", available: true, provider: "runtime-doc" },
  ];
  const oldProjection = ({ source, owner, provider, origin, ...item }) => item;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "/skill-mcp-manager/library-defaults") return json({
      ok: true, configured: selection !== null,
      selection: selection ?? { mcp: ["fixture-mcp"], skills: ["fixture-skill"] },
      mcp: provenance ? defaultMcp : defaultMcp.map(oldProjection),
      skills: provenance ? defaultSkills : defaultSkills.map(oldProjection),
    });
    if (!provenance && ["/skill-mcp-manager/mcp", "/skill-mcp-manager/skills"].includes(String(url))) {
      if (!fallback) return { ok: false, status: 404, json: async () => ({ error: "missing fixture route" }) };
      if (String(url).endsWith("/mcp")) return json({
        entries: defaultMcp.filter((item) => item.source === "registry"),
        native: { entries: defaultMcp.filter((item) => item.source === "plugin").map((item) => ({ serverName: item.name, owner: item.owner })) },
      });
      return json({ skills: defaultSkills });
    }
    if (String(url) !== "/skill-mcp-manager/settings") return previousFetch(url, options);
    if (options?.method === "POST") {
      writes += 1;
      if (reject) return { ok: false, status: 400, json: async () => ({ error: "preset save fixture failure" }) };
      const request = JSON.parse(options.body);
      if (Object.hasOwn(request, "inheritLibraryDefaults")) flag = request.inheritLibraryDefaults;
      if (Object.hasOwn(request, "libraryDefaults")) selection = request.libraryDefaults;
    }
    return json({ ok: true, inheritLibraryDefaults: flag, ...(legacy ? {} : { libraryDefaults: selection }) });
  };
  const nodes = (tree, predicate, out = []) => {
    if (!tree || typeof tree !== "object") return out;
    if (predicate(tree)) out.push(tree);
    for (const child of tree.children ?? []) nodes(child, predicate, out);
    return out;
  };
  const props = panel.options.inject ? panel.options.inject() : {};
  try {
    renderComponent("library defaults initial", panel.component, props);
    await new Promise((resolve) => setTimeout(resolve, 30));
    let tree = renderComponent("library defaults ready", panel.component, props, true);
    const control = () => nodes(tree, (node) => node.props.role === "switch")[0];
    check(findText(tree, "新会话沿用能力库开关").length > 0, "library must show the new-session preset at the top");
    check(!control().props.disabled, "supported host must enable preset switch");
    await control().props.onClick();
    tree = renderComponent("library defaults enabled", panel.component, props, true);
    check(flag && writes === 1 && control().props["aria-checked"] === "true", "preset click must persist its flag and reflect accepted host state");
    const button = (label) => nodes(tree, (node) => node.type === "button" && node.children.includes(label))[0];
    const checkbox = (name) => nodes(tree, (node) => node.props.type === "checkbox" && node.props["aria-label"] === name)[0];
    check(button("配置")?.props.disabled === false, "supported host must offer an enabled Configure button");
    button("配置").props.onClick();
    tree = renderComponent("library dialog loading", panel.component, props, true);
    check(findText(tree, "正在加载能力目录…").length > 0 && button("保存默认配置")?.props.disabled, "loading must not enable save");
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("library dialog loaded", panel.component, props, true);
    check(nodes(tree, (node) => node.props.role === "dialog").length === 1, "default picker must use the shared dialog");
    check(checkbox("MCP fixture-mcp")?.props.checked && checkbox("技能 fixture-skill")?.props.checked, "separate lists must load preselected values");
    const dialog = () => nodes(tree, (node) => node.props.role === "dialog")[0];
    const group = (label) => nodes(dialog(), (node) => node.props.role === "group" && node.props["aria-label"] === label)[0];
    check(group("我的 MCP 服务器") && group("系统"), "default picker must distinguish registry MCP and system skills");
    check(nodes(group("插件 · @acme/mcp"), (node) => node.props.type === "checkbox").length === 2,
      "MCP entries from one owner must appear together under the plugin name");
    check(nodes(group("插件 · @acme/notes"), (node) => node.props["aria-label"] === "技能 plugin-skill").length === 1,
      "skill group must identify its package, not guess from the description");
    check(group("插件 · runtime-doc") && group("未归属插件") && group("暂不可用"),
      "runtime providers, unowned plugins and missing saved names need honest source groups");
    check(checkbox("MCP stopped").props.disabled && checkbox("MCP missing").props.disabled,
      "grouping must not enable unavailable unchecked entries");
    const searchBox = () => nodes(dialog(), (node) => node.props["aria-label"] === "筛选默认能力")[0];
    searchBox().props.onChange({ target: { value: " @ACME/MCP " } });
    tree = renderComponent("default picker plugin search", panel.component, props, true);
    check(checkbox("MCP plugin-a") && checkbox("MCP plugin-b") && !checkbox("MCP fixture-mcp") && !checkbox("技能 plugin-skill"),
      "search must match plugin ownership case-insensitively and hide unrelated groups");
    searchBox().props.onChange({ target: { value: "no-result-fixture" } });
    tree = renderComponent("default picker empty search", panel.component, props, true);
    check(findText(dialog(), "没有匹配的能力").length === 2, "each empty search result must explain why the list is empty");
    searchBox().props.onChange({ target: { value: "" } });
    tree = renderComponent("default picker cleared search", panel.component, props, true);
    check(checkbox("MCP fixture-mcp").props.checked && checkbox("技能 fixture-skill").props.checked,
      "filtering source groups must never erase hidden selections");
    checkbox("MCP fixture-mcp").props.onChange({ target: { checked: false } });
    tree = renderComponent("library dialog edited", panel.component, props, true);
    check(!checkbox("MCP fixture-mcp").props.checked && checkbox("技能 fixture-skill").props.checked, "changing MCP must not flip the selected skill");
    button("取消").props.onClick();
    tree = renderComponent("library dialog cancelled", panel.component, props, true);
    check(!button("保存默认配置") && writes === 1 && selection === null, "cancel must close and not make a request");
    // Start a new tree to emulate reload and real modal unmount (this tiny renderer
    // intentionally retains unused instance slots across keepInstances rerenders).
    renderComponent("library page refreshed", panel.component, props);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("refreshed library ready", panel.component, props, true);
    button("配置").props.onClick();
    renderComponent("reopened library dialog loading", panel.component, props, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("reopened library dialog ready", panel.component, props, true);
    check(checkbox("MCP fixture-mcp").props.checked, "cancelled draft must not appear on next load");
    checkbox("MCP fixture-mcp").props.onChange({ target: { checked: false } });
    checkbox("技能 fixture-skill").props.onChange({ target: { checked: false } });
    tree = renderComponent("library defaults emptied", panel.component, props, true);
    await button("保存默认配置").props.onClick();
    tree = renderComponent("library defaults saved", panel.component, props, true);
    check(flag && writes === 2 && JSON.stringify(selection) === '{"mcp":[],"skills":[]}' && !button("保存默认配置"),
      "save must submit both empty lists and close only after confirmation, without changing the switch");
    renderComponent("library page refreshed after save", panel.component, props);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("saved library page ready", panel.component, props, true);
    button("配置").props.onClick();
    renderComponent("saved library dialog loading", panel.component, props, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("saved library dialog ready", panel.component, props, true);
    check(!checkbox("MCP fixture-mcp").props.checked && !checkbox("技能 fixture-skill").props.checked, "reloaded dialog must render the saved empty selection as empty");
    button("取消").props.onClick();
    tree = renderComponent("saved library dialog closed", panel.component, props, true);
    provenance = false;
    renderComponent("old provenance host", panel.component, props);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("old provenance host ready", panel.component, props, true);
    button("配置").props.onClick();
    renderComponent("old provenance dialog loading", panel.component, props, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("old provenance dialog ready", panel.component, props, true);
    check(group("插件 · @acme/mcp") && group("插件 · @acme/notes") && group("系统"),
      "new client on old host must enrich ownership from existing catalog routes");
    check(!checkbox("MCP fixture-mcp").props.checked && !checkbox("技能 fixture-skill").props.checked,
      "fallback metadata must not replace the saved selection");
    fallback = false;
    renderComponent("host without provenance routes", panel.component, props);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("host without provenance ready", panel.component, props, true);
    button("配置").props.onClick();
    renderComponent("unidentified provenance dialog loading", panel.component, props, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("unidentified provenance dialog ready", panel.component, props, true);
    check(group("来源待识别") && !group("系统") && checkbox("MCP fixture-mcp"),
      "failed metadata enrichment must keep the picker usable without inventing ownership");
    button("取消").props.onClick();
    tree = renderComponent("fallback dialog closed", panel.component, props, true);
    reject = true;
    await control().props.onClick();
    tree = renderComponent("library defaults failed", panel.component, props, true);
    check(control().props["aria-checked"] === "true" && findText(tree, "preset save fixture failure").length > 0,
      "failed preset save must retain accepted switch state and report error");
    legacy = true;
    renderComponent("old host with existing switch", panel.component, props);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("old host without configuration", panel.component, props, true);
    check(!control().props.disabled && button("配置").props.disabled, "older host can keep the old switch but must not advertise configuration");
    globalThis.fetch = async (url, options) => String(url) === "/skill-mcp-manager/settings"
      ? json({ ok: true }) : previousFetch(url, options);
    renderComponent("legacy preset initial", panel.component, props);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tree = renderComponent("legacy preset ready", panel.component, props, true);
    check(control().props.disabled === true, "old host without the preset field must not pretend the switch works");
  } finally { globalThis.fetch = previousFetch; }
}

// 3) Real component event handlers: click authorization, show its waiting card,
// then dismiss it, toast success and replace a stale failed check with fresh host state.
{
  for (const key of Object.keys(stateOverrides)) delete stateOverrides[key];
  const previousFetch = globalThis.fetch;
  const previousOpen = window.open;
  let complete = false;
  let reads = 0;
  let releaseStart;
  let releaseStatus;
  const start = new Promise((resolve) => { releaseStart = resolve; });
  const status = new Promise((resolve) => { releaseStatus = resolve; });
  const tab = { opener: {}, location: { href: "about:blank" }, close() {} };
  window.open = () => tab;
  const entry = () => ({
    id: "oauth-cloud", name: "oauth-cloud", tier: "on-demand", transport: "streamable-http",
    url: "https://oauth.example/mcp", tools: [], toolCount: 0, disabledTools: [],
    lastCheck: complete ? { ok: true, latencyMs: 42, at: new Date().toISOString(), toolCount: 1 }
      : { ok: false, error: "401 stale OAuth check", at: new Date().toISOString() },
  });
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path === "/skill-mcp-manager/oauth/start") { await start; return json({ ok: true, authorizeUrl: "https://oauth.example/authorize" }); }
    if (path.startsWith("/skill-mcp-manager/oauth/status")) { await status; return json({ ok: true, status: "done" }); }
    if (path === "/skill-mcp-manager/mcp/test") return json({ ok: true, check: { ok: false, error: "401 stale OAuth check" } });
    if (path === "/skill-mcp-manager/mcp") { reads += 1; return json({ entries: [entry()], native: { supported: false, entries: [] } }); }
    return previousFetch(url, options);
  };
  const props = panel.options.inject ? panel.options.inject() : {};
  const paint = (retain = true) => renderComponent("authorization feedback", panel.component, props, retain);
  const nodes = (tree, predicate, result = []) => {
    if (!tree || typeof tree !== "object") return result;
    if (predicate(tree)) result.push(tree);
    for (const child of tree.children ?? []) nodes(child, predicate, result);
    return result;
  };
  const button = (tree, text) => nodes(tree, (node) => node.type === "button" && node.children.includes(text))[0];
  try {
    paint(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    let tree = paint();
    await button(tree, "检测").props.onClick();
    tree = paint();
    check(findText(tree, "401 stale OAuth check").length > 0, "fixture must create a real stale manual-check result");
    const operation = button(tree, "授权").props.onClick();
    tree = paint();
    check(findText(tree, "正在准备安全授权…").length > 0, "authorization click must immediately show the loading card");
    releaseStart();
    await new Promise((resolve) => setTimeout(resolve, 20));
    tree = paint();
    check(findText(tree, "请在浏览器中完成登录与授权").length > 0, "waiting card must explain the browser step");
    check(tab.location.href === "https://oauth.example/authorize" && tab.opener === null, "reserved tab must navigate to authorization with no opener");
    complete = true;
    releaseStatus();
    await operation;
    tree = paint();
    check(nodes(tree, (node) => node.props.className === "smx-oauth-card").length === 0, "success must close the loading card");
    check(findText(tree, "授权成功").length > 0, "success must show a toast rather than a permanent notice");
    check(findText(tree, "401 stale OAuth check").length === 0, "stale failed manual check must not mask the new card status");
    check(findText(tree, "上次连通").length > 0 && reads >= 2, "success must fetch and render the refreshed connection result");
    nodes(tree, (node) => node.props["aria-label"] === "关闭授权成功提示")[0].props.onClick();
    tree = paint();
    check(findText(tree, "授权成功").length === 0, "success toast must be dismissible");
    console.log("authorization click -> loading -> toast + fresh card: done");
  } finally {
    globalThis.fetch = previousFetch;
    window.open = previousOpen;
  }
}

if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("CLIENT RENDER SMOKE FAILED");
  process.exit(1);
}
console.log("CLIENT RENDER SMOKE PASSED");