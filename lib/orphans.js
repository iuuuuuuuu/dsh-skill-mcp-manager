// Leftover MCP child processes ("residual" servers): a restart that leaves a
// stdio server behind strands the whole `npx → cmd → node` chain. The plugin
// already knows which commands it manages — registry stdio entries plus the
// plugin-contributed loader rows — so it can list processes that still run one of
// those commands while no live DSH host owns them.
//
// Only the OS query is impure. Windows needs Win32_Process for command lines
// (tasklist-based helpers such as ps-list report none), POSIX uses ps; matching
// and the live/orphan decision are pure so they can be tested against fixtures.

import { spawn } from "node:child_process";
import process from "node:process";

// A bare interpreter name is not a signature: "node" or "cmd" matches everything.
const GENERIC_RUNNERS = new Set([
  "node", "node.exe", "npx", "npx.cmd", "npm", "npm.cmd", "pnpm", "pnpm.cmd",
  "cmd", "cmd.exe", "python", "python3", "python.exe", "uv", "uvx", "deno", "bun",
  "sh", "bash", "zsh", "pwsh", "pwsh.exe", "powershell", "powershell.exe",
]);

// A process belongs to a live harness when it or any ancestor is the desktop
// shell or the dsh CLI — that covers the host we run in and any other running
// DSH instance (a scratch instance's children must survive too).
const HOST_NAME_RE = /dsh tauri\.exe|deepseek-harness-desktop|dsh[\\/]lib[\\/]bin\.js|dsh-app-boot/i;

export function normalizeCommand(value) {
  return String(value ?? "").replace(/\\/g, "/").toLowerCase();
}

// One specific string per managed server. For a generic runner the executable
// part is meaningless, so the script path or the npm package argument is used
// instead — that is also what identifies the leaked npx chains in practice.
export function commandSignatures(commands) {
  const signatures = new Set();
  for (const item of commands ?? []) {
    const command = typeof item?.command === "string" ? item.command.trim() : "";
    if (command === "") continue;
    const base = (command.split(/[\\/]/).pop() ?? command).toLowerCase();
    if (GENERIC_RUNNERS.has(base)) {
      for (const raw of item.args ?? []) {
        const text = String(raw ?? "").trim();
        if (text.length < 8 || text.startsWith("-")) continue;
        if (!/[\\/]|@/.test(text)) continue;
        signatures.add(normalizeCommand(text));
      }
      continue;
    }
    signatures.add(normalizeCommand(command));
    if (base.length >= 8) signatures.add(base);
  }
  return [...signatures];
}

export function classifyOrphans(processes, signatures, selfPid = process.pid) {
  const byPid = new Map((processes ?? []).map((item) => [item.pid, item]));
  const protectedCache = new Map();
  const isProtected = (pid) => {
    if (protectedCache.has(pid)) return protectedCache.get(pid);
    let current = byPid.get(pid);
    let result = false;
    const seen = new Set();
    while (current !== undefined && !seen.has(current.pid)) {
      seen.add(current.pid);
      if (current.pid === selfPid || HOST_NAME_RE.test(`${current.name ?? ""} ${current.cmd ?? ""}`)) {
        result = true;
        break;
      }
      current = byPid.get(current.ppid);
    }
    protectedCache.set(pid, result);
    return result;
  };

  const orphans = [];
  const live = [];
  for (const item of processes ?? []) {
    if (item.pid === undefined || item.pid === 0 || item.pid === selfPid) continue;
    const cmd = normalizeCommand(item.cmd);
    if (cmd === "") continue;
    const matched = (signatures ?? []).find((signature) => cmd.includes(signature));
    if (matched === undefined) continue;
    if (isProtected(item.pid)) {
      live.push({ pid: item.pid, name: item.name ?? "" });
      continue;
    }
    orphans.push({
      pid: item.pid,
      name: item.name ?? "",
      matched,
      cmd: String(item.cmd ?? "").slice(0, 300),
    });
  }
  return { orphans, live };
}

function runCommand(file, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(new Error(`${file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout !== "") resolve(stdout);
      else reject(new Error(`${file} exited with ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

export async function listProcesses() {
  if (process.platform === "win32") {
    const stdout = await runCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ]);
    const parsed = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      name: row.Name ?? "",
      cmd: row.CommandLine ?? "",
    }));
  }
  const stdout = await runCommand("ps", ["-eo", "pid=,ppid=,args="]);
  const rows = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: (match[3].split(/\s+/)[0] ?? ""), cmd: match[3] });
  }
  return rows;
}

// SIGTERM first (a well-behaved MCP server exits on stdin close), SIGKILL for what
// is still alive after the grace period.
export async function killPids(pids, graceMs = 1500) {
  const killed = [];
  const failed = [];
  for (const pid of pids ?? []) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (error) {
      failed.push({ pid, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (killed.length === 0) return { killed, failed };
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  for (const pid of killed) {
    try {
      process.kill(pid, 0);
    } catch {
      continue; // already gone
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* it exited between the check and the kill */
    }
  }
  return { killed, failed };
}
