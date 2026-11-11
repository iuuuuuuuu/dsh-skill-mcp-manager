// Plugin-contributed MCP rows: the loader's own \`@deepseek-ai/dsh-mcp-client\`
// entries that no registry entry claims are surfaced in the MCP list, attributed
// to the bundle whose patch declares the row, and toggled at runtime through
// \`entry.update({disabled})\` — no restart, and the row's bundle patch untouched.
// This exercises the host side with a fake loader (the desktop app creates the
// real one) plus a real profile directory on disk for the attribution.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const tmp = join(process.cwd(), `.test-mcp-native-${process.pid}`);
const home = join(tmp, "home");
const profileDir = join(home, "profiles", "fixture-profile");
const dataDir = join(tmp, "data");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(join(profileDir, "node_modules", "bundle-a"), { recursive: true });
await mkdir(join(profileDir, "node_modules", "@scope", "bundle-b"), { recursive: true });

await writeFile(join(profileDir, "package.json"), JSON.stringify({
  name: "fixture-profile",
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ["bundle-a", "@scope/bundle-b"] } },
}, null, 2), "utf8");

const insertPatch = (id, serverName) => [
  "- insert:",
  `    - id: ${id}`,
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  `        serverName: ${serverName}`,
  "        transport: stdio",
  "        command: node",
  "",
].join("\n");
await writeFile(join(profileDir, "node_modules", "bundle-a", "cordis.patch.yml"), insertPatch("mcp-alpha", "alpha"), "utf8");
await writeFile(join(profileDir, "node_modules", "@scope", "bundle-b", "cordis.patch.yml"), insertPatch("mcp-beta", "beta"), "utf8");
await writeFile(join(profileDir, "cordis.patch.yml"), "", "utf8");

// DSH_HOME is read when lib/index.js loads, so it must be set before the import.
process.env.DSH_HOME = home;
const { apply } = await import("../lib/index.js");

function makeEntry(id, serverName) {
  const entry = {
    id,
    updates: [],
    options: {
      id,
      name: "@deepseek-ai/dsh-mcp-client",
      config: { serverName, transport: "stdio", command: "node" },
    },
    get disabled() {
      return this.options.disabled === true;
    },
    async update(next) {
      this.updates.push(next);
      this.options = { ...this.options, ...next };
    },
  };
  return entry;
}

const entries = [makeEntry("mcp-alpha", "alpha"), makeEntry("mcp-beta", "beta")];
const loader = { entries: () => entries };

const routes = [];
const effects = [];
const ctx = {
  tools: { register() { return () => {}; } },
  skills: { registerProvider() { return () => {}; }, async list() { return []; }, async get() { return undefined; } },
  on() { return () => {}; },
  effect(fn) { const d = fn(); if (typeof d === "function") effects.push(d); return () => {}; },
  get(name) {
    if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
    return undefined;
  },
  inject(names, callback) {
    // the plugin waits for both services through ctx.inject; the fake hands each
    // one over the way the host does (a scoped context object)
    if (names.includes("loader")) callback({ loader });
    if (names.includes("webServer")) {
      const webServer = { register(route) { routes.push(route); return () => {}; } };
      // the host hands mountUi a scoped ctx that inherits the same services
      callback(Object.assign(Object.create(ctx), { webServer }));
    }
  },
  logger: { warn() {}, error() {}, info() {} },
};

await apply(ctx, { dataDir, profile: "fixture-profile", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 50));

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method, url,
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

const mcpRoute = routeByPath("/skill-mcp-manager/mcp");
const nativeRoute = routeByPath("/skill-mcp-manager/mcp/native");
if (nativeRoute === undefined) failed.push("missing route /skill-mcp-manager/mcp/native");

// 1) discovery + attribution
{
  const res = makeRes();
  await mcpRoute.handler(makeReq("GET", "/skill-mcp-manager/mcp"), res);
  const body = bodyOf(res);
  const native = body.native ?? {};
  console.log("native:", JSON.stringify(native.entries));
  if (native.supported !== true) failed.push("native rows should report supported=true when a loader is present");
  if ((native.entries ?? []).length !== 2) failed.push(`expected 2 native rows, got ${(native.entries ?? []).length}`);
  const byId = Object.fromEntries((native.entries ?? []).map((item) => [item.id, item]));
  if (byId["mcp-alpha"]?.owner !== "bundle-a") failed.push("mcp-alpha should be attributed to bundle-a, got " + String(byId["mcp-alpha"]?.owner));
  if (byId["mcp-beta"]?.owner !== "@scope/bundle-b") failed.push("mcp-beta should be attributed to @scope/bundle-b, got " + String(byId["mcp-beta"]?.owner));
  if (byId["mcp-alpha"]?.serverName !== "alpha") failed.push("serverName should come from the row config");
  if (byId["mcp-alpha"]?.enabled !== true) failed.push("a mounted row should report enabled=true");
}

// 2) toggle off at runtime (entry.update) — no restart, no registry write
{
  const res = makeRes();
  await nativeRoute.handler(makeReq("POST", "/skill-mcp-manager/mcp/native", { id: "mcp-alpha", enabled: false }), res);
  const body = bodyOf(res);
  console.log("disable ->", res.status, JSON.stringify(body).slice(0, 220));
  if (res.status !== 200 || body.ok !== true) failed.push("disable did not answer 200 {ok:true}");
  if (body.enabled !== false) failed.push("disable should report enabled=false");
  if (JSON.stringify(entries[0].updates) !== JSON.stringify([{ disabled: true }])) {
    failed.push("the loader entry was not updated with {disabled:true}: " + JSON.stringify(entries[0].updates));
  }
  const after = (body.native?.entries ?? []).find((item) => item.id === "mcp-alpha");
  if (after?.enabled !== false) failed.push("the refreshed view still reports the row as enabled");
}

// 3) toggle back on
{
  const res = makeRes();
  await nativeRoute.handler(makeReq("POST", "/skill-mcp-manager/mcp/native", { id: "mcp-alpha", enabled: true }), res);
  const body = bodyOf(res);
  console.log("enable ->", res.status, JSON.stringify(body).slice(0, 220));
  if (body.enabled !== true) failed.push("enable should report enabled=true");
  if (JSON.stringify(entries[0].updates.slice(-1)) !== JSON.stringify([{ disabled: false }])) {
    failed.push("enable did not update the entry with {disabled:false}");
  }
}

// 4) unknown id / bad input are refused
{
  for (const payload of [{ id: "nope", enabled: false }, { id: "mcp-alpha" }, { id: "", enabled: true }]) {
    const res = makeRes();
    await nativeRoute.handler(makeReq("POST", "/skill-mcp-manager/mcp/native", payload), res);
    const body = bodyOf(res);
    console.log("bad input ->", res.status, JSON.stringify(body).slice(0, 120));
    if (res.status !== 400 || body.ok !== false) failed.push("bad input " + JSON.stringify(payload) + " was not refused with 400");
  }
}

for (const disposer of effects) { try { await disposer(); } catch { /* best effort */ } }
await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("MCP NATIVE SMOKE FAILED");
  process.exit(1);
}
console.log("MCP NATIVE SMOKE PASSED");
