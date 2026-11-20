// Per-conversation capability policy: default CLOSED, per-kind bulk, plugin grouping.
//
// Covers every place that reads the policy — catalog injection, eager mounting,
// mcp_load/mcp_call, the scoped pre-execute guard (skills and plugin-mounted MCP
// tools) — plus the persisted allow list and the session-layer shadow that keeps a
// switched-off skill out of the model-facing catalog.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const tmp = join(process.cwd(), ".test-session-caps-" + process.pid);
const dataDir = join(tmp, "data");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
// DSH_HOME is read when lib/index.js loads, so it must be set before the import —
// otherwise the plugin bundle scan reads the real profiles (and their !!js tags).
process.env.DSH_HOME = join(tmp, "home");
const { apply } = await import("../lib/index.js");

const entry = (name, tier) => ({
  id: name, name, tier, transport: "streamable-http", command: null, args: [], env: {}, cwd: null,
  url: "http://127.0.0.1:1/", headers: {}, notes: "", tools: [{ name: "ping", description: "Ping" }], disabledTools: [],
  serverName: "", serverVersion: "", serverDescription: "fixture " + name, instructions: "",
  metaFetchedAt: "2026-01-01T00:00:00.000Z",
});
await writeFile(join(dataDir, "registry.json"), JSON.stringify({
  version: 1,
  entries: [entry("alpha", "on-demand"), entry("beta", "disabled")],
}, null, 2) + "\n", "utf8");

const skills = {
  "only-standing": { name: "only-standing", description: "Only in the standing scope", path: join(tmp, "standing", "SKILL.md"), provider: "filesystem", invocation: { modelInvocable: true, userInvocable: true }, content: "# standing" },
  "only-conversation": { name: "only-conversation", description: "Only in the conversation scope", path: join(tmp, "conv", "SKILL.md"), provider: "agent-notes", invocation: { modelInvocable: true, userInvocable: true }, content: "# conv" },
  "workspace-skill": { name: "workspace-skill", description: "Lives in the workspace", path: join(tmp, "workspace-a", ".agents", "skills", "workspace-skill", "SKILL.md"), provider: "filesystem", invocation: { modelInvocable: true, userInvocable: true }, content: "# ws" },
  "skill-one": { name: "skill-one", description: "First fixture", path: join(tmp, "one", "SKILL.md"), provider: "filesystem", invocation: { modelInvocable: true, userInvocable: true }, content: "# one" },
};

// Real registry semantics: agent-local registrations shadow same-name provider
// definitions for BOTH list and get, including a registration without a path.
const activeShadows = new WeakMap();
const modernPresetKey = {};
let modernPresets = false;
let presetLeases = 0;
let presetAcquires = 0;
const liveSkillsService = {
  registerProvider() { return () => {}; },
  // The standing scope (no scope option) is what 能力库 lists; a conversation scope
  // only sees its own layer. The view must show the union, not one of them.
  async list(options) {
    const standing = options?.scope === modernPresetKey;
    if (standing && presetLeases === 0) throw new Error("preset scope read after lease disposal");
    const visible = Object.values(skills).filter((s) => (standing || options?.scope === undefined) ? s.name !== "only-conversation" : s.name !== "only-standing");
    const merged = new Map(visible.map((s) => [s.name, s]));
    for (const [name, shadow] of activeShadows.get(options?.scope) ?? []) merged.set(name, shadow);
    return [...merged.values()];
  },
  async get(name, options) {
    if (options?.scope === modernPresetKey && presetLeases === 0) throw new Error("preset definition read after lease disposal");
    return activeShadows.get(options?.scope)?.get(name) ?? skills[name];
  },
};

// One plugin-mounted MCP row: the desktop app's loader owns these, so the plugin can
// only refuse their calls per conversation, never unmount them.
let pluginEnabled = true;
const fakeLoader = {
  entries() {
    return [{
      id: "mcp-sequential",
      disabled: !pluginEnabled,
      update() {},
      options: { name: "@deepseek-ai/dsh-mcp-client", id: "mcp-sequential", config: { transport: "stdio", serverName: "sequential", command: "node", args: [] } },
    }];
  },
};

let deadSkills = false;
let currentWorkspace = join(tmp, "workspace-a");
const routes = [];
const effects = [];
const preSteps = [];
const createdAgents = [];
const toolByName = new Map();
const webServer = { register(route) {
  if (routes.some((item) => item.path === route.path && item.kind === route.kind)) throw new Error("duplicate route " + route.path);
  routes.push(route); return () => {};
} };
const warnings = [];
const ctx = {
  tools: { register(definition) { toolByName.set(definition.name, definition); return () => {}; } },
  get skills() {
    if (deadSkills) throw new Error('cannot get required service "skills" in inactive context');
    return liveSkillsService;
  },
  on(event, handler) {
    if (event === "agent/pre-step") preSteps.push(handler);
    if (event === "agent/created") createdAgents.push(handler);
    return () => {};
  },
  effect(fn) { const d = fn(); if (typeof d === "function") effects.push(d); return () => {}; },
  inject(names, callback) {
    const list = Array.isArray(names) ? names : [names];
    if (list.includes("webServer")) callback(ctx);
    if (list.includes("loader")) callback({ loader: fakeLoader });
    return () => {};
  },
  webServer,
  get(name) {
    if (name === "agentPresets" && modernPresets) return {
      async acquireScope() {
        presetAcquires += 1;
        presetLeases += 1;
        return { key: modernPresetKey, async [Symbol.asyncDispose]() { presetLeases -= 1; } };
      },
    };
    if (name === "webServer") return webServer;
    if (name === "skills") return liveSkillsService;
    if (name === "workingDirectory") return { ensure: async (agent) => agent?.session?.cwd ?? currentWorkspace };
    return undefined;
  },
  logger: { warn(message) { warnings.push(String(message)); }, error() {}, info(message) { if (String(message).startsWith("DEBUG")) console.log(String(message)); } },
};

// An agent whose context does NOT inject `skills`: reading it throws cordis'
// "cannot get property skills without inject", which is the host's normal shape for
// every plugin's agent context. The plugin must survive that and fall back.
function makeBareSkillAgent(sessionId) {
  const guards = [];
  const injectedShadows = [];
  const agent = {
    injectedShadows,
    ctx: {
      tools: { register() { return () => {}; } },
      on(event, handler) { if (event === "tools/pre-execute") guards.push(handler); return () => {}; },
      get skills() { throw new Error('cannot get property "skills" without inject'); },
      // cordis' own pattern: wait for the service, then register inside the scope that
      // injects it. This is the path that keeps the shadow working on such a host.
      inject(names, callback) {
        if (Array.isArray(names) ? names.includes("skills") : names === "skills") {
          callback({ skills: { register(skill) { injectedShadows.push(skill); return () => {}; } } });
        }
        return () => {};
      },
      effect(fn) { fn(); return () => {}; },
    },
    session: { id: sessionId, seq: 0, surface: { nodes: [] }, eventAt: () => undefined },
    guards,
  };
  return agent;
}

