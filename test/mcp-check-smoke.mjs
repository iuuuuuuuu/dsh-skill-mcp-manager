// Connection check from the management UI: one real MCP handshake per entry,
// a recorded result, and a view that carries it. Covers the three answers the
// UI must be able to tell apart — connected (with latency and tool count),
// failed (with the server's error text), and the snapshot that the check
// deliberately does NOT rewrite — plus the secret scrubbing that keeps a
// persisted error from carrying an API key.

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { entryView } from "../lib/ui.js";

const tmp = join(process.cwd(), `.test-mcp-check-${process.pid}`);
const dataDir = join(tmp, "data");
const goodServer = join(tmp, "good-server.mjs");
const badServer = join(tmp, "bad-server.mjs");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

await writeFile(goodServer, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "check-fixture", version: "2.3.4" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "ping", description: "Ping", inputSchema: { type: "object", additionalProperties: false } },
    { name: "echo", description: "Echo", inputSchema: { type: "object", additionalProperties: false } },
  ],
}));
await server.connect(new StdioServerTransport());
`, "utf8");

await writeFile(badServer, "process.exit(3);\n", "utf8");

const entry = (name, args, tools) => ({
  id: name,
  name,
  tier: "on-demand",
  transport: "stdio",
  command: process.execPath,
  args,
  env: {},
  cwd: null,
  url: null,
  headers: {},
  notes: "",
  tools,
  disabledTools: [],
  serverName: "",
  serverVersion: "",
  serverDescription: "fixture server",
  instructions: "",
  // A snapshot-bearing entry: warmSnapshots() only probes entries whose
  // metaFetchedAt is empty, so this one keeps its (deliberately partial) tool
  // snapshot until a check or a manual refresh says otherwise.
  metaFetchedAt: "2026-01-01T00:00:00.000Z",
});

await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [
    entry("good", [goodServer], [{ name: "ping", description: "Ping" }]),
    entry("bad", [badServer], []),
  ],
}, null, 2)}\n`, "utf8");

const routes = [];
const effects = [];
const ctx = {
  tools: { register() { return () => {}; } },
  skills: { registerProvider() { return () => {}; } },
  on() { return () => {}; },
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

await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false, checkTimeoutMs: 8000 });
await new Promise((resolve) => setTimeout(resolve, 100));

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method,
    url,
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() {
      return { async next() { return i < chunks.length ? { value: chunks[i++], done: false } : { done: true }; } };
    },
  };
}

function makeRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (chunk) => { res.body = chunk; };
  return res;
}

const bodyOf = (res) => (res.body ? JSON.parse(res.body) : {});
const routeByPath = (path) => routes.find((route) => route.path === path);
const failed = [];

const testRoute = routeByPath("/skill-mcp-manager/mcp/test");
if (testRoute === undefined) failed.push("missing route /skill-mcp-manager/mcp/test");

// 1) a working server: the check connects, reports latency and the live tool
// count, and leaves the tools snapshot alone (that is 刷新快照's job).
{
  const res = makeRes();
  await testRoute.handler(makeReq("POST", "/skill-mcp-manager/mcp/test", { name: "good" }), res);
  const body = bodyOf(res);
  console.log("good ->", res.status, JSON.stringify(body.check ?? body));
  const check = body.check ?? {};
  if (res.status !== 200 || body.ok !== true) failed.push("good check did not answer 200 {ok:true}");
  if (check.ok !== true) failed.push("good check should have connected");
  if (typeof check.latencyMs !== "number" || check.latencyMs < 0) failed.push("good check has no latencyMs");
  if (check.toolCount !== 2) failed.push(`good check toolCount=${check.toolCount}, expected 2`);
  if (check.toolsDiffer !== true) failed.push("good check should report the snapshot as stale (ping only)");
  if (typeof check.at !== "string" || check.at === "") failed.push("good check has no timestamp");
  if (check.error !== null) failed.push("good check reported an error");
  if (check.serverName !== "check-fixture") failed.push(`good check serverName=${check.serverName}`);
}

