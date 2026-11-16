// OAuth for an MCP server, end to end against a fake authorization server: discovery,
// dynamic client registration, PKCE, the loopback callback, the code exchange, and the
// token landing in the entry's headers. The "browser" here is a fetch that follows the
// authorize redirect — everything else is the production path.

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";

const tmp = join(process.cwd(), ".test-oauth-" + process.pid);
const dataDir = join(tmp, "data");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
process.env.DSH_HOME = join(tmp, "home");

// ── fake authorization server (and a fake MCP endpoint behind the token) ──
const seen = { register: null, token: null, authorize: null };
const fake = createServer(async (req, res) => {
  const url = new URL(String(req.url), "http://127.0.0.1:" + fake.address().port);
  const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return json(200, { resource: url.origin + "/mcp", authorization_servers: [url.origin], scopes_supported: ["mcp:use"] });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(200, {
      issuer: url.origin,
      authorization_endpoint: url.origin + "/oauth/authorize",
      token_endpoint: url.origin + "/oauth/token",
      registration_endpoint: url.origin + "/oauth/register",
      scopes_supported: ["mcp:use"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url.pathname === "/oauth/register") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.register = JSON.parse(raw || "{}");
    return json(201, { client_id: "test-client", token_endpoint_auth_method: "none" });
  }
  if (url.pathname === "/oauth/authorize") {
    seen.authorize = Object.fromEntries(url.searchParams.entries());
    const redirect = new URL(url.searchParams.get("redirect_uri"));
    redirect.searchParams.set("code", "test-code");
    redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: redirect.toString() });
    res.end();
    return;
  }
  if (url.pathname === "/oauth/token") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.token = Object.fromEntries(new URLSearchParams(raw).entries());
    if (seen.token.grant_type !== "authorization_code" || seen.token.code !== "test-code") {
      return json(400, { error: "invalid_grant" });
    }
    return json(200, { access_token: "token-123", token_type: "Bearer", expires_in: 3600, scope: "mcp:use" });
  }
  if (url.pathname === "/mcp") {
    const auth = req.headers.authorization ?? "";
    if (auth !== "Bearer token-123") return json(401, { error: "missing bearer token" });
    // Enough MCP for the post-authorisation probe to succeed.
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw || "{}");
    if (message.method === "initialize") {
      return json(200, {
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } },
      });
    }
    if (message.method === "tools/list") {
      return json(200, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] } });
    }
    return json(200, { jsonrpc: "2.0", id: message.id, result: {} });
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + fake.address().port;

// the registry entry points at the fake MCP endpoint, with no token yet
await writeFile(join(dataDir, "registry.json"), JSON.stringify({
  version: 1,
  entries: [{
    id: "cloud", name: "cloud", tier: "on-demand", transport: "streamable-http",
    command: null, args: [], env: {}, cwd: null,
    url: origin + "/mcp",
    headers: {}, notes: "", tools: [], disabledTools: [],
    serverName: "", serverVersion: "", serverDescription: "", instructions: "", metaFetchedAt: null,
  }],
}, null, 2) + "\n", "utf8");

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
const instance = apply(makeCtx(webServer), { dataDir, profile: "__test__", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 60));

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };
const routeByPath = (path) => routes.find((route) => route.path === path);
function makeRes() {
  const res = { code: 0, body: null };
  res.writeHead = (code) => { res.code = code; return res; };
  res.setHeader = () => res;
  res.end = (text) => { try { res.body = JSON.parse(String(text)); } catch { res.body = String(text); } };
  return res;
}
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

check(routeByPath("/skill-mcp-manager/oauth/start") !== undefined, "the oauth start route must be registered");
check(routeByPath("/skill-mcp-manager/oauth/status") !== undefined, "the oauth status route must be registered");