function makeAgent(sessionId) {
  const guards = [];
  const shadows = [];
  const disposed = [];
  const active = new Map();
  const agent = {
    ctx: {
      tools: { register() { return () => {}; } },
      on(event, handler) {
        if (event === "tools/pre-execute") guards.push(handler);
        return () => {};
      },
      skills: {
        register(skill) {
          shadows.push(skill);
          active.set(skill.name, skill);
          return () => {
            disposed.push(skill.name);
            if (active.get(skill.name) === skill) active.delete(skill.name);
          };
        },
      },
      effect(fn) { fn(); return () => {}; },
    },
    session: { id: sessionId, seq: 0, surface: { nodes: [] }, eventAt: () => undefined },
    guards,
    shadows,
    disposed,
  };
  activeShadows.set(agent, active);
  return agent;
}

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };
const routeByPath = (path) => routes.find((route) => route.path === path);

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method, url,
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() { return { async next() { return i < chunks.length ? { value: chunks[i++], done: false } : { done: true }; } }; },
  };
}
function makeRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (chunk) => { res.body = chunk; };
  return res;
}
const bodyOf = (res) => (res.body ? JSON.parse(res.body) : {});
async function caps(method, body, explicitUrl) {
  const res = makeRes();
  const url = explicitUrl !== undefined
    ? explicitUrl
    : method === "GET"
      ? "/skill-mcp-manager/session-caps?session=" + encodeURIComponent(body?.session ?? "sess-1")
      : "/skill-mcp-manager/session-caps";
  await routeByPath(url.split("?")[0]).handler(makeReq(method, url, body), res);
  return { status: res.status, body: bodyOf(res) };
}
async function preStep(agent) {
  let captured = { kind: "continue", messages: [] };
  for (const listener of preSteps) {
    captured = await listener({ agent, signal: { throwIfAborted() {} } }, async () => captured);
  }
  return captured;
}
const catalogText = (decision) => (decision.messages ?? []).map((m) => m.content?.[0]?.text ?? "").join("\n");

// the workspace declares one MCP server of its own
await mkdir(currentWorkspace, { recursive: true });
await writeFile(join(currentWorkspace, ".mcp.json"), JSON.stringify({ mcpServers: { "ws-server": { command: "node", args: ["ws.js"] } } }, null, 2), "utf8");
// Upgrade fixture: old versions auto-seeded child sessions as closed, without
// recording whether a person explicitly changed the switches.
await writeFile(join(dataDir, "session-caps.json"), JSON.stringify({
  "legacy-parent": { mcp: ["alpha", "sequential"], skills: ["skill-one"], seeded: true },
  "legacy-child": { mcp: [], skills: [], seeded: true },
  "legacy-explicit": { mcp: [], skills: [], seeded: true, explicit: true },
  "legacy-custom": { mcp: ["sequential"], skills: [], seeded: true },
}), "utf8");
await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 50));

const agent = makeAgent("sess-1");

// 1) a fresh conversation starts with EVERYTHING off
{
  // A pre-step is what registers this agent's live runtime; the view then lists the
  // union of the standing scope and this conversation's own layer.
  const decisionAtStart = await preStep(agent);
  const res = await caps("GET", { session: "sess-1" });
  console.log("initial:", JSON.stringify({ mcp: res.body.mcp?.map((m) => m.name + ":" + m.enabled), skills: res.body.skills?.map((s) => s.name + ":" + s.enabled) }));
  check(res.status === 200, "GET session-caps must answer 200");
  check(res.body.mcp?.some((m) => m.name === "beta" && m.globallyEnabled === false && m.enabled === false), "globally disabled registry MCP must remain visible but unavailable");
  check((res.body.mcp ?? []).length === 4, "registry + plugin + workspace rows must all be listed, got " + JSON.stringify((res.body.mcp ?? []).map((m) => m.name)));
  check((res.body.mcp ?? []).some((m) => m.source === "workspace" && m.name === "ws-server"), "the workspace-declared server must be listed");
  const pluginRow = (res.body.mcp ?? []).find((m) => m.source === "plugin");
  check(pluginRow !== undefined && pluginRow.name === "sequential", "the plugin-mounted row must be listed by its server name");
  check(pluginRow !== undefined && pluginRow.owner === "", "an unattributable plugin row keeps an empty owner (the page shows 未归属插件)");
  // Default is closed for everything the USER owns; what the WORKSPACE brings is on.
  for (const row of res.body.mcp ?? []) {
    const owned = row.source === "workspace";
    check(row.enabled === owned, "MCP row " + row.name + " must start " + (owned ? "ON (workspace-owned)" : "OFF"));
  }
  for (const row of res.body.skills ?? []) {
    const owned = row.name === "workspace-skill";
    check(row.enabled === owned, "skill " + row.name + " must start " + (owned ? "ON (workspace-owned)" : "OFF"));
  }
  const names = (res.body.skills ?? []).map((s) => s.name);
  check(names.length === 4, "the union of standing + conversation + workspace scopes must be listed, got " + JSON.stringify(names));
  check(new Set(names).size === names.length, "the union must not duplicate a name");
  check(catalogText(decisionAtStart) === "", "a fresh conversation must get no MCP catalog at all");
  check(agent.shadows.length === 3, "every switched-off skill needs a shadow, got " + agent.shadows.length);
  check(!agent.shadows.some((s) => s.name === "workspace-skill"), "a workspace-owned skill that starts on must NOT get a shadow");
  check(agent.shadows.every((s) => s.invocation?.modelInvocable === false), "shadows must be model-invisible");
}

// Switching any row must not remove shadowed filesystem/plugin skills from management.
{
  for (const [name, enabled] of [["only-conversation", true], ["skill-one", true], ["skill-one", false], ["only-conversation", false]]) {
    const res = await caps("POST", { session: "sess-1", kind: "skills", name, enabled });
    check(res.status === 200, "repeated skill switch must succeed: " + name + ": " + JSON.stringify(res.body));
    check(res.body.skills?.length === 4, "switching " + name + " must retain all management cards");
    check(res.body.skills?.find((s) => s.name === name)?.enabled === enabled, "selected switch must keep its new state");
    check(res.body.skills?.find((s) => s.name === "skill-one")?.provider === "filesystem", "a policy shadow must not replace source attribution");
    const refreshed = await caps("GET", { session: "sess-1" });
    check(refreshed.body.skills?.length === 4, "a subsequent GET must retain every disabled card");
  }
}

