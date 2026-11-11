// Residual MCP child processes: signatures are specific enough not to match a
// bare interpreter, and the live/orphan decision keeps everything that belongs to
// a running harness. Pure functions, so a fixture process table is enough — the
// real kill path is exercised against the OS separately.

import { classifyOrphans, commandSignatures, normalizeCommand } from "../lib/orphans.js";

const failed = [];
const check = (condition, message) => {
  if (!condition) failed.push(message);
};

// 1) signatures: a generic runner contributes its script/package argument, never
// the interpreter name; a dedicated binary contributes its path.
{
  const signatures = commandSignatures([
    { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\tools\\server-sequential-thinking\\dist\\index.js", "-y"] },
    { command: "npx", args: ["-y", "@modelcontextprotocol/server-foo"] },
    { command: "C:\\acme\\tools\\mcp-server.exe", args: [] },
    { command: "", args: ["ignored"] },
  ]);
  console.log("signatures:", signatures);
  check(!signatures.includes("node") && !signatures.includes("node.exe"), "a bare interpreter must not be a signature");
  check(!signatures.includes("npx"), "a bare npx must not be a signature");
  check(signatures.some((s) => s.endsWith("server-sequential-thinking/dist/index.js")), "the script path of a generic runner must be a signature");
  check(signatures.some((s) => s === "@modelcontextprotocol/server-foo"), "an npm package argument must be a signature");
  check(signatures.some((s) => s === "c:/acme/tools/mcp-server.exe"), "a dedicated binary must contribute its normalized path");
  check(signatures.some((s) => s === "mcp-server.exe"), "a dedicated binary must contribute its basename");
  check(!signatures.some((s) => s === "-y"), "flags must not become signatures");
}

// 2) classification: descendants of a live harness survive, unrelated processes are
// ignored, and a stranded chain outside any harness is an orphan.
{
  const processes = [
    { pid: 800, ppid: 1, name: "DSH Tauri.exe", cmd: '"C:\\Program Files\\DSH Tauri.exe" --profile tauri' },
    { pid: 801, ppid: 800, name: "cmd.exe", cmd: "cmd.exe /c node C:\\tools\\server-sequential-thinking\\dist\\index.js" },
    { pid: 802, ppid: 801, name: "node.exe", cmd: "node C:\\tools\\server-sequential-thinking\\dist\\index.js" },
    // stranded chain from an earlier run: parent is gone (ppid 1 / unknown)
    { pid: 900, ppid: 1, name: "cmd.exe", cmd: "cmd.exe /c node C:\\tools\\server-sequential-thinking\\dist\\index.js" },
    { pid: 901, ppid: 900, name: "node.exe", cmd: "node C:\\tools\\server-sequential-thinking\\dist\\index.js" },
    { pid: 950, ppid: 1, name: "chrome.exe", cmd: '"C:\\chrome.exe" --type=renderer' },
    { pid: 999, ppid: 1, name: "self", cmd: "node C:\\tools\\server-sequential-thinking\\dist\\index.js" },
  ];
  const signatures = commandSignatures([{ command: "node", args: ["C:\\tools\\server-sequential-thinking\\dist\\index.js"] }]);
  const { orphans, live } = classifyOrphans(processes, signatures, 999);
  console.log("orphans:", orphans.map((item) => item.pid).join(","), "live:", live.map((item) => item.pid).join(","));
  check(orphans.map((item) => item.pid).sort((a, b) => a - b).join(",") === "900,901", "the stranded chain must be the only orphans");
  check(live.map((item) => item.pid).sort((a, b) => a - b).join(",") === "801,802", "children of a live harness must be kept");
  check(!orphans.some((item) => item.pid === 999), "the calling process must never be an orphan");
  check(!orphans.some((item) => item.pid === 950), "an unrelated process must not be a candidate");
}

// 3) an empty signature set matches nothing (no accidental mass kill)
{
  const { orphans } = classifyOrphans([{ pid: 5, ppid: 1, name: "node.exe", cmd: "node whatever" }], []);
  check(orphans.length === 0, "no signature must mean no candidates");
}

// 4) normalization is case- and separator-insensitive (Windows paths from CIM)
{
  check(normalizeCommand("C:\\Tools\\Server.EXE") === "c:/tools/server.exe", "normalizeCommand should fold separators and case");
}

if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("ORPHAN CLEANUP SMOKE FAILED");
  process.exit(1);
}
console.log("ORPHAN CLEANUP SMOKE PASSED");
