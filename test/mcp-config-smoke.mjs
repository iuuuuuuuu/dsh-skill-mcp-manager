// Pasted MCP config: the parser accepts the shapes other tools export, reports every
// problem it finds, and the import registers per server (one failure never stops the
// rest). The import path is the same one the form uses (registerServerEntry).

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMcpConfigDocument, formatMcpConfig } from "../lib/mcp-config.js";

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };

// 1) the shape from the ticket: { servers: { name: { url, type: "http" } } }
{
  const doc = JSON.stringify({ servers: { ardot: { url: "http://127.0.0.1:50501/api/v1/mcp", type: "http" } } });
  const parsed = parseMcpConfigDocument(doc);
  console.log("ticket shape:", JSON.stringify(parsed));
  check(parsed.errors.length === 0, "the ticket shape must parse cleanly, got " + JSON.stringify(parsed.errors));
  check(parsed.servers.length === 1, "one server must come out");
  check(parsed.servers[0].name === "ardot", "the name must survive");
  check(parsed.servers[0].transport === "streamable-http", "type http maps to streamable-http, got " + parsed.servers[0].transport);
  check(parsed.servers[0].url === "http://127.0.0.1:50501/api/v1/mcp", "the url must survive");
}

// 2) the other wrappers people paste, plus stdio
{
  const claude = parseMcpConfigDocument(JSON.stringify({ mcpServers: { local: { command: "npx", args: ["-y", "@x/y"], env: { TOKEN: "$TOKEN" } } } }));
  check(claude.errors.length === 0 && claude.servers[0].transport === "stdio", "mcpServers + command must be stdio");
  check(claude.servers[0].args.length === 2, "args must survive");
  const bare = parseMcpConfigDocument(JSON.stringify({ plain: { url: "https://x/mcp" } }));
  check(bare.errors.length === 0 && bare.servers[0].transport === "streamable-http", "a bare map with url must work");
  const declared = parseMcpConfigDocument(JSON.stringify({ servers: { s1: { type: "stdio", command: "node", args: ["a.js"] } } }));
  check(declared.servers[0].transport === "stdio", "an explicit stdio type must be honoured");
}

// 3) every error is reported with its path, and nothing half-parsed leaks out
{
  const bad = parseMcpConfigDocument(JSON.stringify({
    servers: {
      ok: { url: "https://x/mcp" },
      noTarget: { notes: "nope" },
      sse: { url: "https://x/sse", type: "sse" },
      "bad name!": { url: "https://x/mcp" },
      badArgs: { command: "npx", args: "not-an-array" },
    },
  }));
  console.log("errors:", JSON.stringify(bad.errors.map((e) => e.path)));
  // `ok` and `badArgs` are usable (the bad args is reported but the entry is kept);
  // `noTarget`, `sse` and the invalid name are dropped.
  check(bad.servers.length === 2, "the usable ones must still come out, got " + bad.servers.length);
  check(bad.errors.some((e) => e.path === "servers.noTarget"), "a server with neither url nor command must be reported");
  check(bad.errors.some((e) => e.path === "servers.sse.type" && e.message.includes("sse")), "an unsupported transport must name itself");
  check(bad.errors.some((e) => e.path === "servers.bad name!"), "an invalid name must be reported");
  check(bad.errors.some((e) => e.path === "servers.badArgs.args"), "a non-array args must be reported");
}

// 4) broken JSON and empty input are answers, not exceptions
{
  const broken = parseMcpConfigDocument("{ servers: { a: } }");
  check(broken.errors.length === 1 && broken.errors[0].message.includes("JSON"), "broken JSON must be reported as a parse error");
  check(broken.servers.length === 0, "nothing may be produced from broken JSON");
  check(parseMcpConfigDocument("").errors[0].message.includes("空"), "empty input must be refused");
  check(parseMcpConfigDocument("[]").errors.length === 1, "an array top level must be refused");
}

// 5) the paste handler's formatter: same content, stable 2-space output, no throw
{
  const compact = '{"servers":{"a":{"url":"https://x/mcp"}}}';
  const pretty = formatMcpConfig(compact);
  check(pretty.includes("\n  \"servers\""), "formatting must indent by two spaces, got " + JSON.stringify(pretty).slice(0, 60));
  check(JSON.stringify(JSON.parse(pretty)) === JSON.stringify(JSON.parse(compact)), "formatting must not change the content");
  check(formatMcpConfig("not json") === "not json", "broken input must come back untouched");
}

// 6) the import route registers what the parser accepted, and reports per server
{
  const tmp = join(process.cwd(), ".test-mcp-config-" + process.pid);
  const dataDir = join(tmp, "data");
  const serverFile = join(tmp, "server.mjs");
  await rm(tmp, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  process.env.DSH_HOME = join(tmp, "home");
  await writeFile(serverFile, [
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    'import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";',
    'const server = new Server({ name: "cfg-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });',
    'server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "t", description: "T", inputSchema: { type: "object" } }] }));',
    'await server.connect(new StdioServerTransport());',
    "",
  ].join("\n"), "utf8");
  await writeFile(join(dataDir, "registry.json"), JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");

  const { apply } = await import("../lib/index.js");
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

  function makeRes() {
    const res = { code: 0, body: null };
    res.writeHead = (code) => { res.code = code; return res; };
    res.setHeader = () => res;
    res.end = (text) => { try { res.body = JSON.parse(String(text)); } catch { res.body = String(text); } };
    return res;
  }
  function makeReq(body) {
    const chunks = [Buffer.from(JSON.stringify(body), "utf8")];
    let i = 0;
    return {
      method: "POST",
      url: "/skill-mcp-manager/mcp/config/import",
      headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
      [Symbol.asyncIterator]() {
        return { async next() { return i < chunks.length ? { value: chunks[i++], done: false } : { done: true, value: undefined }; } };
      },
    };
  }
  const route = routes.find((item) => item.path === "/skill-mcp-manager/mcp/config/import");
  check(route !== undefined, "the import route must be registered");

  const doc = JSON.stringify({
    servers: {
      good: { command: process.execPath, args: [serverFile] },
      broken: { command: process.execPath, args: [join(tmp, "missing.mjs")] },
      sse: { url: "https://x/sse", type: "sse" },
    },
  });
  const res = makeRes();
  await route.handler(makeReq({ text: doc }), res);
  console.log("import ->", res.code, JSON.stringify(res.body).slice(0, 240));
  check(res.code === 200, "import must answer 200, got " + res.code);
  check(res.body.imported === 1, "exactly one server may import, got " + res.body.imported);
  check(res.body.failed === 1, "the server that cannot start must be reported as failed");
  check(res.body.errors.some((e) => e.path === "servers.sse.type"), "the parse error must come back with the results");
  const stored = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
  check(stored.entries.length === 1 && stored.entries[0].name === "good", "only the working server may be stored");
  check(stored.entries[0].tools.length === 1, "the imported entry must carry its tool snapshot");

  if (typeof instance?.dispose === "function") instance.dispose();
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) { for (const message of failed) console.error("FAIL: " + message); console.error("MCP CONFIG SMOKE FAILED"); process.exit(1); }
console.log("MCP CONFIG SMOKE PASSED");