// Pathless runtime skills and late provider discoveries remain manageable too.
{
  const runtimeAgent = makeAgent("runtime-probe");
  await preStep(runtimeAgent);
  skills["runtime-help"] = { name: "runtime-help", description: "Provider-managed runtime skill", provider: "runtime-fixture", source: "runtime", invocation: { modelInvocable: true, userInvocable: true }, content: "# runtime" };
  await preStep(runtimeAgent);
  check(activeShadows.get(runtimeAgent)?.has("runtime-help"), "unchanged policy must still shadow newly discovered skills");
  for (const enabled of [true, false, true, false]) {
    const res = await caps("POST", { session: "runtime-probe", kind: "skills", name: "runtime-help", enabled });
    check(res.status === 200 && res.body.skills?.find((s) => s.name === "runtime-help")?.enabled === enabled,
      "runtime skill without a file path must stay switchable: " + JSON.stringify(res.body));
    check(await runtimeAgent.guards[0]({ name: "skill", arguments: { name: "runtime-help" } }, async () => "allow") === (enabled ? "allow" : "deny"),
      "runtime skill invocation boundary must follow switch");
  }
  const library = makeRes();
  await routeByPath("/skill-mcp-manager/skills").handler(makeReq("GET", "/skill-mcp-manager/skills"), library);
  const libraryRuntime = bodyOf(library).skills?.find((s) => s.name === "runtime-help");
  check(libraryRuntime?.path === "" && libraryRuntime?.readonly === true, "library must include pathless runtime skills as read-only instead of dropping them");
  check(libraryRuntime?.provider === "runtime-fixture", "runtime skill origin must survive library projection");
  const detail = makeRes();
  await routeByPath("/skill-mcp-manager/skills/detail").handler(makeReq("GET", "/skill-mcp-manager/skills/detail?name=runtime-help"), detail);
  check(detail.status === 200 && bodyOf(detail).content === "# runtime", "runtime read-only detail must use the provider's actual content");
  const skipped = makeRes();
  await routeByPath("/skill-mcp-manager/skills/toggle-group").handler(makeReq("POST", "/skill-mcp-manager/skills/toggle-group", { provider: "runtime-fixture", enabled: false }), skipped);
  check(skipped.status === 200 && bodyOf(skipped).skipped?.includes("runtime-help"), "runtime-only group must be reported as read-only, not written or missing");
  for (const action of ["toggle", "open", "delete"]) {
    const denied = makeRes();
    await routeByPath("/skill-mcp-manager/skills/" + action).handler(makeReq("POST", "/skill-mcp-manager/skills/" + action, { name: "runtime-help", enabled: false }), denied);
    check(denied.status === 400, "a runtime skill must not reach filesystem " + action);
  }

  await caps("POST", { session: "runtime-probe", kind: "skills", name: "runtime-help", enabled: true });
  check(!activeShadows.get(runtimeAgent)?.has("runtime-help"), "enabling runtime skill must dispose its policy shadow");
  delete skills["runtime-help"];
}

// Library and management list the same global MCP names, including stopped entries.
{
  const library = makeRes();
  await routeByPath("/skill-mcp-manager/mcp").handler(makeReq("GET", "/skill-mcp-manager/mcp"), library);
  const body = bodyOf(library);
  const libraryNames = [...body.entries.map((x) => x.name), ...(body.native?.entries ?? []).map((x) => x.serverName)].sort();
  const sessionNames = (await caps("GET", { session: "sess-1" })).body.mcp.filter((x) => x.source !== "workspace").map((x) => x.name).sort();
  check(JSON.stringify(libraryNames) === JSON.stringify(sessionNames), "same-scope MCP inventories must match, got " + JSON.stringify({ libraryNames, sessionNames }));
  const stopped = await caps("POST", { session: "sess-1", kind: "mcp", name: "beta", enabled: true });
  check(stopped.status === 400, "conversation switch must not enable a globally stopped MCP");
  pluginEnabled = false;
  const disabled = (await caps("GET", { session: "sess-1" })).body.mcp.find((x) => x.name === "sequential");
  check(disabled?.globallyEnabled === false && disabled.enabled === false, "stopped plugin MCP must stay listed and unavailable");
  const on = await caps("POST", { session: "sess-1", kind: "mcp", name: "sequential", enabled: true });
  check(on.status === 400, "conversation switch must not enable a globally stopped plugin MCP");
  pluginEnabled = true;

}

// 2) turning one MCP server on mounts it into the catalog; mcp_load follows
{
  const on = await caps("POST", { session: "sess-1", kind: "mcp", name: "alpha", enabled: true });
  console.log("enable alpha ->", on.status, JSON.stringify(on.body.mcp?.map((m) => m.name + ":" + m.enabled)));
  check(on.status === 200 && on.body.mcp?.find((m) => m.name === "alpha")?.enabled === true, "alpha must read as on");
  const saved = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check((saved["sess-1"]?.mcp ?? []).includes("alpha"), "the allow list must be persisted per session");
  const decision = await preStep(agent);
  check(catalogText(decision).includes("alpha"), "the catalog must advertise an enabled server");
  const load = toolByName.get("mcp_load");
  check(load !== undefined, "mcp_load tool must be registered");
  if (load !== undefined) {
    let error = "";
    try { await load.execute({ name: "alpha" }, { agent, signal: { throwIfAborted() {} } }); } catch (err) { error = String(err?.message ?? err); }
    check(!/off for this conversation/.test(error), "mcp_load must not refuse an enabled server, got: " + error);
  }
}

// 3) turning it off again refuses it and drops it from the catalog
{
  const off = await caps("POST", { session: "sess-1", kind: "mcp", name: "alpha", enabled: false });
  check(off.body.mcp?.find((m) => m.name === "alpha")?.enabled === false, "alpha must read as off again");
  const load = toolByName.get("mcp_load");
  let error = "";
  try { await load.execute({ name: "alpha" }, { agent, signal: { throwIfAborted() {} } }); } catch (err) { error = String(err?.message ?? err); }
  console.log("mcp_load off ->", error);
  check(/off for this conversation/.test(error), "mcp_load must refuse a switched-off server, got: " + error);
  const decision = await preStep(agent);
  check(catalogText(decision) === "", "the catalog must not advertise a switched-off server");
}

// 4) the guard: skills and plugin-mounted MCP tools, scoped to this conversation
{
  const guard = agent.guards[0];
  check(guard !== undefined, "a pre-execute guard must be registered on the agent context");
  const skillOff = await guard({ name: "skill", arguments: { name: "skill-one" } }, async () => "allow");
  const nativeOff = await guard({ name: "mcp__sequential__think" }, async () => "allow");
  const otherTool = await guard({ name: "shell", arguments: {} }, async () => "allow");
  console.log("guard off:", skillOff, nativeOff, otherTool);
  check(skillOff === "deny", "a switched-off skill must be denied");
  check(nativeOff === "deny", "a switched-off plugin-mounted MCP tool must be denied");
  check(otherTool === "allow", "the guard must not touch unrelated tools");

  await caps("POST", { session: "sess-1", kind: "skills", name: "skill-one", enabled: true });
  await caps("POST", { session: "sess-1", kind: "mcp", name: "sequential", enabled: true });
  const skillOn = await guard({ name: "skill", arguments: { name: "skill-one" } }, async () => "allow");
  const nativeOn = await guard({ name: "mcp__sequential__think" }, async () => "allow");
  console.log("guard on:", skillOn, nativeOn);
  check(skillOn === "allow", "an enabled skill must be allowed");
  check(nativeOn === "allow", "an enabled plugin MCP tool must be allowed");
}