// 1) one 401 tells the user where to authorise
{
  const probe = await fetch(origin + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check(probe.status === 401, "the fake server must refuse without a token");
}

// 2) start: discovery + registration + PKCE, and a URL the browser can open
const res = makeRes();
await routeByPath("/skill-mcp-manager/oauth/start").handler(makeReq("POST", "/skill-mcp-manager/oauth/start", { name: "cloud" }), res);
console.log("start ->", res.code, JSON.stringify(res.body).slice(0, 200));
check(res.code === 200 && typeof res.body.authorizeUrl === "string", "start must return an authorize URL");
const authorize = new URL(res.body.authorizeUrl);
check(authorize.searchParams.get("code_challenge_method") === "S256", "the flow must use PKCE S256");
check(authorize.searchParams.get("scope") === "mcp:use", "the scope must come from the resource metadata");
check(seen.register !== null && Array.isArray(seen.register.redirect_uris), "a client must be registered with a redirect uri");
check(seen.register.redirect_uris[0].startsWith("http://127.0.0.1:"), "the redirect must be loopback: " + seen.register.redirect_uris[0]);

// 3) act like the browser: follow the authorize redirect into the host's callback
const callback = await fetch(res.body.authorizeUrl, { redirect: "follow" });
const callbackText = await callback.text();
console.log("callback ->", callback.status, JSON.stringify(callbackText.slice(0, 80)));
check(callback.status === 200, "the loopback callback must answer the browser");
await new Promise((resolve) => setTimeout(resolve, 400));

check(seen.token !== null && seen.token.grant_type === "authorization_code", "the code must be exchanged");
check(typeof seen.token.code_verifier === "string" && seen.token.code_verifier.length > 20, "the PKCE verifier must be sent");
check(seen.token.redirect_uri === seen.register.redirect_uris[0], "the exchange must reuse the registered redirect");

// 4) the token is stored on the entry, and the probe now succeeds
const stored = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
const entry = stored.entries.find((item) => item.name === "cloud");
console.log("stored headers:", JSON.stringify(entry.headers), "| oauth:", JSON.stringify(entry.oauth));
check(entry.headers.Authorization === "Bearer token-123", "the bearer token must be stored in headers");
check(entry.oauth && entry.oauth.scope === "mcp:use", "the oauth metadata must be recorded");
// The probe that runs after the exchange is best-effort (a server may need more than a
// bare initialize); what the flow must guarantee is that the stored token is accepted.
const authenticated = await fetch(origin + "/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: entry.headers.Authorization },
  body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
});
const authenticatedBody = await authenticated.json();
console.log("authenticated ->", authenticated.status, JSON.stringify(authenticatedBody).slice(0, 120));
check(authenticated.status === 200, "the stored token must be accepted by the server, got " + authenticated.status);
check(Array.isArray(authenticatedBody.result?.tools) && authenticatedBody.result.tools.length === 1, "the authenticated call must return the tool list");
console.log("lastCheck after flow:", JSON.stringify(entry.lastCheck));

// 5) status endpoint reports the finished flow
{
  const statusRes = makeRes();
  await routeByPath("/skill-mcp-manager/oauth/status").handler(makeReq("GET", "/skill-mcp-manager/oauth/status?name=cloud"), statusRes);
  check(statusRes.code === 200 && statusRes.body.status === "done", "status must report done, got " + JSON.stringify(statusRes.body));
}

// 6) guards
{
  const unknown = makeRes();
  await routeByPath("/skill-mcp-manager/oauth/start").handler(makeReq("POST", "/skill-mcp-manager/oauth/start", { name: "nope" }), unknown);
  check(unknown.code === 400, "an unknown server must be refused, got " + unknown.code);
}

fake.close();
if (typeof instance?.dispose === "function") instance.dispose();
await rm(tmp, { recursive: true, force: true });
if (failed.length > 0) { for (const message of failed) console.error("FAIL: " + message); console.error("OAUTH SMOKE FAILED"); process.exit(1); }
console.log("OAUTH SMOKE PASSED");