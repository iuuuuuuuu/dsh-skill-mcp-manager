// Per-conversation capability policy: a conversation can drop individual MCP
// servers and skills. Covers the four apply points that make the switch real —
// catalog injection, eager/on-demand mounting, mcp_load/mcp_call, and the skill
// loader guard — plus the persisted policy file and the session-layer shadow that
// hides a denied skill from the catalog. The agent objects are the same fakes the
// session-isolation test uses (no live harness needed).

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const tmp = join(process.cwd(), `.test-session-caps-${process.pid}`);
const dataDir = join(tmp, "data");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

const entry = (name, tier) => ({
  id: name, name, tier, transport: "stdio", command: "node", args: [], env: {}, cwd: null,
  url: null, headers: {}, notes: "", tools: [{ name: "ping", description: "Ping" }], disabledTools: [],
  serverName: "", serverVersion: "", serverDescription: "fixture " + name, instructions: "",
  metaFetchedAt: "2026-01-01T00:00:00.000Z",
});
await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [entry("alpha", "on-demand"), entry("beta", "disabled")],
}, null, 2)}\n`, "utf8");

const skills = {
  "skill-one": { name: "skill-one", description: "First fixture", path: join(tmp, "one", "SKILL.md"), provider: "filesystem", invocation: { modelInvocable: true, userInvocable: true }, content: "# one" },
  "skill-two": { name: "skill-two", description: "Second fixture", path: join(tmp, "two", "SKILL.md"), provider: "filesystem", invocation: { modelInvocable: true, userInvocable: true }, content: "# two" },
};

function makeAgent(sessionId) {
  const guards = [];
  const shadows = [];
  const disposed = [];
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
          return () => { disposed.push(skill.name); };
        },
      },
      effect(fn) { fn(); return () => {}; },
    },
    session: { id: sessionId, surface: { nodes: [] }, eventAt: () => undefined },
    guards,
    shadows,
    disposed,
  };
  return agent;
}

const routes = [];
const effects = [];
const toolByName = new Map();
const ctx = {
  tools: { register(definition) { toolByName.set(definition.name, definition); return () => {}; } },
  skills: {
    registerProvider() { return () => {}; },
    async list() { return Object.values(skills).map((s) => ({ name: s.name, description: s.description, invocation: s.invocation, provider: s.provider })); },
    async get(name) { return skills[name]; },
  },
  on(event, handler) {
    if (event === "agent/pre-step") preSteps.push(handler);
    return () => {};
  },
  effect(fn) { const d = fn(); if (typeof d === "function") effects.push(d); return () => {}; },
  get(name) {
    if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};
const preSteps = [];
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
const capsRoute = () => routeByPath("/skill-mcp-manager/session-caps");

async function preStep(agent) {
  const decision = { kind: "continue", messages: [] };
  let captured = decision;
  for (const listener of preSteps) {
    captured = await listener({ agent, signal: { throwIfAborted() {} } }, async () => captured);
  }
  return captured;
}

await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 50));

const agent = makeAgent("sess-1");
check(capsRoute() !== undefined, "missing route /skill-mcp-manager/session-caps");

// 1) the list: enabled entries only, everything allowed at first
{
  const res = makeRes();
  await capsRoute().handler(makeReq("GET", "/skill-mcp-manager/session-caps?session=sess-1"), res);
  const body = bodyOf(res);
  console.log("initial:", JSON.stringify({ mcp: body.mcp?.map((m) => m.name + ":" + m.enabled), skills: body.skills?.map((s) => s.name + ":" + s.enabled) }));
  check(res.status === 200, "GET session-caps must answer 200");
  check(!(body.mcp ?? []).some((m) => m.name === "beta"), "a globally disabled entry must not appear in the conversation view");
  check((body.mcp ?? []).every((m) => m.enabled), "everything starts allowed");
  check((body.skills ?? []).length === 2, "both fixture skills must be listed");
}

// 2) deny one MCP server: catalog drops it, mcp_load refuses it, policy persisted
{
  await preStep(agent);
  const res = makeRes();
  await capsRoute().handler(makeReq("POST", "/skill-mcp-manager/session-caps", { session: "sess-1", kind: "mcp", name: "alpha", enabled: false }), res);
  const body = bodyOf(res);
  console.log("deny alpha ->", res.status, JSON.stringify(body.mcp?.map((m) => m.name + ":" + m.enabled)));
  check(res.status === 200 && body.mcp?.find((m) => m.name === "alpha")?.enabled === false, "alpha must read as disabled for this conversation");
  const saved = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check((saved["sess-1"]?.mcp ?? []).includes("alpha"), "the policy must be persisted per session");
  const decision = await preStep(agent);
  const text = (decision.messages ?? []).map((m) => m.content?.[0]?.text ?? "").join("\n");
  check(!text.includes("alpha"), "the catalog must not advertise a denied server");
  check(text === "", "with nothing left visible there must be no catalog message at all");
}

// 3) mcp_load refuses a denied server in that conversation
{
  const load = toolByName.get("mcp_load");
  check(load !== undefined, "mcp_load tool must be registered");
  if (load !== undefined) {
    let error = "";
    try {
      await load.execute({ name: "alpha" }, { agent, signal: { throwIfAborted() {} } });
    } catch (err) {
      error = String(err?.message ?? err);
    }
    console.log("mcp_load denied ->", error);
    check(/disabled in this conversation/.test(error), "mcp_load must refuse a denied server, got: " + error);
  }
}

// 4) deny one skill: the scoped guard refuses it, the shadow hides it
{
  const res = makeRes();
  await capsRoute().handler(makeReq("POST", "/skill-mcp-manager/session-caps", { session: "sess-1", kind: "skills", name: "skill-one", enabled: false }), res);
  console.log("deny skill ->", res.status, JSON.stringify(bodyOf(res).skills?.map((s) => s.name + ":" + s.enabled)));
  await preStep(agent);
  check(agent.guards.length === 1, "exactly one pre-execute guard per agent, got " + agent.guards.length);
  const guard = agent.guards[0];
  const denied = await guard({ name: "skill", arguments: { name: "skill-one" } }, async () => "allow");
  const allowed = await guard({ name: "skill", arguments: { name: "skill-two" } }, async () => "allow");
  const otherTool = await guard({ name: "mcp_load", arguments: { name: "skill-one" } }, async () => "allow");
  console.log("guard:", denied, allowed, otherTool);
  check(denied === "deny", "the guard must deny a denied skill");
  check(allowed === "allow", "the guard must pass an allowed skill through");
  check(otherTool === "allow", "the guard must not touch other tools");
  check(agent.shadows.some((s) => s.name === "skill-one" && s.invocation?.modelInvocable === false), "a shadow with modelInvocable=false must be registered");
  const decision = await preStep(agent);
  check((decision.messages ?? []).every((m) => !String(m.content?.[0]?.text ?? "").includes("mcp-catalog")), "skill policy must not touch the MCP catalog");
}

// 5) re-enabling everything restores the previous state and clears the shadows
{
  for (const [kind, name] of [["mcp", "alpha"], ["skills", "skill-one"]]) {
    const res = makeRes();
    await capsRoute().handler(makeReq("POST", "/skill-mcp-manager/session-caps", { session: "sess-1", kind, name, enabled: true }), res);
    check(res.status === 200, `re-enabling ${kind}/${name} must answer 200`);
  }
  await preStep(agent);
  console.log("after restore: disposed=", agent.disposed.join(","), "| guards=", agent.guards.length);
  check(agent.disposed.includes("skill-one"), "re-enabling must dispose the shadow");
  const saved = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check(saved["sess-1"] === undefined, "an empty policy must be dropped from the file");
  const decision = await preStep(agent);
  const text = (decision.messages ?? []).map((m) => m.content?.[0]?.text ?? "").join("\n");
  check(text.includes("alpha"), "the catalog must advertise the server again");
}

// 6) one-click: bulk off removes both kinds, bulk on restores them
{
  const off = makeRes();
  await capsRoute().handler(makeReq("POST", "/skill-mcp-manager/session-caps", { session: "sess-1", bulk: true, enabled: false }), off);
  const body = bodyOf(off);
  console.log("bulk off ->", off.status, JSON.stringify({ mcp: body.mcp?.map((m) => m.name + ":" + m.enabled), skills: body.skills?.map((x) => x.name + ":" + x.enabled) }));
  check(off.status === 200, "bulk off must answer 200");
  check((body.mcp ?? []).every((m) => m.enabled === false), "bulk off must disable every MCP server");
  check((body.skills ?? []).every((x) => x.enabled === false), "bulk off must disable every skill");
  const saved = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check((saved["sess-1"]?.mcp ?? []).includes("alpha"), "bulk off must persist the MCP denials");
  check((saved["sess-1"]?.skills ?? []).length === 2, "bulk off must persist every skill denial, got " + JSON.stringify(saved["sess-1"]?.skills));
  const guard = agent.guards[0];
  const denied = await guard({ name: "skill", arguments: { name: "skill-two" } }, async () => "allow");
  check(denied === "deny", "after bulk off the guard must deny any skill");

  const on = makeRes();
  await capsRoute().handler(makeReq("POST", "/skill-mcp-manager/session-caps", { session: "sess-1", bulk: true, enabled: true }), on);
  const restored = bodyOf(on);
  console.log("bulk on ->", on.status, JSON.stringify({ mcp: restored.mcp?.map((m) => m.name + ":" + m.enabled), skills: restored.skills?.map((x) => x.name + ":" + x.enabled) }));
  check((restored.mcp ?? []).every((m) => m.enabled === true), "bulk on must enable every MCP server");
  check((restored.skills ?? []).every((x) => x.enabled === true), "bulk on must enable every skill");
  const savedAfter = JSON.parse(await readFile(join(dataDir, "session-caps.json"), "utf8"));
  check(savedAfter["sess-1"] === undefined, "bulk on must clear the session from the policy file");
  const allowed = await guard({ name: "skill", arguments: { name: "skill-two" } }, async () => "allow");
  check(allowed === "allow", "after bulk on the guard must allow the skill again");
}

for (const disposer of effects) { try { await disposer(); } catch { /* best effort */ } }
await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("SESSION CAPS SMOKE FAILED");
  process.exit(1);
}
console.log("SESSION CAPS SMOKE PASSED");