// 5) bulk is PER KIND: enabling all MCP must not touch the skills
{
  await caps("POST", { session: "sess-1", kind: "skills", name: "skill-one", enabled: false });
  const bulk = await caps("POST", { session: "sess-1", kind: "mcp", bulk: true, enabled: true });
  console.log("bulk mcp on ->", bulk.status, JSON.stringify({ mcp: bulk.body.mcp?.map((m) => m.name + ":" + m.enabled), skills: bulk.body.skills?.map((s) => s.name + ":" + s.enabled) }));
  check(bulk.status === 200, "bulk must answer 200");
  check((bulk.body.mcp ?? []).every((m) => m.enabled === (m.name !== "beta")), "bulk mcp on must leave globally disabled servers unavailable");
  check(!(JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"))["sess-1"]?.mcp ?? []).includes("beta"), "bulk enable must not persist a grant for globally disabled MCP");
  check((bulk.body.skills ?? []).filter((s) => s.enabled).map((s) => s.name).join(",") === "workspace-skill",
    "bulk mcp on must not change any skill (only the workspace-owned one was already on), got "
      + JSON.stringify((bulk.body.skills ?? []).filter((s) => s.enabled).map((s) => s.name)));

  const bulkOff = await caps("POST", { session: "sess-1", kind: "mcp", bulk: true, enabled: false });
  check((bulkOff.body.mcp ?? []).every((m) => m.enabled === false), "bulk mcp off must disable every MCP server");
  const saved = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check((saved["sess-1"]?.mcp ?? []).length === 0, "an empty MCP allow list must leave no names behind, got " + JSON.stringify(saved["sess-1"]?.mcp));

  const bulkSkills = await caps("POST", { session: "sess-1", kind: "skills", bulk: true, enabled: true });
  check((bulkSkills.body.skills ?? []).every((s) => s.enabled === true), "bulk skills on must enable every skill");
  check((bulkSkills.body.skills ?? []).length === 4, "bulk skills must cover the whole union, got " + (bulkSkills.body.skills ?? []).length);
  const after = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check((after["sess-1"]?.skills ?? []).length === 4, "every enabled skill must be persisted, got " + JSON.stringify(after["sess-1"]?.skills));
  const cleared = await caps("POST", { session: "sess-1", kind: "skills", bulk: true, enabled: false });
  check((cleared.body.skills ?? []).every((s) => s.enabled === false), "bulk skills off must disable every skill");
  const empty = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  const entry = empty["sess-1"];
  check(entry === undefined || ((entry.mcp ?? []).length === 0 && (entry.skills ?? []).length === 0),
    "a session with nothing enabled must leave no names behind, got " + JSON.stringify(entry));
}

// 5b) the host's normal agent shape (no `skills` inject) must not break a switch
{
  const bare = makeBareSkillAgent("sess-bare");
  await preStep(bare);
  const on = await caps("POST", { session: "sess-bare", kind: "skills", name: "skill-one", enabled: true });
  console.log("bare agent toggle ->", on.status, JSON.stringify(on.body.skills?.map((x) => x.name + ":" + x.enabled)));
  check(on.status === 200, "toggling a skill on a context without the skills inject must answer 200, got " + on.status + " " + JSON.stringify(on.body).slice(0, 120));
  check(on.body.skills?.some((x) => x.name === "skill-one" && x.enabled === true), "the switch must still be recorded");
  const off = await caps("POST", { session: "sess-bare", kind: "skills", name: "skill-one", enabled: false });
  check(off.status === 200, "switching it back off must answer 200 too, got " + off.status);
  const guard = bare.guards[0];
  const skipped = warnings.filter((line) => line.includes("skill policy skipped"));
  console.log("policy warnings:", skipped.length);
  check(skipped.length === 0, "reading a skill through a context without the inject must be handled silently, got: " + skipped.join(" | "));
  check(guard !== undefined, "the enforcement guard must still be installed without the skills inject");
  console.log("injected shadows:", bare.injectedShadows.length);
  check(bare.injectedShadows.length > 0, "the shadow must be registered through the injected scope when the agent context cannot read skills directly");
  check(bare.injectedShadows.every((shadow) => shadow.invocation?.modelInvocable === false), "the injected shadow must be model-invisible");
  const denied = await guard({ name: "skill", arguments: { name: "skill-one" } }, async () => "allow");
  check(denied === "deny", "the guard must still deny a switched-off skill");
}

// 6) a per-session decision never leaks into another conversation
{
  await caps("POST", { session: "sess-1", kind: "mcp", name: "alpha", enabled: true });
  const other = await caps("GET", { session: "sess-2" });
  check((other.body.mcp ?? []).every((m) => m.enabled === false), "another conversation must still start closed");
  const decision = await preStep(makeAgent("sess-2"));
  check(catalogText(decision) === "", "another conversation must get no catalog");
}

// 7) a dead ctx.skills getter falls back to the live service
{
  deadSkills = true;
  const res = await caps("GET", { session: "sess-1" });
  console.log("dead ctx.skills ->", res.status, "skills:", (res.body.skills ?? []).length);
  check(res.status === 200, "an inactive ctx.skills must not break the view");
  check((res.body.skills ?? []).length === 4, "the fallback lookup must still list the skills, got " + (res.body.skills ?? []).length);
  deadSkills = false;
}

// 7b) a workspace default seeds a NEW conversation once, and only in that workspace
{
  const save = await caps("POST", { session: "sess-1", kind: "mcp", name: "alpha", enabled: true });
  check(save.status === 200, "priming sess-1 must work");
  const saved = makeRes();
  await routeByPath("/skill-mcp-manager/workspace-defaults").handler(
    makeReq("POST", "/skill-mcp-manager/workspace-defaults", { workspace: currentWorkspace, action: "save-current", session: "sess-1" }),
    saved,
  );
  const presetBody = bodyOf(saved);
  console.log("preset saved ->", saved.status, JSON.stringify(presetBody).slice(0, 200));
  check(saved.status === 200, "saving the workspace default must answer 200");
  check((presetBody.mcp ?? []).includes("alpha"), "the enabled MCP server must be in the default");
  const onDisk = JSON.parse(await readFile(join(dataDir, "workspace-defaults.json"), "utf8"));
  check(Object.keys(onDisk).length === 1, "the default must be persisted, got " + JSON.stringify(Object.keys(onDisk)));

  // a brand-new conversation in the same workspace starts from it
  const fresh = makeAgent("sess-fresh");
  fresh.session.cwd = currentWorkspace;
  await preStep(fresh);
  const freshCaps = await caps("GET", { session: "sess-fresh" });
  console.log("seeded ->", JSON.stringify(freshCaps.body.mcp?.map((m) => m.name + ":" + m.enabled)));
  check(freshCaps.body.mcp?.find((m) => m.name === "alpha")?.enabled === true, "a new conversation must inherit the workspace default");
  // the saved preset lists alpha only, so the workspace's own server is NOT on top of it
  check(freshCaps.body.mcp?.find((m) => m.name === "ws-server")?.enabled === false, "a saved default must win over the workspace-owned set");
  const wsRow = freshCaps.body.mcp?.find((m) => m.name === "ws-server");
  check(wsRow !== undefined && wsRow.source === "workspace", "the workspace-declared server must be listed as a workspace row");
  check(freshCaps.body.workspace !== "", "the view must report the workspace it belongs to");

  // a conversation in another workspace does not
  const elsewhere = makeAgent("sess-elsewhere");
  elsewhere.session.cwd = join(tmp, "workspace-b");
  await preStep(elsewhere);
  const elsewhereCaps = await caps("GET", { session: "sess-elsewhere" });
  check((elsewhereCaps.body.mcp ?? []).every((m) => m.enabled === false), "another workspace must stay closed");

  // an existing conversation keeps its own choice
  await caps("POST", { session: "sess-1", kind: "mcp", name: "alpha", enabled: false });
  await preStep(agent);
  const kept = await caps("GET", { session: "sess-1" });
  check(kept.body.mcp?.find((m) => m.name === "alpha")?.enabled === false, "an existing conversation must not be re-seeded");

  // clearing the default: the next new conversation starts with what the workspace owns
  const cleared1 = makeRes();
  await routeByPath("/skill-mcp-manager/workspace-defaults").handler(
    makeReq("POST", "/skill-mcp-manager/workspace-defaults", { workspace: currentWorkspace, action: "clear" }),
    cleared1,
  );
  const ownedSession = makeAgent("sess-owned");
  ownedSession.session.cwd = currentWorkspace;
  await preStep(ownedSession);
  const ownedCaps = await caps("GET", { session: "sess-owned" });
  console.log("workspace-owned ->", JSON.stringify({
    mcp: ownedCaps.body.mcp?.map((m) => m.name + ":" + m.enabled),
    skills: ownedCaps.body.skills?.map((x) => x.name + ":" + x.enabled),
  }));
  check(ownedCaps.body.mcp?.find((m) => m.name === "ws-server")?.enabled === true, "a workspace-declared server must start ON");
  check(ownedCaps.body.skills?.find((x) => x.name === "workspace-skill")?.enabled === true, "a skill living in the workspace must start ON");
  check(ownedCaps.body.skills?.find((x) => x.name === "skill-one")?.enabled === false, "a skill outside the workspace must stay OFF");
  check(ownedCaps.body.mcp?.find((m) => m.name === "alpha")?.enabled === false, "a global registry server must stay OFF");
  // mcp_load must RESOLVE a workspace-declared server (it fails to connect here, which
  // is fine — the point is that it is not "not registered").
  const load = toolByName.get("mcp_load");
  let wsLoadError = "";
  try {
    await load.execute({ name: "ws-server" }, { agent: ownedSession, signal: { throwIfAborted() {} } });
  } catch (err) {
    wsLoadError = String(err?.message ?? err);
  }
  console.log("mcp_load workspace server ->", wsLoadError.slice(0, 90));
  check(!/not registered/.test(wsLoadError), "mcp_load must resolve a workspace-declared server, got: " + wsLoadError);

  // clearing removes the default
  const cleared = makeRes();
  await routeByPath("/skill-mcp-manager/workspace-defaults").handler(
    makeReq("POST", "/skill-mcp-manager/workspace-defaults", { workspace: currentWorkspace, action: "clear" }),
    cleared,
  );
  const after = JSON.parse(await readFile(join(dataDir, "workspace-defaults.json"), "utf8"));
  check(Object.keys(after).length === 0, "clearing must drop the entry, got " + JSON.stringify(Object.keys(after)));
  const bad = makeRes();
  await routeByPath("/skill-mcp-manager/workspace-defaults").handler(
    makeReq("POST", "/skill-mcp-manager/workspace-defaults", { workspace: currentWorkspace, action: "nope" }),
    bad,
  );
  check(bad.status === 400, "an unknown action must be refused");
}

// Delegated agents must inherit the actual conversation policy, not the workspace default.
{
  const parent = makeAgent("caps-parent");
  parent.session.header = { id: "caps-parent", cwd: currentWorkspace, isSeeded: false };
  await preStep(parent);
  await caps("POST", { session: "caps-parent", kind: "mcp", name: "alpha", enabled: true });
  await caps("POST", { session: "caps-parent", kind: "mcp", name: "sequential", enabled: true });
  await caps("POST", { session: "caps-parent", kind: "skills", name: "skill-one", enabled: true });
  for (const mode of ["spawn", "fork"]) {
    const child = makeAgent("caps-child-" + mode);
    child.session.header = { id: child.session.id, parentSession: "caps-parent", origin: "subagent", isSeeded: mode === "fork" };
    const decision = await preStep(child);
    const state = await caps("GET", { session: child.session.id });
    check(state.body.mcp.find((x) => x.name === "alpha")?.enabled === true, mode + " child must inherit registry MCP switch");
    check(state.body.mcp.find((x) => x.name === "sequential")?.enabled === true, mode + " child must inherit plugin MCP switch");
    check(state.body.skills.find((x) => x.name === "skill-one")?.enabled === true, mode + " child must inherit skill switch");
    check(catalogText(decision).includes("alpha"), mode + " child's actual catalog must advertise the inherited MCP");
    check(!child.shadows.some((x) => x.name === "skill-one"), mode + " child must not shadow inherited enabled skill");
    check(await child.guards[0]({ name: "skill", arguments: { name: "skill-one" } }, async () => "allow") === "allow", mode + " child's actual skill guard must allow inherited skill");
    check(await child.guards[0]({ name: "mcp__sequential__think" }, async () => "allow") === "allow", mode + " child's native MCP guard must allow inherited server");
    if (mode === "fork") {
      // An explicit child choice detaches a snapshot, including the OTHER kind.
      await caps("POST", { session: child.session.id, kind: "skills", name: "skill-one", enabled: false });
    }
  }
  const concurrent = Array.from({ length: 6 }, (_, index) => {
    const child = makeAgent("caps-parallel-" + index);
    child.session.header = { id: child.session.id, parentSession: "caps-parent", origin: "subagent", isSeeded: false };
    return child;
  });
  check(createdAgents.length > 0, "child policy must be established on agent/created");
  await Promise.all(concurrent.map(async (child) => {
    for (const listener of createdAgents) await listener({ agent: child });
    check((await caps("GET", { session: child.session.id })).body.mcp.find((x) => x.name === "alpha")?.enabled === true,
      "created lifecycle must inherit before the child's first pre-step");
  }));
  const parallelSaved = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check(concurrent.every((child) => parallelSaved[child.session.id]?.inheritFrom === "caps-parent"), "concurrent sibling creation must persist every relationship");
  check(!warnings.some((line) => line.includes("cannot persist session capabilities")), "concurrent policy writes must not collide on the temp file");
  const grandchild = makeAgent("caps-grandchild");
  grandchild.session.header = { id: grandchild.session.id, parentSession: "caps-child-spawn", origin: "subagent", isSeeded: false };
  await preStep(grandchild);
  check((await caps("GET", { session: grandchild.session.id })).body.mcp.find((x) => x.name === "alpha")?.enabled === true, "nested child must resolve the inherited chain");
  await caps("POST", { session: "caps-parent", kind: "mcp", bulk: true, enabled: false });
  await caps("POST", { session: "caps-parent", kind: "skills", name: "skill-one", enabled: false });
  const spawnState = await caps("GET", { session: "caps-child-spawn" });
  const forkState = await caps("GET", { session: "caps-child-fork" });
  check(spawnState.body.mcp.find((x) => x.name === "alpha")?.enabled === false, "inheriting child must follow parent's disable immediately");
  check(forkState.body.mcp.find((x) => x.name === "alpha")?.enabled === true, "explicit child policy must preserve its detached MCP snapshot");
  check(forkState.body.skills.find((x) => x.name === "skill-one")?.enabled === false, "explicit child choice must stay off");
  check(await grandchild.guards[0]({ name: "skill", arguments: { name: "skill-one" } }, async () => "allow") === "deny", "existing descendant guard must read live parent revocation");
  check(await grandchild.guards[0]({ name: "mcp__sequential__think" }, async () => "allow") === "deny", "descendant native MCP guard must read live bulk revocation");
  let denied = "";
  try { await toolByName.get("mcp_load").execute({ name: "alpha", peek: true }, { agent: grandchild }); }
  catch (error) { denied = String(error.message); }
  check(/off for this conversation/.test(denied), "descendant mcp_load must refuse after parent disables");
  const before = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check(before["caps-child-spawn"]?.inheritFrom === "caps-parent", "parent relation must be persisted, not a process-only cache");
  check(before["caps-grandchild"]?.inheritFrom === "caps-child-spawn", "nested relation must be persisted");
  check(before["caps-child-fork"]?.inheritFrom === undefined, "explicit child policy must stop inheriting");
  const unrelated = makeAgent("caps-unrelated");
  unrelated.session.cwd = join(tmp, "workspace-b");
  unrelated.session.header = { id: unrelated.session.id, parentSession: "caps-child-fork", isSeeded: true };
  await preStep(unrelated);
  check(!(await caps("GET", { session: unrelated.session.id })).body.mcp.some((x) => x.enabled), "ordinary session forks must not inherit subagent permissions just because they have parentSession");
  console.log("subagent inheritance: spawn, fork, nested, live revocation, explicit override and isolation checked");
}

// Existing pre-upgrade children must not stay closed just because seeded=true.
{
  for (const id of ["legacy-child", "legacy-explicit", "legacy-custom"]) {
    const child = makeAgent(id);
    child.session.header = { id, parentSession: "legacy-parent", origin: "subagent", isSeeded: false };
    const decision = await preStep(child);
    const state = (await caps("GET", { session: id })).body;
    check(state.mcp.find((x) => x.name === "alpha")?.enabled === (id === "legacy-child"),
      "upgrade must migrate old empty auto-policy, but preserve explicit/custom child: " + id);
    if (id === "legacy-child") {
      check(catalogText(decision).includes("alpha"), "migrated child's actual catalog must inherit");
      check(await child.guards[0]({ name: "skill", arguments: { name: "skill-one" } }, async () => "allow") === "allow",
        "migrated child's skill guard must inherit");
    }
  }
  const saved = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check(saved["legacy-child"].inheritFrom === "legacy-parent", "legacy migration must persist parent relationship");
  check(saved["legacy-explicit"].explicit === true && !saved["legacy-explicit"].inheritFrom,
    "explicit empty policy marker must survive loading and migration");
  await caps("POST", { session: "legacy-child", kind: "skills", name: "skill-one", enabled: false });
  const detached = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check(detached["legacy-child"].explicit === true, "manual edits must mark even an empty child choice explicit");
  console.log("legacy children: seeded empty migrated; explicit empty and custom grants preserved");
}

// 7c) a pin scopes a registry entry to one workspace
{
  const pinned = makeRes();
  await routeByPath("/skill-mcp-manager/mcp/workspace").handler(
    makeReq("POST", "/skill-mcp-manager/mcp/workspace", { name: "alpha", workspace: join(tmp, "workspace-b") }),
    pinned,
  );
  check(pinned.status === 200, "pinning must answer 200, got " + pinned.status + " " + JSON.stringify(bodyOf(pinned)));
  const here = await caps("GET", { session: "sess-1" });
  check(!(here.body.mcp ?? []).some((m) => m.name === "alpha"), "a server pinned elsewhere must not be listed here");
  const there = makeAgent("sess-pinned");
  there.session.cwd = join(tmp, "workspace-b");
  await preStep(there);
  const thereCaps = await caps("GET", { session: "sess-pinned" });
  check((thereCaps.body.mcp ?? []).some((m) => m.name === "alpha"), "the pinned workspace must still list it");
  const saved = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
  check((saved.entries ?? []).some((e) => e.name === "alpha" && e.workspace !== ""), "the pin must be persisted on the entry");
  // unpin restores it everywhere
  const unpin = makeRes();
  await routeByPath("/skill-mcp-manager/mcp/workspace").handler(makeReq("POST", "/skill-mcp-manager/mcp/workspace", { name: "alpha", workspace: "" }), unpin);
  const back = await caps("GET", { session: "sess-1" });
  check((back.body.mcp ?? []).some((m) => m.name === "alpha"), "unpinning must make it global again");
}

// 7d) 详情: tools for MCP, body for a skill
{
  const mcp = await caps("GET", {}, "/skill-mcp-manager/capability-detail?session=sess-1&kind=mcp&name=alpha");
  console.log("mcp detail:", JSON.stringify(mcp.body).slice(0, 160));
  check(mcp.status === 200, "the MCP detail must answer 200, got " + mcp.status + " " + JSON.stringify(mcp.body).slice(0, 120));
  check(Array.isArray(mcp.body.tools) && mcp.body.tools.length === 1, "the fixture server's one tool must be listed, got " + JSON.stringify(mcp.body.tools));
  check(mcp.body.tools[0].name === "ping", "the tool name must survive");
  check(mcp.body.loaded === true, "a server with a snapshot must read as loaded");
  check(mcp.body.transport === "streamable-http", "the transport must be reported");

  const skill = await caps("GET", {}, "/skill-mcp-manager/capability-detail?session=sess-1&kind=skills&name=skill-one");
  console.log("skill detail:", JSON.stringify({ name: skill.body.name, path: skill.body.path, content: String(skill.body.content).slice(0, 20) }));
  check(skill.status === 200, "the skill detail must answer 200, got " + skill.status);
  check(skill.body.content === "# one", "the skill body must come back, got " + JSON.stringify(skill.body.content));
  check(skill.body.path !== "", "the skill path must come back");
  check(skill.body.readonly === false, "a user skill is not read-only");

  const missing = await caps("GET", {}, "/skill-mcp-manager/capability-detail?session=sess-1&kind=skills&name=nope");
  check(missing.status === 400, "an unknown skill must be refused, got " + missing.status);
  const badKind = await caps("GET", {}, "/skill-mcp-manager/capability-detail?session=sess-1&kind=nope&name=alpha");
  check(badKind.status === 400, "an unknown kind must be refused");
}

// 7e) a plugin row with no self-reported description names its owner instead of
// leaving a blank line on the card
{
  const state = await caps("GET", { session: "sess-1" });
  const pluginRow = state.body.mcp.find((row) => row.source === "plugin");
  console.log("plugin row description:", pluginRow?.description);
  check(pluginRow !== undefined, "the fixture must expose a plugin row");
  check(/注入 · 服务器未自报描述$/.test(pluginRow.description), "a plugin row must name its owner, got " + JSON.stringify(pluginRow.description));
  check(state.body.mcp.find((row) => row.source === "registry").description !== "", "a registry row keeps the server's own description");
}

// 8) bad input is refused
{
  const badKind = await caps("POST", { session: "sess-1", kind: "nope", name: "alpha", enabled: true });
  check(badKind.status === 400, "an unknown kind must be refused");
  const badSession = await caps("POST", { kind: "mcp", name: "alpha", enabled: true });
  check(badSession.status === 400, "a missing session must be refused");
  const unknown = await caps("POST", { session: "sess-1", kind: "mcp", name: "nope", enabled: true });
  check(unknown.status === 400, "an unknown MCP name must be refused");
}

// Library defaults seed only NEW roots; existing choices, workspace presets and
// delegated parent policy keep priority, and disabled catalog items stay off.
{
  const settings = routeByPath("/skill-mcp-manager/settings");
  const read = makeRes();
  await settings.handler(makeReq("GET", "/skill-mcp-manager/settings"), read);
  check(bodyOf(read).inheritLibraryDefaults === false, "library defaults must be opt-in for existing installations");
  const oldBlank = makeAgent("library-default-existing-blank");
  for (const listener of createdAgents) await listener({ agent: oldBlank, source: "startup" });
  const enabled = makeRes();
  await settings.handler(makeReq("POST", "/skill-mcp-manager/settings", { inheritLibraryDefaults: true }), enabled);
  check(bodyOf(enabled).inheritLibraryDefaults === true, "library defaults switch must be accepted and returned");
  const saved = JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8"));
  check(saved.inheritLibraryDefaults === true, "library defaults must persist across restart");
  const oldWorkspace = currentWorkspace;
  currentWorkspace = join(tmp, "library-default-workspace");
  await preStep(oldBlank);
  check(!(await caps("GET", { session: oldBlank.session.id })).body.mcp.find((x) => x.name === "alpha")?.enabled,
    "a blank conversation created before opt-in must also keep the old baseline");
  const created = makeAgent("library-default-created");
  created.session.header = { id: created.session.id, cwd: currentWorkspace };
  for (const listener of createdAgents) await listener({ agent: created, source: "startup" });
  const createdCaps = (await caps("GET", { session: created.session.id })).body;
  check(createdCaps.mcp.find((x) => x.name === "alpha")?.enabled === true, "newly created root must be initialized before its first turn");
  check(createdCaps.live && createdCaps.workspace === currentWorkspace && createdCaps.skills.find((x) => x.name === "only-conversation")?.enabled === true,
    "before the first turn the capability panel must already use the new agent's workspace and skill scope");
  const readPreset = () => caps("GET", undefined, "/skill-mcp-manager/workspace-defaults?workspace=" + encodeURIComponent(currentWorkspace));
  check((await readPreset()).body.configured === false, "no saved workspace preset must report unconfigured, not a saved empty preset");
  await mkdir(currentWorkspace, { recursive: true });
  await writeFile(join(currentWorkspace, ".mcp.json"), JSON.stringify({ mcpServers: { "library-project-server": { command: "node", args: ["fixture.js"] } } }), "utf8");
  const resumed = makeAgent("library-default-resumed-no-policy");
  resumed.session.header = { id: resumed.session.id, cwd: currentWorkspace };
  for (const listener of createdAgents) await listener({ agent: resumed, source: "resume" });
  const resumedCaps = (await caps("GET", { session: resumed.session.id })).body;
  check(!resumedCaps.mcp.some((x) => x.source !== "workspace" && x.enabled), "resuming an old conversation without a prior plugin policy must not acquire library defaults");
  await preStep(resumed);
  check(!(await caps("GET", { session: resumed.session.id })).body.mcp.find((x) => x.name === "alpha")?.enabled,
    "pre-step fallback must not turn a resumed conversation into a new one");
  const root = makeAgent("library-default-root");
  skills["skill-one"].invocation.modelInvocable = false;
  await preStep(root);
  let state = (await caps("GET", { session: root.session.id })).body;
  check(state.mcp.find((x) => x.name === "alpha")?.enabled === true, "new root must inherit enabled registry MCP");
  check(state.mcp.find((x) => x.name === "library-project-server")?.enabled === true, "library preset must preserve the workspace server baseline");
  check(state.mcp.find((x) => x.name === "beta")?.enabled === false, "globally stopped MCP must not enter defaults");
  check(state.mcp.find((x) => x.name === "sequential")?.enabled === true, "new root must inherit enabled plugin MCP");
  check(state.skills.find((x) => x.name === "only-conversation")?.enabled === true, "new root must inherit its provider skills");
  check(state.skills.find((x) => x.name === "skill-one")?.enabled === false, "globally model-hidden skill must stay off");
  await caps("POST", { session: root.session.id, kind: "mcp", name: "alpha", enabled: false });
  await preStep(root);
  state = (await caps("GET", { session: root.session.id })).body;
  check(state.mcp.find((x) => x.name === "alpha")?.enabled === false, "library default must not overwrite an existing root choice");
  const child = makeAgent("library-default-child");
  child.session.header = { id: child.session.id, origin: "subagent", parentSession: root.session.id };
  await preStep(child);
  check(!(await caps("GET", { session: child.session.id })).body.mcp.find((x) => x.name === "alpha")?.enabled,
    "child must follow parent choice instead of library defaults");
  const preset = makeRes();
  await routeByPath("/skill-mcp-manager/workspace-defaults").handler(makeReq("POST", "/skill-mcp-manager/workspace-defaults", { workspace: currentWorkspace, action: "save-current", session: root.session.id }), preset);
  check((await readPreset()).body.configured === true, "a saved workspace preset must be reported explicitly");
  const workspaceRoot = makeAgent("library-default-workspace-root");
  await preStep(workspaceRoot);
  check(!(await caps("GET", { session: workspaceRoot.session.id })).body.mcp.find((x) => x.name === "alpha")?.enabled,
    "explicit workspace default must override the library fallback");
  const cleared = makeRes();
  await routeByPath("/skill-mcp-manager/workspace-defaults").handler(makeReq("POST", "/skill-mcp-manager/workspace-defaults", { workspace: currentWorkspace, action: "clear" }), cleared);
  check((await readPreset()).body.configured === false, "clearing the workspace preset must restore the library fallback in the view");
  pluginEnabled = false;
  const next = makeAgent("library-default-next");
  await preStep(next);
  check(!(await caps("GET", { session: next.session.id })).body.mcp.find((x) => x.name === "sequential")?.enabled,
    "next root must read latest library switches, not an old captured snapshot");
  pluginEnabled = true;
  skills["skill-one"].invocation.modelInvocable = true;
  const bad = makeRes();
  await settings.handler(makeReq("POST", "/skill-mcp-manager/settings", { inheritLibraryDefaults: "yes" }), bad);
  check(bad.status === 400, "library default flag must reject non-booleans");
  const off = makeRes();
  await settings.handler(makeReq("POST", "/skill-mcp-manager/settings", { inheritLibraryDefaults: false }), off);
  const closed = makeAgent("library-default-off");
  await preStep(closed);
  check(!(await caps("GET", { session: closed.session.id })).body.mcp.some((x) => x.source !== "workspace" && x.enabled), "disabling library defaults restores closed global capabilities while preserving workspace baseline");
  await rm(join(currentWorkspace, ".mcp.json"));
  currentWorkspace = oldWorkspace;
}

// Reload must preserve inherited relations, detached overrides, empty choices and
// fail-closed handling of damaged chains; it must not reseed from the workspace.
{
  const stored = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  stored["caps-cycle-a"] = { mcp: ["alpha"], skills: ["skill-one"], seeded: true, inheritFrom: "caps-cycle-b" };
  stored["caps-cycle-b"] = { mcp: ["alpha"], skills: ["skill-one"], seeded: true, inheritFrom: "caps-cycle-a" };
  stored["caps-missing"] = { mcp: ["alpha"], skills: [], seeded: true, inheritFrom: "caps-absent" };
  await writeFile(join(dataDir, "session-caps.json"), JSON.stringify(stored), "utf8");
  const restoredRoutes = [];
  const restoredWeb = { register(route) {
    if (restoredRoutes.some((x) => x.path === route.path && x.kind === route.kind)) throw new Error("duplicate route " + route.path);
    restoredRoutes.push(route); return () => {};
  } };
  const restoredCtx = { ...ctx, webServer: restoredWeb,
    get(name) { return name === "webServer" ? restoredWeb : ctx.get(name); },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names];
      if (list.includes("webServer")) callback({ ...restoredCtx, webServer: restoredWeb });
      if (list.includes("loader")) callback({ loader: fakeLoader });
      return () => {};
    },
  };
  await apply(restoredCtx, { dataDir, profile: "__test__", importNativeMcp: false });
  const route = restoredRoutes.find((x) => x.path === "/skill-mcp-manager/session-caps");
  const request = async (method, session, extra = {}) => {
    const res = makeRes();
    await route.handler(makeReq(method, "/skill-mcp-manager/session-caps?session=" + session, method === "POST" ? { session, ...extra } : undefined), res);
    check(res.status === 200, "restored policy route must answer 200");
    return bodyOf(res);
  };
  const detached = await request("GET", "caps-child-fork");
  check(detached.mcp.find((x) => x.name === "alpha")?.enabled === true, "detached child policy must survive reload");
  await request("POST", "caps-parent", { kind: "mcp", name: "alpha", enabled: true });
  for (const id of ["caps-child-spawn", "caps-grandchild"]) {
    const state = await request("GET", id);
    check(state.mcp.find((x) => x.name === "alpha")?.enabled === true, "restored descendants must resolve live parent changes: " + id);
  }
  for (const id of ["caps-cycle-a", "caps-missing"]) {
    const state = await request("GET", id);
    check(!state.mcp.some((x) => x.enabled) && !state.skills.some((x) => x.enabled), "broken parent chain must fail closed: " + id);
  }
  console.log("subagent inheritance persistence: reload, live parent changes, detached override, missing parent and cycle checked");
}

