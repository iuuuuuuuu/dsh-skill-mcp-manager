// 新增 MCP from the library page. It shares registerServerEntry() with the mcp_register
// tool, so a UI-added server is validated the same way: a real stdio handshake + tools
// list, persisted only when the server answers. Failures must be 400 and must not touch
// the registry file.

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";

const tmp = join(process.cwd(), ".test-mcp-add-" + process.pid);
const dataDir = join(tmp, "data");
const serverFile = join(tmp, "server.mjs");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
// DSH_HOME must be isolated before the module loads, or the bundle scan hits real profiles.
process.env.DSH_HOME = join(tmp, "home");
const { apply } = await import("../lib/index.js");

await writeFile(serverFile, [
  'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";',
  'const server = new Server({ name: "add-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });',
  'server.setRequestHandler(ListToolsRequestSchema, async () => ({',
  '  tools: [',
  '    { name: "one", description: "First", inputSchema: { type: "object", additionalProperties: false } },',
  '    { name: "two", description: "Second", inputSchema: { type: "object", additionalProperties: false } },',
  '  ],',
  '}));',
  'await server.connect(new StdioServerTransport());',
  "",
].join("\n"), "utf8");
await writeFile(join(dataDir, "registry.json"), JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");

const routes = [];
const webServer = { register(route) { routes.push(route); return () => {}; } };
const ctx = {
  tools: { register() { return () => {}; } },
  get skills() { return { registerProvider() { return () => {}; }, async list() { return []; }, async get() { return undefined; } }; },
  on() { return () => {}; },
  effect(fn) { const d = fn(); return () => { if (typeof d === "function") d(); }; },
  inject(names, callback) {
    const list = Array.isArray(names) ? names : [names];
    if (list.includes("webServer")) callback(ctx);
    return () => {};
  },
  webServer,
  get(name) { return name === "webServer" ? webServer : undefined; },
  logger: { warn() {}, error() {}, info() {}, debug() {} },
};
const instance = apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 50));

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };
const routeByPath = (path) => routes.find((route) => route.path === path);
function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method, url,
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() {
      return { async next() { return i < chunks.length ? { value: chunks[i++], done: false } : { done: true, value: undefined }; } };
    },
  };
}
function makeRes() {
  const res = { code: 0, body: null };
  res.writeHead = (code) => { res.code = code; return res; };
  res.setHeader = () => res;
  res.end = (text) => { try { res.body = JSON.parse(String(text)); } catch { res.body = String(text); } };
  return res;
}
async function post(body) {
  const res = makeRes();
  await routeByPath("/skill-mcp-manager/mcp/add").handler(makeReq("POST", "/skill-mcp-manager/mcp/add", body), res);
  return res;
}

check(routeByPath("/skill-mcp-manager/mcp/add") !== undefined, "the add route must be registered");

// 1) a real stdio server is registered, snapshot saved, file written
{
  const res = await post({ name: "added", transport: "stdio", command: process.execPath, args: [serverFile] });
  console.log("add ->", res.code, JSON.stringify(res.body).slice(0, 180));
  check(res.code === 200 && res.body.ok === true, "a working server must be accepted, got " + res.code);
  check(res.body.entry && res.body.entry.name === "added", "the new entry must come back");
  check(res.body.toolCount === 2, "the trial connect must report 2 tools, got " + res.body.toolCount);
  check(Array.isArray(res.body.entry.tools) && res.body.entry.tools.length === 2, "the tool snapshot must be saved");
  const stored = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
  check(stored.entries.some((entry) => entry.name === "added"), "the registry file must carry the new server");
}

// 2) the same name updates in place (one code path with mcp_register)
{
  const res = await post({ name: "added", transport: "stdio", command: process.execPath, args: [serverFile], notes: "mine" });
  check(res.code === 200 && res.body.updated === true, "re-adding must update, got " + JSON.stringify(res.body).slice(0, 120));
  check(res.body.entry.notes === "mine", "the note must stick");
  const stored = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
  check(stored.entries.filter((entry) => entry.name === "added").length === 1, "no duplicate entry may appear");
}

// 3) a server that cannot start is refused and not stored
{
  const before = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8")).entries.length;
  const res = await post({ name: "broken", transport: "stdio", command: process.execPath, args: [join(tmp, "missing.mjs")] });
  console.log("broken ->", res.code, JSON.stringify(res.body).slice(0, 140));
  check(res.code === 400, "a failing handshake must answer 400, got " + res.code);
  const after = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8")).entries.length;
  check(after === before, "a failed add must not touch the registry (" + before + " -> " + after + ")");
}

// 4) shape guards
{
  check((await post({ name: "bad name!", transport: "stdio", command: "x" })).code === 400, "an invalid name must be refused");
  check((await post({ name: "notransport" })).code === 400, "a missing transport must be refused");
  check((await post({ name: "nourl", transport: "streamable-http" })).code === 400, "streamable-http without url must be refused");
  check((await post({ name: "nocommand", transport: "stdio" })).code === 400, "stdio without command must be refused");
}

if (typeof instance?.dispose === "function") instance.dispose();
await rm(tmp, { recursive: true, force: true });
if (failed.length > 0) { for (const message of failed) console.error("FAIL: " + message); console.error("MCP ADD SMOKE FAILED"); process.exit(1); }
console.log("MCP ADD SMOKE PASSED");