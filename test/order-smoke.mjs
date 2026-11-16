// Drag ordering of the 能力库 lists: the order is pure presentation, so it lives in its
// own small file; the vendor route must hand the browser a real SortableJS build (the
// client bundle has no bundler and cannot import npm).

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";

const tmp = join(process.cwd(), ".test-order-" + process.pid);
const dataDir = join(tmp, "data");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
process.env.DSH_HOME = join(tmp, "home");
await writeFile(join(dataDir, "registry.json"), JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");
const { apply } = await import("../lib/index.js");

const routes = [];
const webServer = { register(route) { routes.push(route); return () => {}; } };
function makeCtx(server) { return {
  tools: { register() { return () => {}; } },
  get skills() { return { registerProvider() { return () => {}; }, async list() { return []; }, async get() { return undefined; } }; },
  on() { return () => {}; },
  effect(fn) { const d = fn(); return () => { if (typeof d === "function") d(); }; },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names];
      if (list.includes("webServer")) callback(makeCtx(server));
      return () => {};
    },
    webServer: server,
    get(name) { return name === "webServer" ? server : undefined; },
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  }; }
const ctx = makeCtx(webServer);
const instance = apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 50));

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };
const routeByPath = (path) => routes.find((route) => route.path === path);
function makeRes() {
  const res = { code: 0, body: null, headers: {}, raw: "" };
  res.writeHead = (code, headers) => { res.code = code; Object.assign(res.headers, headers || {}); return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; return res; };
  res.end = (text) => {
    const raw = String(text ?? "");
    res.raw = raw;
    try { res.body = JSON.parse(raw); } catch { res.body = raw; }
  };
  return res;
}
function makeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method,
    url: "/skill-mcp-manager/order",
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() {
      return { async next() { return i < chunks.length ? { value: chunks[i++], done: false } : { done: true, value: undefined }; } };
    },
  };
}
async function call(path, method, body) {
  const res = makeRes();
  await routeByPath(path).handler(makeReq(method, body), res);
  return res;
}

check(routeByPath("/skill-mcp-manager/order") !== undefined, "the order route must be registered");
check(routeByPath("/skill-mcp-manager/vendor/sortable") !== undefined, "the vendor route must be registered");

// 1) empty at first
{
  const res = await call("/skill-mcp-manager/order", "GET");
  check(res.code === 200 && res.body.ok === true, "GET must answer the current order, got " + res.code);
  check(Array.isArray(res.body.skills) && res.body.skills.length === 0, "a fresh install has no saved order");
}

// 2) writing persists, dedupes, and ignores junk
{
  const res = await call("/skill-mcp-manager/order", "POST", { kind: "skills", names: ["b", "a", "b", 42, ""] });
  console.log("set ->", res.code, JSON.stringify(res.body).slice(0, 120));
  check(res.code === 200, "POST must answer 200, got " + res.code);
  check(JSON.stringify(res.body.skills) === JSON.stringify(["b", "a"]), "only unique strings may be stored, got " + JSON.stringify(res.body.skills));
  const file = JSON.parse(await readFile(join(dataDir, "order.json"), "utf8"));
  check(JSON.stringify(file.skills) === JSON.stringify(["b", "a"]), "the file must carry the order");
}

// 3) the other kind is independent, and the saved order survives a restart
{
  await call("/skill-mcp-manager/order", "POST", { kind: "mcp", names: ["srv-2", "srv-1"] });
  const reloaded = await import("../lib/index.js?reload=" + Date.now());
  const routes2 = [];
  const webServer2 = { register(route) { routes2.push(route); return () => {}; } };
  const ctx2 = makeCtx(webServer2);
  const instance2 = reloaded.apply(ctx2, { dataDir, profile: "__test__", importNativeMcp: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const res = makeRes();
  await routes2.find((route) => route.path === "/skill-mcp-manager/order").handler(makeReq("GET"), res);
  check(JSON.stringify(res.body.skills) === JSON.stringify(["b", "a"]), "skills order must survive a restart, got " + JSON.stringify(res.body.skills));
  check(JSON.stringify(res.body.mcp) === JSON.stringify(["srv-2", "srv-1"]), "mcp order must survive a restart");
  if (typeof instance2?.dispose === "function") instance2.dispose();
}

// 4) shape guards
{
  check((await call("/skill-mcp-manager/order", "POST", { kind: "nope", names: [] })).code === 400, "an unknown kind must be refused");
  check((await call("/skill-mcp-manager/order", "POST", { kind: "skills", names: "a,b" })).code === 400, "names must be an array");
  check((await call("/skill-mcp-manager/order", "DELETE")).code === 405, "only GET/POST are allowed on the order route");
}

// 5) the vendor route serves a real SortableJS build
{
  const res = await call("/skill-mcp-manager/vendor/sortable", "GET");
  console.log("vendor ->", res.code, res.headers["content-type"], res.raw.length + " bytes");
  check(res.code === 200, "the vendor route must answer 200, got " + res.code);
  check(String(res.headers["content-type"]).includes("javascript"), "the vendor route must serve javascript");
  check(res.raw.length > 10000, "the served file must be the real library, got " + res.raw.length + " bytes");
  check(res.raw.includes("Sortable"), "the served body must be SortableJS");
}

if (typeof instance?.dispose === "function") instance.dispose();
await rm(tmp, { recursive: true, force: true });
if (failed.length > 0) { for (const message of failed) console.error("FAIL: " + message); console.error("ORDER SMOKE FAILED"); process.exit(1); }
console.log("ORDER SMOKE PASSED");