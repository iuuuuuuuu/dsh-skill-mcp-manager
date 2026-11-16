// Per-session MCP instances: two agents each get their own stdio server
// process; a call in A does not see B's runtime, disposing A does not drop B,
// and UI snapshot refresh does not leave a shared live instance.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const tmp = join(process.cwd(), `.test-session-isolate-${process.pid}`);
const dataDir = join(tmp, "data");
const serverPath = join(tmp, "server.mjs");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const id = "pid-" + process.pid + "-" + Math.random().toString(16).slice(2);
const server = new Server({ name: "session-isolate-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "whoami", description: "Return this process id", inputSchema: { type: "object", additionalProperties: false } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: id }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [
    {
      id: "demo",
      name: "demo",
      tier: "on-demand",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {},
      cwd: process.cwd(),
      notes: "",
      tools: [{ name: "whoami", description: "Return this process id" }],
      disabledTools: [],
      serverDescription: "test server",
      metaFetchedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
}, null, 2)}\n`, "utf8");

const registrations = [];
const routes = [];
const effects = [];
let preStep;
const ctx = {
  tools: {
    register(definition) {
      const record = { definition, active: true };
      registrations.push(record);
      return () => { record.active = false; };
    },
  },
  skills: { registerProvider() { return () => {}; } },
  on(event, handler) {
    if (event === "agent/pre-step") preStep = handler;
    return () => {};
  },
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === "function") effects.push(disposer);
    return () => {};
  },
  get(name) {
    if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

function makeAgent(id, parentSession) {
  const sessionEffects = [];
  const agent = {
    ctx: {
      tools: {
        register(definition) {
          const record = { definition, active: true, agent };
          registrations.push(record);
          return () => { record.active = false; };
        },
      },
      effect(fn) {
        const disposer = fn();
        if (typeof disposer === "function") sessionEffects.push(disposer);
        return () => {};
      },
    },
    session: {
      ...(id === undefined ? {} : { id, header: { id, ...(parentSession === undefined ? {} : { parentSession, origin: "subagent" }) } }),
      seq: 0, surface: { nodes: [] }, eventAt() { return undefined; },
    },
    sessionEffects,
  };
  return agent;
}

function makeReq(path, body) {
  const chunks = [Buffer.from(JSON.stringify(body), "utf8")];
  let index = 0;
  return {
    method: "POST",
    url: path,
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() {
      return { async next() { return index < chunks.length ? { value: chunks[index++], done: false } : { done: true }; } };
    },
  };
}

function makeRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (body) => { res.body = body ?? ""; };
  return res;
}

const failed = [];
try {
  await apply(ctx, {
    dataDir,
    profile: "__test__",
    importNativeMcp: false,
    trialTimeoutMs: 5000,
    toolCallTimeoutMs: 5000,
  });

  if (routes.some((route) => route.path === "/skill-mcp-manager/mcp/disconnect")) {
    failed.push("disconnect route should be removed");
  }

  const mcpLoad = registrations.find((record) => record.definition.name === "mcp_load")?.definition;
  const mcpCall = registrations.find((record) => record.definition.name === "mcp_call")?.definition;
  if (!mcpLoad || !mcpCall) failed.push("bridge tools missing");

  const agentA = makeAgent();
  const agentB = makeAgent();
  await preStep({ agent: agentA, signal: { throwIfAborted() {} } }, async () => ({ kind: "enter", messages: [] }));
  await preStep({ agent: agentB, signal: { throwIfAborted() {} } }, async () => ({ kind: "enter", messages: [] }));

  await mcpLoad.execute({ name: "demo" }, { agent: agentA });
  await mcpLoad.execute({ name: "demo" }, { agent: agentB });
  const whoami = { name: "demo", tool: "whoami", args: {} };
  const callText = async (agent) => {
    const value = await mcpCall.execute(whoami, { signal: new AbortController().signal, agent });
    return mcpCall.output.render(whoami, value).map((block) => block.text ?? "").join("\n");
  };
  const idA = await callText(agentA);
  const idB = await callText(agentB);
  if (!idA || !idB) failed.push("whoami returned empty id");
  if (idA === idB) failed.push(`sessions shared one MCP process: ${idA}`);

  for (const dispose of agentA.sessionEffects.reverse()) await dispose();
  let afterA = "";
  try {
    afterA = await callText(agentA);
  } catch (error) {
    afterA = String(error?.message ?? error);
  }
  if (!/not loaded/.test(afterA)) failed.push(`disposing A should drop A's instance: ${afterA}`);
  const stillB = await callText(agentB);
  if (stillB !== idB) failed.push(`disposing A affected B: ${stillB}`);

  const loadRoute = routes.find((route) => route.path === "/skill-mcp-manager/mcp/load");
  const res = makeRes();
  await loadRoute.handler(makeReq("/skill-mcp-manager/mcp/load", { name: "demo" }), res);
  const body = res.body ? JSON.parse(res.body) : {};
  if (res.status !== 200 || body.ok !== true) failed.push(`refresh snapshot failed: ${body.error || res.status}`);
  const stillBAfterRefresh = await callText(agentB);
  if (stillBAfterRefresh !== idB) failed.push(`snapshot refresh replaced B's instance: ${stillBAfterRefresh}`);
  // Real SDK transport + real child policy: no call is mocked. Parent/child share
  // the grant, never the stdio process, and revocation closes child transports now.
  const parent = makeAgent("runtime-parent");
  const child = makeAgent("runtime-child", "runtime-parent");
  const nested = makeAgent("runtime-nested", "runtime-child");
  const unrelated = makeAgent("runtime-unrelated");
  const capRoute = routes.find((route) => route.path === "/skill-mcp-manager/session-caps");
  const flip = async (session, enabled) => {
    const response = makeRes();
    await capRoute.handler(makeReq("/skill-mcp-manager/session-caps", { session, kind: "mcp", name: "demo", enabled }), response);
    if (response.status !== 200) throw new Error("switch failed: " + response.body);
  };
  const step = (agent) => preStep({ agent, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [] }));
  await step(parent);
  await flip("runtime-parent", true);
  for (const agent of [child, nested, unrelated]) await step(agent);
  const inheritedPeek = await mcpLoad.execute({ name: "demo", peek: true }, { agent: child });
  if (!inheritedPeek) failed.push("child peek must work with inherited policy");
  for (const agent of [parent, child, nested]) await mcpLoad.execute({ name: "demo" }, { agent });
  const parentId = await callText(parent);
  const childId = await callText(child);
  const nestedId = await callText(nested);
  if (new Set([parentId, childId, nestedId]).size !== 3) failed.push("inheriting agents must keep separate real MCP subprocesses");
  let unrelatedError = "";
  try { await mcpLoad.execute({ name: "demo", peek: true }, { agent: unrelated }); }
  catch (error) { unrelatedError = String(error.message); }
  if (!/off for this conversation/.test(unrelatedError)) failed.push("unrelated agent must not gain the parent's grant");
  await flip("runtime-parent", false);
  for (const agent of [child, nested]) {
    let callError = "";
    try { await callText(agent); } catch (error) { callError = String(error.message); }
    if (!/off for this conversation/.test(callError)) failed.push("descendant bridge call must refuse immediately after parent revocation");
  }
  await flip("runtime-parent", true);
  let closedError = "";
  try { await callText(child); } catch (error) { closedError = String(error.message); }
  if (!/not loaded/.test(closedError)) failed.push("revocation must actually dispose the child runtime, not just hide the tool");
  await mcpLoad.execute({ name: "demo" }, { agent: child });
  const freshChildId = await callText(child);
  if (freshChildId === childId) failed.push("reloading after revocation must start a new real child MCP process");
  // Make it eager and confirm the child gets its own actual native tool registration.
  const tierRoute = routes.find((route) => route.path === "/skill-mcp-manager/mcp/tier");
  const tierResponse = makeRes();
  await tierRoute.handler(makeReq("/skill-mcp-manager/mcp/tier", { name: "demo", tier: "eager" }), tierResponse);
  if (tierResponse.status !== 200) throw new Error("eager transition failed: " + tierResponse.body);
  await step(child);
  const native = registrations.findLast((record) => record.agent === child && record.active && record.definition.name === "mcp__demo__whoami");
  if (!native) failed.push("child must natively register inherited eager tools in its own context");
  if (native) {
    const result = await native.definition.execute({}, { agent: child, signal: new AbortController().signal });
    if (!JSON.stringify(result).includes("pid-")) failed.push("child eager execute must reach the real MCP process");
  }
  await flip("runtime-parent", false);
  if (native?.active) failed.push("parent revocation must unregister the child's eager tool immediately");
  if (native) {
    let refused = "";
    try { await native.definition.execute({}, { agent: child, signal: new AbortController().signal }); }
    catch (error) { refused = String(error.message); }
    if (!/off for this conversation/.test(refused)) failed.push("retained eager execute must refuse revoked inherited permissions at the call boundary");
  }
  console.log("real child MCP calls: separate PIDs, nested inheritance, live revocation, restart and eager native tool verified");


} finally {
  for (const dispose of effects.reverse()) await dispose();
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("SESSION ISOLATE SMOKE FAILED");
  process.exit(1);
}
console.log("SESSION ISOLATE SMOKE PASSED");