// 2) the result is recorded on disk and survives a reload, so a card can show
// state before anything is clicked again.
{
  const saved = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
  const good = saved.entries.find((item) => item.name === "good");
  if (good.lastCheck?.ok !== true) failed.push("good lastCheck was not persisted to registry.json");
  if (good.lastCheck?.toolCount !== 2) failed.push("persisted toolCount is wrong");
  if ((good.tools ?? []).length !== 1) failed.push("check rewrote the tools snapshot (it must not)");
  const listed = makeRes();
  await routeByPath("/skill-mcp-manager/mcp").handler(makeReq("GET", "/skill-mcp-manager/mcp"), listed);
  const view = bodyOf(listed).entries.find((item) => item.name === "good");
  if (view?.lastCheck?.ok !== true) failed.push("GET /mcp view does not carry lastCheck");
  if (view?.lastCheck?.toolCount !== 2) failed.push("GET /mcp view lost toolCount");
}

// 3) a broken server is an answer, not an HTTP error: the card needs the text.
{
  const res = makeRes();
  await testRoute.handler(makeReq("POST", "/skill-mcp-manager/mcp/test", { name: "bad" }), res);
  const body = bodyOf(res);
  console.log("bad ->", res.status, JSON.stringify(body.check ?? body).slice(0, 240));
  const check = body.check ?? {};
  if (res.status !== 200 || body.ok !== true) failed.push("bad check did not answer 200 {ok:true}");
  if (check.ok !== false) failed.push("bad check should have failed");
  if (typeof check.error !== "string" || check.error === "") failed.push("bad check carries no error text");
  if (typeof check.latencyMs !== "number") failed.push("bad check has no latencyMs");
  const saved = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
  const bad = saved.entries.find((item) => item.name === "bad");
  if (bad.lastCheck?.ok !== false) failed.push("failed check was not persisted");
}

// 4) an unknown name is a validation failure, so the route must refuse it.
{
  const res = makeRes();
  await testRoute.handler(makeReq("POST", "/skill-mcp-manager/mcp/test", { name: "nope" }), res);
  const body = bodyOf(res);
  console.log("unknown ->", res.status, JSON.stringify(body));
  if (res.status !== 400 || body.ok !== false) failed.push("unknown name was not refused with 400");
}

// 5) a persisted error must not carry a secret into the browser.
{
  const secret = "sk-live-0123456789abcdef";
  const view = entryView({
    id: "remote",
    name: "remote",
    tier: "on-demand",
    transport: "streamable-http",
    url: "https://example.test/mcp?token=" + secret,
    headers: { authorization: "Bearer " + secret },
    env: { API_KEY: secret },
    lastCheck: {
      at: "2026-01-01T00:00:00.000Z",
      ok: false,
      latencyMs: 12,
      toolCount: null,
      serverName: null,
      toolsDiffer: false,
      error: `connect failed for https://example.test/mcp?token=${secret} (key ${secret})`,
    },
  }, false);
  console.log("scrubbed:", view.lastCheck.error);
  if (view.lastCheck.error.includes(secret)) failed.push("lastCheck error leaks the secret");
  const revealed = entryView({
    id: "remote",
    name: "remote",
    tier: "on-demand",
    transport: "streamable-http",
    url: "https://example.test/mcp?token=" + secret,
    headers: { authorization: "Bearer " + secret },
    env: { API_KEY: secret },
    lastCheck: { at: "2026-01-01T00:00:00.000Z", ok: false, latencyMs: 12, error: "key " + secret },
  }, true);
  if (!revealed.lastCheck.error.includes(secret)) failed.push("reveal=1 should show the raw error");
}

for (const disposer of effects) {
  try { await disposer(); } catch { /* teardown is best effort */ }
}
await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("MCP CHECK SMOKE FAILED");
  process.exit(1);
}
console.log("MCP CHECK SMOKE PASSED");
