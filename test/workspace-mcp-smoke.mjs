// Workspace-provided MCP servers: the file convention, the two accepted shapes, and
// the refusals that keep a broken project file from taking a conversation down.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_MCP_FILES, normalizeWorkspaceServer, parseWorkspaceMcpDocument, readWorkspaceMcp } from "../lib/workspace-mcp.js";

const tmp = join(process.cwd(), `.test-workspace-mcp-${process.pid}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };

check(WORKSPACE_MCP_FILES.length === 3 && WORKSPACE_MCP_FILES[0] === ".dsh/mcp.json", "three files, the DSH one first");

// 1) the common map shape (Claude Code / Cursor)
{
  const parsed = parseWorkspaceMcpDocument({
    mcpServers: {
      reqable: { command: "npx", args: ["-y", "reqable-mcp"], env: { REQABLE_TOKEN: "x", PORT: 9000 } },
      figma: { url: "https://figma.example/mcp", headers: { authorization: "Bearer t" } },
      broken: {}, 
      "bad name": { command: "x" },
      both: { command: "x", url: "https://y" },
    },
  });
  const names = parsed.servers.map((s) => s.name).sort();
  console.log("map shape ->", names.join(","), "| errors:", parsed.errors.length);
  check(names.join(",") === "figma,reqable", "two valid servers expected, got " + names.join(","));
  const reqable = parsed.servers.find((s) => s.name === "reqable");
  check(reqable.transport === "stdio" && reqable.command === "npx", "a command implies stdio");
  check(reqable.args.length === 2 && reqable.args[0] === "-y", "args must be carried over");
  check(reqable.env.REQABLE_TOKEN === "x" && reqable.env.PORT === "9000", "env values are stringified, got " + JSON.stringify(reqable.env));
  check(reqable.tier === "on-demand", "a workspace server is always on-demand");
  const figma = parsed.servers.find((s) => s.name === "figma");
  check(figma.transport === "streamable-http" && figma.url === "https://figma.example/mcp", "a url implies streamable-http");
  check(figma.headers.authorization === "Bearer t", "headers must be carried over");
  check(parsed.errors.length === 3, "three refusals expected (empty, bad name, both), got " + parsed.errors.length);
}

// 2) the explicit array shape
{
  const parsed = parseWorkspaceMcpDocument({
    servers: [
      { name: "alpha", command: "node", args: ["server.js"], transport: "stdio", notes: "项目自带" },
      { name: "beta", url: "http://127.0.0.1:9/mcp" },
      { name: "alpha", command: "duplicate" },
    ],
  });
  console.log("array shape ->", parsed.servers.map((s) => s.name + ":" + s.transport).join(","));
  check(parsed.servers.length === 2, "the duplicate name must be dropped, got " + parsed.servers.length);
  const alpha = parsed.servers.find((s) => s.name === "alpha");
  check(alpha.notes === "项目自带", "notes are carried over");
  check(alpha.tier === "on-demand" && alpha.tools.length === 0, "no tools are known before connecting");
}

// 3) shape refusals
{
  check(parseWorkspaceMcpDocument(null).errors.length === 1, "null is refused");
  check(parseWorkspaceMcpDocument([]).errors.length === 1, "an array root is refused");
  check(parseWorkspaceMcpDocument({}).errors[0].includes("neither"), "a document with no servers key says so");
  check(normalizeWorkspaceServer("x", { transport: "sse", url: "http://a" }).error?.includes("unsupported transport"), "an unsupported transport is refused");
  check(normalizeWorkspaceServer("x", { transport: "stdio" }).error?.includes("no command"), "stdio without a command is refused");
  check(normalizeWorkspaceServer("x", { transport: "streamable-http" }).error?.includes("no url"), "http without a url is refused");
  check(normalizeWorkspaceServer("x".repeat(40), { command: "a" }).error !== undefined, "an over-long name is refused");
}

// 4) reading a real workspace: precedence, dedupe, broken JSON
{
  await writeFile(join(tmp, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "from-mcp-json" }, onlyGeneric: { command: "g" } } }), "utf8");
  await mkdir(join(tmp, ".dsh"), { recursive: true });
  await writeFile(join(tmp, ".dsh", "mcp.json"), JSON.stringify({ servers: [{ name: "shared", command: "from-dsh" }, { name: "onlyDsh", command: "d" }] }), "utf8");
  await mkdir(join(tmp, ".agents"), { recursive: true });
  await writeFile(join(tmp, ".agents", "mcp.json"), "{ this is not json", "utf8");
  const read = await readWorkspaceMcp(tmp);
  console.log("workspace read ->", read.servers.map((s) => s.name + "@" + s.file).join(","), "| errors:", read.errors.length);
  check(read.servers.length === 3, "three servers expected, got " + read.servers.length);
  const shared = read.servers.find((s) => s.name === "shared");
  check(shared.command === "from-dsh", "the more specific file wins a duplicate name, got " + shared.command);
  check(shared.file === ".dsh/mcp.json", "the winning file is reported");
  check(read.files.length === 3, "every file that parsed is reported, got " + JSON.stringify(read.files));
  check(read.errors.some((line) => line.includes("not json") || line.includes("JSON") || line.includes("Unexpected")), "broken JSON is reported, got " + JSON.stringify(read.errors));
  const empty = await readWorkspaceMcp(join(tmp, "nope"));
  check(empty.servers.length === 0 && empty.errors.length === 0, "a workspace without files is silent");
  check((await readWorkspaceMcp("")).servers.length === 0, "no workspace means no servers");
}

await rm(tmp, { recursive: true, force: true });
if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("WORKSPACE MCP SMOKE FAILED");
  process.exit(1);
}
console.log("WORKSPACE MCP SMOKE PASSED");