// Modern hosts removed standingKeyFor; all preset reads must retain/release a lease.
{
  modernPresets = true;
  const res = await caps("GET", { session: "sess-modern-cold" });
  check(res.status === 200 && res.body.skills?.some((s) => s.name === "only-standing"), "modern preset-only skill must appear without a live agent");
  const response = makeRes();
  await routeByPath("/skill-mcp-manager/skills").handler(makeReq("GET", "/skill-mcp-manager/skills"), response);
  check(bodyOf(response).skills?.some((s) => s.name === "only-standing"), "library must use modern preset scope too");
  check(presetAcquires >= 2, "supported acquireScope must be used instead of a silent global fallback");
  check(presetLeases === 0, "all preset scope leases must be released after reads");
  modernPresets = false;
}

// A persisted library default must survive a full plugin apply, not only one process variable.
{
  const stored = JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8"));
  stored.inheritLibraryDefaults = true;
  await writeFile(join(dataDir, "settings.json"), JSON.stringify(stored), "utf8");
  const reloadRoutes = [], reloadCreated = [];
  const web = { register(route) { reloadRoutes.push(route); return () => {}; } };
  const reloadCtx = { ...ctx, webServer: web,
    on(event, fn) { if (event === "agent/created") reloadCreated.push(fn); return () => {}; },
    get(name) { return name === "webServer" ? web : ctx.get(name); },
    inject(names, fn) { if (names.includes("webServer")) fn({ ...reloadCtx, webServer: web }); if (names.includes("loader")) fn({ loader: fakeLoader }); return () => {}; },
  };
  await apply(reloadCtx, { dataDir, profile: "__test__", importNativeMcp: false });
  const agent = makeAgent("library-default-reloaded");
  agent.session.header = { id: agent.session.id, cwd: join(tmp, "reload-workspace") };
  for (const fn of reloadCreated) await fn({ agent });
  const saved = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check(saved[agent.session.id]?.mcp.includes("alpha"), "persisted default must seed new conversations after reload");
}

for (const disposer of effects) { try { await disposer(); } catch { /* best effort */ } }
await rm(tmp, { recursive: true, force: true });
if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("SESSION CAPS SMOKE FAILED");
  process.exit(1);
}
console.log("SESSION CAPS SMOKE PASSED");
