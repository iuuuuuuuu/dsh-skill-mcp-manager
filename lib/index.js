// dsh-skill-mcp-manager — host plugin for DeepSeek Harness.
//
// Visual, manageable, injectable MCP management (Skill management lands in M1).
// Three tiers per MCP server:
//   - eager      : each session starts its own connection and registers native `mcp__<server>__<tool>` tools
//   - on-demand  : no connection until that session calls `mcp_load`; `mcp_call` uses the session instance
//   - disabled   : registered but hidden
//
// Model-facing tools: mcp_register / mcp_load / mcp_call.
// A pre-step `mcp-catalog` injects the visible server summary (append-only,
// re-appended only when the model-facing text is no longer on the surface).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stringify, parse } from "yaml";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ResilientStdioTransport } from "./stdio-transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerRecursiveSkillProvider, setDisableModelInvocation } from "./skill.js";
import { readWorkspaceMcp } from "./workspace-mcp.js";
import { formatMcpConfig, parseMcpConfigDocument } from "./mcp-config.js";
import { buildAuthorizeUrl, exchangeCode, pkcePair, planOAuth, randomState, registerClient } from "./oauth.js";
import { createServer as createHttpServer } from "node:http";
import {
  assignSkill as assignSkillToGroup,
  createGroup as createSkillGroup,
  deleteGroup as deleteSkillGroup,
  emptyGroups,
  moveGroup as moveSkillGroup,
  normalizeGroups,
  renameGroup as renameSkillGroup,
} from "./skill-groups.js";
import { mountUi, entryView, openWithSystemEditor, trashDirectory } from "./ui.js";
import { classifyOrphans, commandSignatures, killPids, listProcesses } from "./orphans.js";
import { createAuditRunner } from "./session-audit.js";
import { copySkillDir, importSourceDirs, isValidTargetName, pruneNested, skillsInDir } from "./skills-import.js";
import { childEnv } from "./child-env.js";
import {
  createMcpResultOutput,
  finalizeMcpResultContent,
  settleMcpToolResult,
  supportedStructuredSchema,
} from "./mcp-result.js";

const name = "skill-mcp-manager";
const inject = ["tools", "skills"];

function readPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
  } catch {
    /* package.json unreadable — the MCP handshake still needs a string */
  }
  return "0.0.0";
}

const PLUGIN_VERSION = readPluginVersion();

const TIERS = new Set(["eager", "on-demand", "disabled"]);
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
// Managed MCP shadow/takeover block in the profile's cordis.patch.yml.
// reconcile / prepare-uninstall replace only the span between these markers.
const MANAGED_MARKER = "# ── Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries) ──";
const MANAGED_END_MARKER = "# ── End managed MCP servers (dsh-skill-mcp-manager) ──";
// Begin of the block after prepare-uninstall hands entries back to native.
const HANDOVER_MARKER = "# ── Handed back to native dsh-mcp-client (was managed by dsh-skill-mcp-manager) ──";
// DeepSeek function-name contract: 64 chars, [A-Za-z0-9_-].
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

const Config = z.object({
  dataDir: z.string().default(""),
  profile: z.string().default("web"),
  trialTimeoutMs: z.number().default(30000),
  // Connection check from the management UI. Shorter than the trial timeout:
  // the caller is a person looking at a card, not a registration that must not
  // be lost to a slow cold start.
  checkTimeoutMs: z.number().default(15000),
  toolCallTimeoutMs: z.number().default(60000),
  catalogDescriptionMaxLength: z.number().default(500),
  toolDescriptionMaxLength: z.number().default(150),
  importNativeMcp: z.boolean().default(true),
  // Where skills imported from another agent are copied to (default
  // `$DSH_HOME/skills`) and which home the sources (~/.agents, ~/.claude,
  // ~/.codex) are resolved under (default the current user). Only tests and
  // unusual installations change them.
  skillsDir: z.string().default(""),
  importHomeDir: z.string().default(""),
});

// ── storage ────────────────────────────────────────────────────────────────

// `~` is the only expansion a config path gets; anything else is verbatim.
function expandHome(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

function resolveDataDir(config) {
  return expandHome(config.dataDir) || join(DSH_HOME, "skill-mcp-manager");
}

// The profile this host process actually booted (`--profile <name>` on the
// dsh CLI invocation), so a bundle-installed plugin manages the profile it
// lives in without a hand-written config row.
function argvProfile() {
  const argv = process.argv;
  const flag = argv.indexOf("--profile");
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith("-")) return argv[flag + 1];
  return undefined;
}

function resolveProfile(config) {
  return config.profile && config.profile !== "" ? config.profile : argvProfile() ?? "web";
}

function emptyRegistry() {
  return { version: 1, entries: [] };
}

async function loadRegistry(dataDir) {
  try {
    const text = await readFile(join(dataDir, "registry.json"), "utf8");
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object" || !Array.isArray(data.entries)) {
      throw new Error("registry.json has an invalid shape (expected { version, entries })");
    }
    return data;
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

async function saveRegistry(dataDir, registry) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, "registry.json");
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

async function loadSettings(dataDir) {
  try {
    const text = await readFile(join(dataDir, "settings.json"), "utf8");
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function saveSettings(dataDir, settings) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, "settings.json");
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

// Keep the newest `keep` backups named `${prefix}<timestamp>`. Older copies
// are removed. Unrelated files in the directory are left alone.
export async function pruneBackups(directory, prefix, keep = 5) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const backups = names
    .filter((item) => item.startsWith(prefix))
    .map((item) => ({ item, stamp: Number(item.slice(prefix.length)) }))
    .filter((item) => Number.isFinite(item.stamp))
    .sort((a, b) => a.stamp - b.stamp);
  const extra = backups.slice(0, Math.max(0, backups.length - keep));
  for (const item of extra) {
    try {
      await unlink(join(directory, item.item));
    } catch {
      /* a backup that already disappeared is pruned */
    }
  }
}

async function writePatch(patchPath, current, next) {
  if (next === current) return false;
  await writeFile(`${patchPath}.bak-${Date.now()}`, current, "utf8");
  await writeFile(patchPath, next, "utf8");
  await pruneBackups(dirname(patchPath), `${basename(patchPath)}.bak-`);
  return true;
}

const LOCAL_COMMAND_APPROVALS = new Set(["follow", "always-ask", "always-allow"]);

export function normalizeLanHostAllowlist(value) {
  if (!Array.isArray(value)) throw new Error("lanHostAllowlist must be an array of hostnames");
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("lanHostAllowlist entries must be hostnames");
    const host = item.trim().toLowerCase();
    if (host === "") continue;
    if (host.length > 253 || /[\s/\\:@]/.test(host) || host.includes("..")) {
      throw new Error(`invalid LAN hostname "${item}"`);
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

// ── native MCP import / takeover ──────────────────────────────────────────

// Parse a patch section (the text before the managed marker) for native
// @deepseek-ai/dsh-mcp-client insert rows. A native section that does not
// parse (e.g. it uses an unknown YAML tag) yields [] so the plugin never
// corrupts it — native entries are simply left untouched.
function parseNativeMcpEntries(nativeText) {
  const found = [];
  try {
    const docs = parse(nativeText);
    if (!Array.isArray(docs)) return found;
    for (const block of docs) {
      if (block === null || typeof block !== "object" || !Array.isArray(block.insert)) continue;
      for (const entry of block.insert) {
        if (entry !== null && typeof entry === "object" && entry.name === "@deepseek-ai/dsh-mcp-client") {
          found.push(entry);
        }
      }
    }
  } catch {
    /* leave native entries untouched */
  }
  return found;
}

function indexAfterLine(text, index) {
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline + 1;
}

// Top-level `- …` blocks in a patch-array slice. Comments and blank lines
// that are not attached to a block are ignored (the managed span's comments
// are generated by this plugin).
function splitTopLevelPatchEntries(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  let buf = [];
  const flush = () => {
    while (buf.length > 0 && buf[buf.length - 1] === "") buf.pop();
    if (buf.length === 0) return;
    entries.push(buf.join("\n"));
    buf = [];
  };
  for (const line of lines) {
    if (line.startsWith("- ")) {
      flush();
      buf.push(line);
    } else if (buf.length > 0) {
      buf.push(line);
    }
  }
  flush();
  return entries;
}

// Ours: a shadow `- insert:` of dsh-mcp-client rows, or a takeover row that
// is only `{ id, disabled: true }`. Anything else (oauth, other plugins,
// mixed inserts) is not rewritten.
function isManagedPatchEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  if (
    typeof entry.id === "string" &&
    entry.id !== "" &&
    entry.disabled === true &&
    keys.length === 2 &&
    keys.includes("id") &&
    keys.includes("disabled")
  ) {
    return true;
  }
  if (!Array.isArray(entry.insert) || entry.insert.length === 0) return false;
  if (typeof entry.id === "string" && entry.id !== "") return false;
  return entry.insert.every(
    (item) => item !== null && typeof item === "object" && item.name === "@deepseek-ai/dsh-mcp-client",
  );
}

function extractUnrecognizedMiddle(middleText) {
  const kept = [];
  for (const block of splitTopLevelPatchEntries(middleText)) {
    let parsed;
    try {
      parsed = parse(block);
    } catch {
      kept.push(block);
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length > 0 && items.every(isManagedPatchEntry)) continue;
    kept.push(block);
  }
  return kept.join("\n");
}

function splitPatchAroundManaged(text) {
  const start = text.indexOf(MANAGED_MARKER);
  if (start < 0) {
    return { prefix: text, middle: "", relocated: "", suffix: "" };
  }
  const afterStart = indexAfterLine(text, start);
  const end = text.indexOf(MANAGED_END_MARKER, afterStart);
  let middle;
  let suffix;
  if (end >= 0) {
    middle = text.slice(afterStart, end);
    suffix = text.slice(indexAfterLine(text, end));
  } else {
    middle = text.slice(afterStart);
    suffix = "";
  }
  return {
    prefix: text.slice(0, start),
    middle,
    relocated: extractUnrecognizedMiddle(middle),
    suffix,
  };
}

function stitchPatch(prefix, block, relocated, suffix) {
  const extras = [];
  if (block && block.trim() !== "") extras.push(block.replace(/^\n+/, "").trimEnd());
  if (relocated && relocated.trim() !== "") extras.push(relocated.replace(/^\n+/, "").trimEnd());
  let next = prefix.trimEnd();
  if (extras.length > 0) next += `\n\n${extras.join("\n\n")}\n`;
  else next += "\n";
  if (suffix) {
    next += suffix;
    if (!next.endsWith("\n")) next += "\n";
  }
  return next;
}

// ── full-merge takeover helpers ────────────────────────────────────────────

// Top-level `- …` blocks in a patch-array slice, with their line spans so the
// caller can excise whole blocks. Comments and blank lines that are not
// attached to a block are ignored.
function splitTopLevelPatchEntriesWithRanges(text) {
  const lines = text.split(/\r?\n/);
  const lineOffsets = [];
  let acc = 0;
  for (const line of lines) {
    lineOffsets.push(acc);
    acc += line.length + 1;
  }
  const entries = [];
  let buf = [];
  let startLine = -1;
  const flush = () => {
    while (buf.length > 0 && buf[buf.length - 1] === "") buf.pop();
    if (buf.length === 0) return;
    const startOffset = lineOffsets[startLine];
    const endLine = startLine + buf.length;
    entries.push({
      text: buf.join("\n"),
      startLine,
      lineCount: buf.length,
      startOffset,
      endOffset: lineOffsets[Math.min(endLine, lineOffsets.length - 1)] + (endLine >= lineOffsets.length ? lines[lines.length - 1].length : 0),
    });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("- ")) {
      flush();
      startLine = i;
      buf.push(lines[i]);
    } else if (buf.length > 0) {
      buf.push(lines[i]);
    }
  }
  flush();
  return { entries, lineOffsets, lineCount: lines.length };
}

// Segment the rows of one `- insert:` entry into line spans. Row starts are
// `- ` lines at the sequence's own indent; deeper-indented lines (args lists,
// nested maps) belong to the current row. Returns null when the structure is
// not recognizable — the caller then leaves the entry untouched.
function segmentInsertRows(entryText) {
  const lines = entryText.split(/\r?\n/);
  let seqIndent = null;
  const rows = [];
  let current = null;
  for (let i = 1; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- /);
    if (match !== null) {
      const indent = match[1].length;
      if (seqIndent === null) seqIndent = indent;
      if (indent === seqIndent) {
        if (current !== null) rows.push(current);
        current = { relStart: i, relEnd: lines.length };
        continue;
      }
    }
  }
  if (current !== null) rows.push(current);
  if (seqIndent === null) return null;
  // close each row at the next row start
  for (let i = 0; i < rows.length; i++) {
    rows[i].relEnd = i + 1 < rows.length ? rows[i + 1].relStart : lines.length;
  }
  return rows;
}

// Remove every @deepseek-ai/dsh-mcp-client insert row that lives OUTSIDE the
// managed span and is claimed by a registry entry (row id ∈ claimedIds) —
// after a merge those rows exist only inside the managed block, and a
// leftover copy outside would collide on the loader entry id. Rows the
// registry does not claim (importNativeMcp: false, foreign rows) stay
// untouched. Whole `- insert:` blocks that become empty are removed;
// comments trailing an entry are kept.
function removeOutsideMcpRows(text, managedStartOffset, managedEndOffset, claimedIds) {
  const { entries, lineOffsets, lineCount } = splitTopLevelPatchEntriesWithRanges(text);
  const cuts = [];
  for (const entry of entries) {
    // A negative managedStartOffset means the file has no managed span yet —
    // every row is then outside and subject to excision.
    if (managedStartOffset >= 0 && entry.startOffset >= managedStartOffset && entry.startOffset < managedEndOffset) continue;
    let parsed;
    try {
      parsed = parse(entry.text);
    } catch {
      continue;
    }
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    if (blocks.length !== 1 || blocks[0] === null || typeof blocks[0] !== "object") continue;
    const insert = blocks[0].insert;
    if (!Array.isArray(insert) || insert.length === 0) continue;
    const dshIndexes = [];
    const claimedIndexes = [];
    insert.forEach((row, index) => {
      if (row === null || typeof row !== "object" || row.name !== "@deepseek-ai/dsh-mcp-client") return;
      dshIndexes.push(index);
      if (typeof row.id === "string" && claimedIds.has(row.id)) claimedIndexes.push(index);
    });
    if (claimedIndexes.length === 0) continue;
    if (claimedIndexes.length === dshIndexes.length && dshIndexes.length === insert.length) {
      // Whole entry goes; keep trailing comment lines attached after it.
      let endOffset = entry.endOffset;
      const entryLines = entry.text.split(/\r?\n/);
      while (entryLines.length > 0) {
        const last = entryLines[entryLines.length - 1].trim();
        if (last === "" || last.startsWith("#")) {
          entryLines.pop();
          endOffset = lineOffsets[entry.startLine + entryLines.length] ?? endOffset;
        } else break;
      }
      cuts.push([entry.startOffset, endOffset]);
      continue;
    }
    const rows = segmentInsertRows(entry.text);
    if (rows === null || rows.length !== insert.length) continue;
    const entryLines = entry.text.split(/\r?\n/);
    const relOffsets = [];
    let relAcc = 0;
    for (const line of entryLines) {
      relOffsets.push(relAcc);
      relAcc += line.length + 1;
    }
    for (const index of claimedIndexes) {
      const row = rows[index];
      const start = entry.startOffset + relOffsets[row.relStart];
      const lastLine = Math.min(row.relEnd, entryLines.length - 1);
      const end = entry.startOffset + relOffsets[lastLine] + (entryLines[lastLine]?.length ?? 0) + 1;
      cuts.push([start, Math.min(end, text.length)]);
    }
  }
  let next = text;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, start) + next.slice(Math.min(end, next.length));
  }
  return next;
}

// Build a registry entry from a native dsh-mcp-client insert row.
// `rawConfig` keeps the row's original config verbatim (including fields the
// registry does not model) until the user edits the entry through
// mcp_register, which rebuilds the entry and drops it.
function nativeEntryToRegistryEntry(native, tier) {
  const cfg = native.config ?? {};
  const name = cfg.serverName;
  const now = new Date().toISOString();
  return {
    id: name,
    name,
    tier,
    transport: cfg.transport,
    command: cfg.command ?? null,
    args: cfg.args ?? [],
    env: cfg.env ?? {},
    cwd: cfg.cwd ?? null,
    url: cfg.url ?? null,
    headers: cfg.headers ?? {},
    notes: "",
    systemEntryId: typeof native.id === "string" ? native.id : `mcp-${name}`,
    managed: true,
    registeredAt: now,
    lastLoadAt: null,
    lastCheck: null,
    lastSyncAt: now,
    tools: [],
    disabledTools: [],
    serverName: "",
    serverVersion: "",
    serverTitle: "",
    serverDescription: "",
    websiteUrl: "",
    instructions: "",
    capabilities: null,
    metaFetchedAt: null,
    rawConfig: { ...cfg },
  };
}

// ── MCP client ─────────────────────────────────────────────────────────────

async function buildTransport(entry, stdioMaxBufferSizeBytes) {
  switch (entry.transport) {
    case "stdio":
      // ResilientStdioTransport: wire-compatible with the SDK transport, but an
      // oversized message is answered with a synthetic JSON-RPC error instead
      // of tearing the connection down (see lib/stdio-transport.js).
      return new ResilientStdioTransport({
        command: entry.command,
        args: entry.args ?? [],
        env: await childEnv(entry.env),
        cwd: entry.cwd || undefined,
        ...(stdioMaxBufferSizeBytes === undefined ? {} : { maxBufferSize: stdioMaxBufferSizeBytes }),
      });
    case "streamable-http":
      return new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: { headers: entry.headers ?? {} },
      });
    default:
      throw new Error(`unsupported transport "${entry.transport}"`);
  }
}

async function connectEntry(entry, timeoutMs, stdioMaxBufferSizeBytes) {
  const client = new Client({ name, version: PLUGIN_VERSION });
  const transport = await buildTransport(entry, stdioMaxBufferSizeBytes);
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`connection to "${entry.name}" timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([client.connect(transport), timeout]);
    const tools = await listTools(client);
    // Server-declared metadata from the initialize handshake (the newer spec
    // adds name/version/title/description/websiteUrl to serverInfo, plus a
    // top-level instructions string and a capabilities object). Empty when the
    // server omits them.
    const serverInfo = client.getServerVersion();
    const instructions = client.getInstructions();
    const capabilities = client.getServerCapabilities();
    return { client, transport, tools, serverInfo, instructions, capabilities };
  } catch (error) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function listTools(client) {
  const tools = [];
  let cursor;
  do {
    const response = await client.request(
      { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema,
    );
    tools.push(...response.tools);
    cursor = response.nextCursor;
  } while (cursor);
  return tools;
}

const MAX_ERROR_CONTEXT_CHARS = 2000;

// Same job as dsh-mcp-client's RawCallToolResultSchema: do not let the SDK
// reject a tools/call payload before this plugin applies the host projection.
// A zod record is not importable here; safeParse is all the SDK calls.
const RawCallToolResultSchema = {
  safeParse(data) {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { success: false, error: new Error("MCP tool result must be an object") };
    }
    return { success: true, data };
  },
};

function clipJson(value) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= MAX_ERROR_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_CONTEXT_CHARS)}…(truncated, ${text.length} chars total)`;
}

// Protocol/transport-level tool-call failures (-32602, -32603, timeouts, …) are
// opaque to the model on their own. When errorInfo is provided, append the call
// context (server/tool, arguments sent, tool inputSchema) so the model can see
// what it sent and self-correct instead of guessing.
async function callTool(client, rawName, args, timeoutMs, signal, errorInfo) {
  const safeArgs = args && typeof args === "object" ? args : {};
  try {
    return await client.request(
      { method: "tools/call", params: { name: rawName, arguments: safeArgs } },
      RawCallToolResultSchema,
      { signal, timeout: timeoutMs },
    );
  } catch (err) {
    if (errorInfo === undefined) throw err;
    const lines = [
      err instanceof Error ? err.message : String(err),
      `called MCP tool: ${errorInfo.server}/${rawName}`,
      `arguments sent: ${clipJson(safeArgs)}`,
    ];
    if (errorInfo.inputSchema !== undefined) {
      lines.push(`tool inputSchema: ${clipJson(errorInfo.inputSchema)}`);
    }
    throw new Error(lines.join("\n"));
  }
}

// isError tool results are normal responses (server-side business failures,
// e.g. "unknown tool", bad parameters), not protocol rejects — attach the same
// call context so the model can see what it sent and self-correct.
function isErrorContextSuffix(errorInfo, rawName, args) {
  if (errorInfo === undefined) return "";
  return `\ncalled MCP tool: ${errorInfo.server}/${rawName}\narguments sent: ${clipJson(args && typeof args === "object" ? args : {})}`;
}

// ── naming / validation ────────────────────────────────────────────────────

function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

function assertServerName(value) {
  if (typeof value !== "string" || !SERVER_NAME_PATTERN.test(value)) {
    throw new Error(`invalid MCP name "${value}" (must match [A-Za-z0-9_-]{1,32})`);
  }
}

function truncate(value, maxLength) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function disabledToolNames(entry) {
  return new Set(Array.isArray(entry?.disabledTools) ? entry.disabledTools.filter((value) => typeof value === "string") : []);
}

function isToolDisabled(entry, toolName) {
  return disabledToolNames(entry).has(toolName);
}

function enabledTools(entry, tools) {
  const disabled = disabledToolNames(entry);
  return (tools ?? []).filter((tool) => !disabled.has(tool.name));
}

function connectionIdentity(entry) {
  if (entry.transport === "stdio") {
    return JSON.stringify({
      transport: "stdio",
      command: entry.command ?? null,
      args: entry.args ?? [],
      env: entry.env ?? {},
      cwd: entry.cwd ?? null,
    });
  }
  return JSON.stringify({
    transport: entry.transport ?? null,
    url: entry.url ?? null,
    headers: entry.headers ?? {},
  });
}

function registrationIdentity(entry) {
  return JSON.stringify({
    connection: connectionIdentity(entry),
    disabledTools: [...disabledToolNames(entry)].sort(),
  });
}

// A new stdio command, or a change to the program / args / env / cwd that
// will actually be executed. Tier, notes, remote URL, and an unchanged
// resubmit are not a local-command change.
export function localExecutionChange(existing, args, transport) {
  if (transport !== "stdio") return null;
  const next = {
    command: args.command !== undefined ? args.command : existing?.command ?? null,
    args: args.args !== undefined ? args.args : existing?.args ?? [],
    env: args.env !== undefined ? args.env : existing?.env ?? {},
    cwd: args.cwd !== undefined ? args.cwd : existing?.cwd ?? null,
  };
  if (existing === undefined || existing.transport !== "stdio") return { kind: "add", ...next };
  const same = (existing.command ?? null) === next.command
    && JSON.stringify(existing.args ?? []) === JSON.stringify(next.args)
    && JSON.stringify(existing.env ?? {}) === JSON.stringify(next.env)
    && (existing.cwd ?? null) === next.cwd;
  if (same) return null;
  return { kind: "change", ...next };
}

function localExecutionReason(change) {
  const lines = [
    change.kind === "add"
      ? "将新登记一个本地程序。保存之后，开机预热和每个会话都可能再次启动它。"
      : "将修改一个本地程序。保存之后，开机预热和每个会话都可能再次启动它。",
    `程序：${change.command}`,
    `参数：${JSON.stringify(change.args ?? [])}`,
  ];
  if (change.cwd) lines.push(`工作目录：${change.cwd}`);
  const envKeys = Object.keys(change.env ?? {});
  if (envKeys.length > 0) lines.push(`环境变量名：${envKeys.join(", ")}`);
  return lines.join("\n");
}

// ── entry construction ─────────────────────────────────────────────────────

function buildEntry(args, existing, tools) {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? args.name,
    name: args.name,
    tier: args.tier ?? existing?.tier ?? "on-demand",
    transport: args.transport ?? existing?.transport,
    command: args.command ?? existing?.command ?? null,
    args: args.args ?? existing?.args ?? [],
    env: args.env ?? existing?.env ?? {},
    cwd: args.cwd ?? existing?.cwd ?? null,
    url: args.url ?? existing?.url ?? null,
    headers: args.headers ?? existing?.headers ?? {},
    notes: args.notes ?? existing?.notes ?? "",
    systemEntryId: `mcp-${args.name}`,
    managed: true,
    registeredAt: existing?.registeredAt ?? now,
    lastLoadAt: existing?.lastLoadAt ?? null,
    lastCheck: existing?.lastCheck ?? null,
    lastSyncAt: now,
    tools: tools ?? existing?.tools ?? [],
    disabledTools: existing?.disabledTools ?? [],
    serverName: existing?.serverName ?? "",
    serverVersion: existing?.serverVersion ?? "",
    serverTitle: existing?.serverTitle ?? "",
    serverDescription: existing?.serverDescription ?? "",
    websiteUrl: existing?.websiteUrl ?? "",
    instructions: existing?.instructions ?? "",
    capabilities: existing?.capabilities ?? null,
    metaFetchedAt: existing?.metaFetchedAt ?? null,
  };
}

// ── model-facing output ────────────────────────────────────────────────────
// Management tools stay text. MCP tool results use the host client's contract
// (raw content + text projection + image admission) from lib/mcp-result.js.

const TEXT_OUTPUT = {
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: "text", text: value.text }],
};

// ── apply ──────────────────────────────────────────────────────────────────

async function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config);
  // Import target: the DSH-owned skill root the built-in filesystem provider
  // scans (user-dsh rank). The built-in provider ranks a project root above it,
  // so an imported skill never shadows a project's own copy.
  const skillsImportDir = expandHome(config.skillsDir) || join(DSH_HOME, "skills");
  const importHomeDir = expandHome(config.importHomeDir) || homedir();
  const trialTimeoutMs = config.trialTimeoutMs ?? 30000;
  const checkTimeoutMs = config.checkTimeoutMs ?? 15000;
  const toolCallTimeoutMs = config.toolCallTimeoutMs ?? 60000;
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? 500;
  let toolDescriptionMaxLength = config.toolDescriptionMaxLength ?? 150;
  let localCommandApproval = "follow";
  let lanHostAllowlist = [];
  // stdio read-buffer limit for MCP connections, in MB. null = unset = the
  // SDK default (10 MiB). No extra ceiling is enforced on top of the SDK's
  // own semantics; see lib/stdio-transport.js for the oversized-message path.
  let stdioMaxBufferSizeMb = null;
  let stdioMaxBufferSizeBytes = undefined;
  function applyStdioMaxBufferSizeSetting(value) {
    stdioMaxBufferSizeMb = typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
    stdioMaxBufferSizeBytes = stdioMaxBufferSizeMb === null ? undefined : stdioMaxBufferSizeMb * 1048576;
  }

  // Live runtime state: one MCP instance set per DSH agent/session.
  const liveSessions = new Set();
  // Eager entries that failed to connect. The tier stays eager. Sessions that
  // are not already mounted skip further automatic connects until a manual
  // load or snapshot refresh succeeds. Not persisted: a process restart tries
  // once again.
  const eagerConnectFailed = new Set();
  // Row ids removed through the management UI. Reconcile must not adopt the
  // shadow row that is still in the patch until this same reconcile rewrites it.
  const retiredRowIds = new Set();
  let registry = emptyRegistry();

  async function snapshotTools(client) {
    // Keep the server-declared inputSchema in snapshots: mcp_load renders it so
    // the model can see parameter structure before calling, and registry.json
    // persists it for peek/UI. Stripping it here silently starves the renderer.
    return (await listTools(client)).map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
  }

  // Copy server-declared metadata (from the initialize handshake) onto the
  // entry. These are read-only and refresh only when we reconnect — they are
  // never overwritten by a user note or an mcp_register edit.
  function applyServerMetadata(entry, connection) {
    entry.metaFetchedAt = new Date().toISOString();
    const info = connection?.serverInfo;
    if (info && typeof info === "object") {
      if (typeof info.name === "string" && info.name !== "") entry.serverName = info.name;
      if (typeof info.version === "string" && info.version !== "") entry.serverVersion = info.version;
      if (typeof info.title === "string" && info.title !== "") entry.serverTitle = info.title;
      if (typeof info.description === "string" && info.description !== "") entry.serverDescription = info.description;
      if (typeof info.websiteUrl === "string" && info.websiteUrl !== "") entry.websiteUrl = info.websiteUrl;
    }
    if (typeof connection?.instructions === "string" && connection.instructions !== "") {
      entry.instructions = connection.instructions;
    }
    if (connection?.capabilities && typeof connection.capabilities === "object") {
      entry.capabilities = connection.capabilities;
    }
  }

  function sessionOf(agent) {
    if (agent === undefined || agent === null) throw new Error("MCP session runtime requires an agent");
    for (const session of liveSessions) {
      if (session.agent === agent) return session;
    }
    const session = {
      agent,
      connections: new Map(),
      nativeDisposers: new Map(),
      registrationKeys: new Map(),
      connectionKeys: new Map(),
    };
    liveSessions.add(session);
    const agentCtx = agent.ctx;
    if (agentCtx !== undefined && typeof agentCtx.effect === "function") {
      agentCtx.effect(() => async () => {
        liveSessions.delete(session);
        await disposeSession(session);
      });
    }
    return session;
  }

  function toolHost(session) {
    return session.agent?.ctx?.tools ?? ctx.tools;
  }

  async function ensureConnected(session, entry) {
    const existing = session.connections.get(entry.name);
    if (existing !== undefined) return existing;
    const connection = await connectEntry(entry, trialTimeoutMs, stdioMaxBufferSizeBytes);
    session.connections.set(entry.name, connection);
    applyServerMetadata(entry, connection);
    return connection;
  }

  async function ensureEager(session, entry) {
    const connection = await ensureConnected(session, entry);
    entry.tools = connection.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
    const previous = session.nativeDisposers.get(entry.name);
    if (previous !== undefined) for (const dispose of previous.values()) dispose();
    const disposers = new Map();
    const host = toolHost(session);
    for (const tool of enabledTools(entry, connection.tools)) {
      const publicName = publicToolName(entry.name, tool.name);
      const projections = new WeakMap();
      disposers.set(publicName, host.register({
        name: publicName,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object" },
        output: createMcpResultOutput(supportedStructuredSchema(tool.outputSchema), tool.name),
        finalizeContent(exec, result) {
          return finalizeMcpResultContent(projections, exec, result);
        },
        async execute(args, exec) {
          if (isToolDisabled(entry, tool.name)) throw new Error(`MCP tool "${entry.name}/${tool.name}" is disabled`);
          const live = session.connections.get(entry.name) ?? connection;
          const errorContext = { server: entry.name, inputSchema: tool.inputSchema };
          const result = await callTool(live.client, tool.name, args, toolCallTimeoutMs, exec.signal, errorContext);
          return settleMcpToolResult(
            ctx,
            exec,
            projections,
            result,
            tool.name,
            isErrorContextSuffix(errorContext, tool.name, args),
          );
        },
      }));
    }
    session.nativeDisposers.set(entry.name, disposers);
    return disposers.size;
  }

  function rememberMount(session, entry) {
    session.registrationKeys.set(entry.name, registrationIdentity(entry));
    session.connectionKeys.set(entry.name, connectionIdentity(entry));
  }

  async function disposeSessionEntry(session, entryName) {
    const connection = session.connections.get(entryName);
    session.connections.delete(entryName);
    session.registrationKeys.delete(entryName);
    session.connectionKeys.delete(entryName);
    const disposers = session.nativeDisposers.get(entryName);
    session.nativeDisposers.delete(entryName);
    if (disposers !== undefined) for (const dispose of disposers.values()) dispose();
    if (connection !== undefined) {
      try {
        await connection.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function disposeSession(session) {
    const names = new Set([...session.connections.keys(), ...session.nativeDisposers.keys()]);
    for (const entryName of names) await disposeSessionEntry(session, entryName);
  }

  async function disposeNamedEverywhere(entryName) {
    for (const session of [...liveSessions]) await disposeSessionEntry(session, entryName);
  }

  async function syncEagerEverywhere(entry) {
    let failed = false;
    const sessions = [...liveSessions];
    for (const session of sessions) {
      try {
        const connected = session.connections.has(entry.name);
        const sameConnection = connected && session.connectionKeys.get(entry.name) === connectionIdentity(entry);
        if (connected && !sameConnection) await disposeSessionEntry(session, entry.name);
        await ensureEager(session, entry);
        rememberMount(session, entry);
      } catch (error) {
        failed = true;
        session.registrationKeys.delete(entry.name);
        ctx.logger.error(`skill-mcp-manager: failed to start eager MCP "${entry.name}" for a session: ${String(error?.message ?? error)}`);
      }
    }
    if (failed) eagerConnectFailed.add(entry.name);
    else if (sessions.length > 0) eagerConnectFailed.delete(entry.name);
  }

  async function ensureSessionRuntime(agent) {
    if (agent === undefined || agent === null) return;
    const session = sessionOf(agent);
    const sessionId = sessionIdOf(agent);
    const sessionWorkspace = await workspaceOf(agent);
    for (const entry of registry.entries) {
      // Pinned to a different workspace: never mounted here, not even to be denied.
      const pinned = workspaceKey(entry.workspace ?? "");
      if (pinned !== "" && pinned !== workspaceKey(sessionWorkspace)) {
        if (session.connections.has(entry.name) || session.nativeDisposers.has(entry.name)) {
          await disposeSessionEntry(session, entry.name);
        }
        continue;
      }
      if (!isSessionAllowed(sessionId, "mcp", entry.name)) {
        if (session.connections.has(entry.name) || session.nativeDisposers.has(entry.name)) {
          await disposeSessionEntry(session, entry.name);
        }
        continue;
      }
      if (entry.tier === "eager") {
        const connected = session.connections.has(entry.name);
        if (!connected && eagerConnectFailed.has(entry.name)) continue;
        const registrationKey = registrationIdentity(entry);
        if (connected && session.registrationKeys.get(entry.name) === registrationKey) continue;
        const sameConnection = connected && session.connectionKeys.get(entry.name) === connectionIdentity(entry);
        try {
          if (connected && !sameConnection) await disposeSessionEntry(session, entry.name);
          await ensureEager(session, entry);
          rememberMount(session, entry);
          eagerConnectFailed.delete(entry.name);
        } catch (error) {
          eagerConnectFailed.add(entry.name);
          session.registrationKeys.delete(entry.name);
          ctx.logger.error(`skill-mcp-manager: failed to start eager MCP "${entry.name}": ${String(error?.message ?? error)}`);
        }
      } else if (entry.tier === "disabled") {
        await disposeSessionEntry(session, entry.name);
      }
    }
  }

  // System-config reconcile (M2): write a `disabled: true` shadow entry per
  // active (non-disabled) registry entry into the profile's cordis.patch.yml,
  // so config survives a plugin uninstall as a static dsh-mcp-client fallback.
  function shadowConfig(entry) {
    const config = { serverName: entry.name, toolCallTimeoutMs: 120000 };
    if (entry.transport === "stdio") {
      config.transport = "stdio";
      config.command = entry.command;
      if (Array.isArray(entry.args) && entry.args.length > 0) config.args = entry.args;
      if (entry.env !== undefined && entry.env !== null && Object.keys(entry.env).length > 0) config.env = entry.env;
      if (entry.cwd) config.cwd = entry.cwd;
    } else if (entry.transport === "streamable-http") {
      config.transport = "streamable-http";
      config.url = entry.url;
      if (entry.headers !== undefined && entry.headers !== null && Object.keys(entry.headers).length > 0) config.headers = entry.headers;
    } else {
      return null;
    }
    return config;
  }

  // Regenerate the managed block from the registry: exactly one disabled row
  // per entry. Config comes from the adopted raw config (serverName kept
  // aligned with the entry's current name) or is synthesized for
  // registry-born entries. A duplicate loader id can never be written —
  // refuse loudly instead of producing a patch that breaks the next boot.
  function entryRowConfig(entry) {
    if (entry.rawConfig && typeof entry.rawConfig === "object") {
      return { ...entry.rawConfig, serverName: entry.name };
    }
    return shadowConfig(entry);
  }

  function entryRowId(entry) {
    return typeof entry.systemEntryId === "string" && entry.systemEntryId !== ""
      ? entry.systemEntryId
      : `mcp-${entry.name}`;
  }

  // ── plugin-contributed MCP rows ───────────────────────────────────────────
  // A bundle may insert its own `@deepseek-ai/dsh-mcp-client` loader row (the box
  // plugin does). Such rows never reach the registry: reconcile only reads the
  // profile patch, and a modifier row there cannot override a bundle's own
  // insert. They are still MCP servers the user wants to switch off, so the UI
  // reads them from the live loader instead, attributes each one to the bundle
  // that declares the row, and toggles it AT RUNTIME — `entry.update({disabled})`
  // disposes or re-creates the fiber, so nothing needs a restart.
  let loader = null;
  if (typeof ctx.inject === "function") {
    ctx.inject(["loader"], (scoped) => {
      loader = scoped.loader;
    });
  } else if (typeof ctx.get === "function") {
    loader = ctx.get("loader") ?? null;
  }

  // loader row id -> bundle name, read from each bundle's own patch file.
  let bundleOwnersCache = null;
  async function bundleRowOwners() {
    if (bundleOwnersCache !== null) return bundleOwnersCache;
    const owners = new Map();
    const scanProfile = async (profileDir) => {
      let pkg;
      try {
        pkg = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
      } catch {
        return;
      }
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
      for (const bundle of bundles) {
        if (typeof bundle !== "string" || bundle === "") continue;
        let text;
        try {
          text = await readFile(join(profileDir, "node_modules", bundle, "cordis.patch.yml"), "utf8");
        } catch {
          continue;
        }
        let docs;
        try {
          docs = parse(text);
        } catch {
          continue;
        }
        if (!Array.isArray(docs)) continue;
        for (const block of docs) {
          if (block === null || typeof block !== "object" || !Array.isArray(block.insert)) continue;
          for (const row of block.insert) {
            if (row === null || typeof row !== "object") continue;
            if (row.name !== "@deepseek-ai/dsh-mcp-client") continue;
            if (typeof row.id !== "string" || row.id === "") continue;
            if (!owners.has(row.id)) owners.set(row.id, bundle);
          }
        }
      }
    };
    // The booted profile is not always the one resolveProfile() names (the
    // desktop launcher does not always pass --profile, and config.profile may be
    // absent), so try that one first and then the rest of the profiles. First
    // match wins; an unattributed row simply shows as "未归属插件".
    const preferred = join(DSH_HOME, "profiles", resolveProfile(config));
    await scanProfile(preferred);
    let siblings = [];
    try {
      siblings = await readdir(join(DSH_HOME, "profiles"));
    } catch {
      siblings = [];
    }
    for (const name of siblings) {
      const dir = join(DSH_HOME, "profiles", name);
      if (dir === preferred) continue;
      await scanProfile(dir);
    }
    bundleOwnersCache = owners;
    return owners;
  }

  function urlHostOnly(url) {
    try {
      const parsed = new URL(String(url));
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return "";
    }
  }

  function nativeLoaderEntries() {
    if (loader === null || typeof loader.entries !== "function") return [];
    return [...loader.entries()].filter((entry) => {
      if (entry === null || entry === undefined) return false;
      if (entry.options?.group) return false;
      return entry.options?.name === "@deepseek-ai/dsh-mcp-client";
    });
  }

  function loaderRowIdOf(entry) {
    return typeof entry.options?.id === "string" && entry.options.id !== "" ? entry.options.id : entry.id;
  }

  // Rows the registry claims are our own shadow rows; everything else came from a
  // bundle (or from a hand-written row reconcile has not absorbed yet — same
  // treatment: it is not one of ours to configure here).
  async function nativeMcpViews() {
    if (loader === null) return { supported: false, entries: [] };
    const owners = await bundleRowOwners();
    const claimed = new Set(registry.entries.map((entry) => entryRowId(entry)));
    const entries = [];
    for (const entry of nativeLoaderEntries()) {
      const id = loaderRowIdOf(entry);
      if (typeof id !== "string" || claimed.has(id)) continue;
      const cfg = entry.options.config ?? {};
      entries.push({
        id,
        serverName: typeof cfg.serverName === "string" && cfg.serverName !== "" ? cfg.serverName : id,
        // Some bundles describe their row in the config; most do not — the card shows
        // nothing rather than inventing text.
        description: typeof cfg.description === "string" ? truncate(cfg.description, 300) : "",
        transport: typeof cfg.transport === "string" ? cfg.transport : "",
        command: typeof cfg.command === "string" ? cfg.command : null,
        urlHost: typeof cfg.url === "string" ? urlHostOnly(cfg.url) : "",
        envKeys: Object.keys(cfg.env ?? {}).length,
        headerKeys: Object.keys(cfg.headers ?? {}).length,
        owner: owners.get(id) ?? null,
        enabled: !entry.disabled,
      });
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    return { supported: true, entries };
  }

  function managedBlockYaml() {
    const rows = [];
    const seen = new Set();
    for (const entry of registry.entries) {
      const id = entryRowId(entry);
      if (seen.has(id)) {
        throw new Error(`managed MCP rows would duplicate loader id "${id}" — refusing to write the patch`);
      }
      seen.add(id);
      const config = entryRowConfig(entry);
      if (config === null) continue;
      rows.push({ id, name: "@deepseek-ai/dsh-mcp-client", config, disabled: true });
    }
    const parts = [MANAGED_MARKER];
    if (rows.length > 0) parts.push(stringify([{ insert: rows }]));
    parts.push(MANAGED_END_MARKER);
    return `${parts.join("\n")}\n`;
  }

  // prepare-uninstall: hand every entry back to the native dsh-mcp-client as
  // an insert row (enabled, except disabled-tier entries keep their disabled
  // flag so the user's off choice survives the handover).
  function handoverBlockYaml() {
    const rows = [];
    for (const entry of registry.entries) {
      const config = entryRowConfig(entry);
      if (config === null) continue;
      const row = { id: entryRowId(entry), name: "@deepseek-ai/dsh-mcp-client", config };
      if (entry.tier === "disabled") row.disabled = true;
      rows.push(row);
    }
    if (rows.length === 0) return "";
    return `${HANDOVER_MARKER}\n${stringify([{ insert: rows }])}`;
  }

  // Absorb + full-merge reconcile:
  //   1. Scan the WHOLE patch file (managed span included) for
  //      @deepseek-ai/dsh-mcp-client insert rows and adopt the ones no
  //      registry entry claims by row id (systemEntryId) — hand-added rows
  //      anywhere are absorbed once; renamed entries are never re-imported.
  //   2. Regenerate the managed span from the registry: exactly one disabled
  //      row per entry. A duplicate loader id aborts the write (self-check).
  //   3. Remove every dsh-mcp-client row outside the managed span — the rows
  //      moved into the block must not survive as stray copies.
  // Returns the number of newly adopted entries.
  async function reconcile() {
    const patchPath = join(DSH_HOME, "profiles", resolveProfile(config), "cordis.patch.yml");
    let current;
    try {
      current = await readFile(patchPath, "utf8");
    } catch {
      ctx.logger.warn(`skill-mcp-manager: cannot read ${patchPath}; reconcile skipped`);
      return 0;
    }
    const { prefix, middle, suffix } = splitPatchAroundManaged(current);
    const claimedIds = new Set(registry.entries.map((entry) => entryRowId(entry)));
    let imported = 0;
    const absorb = (text) => {
      if (config.importNativeMcp === false) return;
      for (const row of parseNativeMcpEntries(text)) {
        const rowId = typeof row.id === "string" && row.id !== "" ? row.id : null;
        if (rowId !== null && (claimedIds.has(rowId) || retiredRowIds.has(rowId))) continue;
        const serverName = row.config?.serverName;
        if (typeof serverName !== "string" || serverName === "") continue;
        if (registry.entries.some((entry) => entry.name === serverName)) continue;
        registry.entries.push(nativeEntryToRegistryEntry(row, row.disabled === true ? "disabled" : "on-demand"));
        if (rowId !== null) claimedIds.add(rowId);
        imported += 1;
      }
    };
    absorb(prefix);
    absorb(middle);
    absorb(suffix);

    let block;
    try {
      block = managedBlockYaml();
    } catch (error) {
      ctx.logger.error(`skill-mcp-manager: ${String(error?.message ?? error)}`);
      if (imported > 0) await saveRegistry(dataDir, registry);
      return imported;
    }

    const managedStart = current.indexOf(MANAGED_MARKER);
    const endMarkerIndex = managedStart < 0 ? -1 : current.indexOf(MANAGED_END_MARKER, managedStart);
    const managedEnd = managedStart < 0 || endMarkerIndex < 0 ? current.length : indexAfterLine(current, endMarkerIndex);
    const stripped = removeOutsideMcpRows(current, managedStart, managedEnd, claimedIds);
    const parts = splitPatchAroundManaged(stripped);
    const next = stitchPatch(parts.prefix, block, parts.relocated, parts.suffix);
    if (next !== current || imported > 0) {
      if (next !== current) {
        await writePatch(patchPath, current, next);
        ctx.logger.info(`skill-mcp-manager: reconciled ${patchPath} (scope: ${resolveProfile(config)})`);
      }
      if (imported > 0) await saveRegistry(dataDir, registry);
    }
    return imported;
  }

  // Warm up imported entries that have no cached snapshot: connect + listTools
  // once (concurrent) so the catalog and the capability-library UI show real
  // tool names from the first session onward. Uses the trial-connection timeout
  // (30s) because the stdio python servers can take 10-30s to boot; a failure
  // is non-fatal — the entry stays empty and can still be loaded via mcp_load.
  async function warmSnapshots() {
    let changed = false;
    const missing = registry.entries.filter(
      (entry) => entry.tier !== "disabled" && (
        !Array.isArray(entry.tools) || entry.tools.length === 0 ||
        entry.metaFetchedAt === undefined || entry.metaFetchedAt === null
      ),
    );
    await Promise.all(missing.map(async (entry) => {
      try {
        const connection = await connectEntry(entry, trialTimeoutMs, stdioMaxBufferSizeBytes);
        try {
          entry.tools = await snapshotTools(connection.client);
          entry.lastLoadAt = new Date().toISOString();
          applyServerMetadata(entry, connection);
          changed = true;
        } finally {
          await connection.client.close();
        }
      } catch (error) {
        ctx.logger.warn(`skill-mcp-manager: warm-up snapshot for "${entry.name}" failed: ${String(error?.message ?? error)}`);
      }
    }));
    if (changed) await saveRegistry(dataDir, registry);
  }

  // prepare-uninstall: flip managed shadow entries `disabled: true -> absent`
  // (enabled), handing them back to the native dsh-mcp-client so they survive
  // uninstalling this plugin. Also dispose eager native registrations first to
  // avoid a transient double registration when the patch hot-reloads.
  async function prepareUninstall() {
    const patchPath = join(DSH_HOME, "profiles", resolveProfile(config), "cordis.patch.yml");
    let current;
    try {
      current = await readFile(patchPath, "utf8");
    } catch {
      return { kind: "error", text: `cannot read ${patchPath}` };
    }
    const { prefix, relocated, suffix } = splitPatchAroundManaged(current);
    if (!current.includes(MANAGED_MARKER)) {
      return { kind: "success", text: "No managed MCP block found — nothing to hand back." };
    }
    const count = registry.entries.filter((entry) => entry.tier !== "disabled").length;
    const block = handoverBlockYaml();
    const next = stitchPatch(prefix, block, relocated, suffix);
    if (next !== current) await writePatch(patchPath, current, next);
    for (const entry of registry.entries) {
      if (entry.tier === "eager") await disposeNamedEverywhere(entry.name);
    }
    return {
      kind: "success",
      text: `Handed ${count} MCP entry/entries back to native dsh-mcp-client. Now remove the skill-mcp-manager entry from cordis.patch.yml to finish uninstalling.`,
    };
  }

  function followMustAsk(agent) {
    const policy = ctx.get("sandboxPolicy");
    if (policy === undefined || typeof policy.resolve !== "function" || agent?.session === undefined) return true;
    return policy.resolve({ session: agent.session }).mode !== "danger-full-access";
  }

  // Ask before the trial connect, which is what starts the process. No
  // approval service means this host has no ask channel: keep the previous
  // silent allow. A present channel whose session policy rejects still asks;
  // anything other than allowed-once does not save and does not start.
  async function approveLocalExecution(exec, change) {
    if (localCommandApproval === "always-allow") return;
    const approval = ctx.get("approval");
    if (approval === undefined || typeof approval.request !== "function") return;
    const mustAsk = localCommandApproval === "always-ask" || followMustAsk(exec?.agent);
    if (!mustAsk) return;
    const agent = exec?.agent;
    if (agent?.session === undefined) {
      throw new Error("local command approval has no session to ask; the entry was not saved and was not started");
    }
    const outcome = await approval.request({
      agent,
      toolName: "mcp_register",
      reason: localExecutionReason(change),
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
    });
    if (outcome !== "allowed-once") {
      throw new Error(`local command was not approved (${outcome}); the entry was not saved and was not started`);
    }
  }

  // ── mcp_register ──
  // Registration is shared by the model tool and the library page's 新增 button: one
  // code path, so a UI-added server is validated (trial connect + tools/list) exactly
  // like a model-added one. `exec === null` means a human typed it into the UI, so the
  // local-command approval prompt (a guard against the MODEL running local commands)
  // does not apply.
  async function registerServerEntry(args, { exec = null } = {}) {
    assertServerName(args.name);
    const tier = args.tier ?? "on-demand";
    if (!TIERS.has(tier)) throw new Error('invalid tier "' + tier + '"');

    const existingIndex = registry.entries.findIndex((e) => e.name === args.name);
    const existing = existingIndex >= 0 ? registry.entries[existingIndex] : undefined;
    const isUpdate = existing !== undefined;
    const transport = args.transport ?? existing?.transport;
    if (transport === undefined) throw new Error("`transport` is required when registering a new MCP server");
    if (transport !== "stdio" && transport !== "streamable-http") throw new Error('invalid transport "' + transport + '"');
    if (transport === "stdio" && !args.command && !existing?.command) throw new Error("stdio transport requires `command`");
    if (transport === "streamable-http" && !args.url && !existing?.url) throw new Error("streamable-http transport requires `url`");

    if (exec !== null) {
      const localChange = localExecutionChange(existing, args, transport);
      if (localChange !== null) await approveLocalExecution(exec, localChange);
    }

    // Trial-connect only when the connection contract changes or the tier becomes eager.
    // A server that only answers after a browser OAuth flow cannot pass a trial connect.
    // `skipTrial` registers it anyway (能力库 then shows it with the 401 it got, and the
    // user finishes the authorisation on the provider side).
    const skipTrial = args.skipTrial === true;
    const needsTrial = !skipTrial && (
      tier === "eager" ||
      args.transport !== undefined ||
      args.command !== undefined ||
      args.url !== undefined ||
      args.env !== undefined ||
      args.headers !== undefined ||
      args.args !== undefined ||
      args.cwd !== undefined
    );

    let snapshot = existing?.tools ?? [];
    let trialMeta = null;
    if (needsTrial) {
      const candidate = buildEntry(args, existing);
      const connection = await connectEntry(candidate, trialTimeoutMs, stdioMaxBufferSizeBytes);
      try {
        snapshot = await snapshotTools(connection.client);
        trialMeta = connection;
      } finally {
        await connection.client.close();
      }
    }

    const entry = buildEntry(args, existing, snapshot);
    if (trialMeta !== null) applyServerMetadata(entry, trialMeta);
    if (isUpdate) registry.entries[existingIndex] = entry;
    else registry.entries.push(entry);
    await saveRegistry(dataDir, registry);
    if (needsTrial) eagerConnectFailed.delete(entry.name);

    if (tier === "eager") {
      await syncEagerEverywhere(entry);
      await reconcile();
    } else {
      if (isUpdate && existing.tier === "eager") await disposeNamedEverywhere(entry.name);
      await reconcile();
    }
    return { entry, isUpdate, toolCount: snapshot.length };
  }

  const mcpRegister = {
    name: "mcp_register",
    description:
      "Register (add) or modify an MCP server entry. Validates by trial-connecting (30s) and listing tools, then persists to the registry. The server's own description/version/title/website/instructions are captured automatically from the server during the trial connection. Reuse it to change tier/parameters/notes. Only connection-contract changes re-connect; changing notes or downgrading to disabled skips the trial connection.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Stable server name ([A-Za-z0-9_-]{1,32}); the model-facing namespace." },
        tier: { type: "string", enum: ["eager", "on-demand", "disabled"], description: "Default on-demand." },
        transport: { type: "string", enum: ["stdio", "streamable-http"], description: "Required on add." },
        command: { type: "string", description: "stdio: executable to spawn." },
        args: { type: "array", items: { type: "string" }, description: "stdio: argument array (no shell)." },
        env: { type: "object", description: "stdio: extra env; value may be a literal or a $VAR reference." },
        cwd: { type: "string", description: "stdio: working directory." },
        url: { type: "string", description: "streamable-http: server URL." },
        headers: { type: "object", description: "streamable-http: extra headers." },
        notes: { type: "string", description: "Optional USER-maintained note (never overwritten by developer/server updates); surfaced in the on-demand catalog." },
      },
        skipTrial: { type: "boolean", description: "Default false. true = register WITHOUT trial-connecting; use it for servers that only answer after a browser OAuth flow (能力库 then shows the 401 until they are authorised)." },
      required: ["name"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { entry, isUpdate, toolCount } = await registerServerEntry(args, { exec });
      const verb = isUpdate ? "updated" : "registered";
      if (entry.tier === "eager") {
        return { text: "MCP \"" + entry.name + "\" " + verb + " as eager — live sessions will register it with the fresh definition." };
      }
      return { text: "MCP \"" + entry.name + "\" " + verb + " (tier=" + entry.tier + ", " + toolCount + " tools) — live sessions pick it up on the next pre-step." };
    },
  };

  // ── mcp_load ──
  const mcpLoad = {
    name: "mcp_load",
    description:
      "Load (or hot-reload) one non-disabled MCP server for the current session and return its full tool definitions (names, descriptions, parameter schemas) as this tool's result. With peek=true it only reads the latest snapshot or this session's active connection without connecting, registering, or dropping a live connection.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Registered MCP server name." },
        peek: { type: "boolean", description: "Default false. true = only inspect, never connect or reload." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      // Registry first, then whatever this conversation's workspace declares.
      const resolved = exec?.agent === undefined
        ? (registry.entries.some((e) => e.name === args.name) ? { entry: registry.entries.find((e) => e.name === args.name) } : null)
        : await entryForAgent(exec.agent, args.name);
      const entry = resolved === null ? undefined : resolved.entry;
      if (entry === undefined) throw new Error(`MCP "${args.name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${args.name}" is disabled`);
      if (!isSessionAllowed(sessionIdOf(exec?.agent), "mcp", entry.name)) {
        throw new Error(`MCP "${args.name}" is off for this conversation — turn it on in 能力管理`);
      }

      if (args.peek === true) {
        const session = exec?.agent === undefined ? undefined : sessionOf(exec.agent);
        const tools = session?.connections.get(entry.name)?.tools ?? entry.tools ?? [];
        return { text: renderDefinitions(entry, tools) };
      }

      if (exec?.agent === undefined) throw new Error("mcp_load requires a session");
      const session = sessionOf(exec.agent);
      try {
        await disposeSessionEntry(session, entry.name);
        const connection = await ensureConnected(session, entry);
        entry.tools = await snapshotTools(connection.client);
        entry.lastLoadAt = new Date().toISOString();
        await saveRegistry(dataDir, registry);
        if (entry.tier === "eager") {
          const toolCount = await ensureEager(session, entry);
          rememberMount(session, entry);
          eagerConnectFailed.delete(entry.name);
          return { text: `MCP "${entry.name}" reloaded (eager): ${toolCount} enabled native tool(s) re-registered for this session.` };
        }
        return { text: renderDefinitions(entry, entry.tools) };
      } catch (error) {
        if (entry.tier === "eager") eagerConnectFailed.add(entry.name);
        throw error;
      }
    },
  };

  function renderDefinitions(entry, tools) {
    const visibleTools = enabledTools(entry, tools);
    const lines = [
      `MCP "${entry.name}" (${entry.tier})`,
      entry.serverDescription ? `description: ${entry.serverDescription}` : "description: (no description)",
      entry.serverName ? `serverName: ${entry.serverName}` : "",
      entry.serverVersion ? `version: ${entry.serverVersion}` : "",
      entry.serverTitle ? `title: ${entry.serverTitle}` : "",
      entry.websiteUrl ? `website: ${entry.websiteUrl}` : "",
      entry.instructions ? `instructions: ${entry.instructions}` : "",
      entry.notes ? `notes: ${entry.notes}` : "",
      "",
      "Tools:",
      ...visibleTools.map((tool) => {
        const schema = tool.inputSchema ? `\n    inputSchema: ${JSON.stringify(tool.inputSchema)}` : "";
        return `- ${tool.name}: ${tool.description ?? ""}${schema}`;
      }),
    ];
    return lines.filter((line) => line !== "").join("\n");
  }

  // ── mcp_call ──
  const mcpCallProjections = new WeakMap();
  const mcpCall = {
    name: "mcp_call",
    description:
      "Invoke one tool of an on-demand MCP server through the bridge. The server must be loaded first via mcp_load; calling an unloaded server returns an error telling you to mcp_load first. Pass structured `args` only (never shell text, never a temp file). Eager servers are called directly as mcp__<server>__<tool> instead.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Registered MCP server name." },
        tool: { type: "string", description: "Raw tool name as reported by mcp_load." },
        args: { type: "object", description: "Structured JSON arguments matching the tool's inputSchema." },
      },
      required: ["name", "tool"],
      additionalProperties: false,
    },
    output: createMcpResultOutput(undefined, (args) => args.tool),
    finalizeContent(exec, result) {
      return finalizeMcpResultContent(mcpCallProjections, exec, result);
    },
    async execute(args, exec) {
      // Parameter-shape guard: the model sometimes nests the tool call inside
      // "args" (e.g. {name, args: {tool, args}}), which previously slipped
      // through as params.name=undefined and produced an opaque server-side
      // -32602. Reject early with the correct shape; never auto-unwrap.
      if (typeof args.tool !== "string" || args.tool === "") {
        const nested =
          args.args !== null &&
          typeof args.args === "object" &&
          !Array.isArray(args.args) &&
          typeof args.args.tool === "string" &&
          args.args.tool !== "";
        throw new Error(
          nested
            ? `mcp_call parameter shape error: the tool name was nested inside "args" (args.tool="${args.args.tool}"). Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...tool arguments...}} — "tool" is a TOP-LEVEL string field; only the tool's own arguments go inside "args". Retry with the corrected shape.`
            : `mcp_call requires a top-level "tool" string field. Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...tool arguments...}}.`,
        );
      }
      if (args.args !== undefined && (args.args === null || typeof args.args !== "object" || Array.isArray(args.args))) {
        throw new Error(
          `mcp_call "args" must be an object holding the tool arguments (or omitted entirely for no-argument tools), got ${Array.isArray(args.args) ? "an array" : JSON.stringify(args.args)}. Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...}}.`,
        );
      }
      // Registry first, then whatever this conversation's workspace declares.
      const resolved = exec?.agent === undefined
        ? (registry.entries.some((e) => e.name === args.name) ? { entry: registry.entries.find((e) => e.name === args.name) } : null)
        : await entryForAgent(exec.agent, args.name);
      const entry = resolved === null ? undefined : resolved.entry;
      if (entry === undefined) throw new Error(`MCP "${args.name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${args.name}" is disabled`);
      if (!isSessionAllowed(sessionIdOf(exec?.agent), "mcp", entry.name)) {
        throw new Error(`MCP "${args.name}" is off for this conversation — turn it on in 能力管理`);
      }
      if (isToolDisabled(entry, args.tool)) throw new Error(`MCP tool "${entry.name}/${args.tool}" is disabled`);
      if (exec?.agent === undefined) throw new Error("mcp_call requires a session");
      const session = sessionOf(exec.agent);
      const connection = session.connections.get(entry.name);
      if (connection === undefined) {
        throw new Error(`MCP "${args.name}" is not loaded — call mcp_load first`);
      }
      const targetTool = Array.isArray(connection.tools)
        ? connection.tools.find((tool) => tool.name === args.tool)
        : undefined;
      const errorContext = { server: entry.name, inputSchema: targetTool?.inputSchema };
      const result = await callTool(connection.client, args.tool, args.args, toolCallTimeoutMs, exec.signal, errorContext);
      return settleMcpToolResult(
        ctx,
        exec,
        mcpCallProjections,
        result,
        args.tool,
        isErrorContextSuffix(errorContext, args.tool, args.args),
      );
    },
  };

  // ── client-UI RPC handlers (skill + mcp drawers) ──
  const BUNDLE_SKILL_RE = /(^|[\\/])SKILL\.md$/i;

  // Skills living inside the DSH install (app.asar.unpacked) or any installed
  // package's node_modules are SHIPPED/read-only: the drawer may list and open
  // them, but must never toggle or delete them — doing so would corrupt the
  // deployment or a third-party plugin. Only user-writable roots are managed.
  function isReadonlySkillPath(path) {
    return /[\\/]app\.asar|[\\/]node_modules[\\/]/.test(path);
  }

  // Which provider a skill comes from decides the group it lands in:
  //   - the built-in filesystem provider and this plugin's own recursive scan
  //     read directories the user owns → 系统
  //   - any other provider is a plugin that registered skills → one group per
  //     plugin, keyed by the provider name
  // The path only names the owning package for the label. The provider name is
  // the authority: a plugin may materialise its skills in a temporary directory
  // (dsh-windows-acl does, with a fresh path on every start), so grouping must
  // never key off the path.
  const SYSTEM_SKILL_PROVIDERS = new Set(["", "filesystem", "skill-mcp-manager-recursive"]);
  const PACKAGE_FROM_PATH_RE = /[\\/](?:app\.asar[^\\/]*|node_modules)[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/;

  function packageNameFromPath(path) {
    const match = PACKAGE_FROM_PATH_RE.exec(String(path ?? ""));
    return match === null ? null : match[1].replace(/[\\/]/g, "/");
  }

  // The package a skill belongs to: prefer the nearest package.json (a plugin
  // installed with `link:` lives outside node_modules, so the path alone says
  // nothing), fall back to the path segment under node_modules/app.asar.
  //
  // Only a package that keeps the bundle under its own `skills/` directory counts:
  // that is the plugin convention, and it keeps an unrelated project's
  // package.json (a user skill that happens to live in a repo) from naming a
  // group. System providers never reach this function.
  async function nearestPackageName(path) {
    let dir = dirname(path);
    for (let depth = 0; depth < 4; depth += 1) {
      // The try covers the read only: a bug in the naming logic must not be
      // mistaken for "this directory has no package.json" (that is exactly how a
      // shadowed `relative` stayed silent here once).
      let pkg;
      try {
        pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      } catch {
        pkg = undefined;
      }
      if (pkg !== undefined && typeof pkg.name === "string" && pkg.name !== "") {
        const segments = relative(dir, path).split(/[\\/]/);
        if (segments.length >= 2 && segments[0].toLowerCase() === "skills") return pkg.name;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return packageNameFromPath(path);
  }

  async function skillOrigin(definition) {
    const provider = typeof definition.provider === "string" ? definition.provider : "";
    const path = typeof definition.path === "string" ? definition.path : "";
    if (SYSTEM_SKILL_PROVIDERS.has(provider)) {
      return { kind: "system", key: "system", label: "系统", provider, package: null, runtime: false };
    }
    return {
      kind: "plugin",
      key: provider,
      label: provider,
      provider,
      package: await nearestPackageName(path),
      // Only the generated-directory pattern counts: a plugin that writes its
      // SKILL.md into a fresh temp directory on every start (dsh-windows-acl does)
      // must be recognised, while a user who happens to keep skills under Temp is
      // not relabelled.
      runtime: /dsh-acl-skill-|[\\/]dsh-[a-z-]+-skill-[a-z0-9]{6}[\\/]/i.test(path),
    };
  }

  // Built-in dsh-skill-filesystem is mounted by the agent preset, so its
  // catalog (including ~/.dsh/skills junctions) is only visible when list/get
  // pass that preset's standing scope. Host UI has no current agent; use the
  // same standingKeyFor fallback the host API uses for cold transcript reads.
  async function skillLookup(cwd) {
    const lookup = {};
    const presets = ctx.get("agentPresets");
    if (presets !== undefined && typeof presets.standingKeyFor === "function") {
      try {
        lookup.scope = await presets.standingKeyFor();
      } catch {
        /* no preset scope: the global layer is still listable */
      }
    }
    // Project roots (.dsh/skills, .agents/skills) only exist for a cwd. The GUI
    // passes the workspace the user picked; without one only global skills show.
    const workspace = normalizeWorkspace(cwd);
    if (workspace !== undefined) lookup.cwd = workspace;
    return lookup;
  }

  function normalizeWorkspace(value) {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }

  // Everything this host can see for one workspace, keyed by skill name. Used by
  // the list and by the import sheet's duplicate check, so both answer from the
  // same snapshot.
  async function visibleSkills(cwd) {
    const lookup = await skillLookup(cwd);
    const summaries = await skillsService().list(lookup);
    const out = new Map();
    for (const summary of summaries) {
      const definition = await resolveSkillPath(summary.name, lookup);
      if (definition !== undefined && !out.has(definition.name)) out.set(definition.name, definition);
    }
    return out;
  }

  async function pathExists(path) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  function isInsideDir(child, parent) {
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  // A copy lands in a directory with no watcher yet (the user-dsh root may not
  // even exist before the first import), so the registry's collect cache has to
  // be dropped explicitly for the new skill to appear in the same breath.
  function invalidateSkillCache() {
    try {
      skillsService().invalidateCache?.();
    } catch {
      /* older host without the method: the next list re-scans anyway */
    }
  }

  // Workspaces the GUI knows about. The picker needs them because project-level
  // skills are keyed by cwd.
  function listWorkspaces() {
    const service = ctx.get("workspaceRegistry");
    if (service === undefined || typeof service.list !== "function") return [];
    try {
      return service.list().map((workspace) => ({
        id: String(workspace.id),
        title: typeof workspace.title === "string" && workspace.title !== "" ? workspace.title : String(workspace.path),
        path: String(workspace.path),
      }));
    } catch {
      return [];
    }
  }

  // The desktop shell re-applies loader entries when the profile patch changes,
  // which can leave a plugin's HTTP routes serving from a fiber that is no longer
  // active. `ctx.skills` then throws cordis' "cannot get required service ...
  // in inactive context", which means nothing to the person looking at the page.
  // Translate it into something actionable instead of leaking the raw error.
  // The service is looked up through every context path we can reach: a plugin
  // whose fiber went inactive (the shell re-applies entries when the profile
  // changes) still sees a dead `ctx.skills` while `ctx.get`/`ctx.root` may resolve
  // the live service. First one that answers wins; only when none does is the
  // failure reported, and then as something a person can act on.
  function skillsService() {
    const candidates = [];
    try {
      candidates.push(ctx.skills);
    } catch {
      /* inactive context */
    }
    try {
      candidates.push(typeof ctx.get === "function" ? ctx.get("skills") : undefined);
    } catch {
      /* get threw */
    }
    try {
      candidates.push(ctx.root === undefined ? undefined : ctx.root.skills);
    } catch {
      /* root unavailable */
    }
    for (const service of candidates) {
      if (service !== undefined && service !== null && typeof service.list === "function") return service;
    }
    throw new Error("DSH 的技能服务当前不可用（插件上下文已失效），重启 DSH 即可恢复");
  }

  async function resolveSkillPath(name, lookup) {
    const definition = await skillsService().get(name, lookup ?? {});
    if (definition === undefined || typeof definition.path !== "string") return undefined;
    if (!BUNDLE_SKILL_RE.test(definition.path)) return undefined;
    return definition;
  }

  // ── legacy session audit ──
  // Sessions written before 1.1.5 carry a source kind the v0 -> v3 migration
  // refuses and cannot be opened at all once DSH reaches 2.0.9. This only
  // detects them so the UI can point at the repair guide; it never writes to a
  // session log.
  //
  // Nothing is scheduled at startup. The scan is heavy enough to starve the
  // host's boot work — one frame can block the event loop for over a second, and
  // a large library takes 30-136s — while the desktop host fails `host-boot` on a
  // ~120s watchdog and drops into safe mode. Plugin load happens early in boot,
  // so neither an `await` nor a delayed timer can stay clear of that window
  // (both were tried on 2026-09-14 and both landed in it). The scan is therefore
  // started by the first UI request: if the page is asking, the app is up.
  //
  // It re-runs until its `check` flag is retired; a clean scan retires the flag
  // itself. There is no dismiss action, so an accidental click can never hide a
  // real problem.
  //
  // The `__test__` sentinel profile gets an inert runner: tests point the plugin
  // at a throwaway dataDir precisely so they never touch the real home, and
  // reading the real sessions tree would break that isolation.
  const auditRunner = resolveProfile(config) === "__test__"
    ? { kick() {}, read: async () => null, running: () => false, checked: () => false }
    : createAuditRunner(dataDir, join(DSH_HOME, "sessions"), ctx.logger);

  function viewOf(entry, reveal) {
    return entryView(entry, reveal, {
      connectFailed: entry.tier === "eager" && eagerConnectFailed.has(entry.name),
    });
  }

  // The skills this conversation's 能力管理 view shows: 能力库's list (standing
  // scope) unioned with whatever only the live conversation can see. Listing the
  // conversation scope alone showed 1 of 6 skills — the plugin's own registration
  // but not the filesystem/bundled ones the library lists.
  async function sessionSkillEntries(sessionId, live, workspaceHint) {
    const entries = [];
    const seen = new Set();
    const collect = async (lookup) => {
      let summaries = [];
      try {
        summaries = await skillsService().list(lookup);
      } catch {
        return;
      }
      for (const summary of summaries) {
        const definition = await resolveSkillPath(summary.name, lookup);
        if (definition === undefined || seen.has(definition.name)) continue;
        seen.add(definition.name);
        entries.push({
          name: definition.name,
          description: definition.description ?? "",
          path: typeof definition.path === "string" ? definition.path : "",
          provider: definition.provider ?? "",
          readonly: isReadonlySkillPath(definition.path),
          enabled: isSessionAllowed(sessionId, "skills", definition.name),
        });
      }
    };
    // Project skills are keyed by cwd, so the workspace has to ride along or the
    // conversation scope alone shows a different set (the "only one skill" bug).
    let workspace = workspaceHint;
    if (workspace === undefined && live !== null) workspace = await workspaceOf(live.agent);
    await collect(await skillLookup(workspace === undefined || workspace === "" ? undefined : workspace));
    if (live !== null) await collect({ scope: live.agent, ...(workspace === undefined || workspace === "" ? {} : { cwd: workspace }) });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  // ── importing skills from other agents ──────────────────────────────────
  // Two steps, one plan: the sheet reviews what could be imported (and why a
  // candidate is refused), and the copy itself re-plans so a stale page can
  // never overwrite a skill that appeared in the meantime.
  async function planSkillImport(cwd) {
    const workspace = normalizeWorkspace(cwd);
    let visible = new Map();
    let warning = "";
    try {
      visible = await visibleSkills(workspace);
    } catch (error) {
      // A dead skill service must not make the sheet look empty — but it also
      // cannot promise uniqueness, and the caller has to say so out loud.
      warning = error instanceof Error ? error.message : String(error);
    }
    const sources = [];
    for (const source of importSourceDirs({ home: importHomeDir, cwd: workspace })) {
      const items = await skillsInDir(source.dir);
      // A skill nested inside another skill's directory is copied along with its
      // parent; listing it again would import the same files twice.
      const { kept, nested } = pruneNested(items);
      const skills = [];
      for (const item of kept) skills.push(await importItemView(item, visible));
      for (const child of nested) {
        skills.push({
          ...(await importItemView(child, visible)),
          conflict: `已包含在 ${child.parentDir} 的技能目录里`,
          blocked: true,
        });
      }
      sources.push({
        id: source.id,
        kind: source.kind,
        label: source.label,
        dir: source.dir,
        exists: await pathExists(source.dir),
        skills,
      });
    }
    return { ok: true, target: skillsImportDir, cwd: workspace ?? "", sources, warning };
  }

  // `blocked` and `conflict` are different answers on purpose:
  //   - blocked  : importing cannot be done at all (already in the target root,
  //                invalid directory name, covered by a parent skill)
  //   - conflict : a same-name skill already answers in DSH from another root.
  //                The copy is allowed — the DSH root outranks the user roots, so
  //                the copy would take over — but it must be a deliberate choice,
  //                never a side effect of 全选, because edits to the original
  //                would stop taking effect.
  async function importItemView(item, visible) {
    const view = {
      name: item.name,
      description: item.description,
      dir: item.dir,
      dirName: item.dirName,
      conflict: null,
      blocked: false,
    };
    if (!isValidTargetName(item.dirName)) {
      view.conflict = "目录名不能作为 DSH 技能目录名";
      view.blocked = true;
      return view;
    }
    const dest = join(skillsImportDir, item.dirName);
    if (await pathExists(dest)) {
      view.conflict = `已导入（${dest} 已存在）`;
      view.blocked = true;
      return view;
    }
    const existing = visible.get(item.name);
    if (existing !== undefined && !isInsideDir(existing.path, skillsImportDir)) {
      view.conflict = `DSH 已有同名技能（来自 ${dirname(existing.path)}）；导入后 DSH 会优先用这份副本`;
    }
    return view;
  }

  const uiHandlers = {
    async listSkills(cwd) {
      const definitions = await visibleSkills(cwd);
      const views = [];
      for (const definition of definitions.values()) {
        views.push({
          name: definition.name,
          description: definition.description ?? "",
          path: definition.path,
          directory: dirname(definition.path),
          source: definition.source ?? "",
          provider: definition.provider ?? "",
          // Where the skill came from in filesystem terms (project / user /
          // bundled); the card shows it as a badge so a workspace switch is
          // visible without reading paths.
          scope: definition.source ?? "",
          modelInvocable: definition.invocation?.modelInvocable !== false,
          userInvocable: definition.invocation?.userInvocable !== false,
          readonly: isReadonlySkillPath(definition.path),
          // Grouping key + label for the card grid: 系统 for the user's own
          // directories, one group per plugin provider.
          origin: await skillOrigin(definition),
          ...(definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {}),
        });
      }
      views.sort((a, b) => a.path.localeCompare(b.path));
      return views;
    },
    async toggleSkill(name, enabled, cwd) {
      const definition = await resolveSkillPath(name, await skillLookup(cwd));
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (isReadonlySkillPath(definition.path)) throw new Error(`skill "${name}" is shipped/read-only and cannot be toggled`);
      const result = await setDisableModelInvocation(definition.path, !enabled);
      return {
        name: definition.name,
        path: definition.path,
        directory: dirname(definition.path),
        modelInvocable: result.modelInvocable,
        changed: result.changed,
      };
    },
    // Master switch for one plugin group: every skill that plugin provides gets
    // the same frontmatter flag. Shipped (read-only) skills are reported back
    // instead of being written — a package we cannot write must not look like it
    // was switched off.
    async toggleSkillGroup(provider, enabled, cwd) {
      if (typeof provider !== "string" || provider === "") throw new Error("provider is required");
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      if (SYSTEM_SKILL_PROVIDERS.has(provider)) throw new Error("the system group has no master switch");
      const lookup = await skillLookup(cwd);
      const summaries = await skillsService().list(lookup);
      const updated = [];
      const skipped = [];
      for (const summary of summaries) {
        const definition = await resolveSkillPath(summary.name, lookup);
        if (definition === undefined) continue;
        const origin = await skillOrigin(definition);
        if (origin.kind !== "plugin" || origin.key !== provider) continue;
        if (isReadonlySkillPath(definition.path)) {
          skipped.push(definition.name);
          continue;
        }
        const result = await setDisableModelInvocation(definition.path, !enabled);
        updated.push({ name: definition.name, modelInvocable: result.modelInvocable !== false });
      }
      if (updated.length === 0 && skipped.length === 0) {
        throw new Error(`no skill belongs to plugin "${provider}"`);
      }
      return { ok: true, provider, enabled, updated, skipped };
    },
    async openSkill(name, cwd) {
      const definition = await resolveSkillPath(name, await skillLookup(cwd));
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (!openWithSystemEditor(definition.path)) throw new Error(`no default handler available to open ${definition.path}`);
      return { ok: true, path: definition.path };
    },
    async deleteSkill(name, cwd) {
      const definition = await resolveSkillPath(name, await skillLookup(cwd));
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (isReadonlySkillPath(definition.path)) throw new Error(`skill "${name}" is shipped/read-only and cannot be deleted`);
      return trashDirectory(dirname(definition.path), dataDir);
    },
    // Workspaces are the cwd keys project-level skills hang off.
    async listWorkspaces() {
      return { ok: true, workspaces: listWorkspaces(), cwd: process.cwd() };
    },
    async listSkillGroups() {
      return { ok: true, ...skillGroups };
    },
    // One action per call keeps the file consistent: the browser sends what the
    // user did, not a whole store it computed.
    async skillGroupsAction(payload) {
      const action = payload?.action;
      let next = skillGroups;
      if (action === "create") {
        const result = createSkillGroup(skillGroups, payload.name);
        next = result.state;
      } else if (action === "rename") {
        next = renameSkillGroup(skillGroups, payload.id, payload.name);
      } else if (action === "delete") {
        next = deleteSkillGroup(skillGroups, payload.id);
      } else if (action === "move") {
        next = moveSkillGroup(skillGroups, payload.id, Number(payload.direction) < 0 ? -1 : 1);
      } else if (action === "assign") {
        if (typeof payload.skill !== "string" || payload.skill === "") throw new Error("skill is required");
        next = assignSkillToGroup(skillGroups, payload.skill, typeof payload.group === "string" && payload.group !== "" ? payload.group : null);
      } else {
        throw new Error('action must be one of "create" | "rename" | "delete" | "move" | "assign"');
      }
      skillGroups = next;
      await saveSkillGroups();
      return { ok: true, ...skillGroups };
    },
    async scanSkillImport(cwd) {
      return await planSkillImport(cwd);
    },
    // Copies the reviewed candidates into the DSH-owned skill root. Only
    // directories the scan just offered are accepted, so this route can never be
    // talked into copying an arbitrary path.
    async importSkills(items, cwd) {
      if (!Array.isArray(items) || items.length === 0) throw new Error("items must be a non-empty array");
      const plan = await planSkillImport(cwd);
      const offered = new Map();
      for (const source of plan.sources) {
        for (const item of source.skills) offered.set(item.dir, item);
      }
      const imported = [];
      const skipped = [];
      for (const raw of items) {
        if (typeof raw !== "string" || raw === "") throw new Error("items must be skill directory paths");
        const item = offered.get(raw);
        if (item === undefined) throw new Error(`not a skill directory offered by the import scan: ${raw}`);
        if (item.blocked === true) {
          skipped.push({ name: item.name, dir: item.dir, reason: item.conflict });
          continue;
        }
        const dest = join(skillsImportDir, item.dirName);
        await copySkillDir(item.dir, dest);
        imported.push({ name: item.name, dir: item.dir, target: dest });
      }
      if (imported.length > 0) invalidateSkillCache();
      return { ok: true, target: skillsImportDir, imported, skipped };
    },
    async listMcp(reveal) {
      return registry.entries.map((entry) => viewOf(entry, reveal));
    },
    // Plugin-contributed rows (not in the registry): read from the live loader and
    // toggled at runtime, without a restart.
    // ── workspace defaults ─────────────────────────────────────────────────
    // "New conversations in this workspace start with…" — the view saves its current
    // allow lists as that default, or clears it. Nothing here touches a conversation
    // that already exists.
    async getWorkspaceDefaults(workspace) {
      const key = workspaceKey(workspace);
      if (key === "") return { ok: true, workspace: "", mcp: [], skills: [] };
      const preset = workspaceDefaults[key];
      return {
        ok: true,
        workspace: key,
        mcp: preset === undefined ? [] : [...preset.mcp],
        skills: preset === undefined ? [] : [...preset.skills],
      };
    },
    async setWorkspaceDefaults(payload) {
      const key = workspaceKey(payload?.workspace);
      if (key === "") throw new Error("workspace is required");
      const action = payload?.action;
      if (action === "clear") {
        delete workspaceDefaults[key];
        await saveWorkspaceDefaults();
        return { ok: true, workspace: key, mcp: [], skills: [] };
      }
      if (action !== "save-current") throw new Error('action must be "save-current" or "clear"');
      const service = liveSessionOf(payload?.session);
      const current = service === null
        ? null
        : await uiHandlers.getSessionCapabilities(payload.session);
      if (current === null) throw new Error("this conversation is not running yet — open it once, then save");
      const mcp = current.mcp.filter((item) => item.enabled).map((item) => item.name);
      const skills = current.skills.filter((item) => item.enabled).map((item) => item.name);
      workspaceDefaults[key] = { mcp, skills };
      await saveWorkspaceDefaults();
      return { ok: true, workspace: key, mcp, skills };
    },
    // What a capability actually exposes, for the 能力管理 view's 详情 panel:
    // an MCP server's tools (name + description + input schema) and a skill's body.
    // Read-only, session-scoped, and it never connects anything by itself.
    async getCapabilityDetail(sessionId, kind, name) {
      if (typeof sessionId !== "string" || sessionId === "") throw new Error("session is required");
      if (kind !== "mcp" && kind !== "skills") throw new Error('kind must be "mcp" or "skills"');
      if (typeof name !== "string" || name === "") throw new Error("name is required");
      const live = liveSessionOf(sessionId);
      if (kind === "skills") {
        const lookup = live === null ? await skillLookup() : { scope: live.agent };
        const definition = await skillsService().get(name, lookup);
        if (definition === undefined) throw new Error(`skill "${name}" not found`);
        return {
          ok: true,
          kind: "skills",
          name: definition.name,
          description: definition.description ?? "",
          ...(typeof definition.whenToUse === "string" ? { whenToUse: definition.whenToUse } : {}),
          path: typeof definition.path === "string" ? definition.path : "",
          provider: definition.provider ?? "",
          readonly: isReadonlySkillPath(definition.path),
          content: typeof definition.content === "string" ? definition.content : "",
        };
      }
      // MCP: the registry's snapshot, or the workspace/plugin row when it has one.
      const resolved = live !== null ? await entryForAgent(live.agent, name) : null;
      const entry = resolved === null ? registry.entries.find((candidate) => candidate.name === name) : resolved.entry;
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      const tools = enabledTools(entry, entry.tools ?? []).map((tool) => ({
        name: tool.name,
        description: truncate(tool.description ?? "", 2000),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
      }));
      return {
        ok: true,
        kind: "mcp",
        name: entry.name,
        source: resolved === null ? "registry" : resolved.source,
        transport: entry.transport ?? "",
        tier: entry.tier ?? "",
        ...(typeof entry.serverDescription === "string" && entry.serverDescription !== "" ? { serverDescription: entry.serverDescription } : {}),
        ...(typeof entry.notes === "string" && entry.notes !== "" ? { notes: entry.notes } : {}),
        tools,
        // An empty list means "we have no snapshot yet", which is a different answer
        // from "this server exposes nothing" — the panel has to say which.
        loaded: tools.length > 0,
      };
    },
    // ── per-conversation capability policy (the 能力管理 view) ──────────────
    // Lists what THIS conversation may use, and flips one name at a time. The
    // global configuration is untouched; the policy file keeps the answer across
    // restarts, and every apply point reads it live.
    async getSessionCapabilities(sessionId) {
      if (typeof sessionId !== "string" || sessionId === "") throw new Error("session is required");
      const live = liveSessionOf(sessionId);
      // The conversation's workspace decides which project servers exist and which
      // registry entries are in scope at all.
      let workspace = "";
      if (live !== null) {
        try {
          workspace = await workspaceOf(live.agent);
        } catch {
          workspace = "";
        }
      }
      // MCP rows come from three places, grouped by who owns them: the registry (the
      // user's own servers), the rows a plugin mounted for itself, and the servers the
      // workspace declares in its own files.
      const mcp = [];
      for (const entry of registry.entries) {
        if (entry.tier === "disabled") continue;
        // A registry entry pinned to another workspace is not this conversation's business.
        const pinned = workspaceKey(entry.workspace ?? "");
        if (pinned !== "" && pinned !== workspaceKey(workspace)) continue;
        mcp.push({
          name: entry.name,
          source: "registry",
          owner: "",
          // The server's own sentence, capped like the catalog does — a card shows one
          // line of it; 详情 shows the rest.
          description: truncate(entry.serverDescription ?? "", 300),
          tier: entry.tier,
          transport: entry.transport,
          toolCount: Array.isArray(entry.tools) ? entry.tools.length : 0,
          enabled: isSessionAllowed(sessionId, "mcp", entry.name),
        });
      }
      try {
        for (const row of (await nativeMcpViews()).entries ?? []) {
          if (row.enabled !== true) continue;
          mcp.push({
            name: row.serverName,
            id: row.id,
            source: "plugin",
            owner: typeof row.owner === "string" ? row.owner : "",
            tier: "plugin",
            transport: row.transport,
            // The loader row usually has no self-reported description, and a blank line
            // reads like a bug — say who mounted it instead of inventing a feature blurb.
            description: typeof row.description === "string" && row.description !== ""
              ? row.description
              : "由 " + (typeof row.owner === "string" && row.owner !== "" ? row.owner : "未归属插件") + " 注入 · 服务器未自报描述",
            toolCount: 0,
            enabled: isSessionAllowed(sessionId, "mcp", row.serverName),
          });
        }
      } catch {
        /* a loader-less host simply has no plugin rows */
      }
      try {
        const { servers, errors, files } = await workspaceMcpOf(workspace);
        for (const server of servers) {
          mcp.push({
            name: server.name,
            source: "workspace",
            owner: "",
            description: truncate(server.notes ?? "", 300),
            file: server.file ?? "",
            tier: "on-demand",
            transport: server.transport,
            toolCount: 0,
            enabled: isSessionAllowed(sessionId, "mcp", server.name),
          });
        }
        if (errors.length > 0) ctx.logger.warn(`skill-mcp-manager: workspace MCP file warnings: ${errors.join("; ")}`);
        void files;
      } catch {
        /* an unreadable project file simply contributes nothing */
      }
      let skills = [];
      try {
        skills = await sessionSkillEntries(sessionId, live, workspace);
      } catch {
        /* a broken skill service must not hide the MCP half of the view */
      }
      return { ok: true, session: sessionId, live: live !== null, workspace, mcp, skills };
    },
    // One call flips one name. `bulk` flips a whole kind (MCP and skills are separate
    // operations on purpose: the two lists have different blast radii).
    async setSessionCapability(sessionId, kind, name, enabled, bulk) {
      if (typeof sessionId !== "string" || sessionId === "") throw new Error("session is required");
      if (kind !== "mcp" && kind !== "skills") throw new Error('kind must be "mcp" or "skills"');
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      const live = liveSessionOf(sessionId);

      if (bulk === true) {
        // Every name of that kind, taken from the same list the view renders.
        const current = await uiHandlers.getSessionCapabilities(sessionId);
        const names = kind === "mcp"
          ? current.mcp.map((item) => item.name)
          : current.skills.map((item) => item.name);
        for (const item of names) await setSessionAllowed(sessionId, kind, item, enabled);
        if (kind === "mcp") {
          for (const name of names) {
            const entry = registry.entries.find((candidate) => candidate.name === name);
            if (entry === undefined) continue;
            if (live === null) continue;
            if (!enabled) {
              await disposeSessionEntry(live, name);
            } else if (entry.tier === "eager" && isSessionAllowed(sessionId, "mcp", name)) {
              try {
                await ensureEager(live, entry);
                rememberMount(live, entry);
              } catch (error) {
                ctx.logger.warn(`skill-mcp-manager: cannot re-mount "${name}" for this conversation: ${String(error?.message ?? error)}`);
              }
            }
          }
        } else if (live !== null) {
          try {
            try {
          try {
            await applySessionSkillPolicy(live.agent);
          } catch (error) {
            ctx.logger.warn(`skill-mcp-manager: skill policy skipped: ${String(error?.message ?? error)}`);
          }
        } catch (error) {
          ctx.logger.warn(`skill-mcp-manager: skill policy skipped: ${String(error?.message ?? error)}`);
        }
          } catch (error) {
            ctx.logger.warn(`skill-mcp-manager: skill policy skipped: ${String(error?.message ?? error)}`);
          }
        }
        return await uiHandlers.getSessionCapabilities(sessionId);
      }

      if (typeof name !== "string" || name === "") throw new Error("name is required");
      if (kind === "mcp") {
        const entry = registry.entries.find((candidate) => candidate.name === name);
        if (entry === undefined) {
          // A plugin-mounted row or a workspace-declared server: nothing of ours to
          // mount here — the guard and mcp_load read the policy on every call, so
          // recording the answer is the whole job.
          const rows = (await nativeMcpViews().catch(() => ({ entries: [] }))).entries ?? [];
          const fromPlugin = rows.some((row) => row.serverName === name);
          let fromWorkspace = false;
          if (!fromPlugin) {
            if (live !== null) {
              const { servers } = await workspaceMcpOf(await workspaceOf(live.agent));
              fromWorkspace = servers.some((server) => server.name === name);
            }
          }
          if (!fromPlugin && !fromWorkspace) throw new Error(`MCP "${name}" is not registered`);
          await setSessionAllowed(sessionId, "mcp", name, enabled);
          return await uiHandlers.getSessionCapabilities(sessionId);
        }
        if (entry.tier === "disabled") throw new Error(`MCP "${name}" is disabled globally — enable it in 能力库 first`);
        await setSessionAllowed(sessionId, "mcp", name, enabled);
        if (live !== null) {
          if (!enabled) {
            await disposeSessionEntry(live, name);
          } else if (entry.tier === "eager") {
            try {
              await ensureEager(live, entry);
              rememberMount(live, entry);
            } catch (error) {
              ctx.logger.warn(`skill-mcp-manager: cannot re-mount "${name}" for this conversation: ${String(error?.message ?? error)}`);
            }
          }
        }
      } else {
        const known = await sessionSkillEntries(sessionId, live);
        if (!known.some((item) => item.name === name)) throw new Error(`skill "${name}" not found`);
        await setSessionAllowed(sessionId, "skills", name, enabled);
        if (live !== null) {
          try {
            await applySessionSkillPolicy(live.agent);
          } catch (error) {
            ctx.logger.warn(`skill-mcp-manager: skill policy skipped: ${String(error?.message ?? error)}`);
          }
        }
      }
      return await uiHandlers.getSessionCapabilities(sessionId);
    },
    // Pin a registry entry to one workspace (empty clears the pin). Pinned entries are
    // only listed and mounted in conversations of that workspace.
    // The library page's 新增 button: the same validation as mcp_register (trial connect
    // + tools/list), but the human is the caller, so no local-command approval prompt.
    // The client posts already-parsed fields; anything blank is treated as absent so a
    // half-filled form cannot silently wipe an existing entry's command.
    // Pasted MCP config: the client sends the raw text. Parsing lives in the host so the
    // preview the user sees and the servers that get registered come from one parser.
    async parseMcpConfig(body) {
      const text = typeof body?.text === "string" ? body.text : "";
      const parsed = parseMcpConfigDocument(text);
      return { ok: true, ...parsed, formatted: formatMcpConfig(text) };
    },
    // Import is per-server: one bad transport must not stop the other nine. Each entry
    // goes through registerServerEntry(), so a pasted server is validated by a real
    // handshake exactly like one added through the form.
    async importMcpConfig(body) {
      const text = typeof body?.text === "string" ? body.text : "";
      const parsed = parseMcpConfigDocument(text);
      const results = [];
      for (const entry of parsed.servers) {
        try {
          const registered = await registerServerEntry(entry, { exec: null });
          results.push({ name: entry.name, ok: true, updated: registered.isUpdate, toolCount: registered.toolCount });
        } catch (error) {
          results.push({ name: entry.name, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        ok: true,
        errors: parsed.errors,
        results,
        imported: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
      };
    },
    // The 能力库 lists' order, as chosen by dragging. Presentation only: nothing here
    // affects what the model sees, and unknown names are dropped rather than stored.
    async getCapOrder() {
      return { ok: true, skills: capOrder.skills, mcp: capOrder.mcp };
    },
    async setCapOrder(body) {
      const kind = body?.kind;
      if (kind !== "skills" && kind !== "mcp") throw new Error('kind must be "skills" or "mcp"');
      if (!Array.isArray(body?.names)) throw new Error("names must be an array of strings");
      const seen = new Set();
      const names = [];
      for (const name of body.names) {
        if (typeof name !== "string" || name === "" || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
      }
      capOrder = { ...capOrder, [kind]: names };
      await saveCapOrder();
      return { ok: true, skills: capOrder.skills, mcp: capOrder.mcp };
    },

    // OAuth for one registry server: discover → register (PKCE) → hand the user a URL.
    // The redirect comes back to a loopback listener owned by this process, so the token
    // lands in the entry's headers without anyone copying a code by hand.
    async startMcpOAuth(name) {
      const entry = registry.entries.find((item) => item.name === name);
      if (entry === undefined) throw new Error("MCP \"" + name + "\" is not registered");
      if (entry.transport !== "streamable-http" || typeof entry.url !== "string" || entry.url === "") {
        throw new Error("只有 streamable-http 的服务器需要 OAuth 授权");
      }
      // Re-running the flow replaces the previous attempt (and closes its listener).
      const previous = mcpOAuthFlows.get(name);
      if (previous !== undefined && typeof previous.close === "function") {
        try { previous.close(); } catch { /* already closed */ }
      }
      const plan = await planOAuth(entry.url);
      const redirect = await new Promise((resolve, reject) => {
        const server = createHttpServer((request, response) => {
          const url = new URL(String(request.url ?? "/"), "http://localhost");
          if (url.pathname !== "/callback") {
            response.writeHead(404);
            response.end();
            return;
          }
          const flow = mcpOAuthFlows.get(name);
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const failure = url.searchParams.get("error");
          const finish = (title, text) => {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end("<!doctype html><meta charset=utf-8><title>" + title + "</title><body style=\"font:14px system-ui;padding:40px;line-height:1.6\">" + text + "</body>");
          };
          if (flow === undefined) return finish("授权", "这次授权已经结束，可以关闭这个页面。");
          if (failure !== null) {
            flow.status = "error";
            flow.error = "授权被拒绝：" + failure;
            return finish("授权失败", "授权被拒绝（" + failure + "），回到能力库重试。");
          }
          if (state !== flow.state || code === null) {
            flow.status = "error";
            flow.error = "回调缺少 code 或 state 不匹配";
            return finish("授权失败", "回调和这次请求对不上，回到能力库重试。");
          }
          flow.status = "exchanging";
          exchangeCode({
            tokenEndpoint: flow.server.tokenEndpoint,
            clientId: flow.clientId,
            clientSecret: flow.clientSecret,
            code,
            redirectUri: flow.redirectUri,
            verifier: flow.verifier,
            resource: flow.resource,
          })
            .then(async (token) => {
              const target = registry.entries.find((item) => item.name === name);
              if (target === undefined) throw new Error("服务器在授权过程中被删除了");
              target.headers = { ...(target.headers ?? {}), Authorization: token.tokenType + " " + token.accessToken };
              target.oauth = {
                scope: token.scope ?? flow.scope,
                at: new Date().toISOString(),
                ...(token.expiresIn === null ? {} : { expiresIn: token.expiresIn }),
                ...(token.refreshToken === null ? {} : { refreshToken: token.refreshToken }),
              };
              await saveRegistry(dataDir, registry);
              flow.status = "done";
              flow.token = token;
              // Fill the tool snapshot right away; a failure here is still a success —
              // the token is stored and 检测 can be retried from the card.
              try {
                await testMcp(name);
              } catch {
                // the token is stored; 检测 can be retried from the card
              }
              finish("授权完成", "已登录，可以关闭这个页面回到能力库。");
            })
            .catch((error) => {
              flow.status = "error";
              flow.error = error instanceof Error ? error.message : String(error);
              finish("授权失败", "换 token 失败，回到能力库看提示。");
            })
            .finally(() => { setTimeout(() => { try { close(); } catch { /* closed */ } }, 200); });
        });
        const close = () => server.close();
        server.on("error", reject);
        server.listen(0, "localhost", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          // Register and reuse the exact loopback URI for this authorization attempt.
          resolve({ port, close, uri: "http://localhost:" + port + "/callback" });
        });
      });
      const client = await registerClient({
        registrationEndpoint: plan.server.registrationEndpoint,
        redirectUri: redirect.uri,
        scope: plan.scope,
      });
      const pkce = pkcePair();
      const state = randomState();
      const authorizeUrl = buildAuthorizeUrl({
        authorizationEndpoint: plan.server.authorizationEndpoint,
        clientId: client.clientId,
        redirectUri: redirect.uri,
        scope: plan.scope,
        resource: plan.resource.resource,
        challenge: pkce.challenge,
        state,
      });
      mcpOAuthFlows.set(name, {
        status: "pending",
        authorizeUrl,
        server: plan.server,
        resource: plan.resource.resource,
        scope: plan.scope,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUri: redirect.uri,
        state,
        verifier: pkce.verifier,
        port: redirect.port,
        close: redirect.close,
        startedAt: Date.now(),
      });
      // A flow nobody finishes must not leave a port open.
      setTimeout(() => {
        const flow = mcpOAuthFlows.get(name);
        if (flow !== undefined && flow.status === "pending") {
          flow.status = "expired";
          try { flow.close(); } catch { /* closed */ }
        }
      }, 5 * 60 * 1000).unref?.();
      return { ok: true, authorizeUrl, redirectUri: redirect.uri, scope: plan.scope };
    },
    async getMcpOAuthStatus(name) {
      const flow = mcpOAuthFlows.get(name);
      if (flow === undefined) return { ok: true, status: "none" };
      return {
        ok: true,
        status: flow.status,
        ...(flow.error === undefined ? {} : { error: flow.error }),
        ...(flow.status === "pending" ? { authorizeUrl: flow.authorizeUrl } : {}),
      };
    },

    async addMcp(body) {
      if (body === null || typeof body !== "object") throw new Error("body must be an object");
      const args = {};
      for (const key of ["name", "tier", "transport", "command", "args", "env", "cwd", "url", "headers", "notes", "skipTrial"]) {
        const value = body[key];
        if (value === undefined || value === null || value === "") continue;
        args[key] = value;
      }
      const { entry, isUpdate, toolCount } = await registerServerEntry(args, { exec: null });
      return { ok: true, updated: isUpdate, toolCount, entry: entryView(entry) };
    },

    async setMcpWorkspace(name, workspace) {
      if (typeof name !== "string" || name === "") throw new Error("name is required");
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      const path = typeof workspace === "string" ? normalizeWorkspacePath(workspace) : "";
      entry.workspace = path;
      await saveRegistry(dataDir, registry);
      return { ok: true, name: entry.name, workspace: entry.workspace };
    },
    async listNativeMcp() {
      return nativeMcpViews();
    },
    // Residual MCP child processes: a restart that leaves a stdio server behind
    // strands its whole npx → cmd → node chain. Only commands this plugin manages
    // are candidates, and anything owned by a live harness is kept. Dry run by
    // default — the UI shows the list before anything is killed.
    async cleanOrphanMcp(confirm) {
      const commands = [];
      for (const entry of registry.entries) {
        if (entry.transport !== "stdio") continue;
        commands.push({ command: entry.command, args: entry.args ?? [] });
      }
      for (const entry of nativeLoaderEntries()) {
        const cfg = entry.options.config ?? {};
        if (cfg.transport !== "stdio") continue;
        commands.push({ command: cfg.command, args: cfg.args ?? [] });
      }
      const signatures = commandSignatures(commands);
      if (signatures.length === 0) {
        return { ok: true, confirmed: false, candidates: [], live: [], signatures: [] };
      }
      let processes;
      try {
        processes = await listProcesses();
      } catch (error) {
        throw new Error(`cannot list processes: ${error instanceof Error ? error.message : String(error)}`);
      }
      const { orphans, live } = classifyOrphans(processes, signatures);
      if (confirm !== true) {
        return { ok: true, confirmed: false, candidates: orphans, live, signatures };
      }
      const { killed, failed } = await killPids(orphans.map((item) => item.pid));
      ctx.logger.info(`skill-mcp-manager: orphan cleanup killed ${killed.length}, kept ${live.length} live`);
      return { ok: true, confirmed: true, candidates: orphans, killed, failed, live, signatures };
    },
    async setNativeMcpEnabled(id, enabled) {
      if (typeof id !== "string" || id === "") throw new Error("id is required");
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      if (loader === null || typeof loader.entries !== "function") {
        throw new Error("this host does not expose the plugin loader, so a native MCP row cannot be toggled");
      }
      const entry = nativeLoaderEntries().find((candidate) => loaderRowIdOf(candidate) === id);
      if (entry === undefined) throw new Error(`MCP loader row "${id}" is not mounted`);
      await entry.update({ disabled: !enabled });
      return { ok: true, id, enabled: !entry.disabled, native: await nativeMcpViews() };
    },
    async setTier(name, tier) {
      if (!TIERS.has(tier)) throw new Error(`invalid tier "${tier}"`);
      const index = registry.entries.findIndex((entry) => entry.name === name);
      if (index < 0) throw new Error(`MCP "${name}" is not registered`);
      const entry = registry.entries[index];
      const wasEager = entry.tier === "eager";
      if (tier === "eager" && !wasEager) {
        const candidate = { ...entry, tier };
        const connection = await connectEntry(candidate, trialTimeoutMs, stdioMaxBufferSizeBytes);
        try {
          entry.tools = await snapshotTools(connection.client);
        } finally {
          await connection.client.close();
        }
        eagerConnectFailed.delete(name);
      }
      entry.tier = tier;
      entry.lastSyncAt = new Date().toISOString();
      await saveRegistry(dataDir, registry);
      if (tier === "eager") await syncEagerEverywhere(entry);
      else if (wasEager) {
        eagerConnectFailed.delete(name);
        await disposeNamedEverywhere(name);
      }
      await reconcile();
      return viewOf(entry, false);
    },
    async setToolEnabled(name, toolName, enabled) {
      if (typeof toolName !== "string" || toolName === "") throw new Error("tool name is required");
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      const knownTools = entry.tools ?? [];
      if (!knownTools.some((tool) => tool.name === toolName)) {
        throw new Error(`MCP tool "${name}/${toolName}" is not in the latest tool snapshot`);
      }
      const disabled = disabledToolNames(entry);
      if (enabled) disabled.delete(toolName);
      else disabled.add(toolName);
      entry.disabledTools = [...disabled];
      entry.lastSyncAt = new Date().toISOString();
      await saveRegistry(dataDir, registry);
      if (entry.tier === "eager") await syncEagerEverywhere(entry);
      return viewOf(entry, false);
    },
    async deleteMcp(name) {
      const index = registry.entries.findIndex((entry) => entry.name === name);
      if (index < 0) throw new Error(`MCP "${name}" is not registered`);
      await disposeNamedEverywhere(name);
      eagerConnectFailed.delete(name);
      retiredRowIds.add(entryRowId(registry.entries[index]));
      registry.entries.splice(index, 1);
      await saveRegistry(dataDir, registry);
      await reconcile();
      return { ok: true };
    },
    async peekMcp(name) {
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${name}" is disabled`);
      return { ok: true, text: renderDefinitions(entry, entry.tools ?? []) };
    },
    async refreshSnapshot(name) {
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${name}" is disabled`);
      try {
        const connection = await connectEntry(entry, trialTimeoutMs, stdioMaxBufferSizeBytes);
        try {
          entry.tools = await snapshotTools(connection.client);
          applyServerMetadata(entry, connection);
          entry.lastLoadAt = new Date().toISOString();
          await saveRegistry(dataDir, registry);
          if (entry.tier === "eager") eagerConnectFailed.delete(entry.name);
          return { ok: true, text: renderDefinitions(entry, entry.tools) };
        } finally {
          try {
            await connection.client.close();
          } catch {
            /* ignore */
          }
        }
      } catch (error) {
        if (entry.tier === "eager") eagerConnectFailed.add(entry.name);
        throw error;
      }
    },
    // Connection check for the management UI: one real handshake against the
    // entry's configured transport, then the probe client is closed. Nothing is
    // registered and no live session instance is touched — the only write is the
    // last-check record below, which is what lets a card show state across
    // reloads. Tool snapshots cannot answer "does this still connect": they may
    // be months old, so the probe is the only honest source.
    async testMcp(name) {
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      const startedAt = Date.now();
      const record = {
        at: new Date().toISOString(),
        ok: false,
        latencyMs: null,
        toolCount: null,
        serverName: null,
        toolsDiffer: null,
        error: null,
      };
      try {
        const connection = await connectEntry(entry, checkTimeoutMs, stdioMaxBufferSizeBytes);
        try {
          const live = (await listTools(connection.client)).map((tool) => tool.name).sort();
          record.ok = true;
          record.toolCount = live.length;
          record.serverName = typeof connection.serverInfo?.name === "string" ? connection.serverInfo.name : null;
          const snapshot = Array.isArray(entry.tools) ? entry.tools.map((tool) => tool.name).sort() : [];
          record.toolsDiffer = snapshot.length === 0 ? null : JSON.stringify(snapshot) !== JSON.stringify(live);
        } finally {
          try {
            await connection.client.close();
          } catch {
            /* a probe that already ended is not a failed check */
          }
        }
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
      }
      record.latencyMs = Date.now() - startedAt;
      entry.lastCheck = record;
      await saveRegistry(dataDir, registry);
      return { ok: true, check: record };
    },
    lanHostAllowlist() {
      return lanHostAllowlist;
    },
    prepareUninstall,
    async getSettings() {
      return {
        toolDescriptionMaxLength,
        localCommandApproval,
        lanHostAllowlist: [...lanHostAllowlist],
        stdioMaxBufferSizeMb,
      };
    },
    async setSettings(body) {
      const settings = await loadSettings(dataDir);
      if (body.toolDescriptionMaxLength !== undefined) {
        const n = Number(body.toolDescriptionMaxLength);
        if (!Number.isInteger(n) || n <= 0 || n > 5000) {
          throw new Error("toolDescriptionMaxLength must be a positive integer (<= 5000)");
        }
        toolDescriptionMaxLength = n;
        settings.toolDescriptionMaxLength = n;
      }
      if (body.localCommandApproval !== undefined) {
        if (!LOCAL_COMMAND_APPROVALS.has(body.localCommandApproval)) {
          throw new Error("localCommandApproval must be follow, always-ask, or always-allow");
        }
        localCommandApproval = body.localCommandApproval;
        settings.localCommandApproval = body.localCommandApproval;
      }
      if (body.lanHostAllowlist !== undefined) {
        lanHostAllowlist = normalizeLanHostAllowlist(body.lanHostAllowlist);
        settings.lanHostAllowlist = [...lanHostAllowlist];
      }
      if (body.stdioMaxBufferSizeMb !== undefined) {
        // null clears the override (back to the SDK default); otherwise a
        // positive integer of megabytes. No ceiling: aligned with the SDK,
        // where maxBufferSize is an unvalidated number.
        const raw = body.stdioMaxBufferSizeMb;
        if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0)) {
          throw new Error("stdioMaxBufferSizeMb must be a positive integer (MB) or null to use the SDK default");
        }
        applyStdioMaxBufferSizeSetting(raw);
        settings.stdioMaxBufferSizeMb = stdioMaxBufferSizeMb;
      }
      await saveSettings(dataDir, settings);
      return {
        ok: true,
        toolDescriptionMaxLength,
        localCommandApproval,
        lanHostAllowlist: [...lanHostAllowlist],
        stdioMaxBufferSizeMb,
      };
    },
    async getSessionAudit() {
      // This request IS the scan trigger (see `auditRunner` above), and the scan
      // itself must not be awaited: it takes tens of seconds and this response
      // sits on the client's page-load path. The client polls `scanning` instead.
      auditRunner.kick();
      // A scan actually in flight is what the client shows a wait notice for.
      // `running()` goes false the instant the answer lands, so there is no
      // window where the UI waits on a scan that has already finished.
      if (auditRunner.running()) return { scanning: true };
      const record = await auditRunner.read();
      // Settled and still nothing on disk means this check has nothing left to
      // do — a machine that never had legacy logs writes no record at all. That
      // is reported as done, not as "waiting", so the UI stays quiet instead of
      // showing a check that will never finish.
      if (record === null) return { done: true, checked: auditRunner.checked() };
      return {
        done: true,
        // Whether a scan ran in this process, as opposed to a record that was
        // already on disk. The UI announces a result only for a scan that ran,
        // so a retired check is not re-announced on every start.
        checked: auditRunner.checked(),
        // A retired check is reported as off, so the notice hides as soon as the
        // scan that found nothing has been recorded.
        check: record.check === true,
        scanned: record.scanned,
        affected: record.affected,
        checkedAt: record.checkedAt,
      };
    },
  };

  // webServer is provided lazily by the web-app bundle; acquire it by waiting
  // on it (the same ctx.inject pattern dshmarket uses). A synchronous
  // ctx.get("webServer") here would return undefined and the routes would never
  // register, so the browser would get the SPA fallback instead of JSON.
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (hostCtx) => {
      mountUi(hostCtx, uiHandlers, { dataDir, webServer: hostCtx.webServer });
    });
  } else {
    mountUi(ctx, uiHandlers, { dataDir });
  }

  // ── pre-step catalog injector ──
  // Mirror dsh-tool-skill's skill-catalog: decide from the durable session
  // surface, not a process-local flag. Compaction can drop the previous
  // mcp-catalog off the surface while the registry is unchanged; in that case
  // the catalog must be re-appended.
  //
  // Identity is the model-facing text itself, compared as a whole string. A
  // stored digest would have to ride in `source`, and `source` must stay
  // minimal: the released migration edges audit message sources (v2→v3 admits
  // only its 15 built-in kinds; v0→v1 admits the `{kind:"plugin", plugin}` pair
  // plus `form`/`sections`/`summary`), and a `digest` member once made every
  // historical log unloadable on the next format generation (2026-09-11
  // incident). The text needs no carrier: it is already durable as the message
  // content.

  // ── user-defined skill groups ───────────────────────────────────────────
  // A small durable file the page edits directly; every rule (unique names,
  // ordering, what a delete does to members) lives in lib/skill-groups.js so it
  // is testable without a host.
  let skillGroups = emptyGroups();
  const skillGroupsPath = () => join(dataDir, "skill-groups.json");

  async function loadSkillGroups() {
    try {
      skillGroups = normalizeGroups(JSON.parse(await readFile(skillGroupsPath(), "utf8")));
    } catch {
      skillGroups = emptyGroups();
    }
  }

  async function saveSkillGroups() {
    try {
      await mkdir(dataDir, { recursive: true });
      const file = skillGroupsPath();
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(skillGroups, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    } catch (error) {
      ctx.logger.warn(`skill-mcp-manager: cannot persist skill groups: ${String(error?.message ?? error)}`);
    }
  }

  // ── per-conversation capability policy ─────────────────────────────────────
  // DEFAULT IS CLOSED: a conversation starts with every MCP server and every skill
  // switched off, and 能力管理 is where the user turns on what this chat may use.
  // The file therefore stores ALLOW lists (`session-caps.json`, keyed by session id);
  // a session with no entry simply has nothing enabled.
  //
  // Enforcement points, all reading the live policy:
  //   MCP (registry): never mounted for that agent, never injected into its catalog,
  //     refused by mcp_load/mcp_call, and its live connection dropped on disable.
  //   MCP (plugin rows): not ours to mount, so a scoped pre-execute guard refuses
  //     their `mcp__<server>__<tool>` calls instead.
  //   Skills: the model-facing catalog and the `skill` loader are one unit in this
  //     host, so hiding leans on two layers — a session-layer shadow with
  //     modelInvocable=false (drops it from the catalog) plus the same guard
  //     refusing the load call (the layer rules may change; the guard will not).
  let sessionCaps = {};
  const sessionCapsPath = () => join(dataDir, "session-caps.json");

  async function loadSessionCaps() {
    try {
      const text = await readFile(sessionCapsPath(), "utf8");
      const data = JSON.parse(text);
      if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
      const out = {};
      for (const [id, value] of Object.entries(data)) {
        if (value === null || typeof value !== "object") continue;
        out[id] = {
          mcp: Array.isArray(value.mcp) ? value.mcp.filter((n) => typeof n === "string") : [],
          skills: Array.isArray(value.skills) ? value.skills.filter((n) => typeof n === "string") : [],
          // "This conversation already started from somewhere" — an empty allow list
          // is a choice, not a blank slate. Kept so the workspace default never
          // re-seeds a conversation the user has since emptied by hand.
          ...(value.seeded === true ? { seeded: true } : {}),
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  async function saveSessionCaps() {
    try {
      await mkdir(dataDir, { recursive: true });
      const file = sessionCapsPath();
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(sessionCaps, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    } catch (error) {
      ctx.logger.warn(`skill-mcp-manager: cannot persist session capabilities: ${String(error?.message ?? error)}`);
    }
  }

  // ── user-chosen ordering of the能力库 lists ───────────────────────────────
  // Pure presentation: which card the user dragged where. Names are stored as a flat
  // list per kind; anything not in the list keeps its natural place, so a new skill or
  // server never disappears just because it is not in the saved order yet.
  let capOrder = { skills: [], mcp: [] };

  // OAuth flows in flight, one per server: the loopback listener below is the redirect
  // target, so the code never has to be pasted by hand.
  const mcpOAuthFlows = new Map();
  const capOrderPath = () => join(dataDir, "order.json");

  async function loadCapOrder() {
    try {
      const data = JSON.parse(await readFile(capOrderPath(), "utf8"));
      if (data === null || typeof data !== "object" || Array.isArray(data)) return { skills: [], mcp: [] };
      const list = (value) => (Array.isArray(value) ? value.filter((name) => typeof name === "string") : []);
      return { skills: list(data.skills), mcp: list(data.mcp) };
    } catch {
      return { skills: [], mcp: [] };
    }
  }

  async function saveCapOrder() {
    try {
      await mkdir(dataDir, { recursive: true });
      const file = capOrderPath();
      const tmp = file + ".tmp-" + process.pid;
      await writeFile(tmp, JSON.stringify(capOrder, null, 2) + "\n", "utf8");
      await rename(tmp, file);
    } catch (error) {
      ctx.logger.warn("skill-mcp-manager: cannot persist list order: " + String(error?.message ?? error));
    }
  }

  // ── OAuth flows in flight ───────────────────────────────────────────────
  // "In this workspace, a new chat should start with these capabilities on." Keyed by
  // the workspace path (the same cwd key project skills hang off). A conversation
  // seeds from it exactly once, the first time it produces a turn — later edits of
  // the default never rewrite a conversation that already made its own choice.
  let workspaceDefaults = {};
  const workspaceDefaultsPath = () => join(dataDir, "workspace-defaults.json");

  function workspaceKey(value) {
    if (typeof value !== "string" || value === "") return "";
    let key;
    try {
      key = resolve(value);
    } catch {
      return "";
    }
    if (key.length > 1 && (key.endsWith("\\") || key.endsWith("/"))) key = key.slice(0, -1);
    return process.platform === "win32" ? key.toLowerCase() : key;
  }

  async function loadWorkspaceDefaults() {
    try {
      const data = JSON.parse(await readFile(workspaceDefaultsPath(), "utf8"));
      if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
      const out = {};
      for (const [workspace, value] of Object.entries(data)) {
        if (value === null || typeof value !== "object") continue;
        out[workspace] = {
          mcp: Array.isArray(value.mcp) ? value.mcp.filter((name) => typeof name === "string") : [],
          skills: Array.isArray(value.skills) ? value.skills.filter((name) => typeof name === "string") : [],
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  async function saveWorkspaceDefaults() {
    try {
      await mkdir(dataDir, { recursive: true });
      const file = workspaceDefaultsPath();
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(workspaceDefaults, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    } catch (error) {
      ctx.logger.warn(`skill-mcp-manager: cannot persist workspace defaults: ${String(error?.message ?? error)}`);
    }
  }

  // The conversation's workspace, resolved the same way the host resolves cwd for
  // project skills. Absent when the host cannot tell us — then there is no default.
  // The real path (used for every filesystem decision: project files, project skills,
  // containment checks). Storage keys go through workspaceKey(), never this.
  function normalizeWorkspacePath(value) {
    if (typeof value !== "string" || value === "") return "";
    try {
      const resolved = resolve(value);
      return resolved.length > 1 && (resolved.endsWith("\\") || resolved.endsWith("/")) ? resolved.slice(0, -1) : resolved;
    } catch {
      return "";
    }
  }

  async function workspaceOf(agent, signal) {
    const workingDirectory = ctx.get("workingDirectory");
    if (workingDirectory !== undefined && typeof workingDirectory.ensure === "function") {
      try {
        const cwd = normalizeWorkspacePath(await workingDirectory.ensure(agent, signal));
        if (cwd !== "") return cwd;
      } catch {
        /* the host could not resolve a cwd for this agent */
      }
    }
    return normalizeWorkspacePath(typeof agent?.session?.header?.cwd === "string" ? agent.session.header.cwd : "");
  }

  // The servers this workspace declares for itself. They live in project files, are
  // never written into the registry or the profile patch, and are always on-demand.
  async function workspaceMcpOf(workspace) {
    if (typeof workspace !== "string" || workspace === "") return { servers: [], errors: [] };
    try {
      return await readWorkspaceMcp(workspace);
    } catch (error) {
      return { servers: [], errors: [String(error?.message ?? error)] };
    }
  }

  function workspaceEntryView(server) {
    return {
      name: server.name,
      tier: "on-demand",
      transport: server.transport,
      // connectEntry/connect flow wants the registry entry shape.
      command: server.command ?? null,
      args: server.args ?? [],
      env: server.env ?? {},
      cwd: server.cwd ?? null,
      url: server.url ?? null,
      headers: server.headers ?? {},
      notes: server.notes ?? "",
      tools: [],
      disabledTools: [],
      serverName: "",
      serverDescription: "",
      metaFetchedAt: null,
      file: server.file ?? "",
    };
  }

  // A name resolves to the user's registry first, then to whatever the conversation's
  // workspace declares. Both are per-session capabilities, so both answer to the
  // same allow list.
  async function entryForAgent(agent, name) {
    const entry = registry.entries.find((candidate) => candidate.name === name);
    if (entry !== undefined) return { entry, source: "registry" };
    const workspace = await workspaceOf(agent);
    const { servers } = await workspaceMcpOf(workspace);
    const server = servers.find((candidate) => candidate.name === name);
    if (server === undefined) return null;
    return { entry: workspaceEntryView(server), source: "workspace" };
  }

  // Everything the workspace itself brings: its declared MCP servers, the registry
  // entries the user pinned to this workspace, and the skills that live under it.
  async function workspaceOwnedCaps(workspace, agent) {
    const mcp = [];
    try {
      const { servers } = await workspaceMcpOf(workspace);
      for (const server of servers) mcp.push(server.name);
    } catch {
      /* an unreadable project file owns nothing */
    }
    for (const entry of registry.entries) {
      if (entry.tier === "disabled") continue;
      if (workspaceKey(entry.workspace ?? "") !== workspace) continue;
      if (!mcp.includes(entry.name)) mcp.push(entry.name);
    }
    // Only skills that live inside the workspace count as "brought by the workspace".
    // Everything visible from that cwd (the user's own roots, bundled skills) is not.
    const skills = [];
    try {
      const entries = await sessionSkillEntries("__seed__", null, workspace);
      for (const item of entries) {
        if (typeof item.path !== "string" || !isInsideDir(item.path, workspace)) continue;
        skills.push(item.name);
      }
    } catch {
      /* no skill service, no skills */
    }
    return { mcp, skills };
  }

  // Seed a brand-new conversation from its workspace default. Runs once per
  // conversation: the first turn marks it, so a conversation the user has since
  // emptied by hand is a choice, not a blank slate that gets re-seeded.
  async function seedFromWorkspaceDefault(agent, signal) {
    const sessionId = sessionIdOf(agent);
    if (sessionId === null) return;
    const existing = sessionCaps[sessionId];
    if (existing !== undefined) {
      if (existing.seeded === true) return;
      existing.seeded = true;
      await saveSessionCaps();
      return;
    }
    const workspace = await workspaceOf(agent, signal);
    const preset = workspace === "" ? undefined : workspaceDefaults[workspaceKey(workspace)];
    // No saved default: a conversation starts with what its WORKSPACE brings — the
    // project's own MCP servers and the skills it carries — and nothing global.
    const owned = workspace === "" ? { mcp: [], skills: [] } : await workspaceOwnedCaps(workspace, agent);
    const mcp = preset === undefined ? owned.mcp : [...preset.mcp];
    const skills = preset === undefined ? owned.skills : [...preset.skills];
    sessionCaps[sessionId] = { mcp, skills, seeded: true };
    await saveSessionCaps();
    ctx.logger.info(`skill-mcp-manager: conversation seeded (${mcp.length} MCP, ${skills.length} skills, ${preset === undefined ? "workspace-owned" : "saved default"})`);
  }

  function sessionIdOf(agent) {
    const id = agent?.session?.id;
    return typeof id === "string" && id !== "" ? id : null;
  }

  function sessionEntry(sessionId) {
    const entry = sessionCaps[sessionId];
    return entry === undefined ? { mcp: [], skills: [] } : entry;
  }

  // Closed by default: only names the user turned on for this conversation are
  // allowed. A context with no session identity (a tool call without an agent, a host
  // that does not expose `session.id`) is left alone — it cannot be shown in
  // 能力管理, so closing it would produce a state nobody could turn back on.
  function isSessionAllowed(sessionId, kind, name) {
    if (sessionId === null) return true;
    return sessionEntry(sessionId)[kind].includes(name);
  }

  // The live runtime of one conversation, if that agent has already produced one.
  function liveSessionOf(sessionId) {
    if (sessionId === null) return null;
    for (const session of liveSessions) {
      if (sessionIdOf(session.agent) === sessionId) return session;
    }
    return null;
  }

  async function setSessionAllowed(sessionId, kind, name, allowed) {
    const entry = sessionCaps[sessionId] === undefined
      ? { mcp: [], skills: [] }
      : sessionCaps[sessionId];
    const list = new Set(entry[kind]);
    if (allowed) list.add(name);
    else list.delete(name);
    entry[kind] = [...list];
    if (entry.mcp.length === 0 && entry.skills.length === 0 && entry.seeded !== true) delete sessionCaps[sessionId];
    else sessionCaps[sessionId] = entry;
    await saveSessionCaps();
  }

  // Shadows this plugin owns per agent: name -> Cordis disposer handed back by
  // `ctx.skills.register()`. Kept per agent because the agent's own context is
  // the layer the shadow lands in (`scopeOf(agent.ctx)` is that agent).
  const sessionSkillShadows = new WeakMap();

  function shadowsOf(agent) {
    let shadows = sessionSkillShadows.get(agent);
    if (shadows === undefined) {
      shadows = new Map();
      sessionSkillShadows.set(agent, shadows);
    }
    return shadows;
  }

  // Scoped shadow: register a same-name runtime skill in the agent's own layer
  // with model invocation disabled. A read merges the agent's layers with the
  // nearest layer winning a duplicate name outright, and every host consumer
  // (skill catalog, `skill` tool) filters `isModelInvocable` — so this both hides
  // the skill and makes the loader refuse it with the host's own error. The
  // registry needs a non-empty description, so an unreadable definition still
  // gets a placeholder: the name stays refused either way.
  // Reading `skills` off an agent context throws cordis' "cannot get property
  // \"skills\" without inject" when that context does not declare the service — which is
  // normal: the host does not put this plugin's inject list on every agent. So every
  // per-agent read goes through here, and a missing service means "no local view"
  // rather than an exception in the middle of a switch.
  function agentSkills(agent) {
    try {
      const local = agent?.ctx?.skills;
      if (local !== undefined && local !== null && typeof local.list === "function") return local;
    } catch {
      /* the agent context does not inject skills */
    }
    try {
      return skillsService();
    } catch {
      return undefined;
    }
  }

  // A shadow hides one skill from THIS conversation's model-facing catalog. Two ways
  // in, because the host does not always hand the agent a context that injects
  // `skills`: read it directly when it is there, otherwise ask cordis for a scope that
  // does inject it (the canonical pattern) and register through that. The returned
  // disposer is always callable, even when the registration lands a tick later.
  function skillShadow(agent, name, definition) {
    const payload = {
      name,
      description: typeof definition?.description === "string" && definition.description !== ""
        ? definition.description
        : "hidden in this conversation by dsh-skill-mcp-manager",
      content: typeof definition?.content === "string" ? definition.content : "",
      ...(typeof definition?.whenToUse === "string" ? { whenToUse: definition.whenToUse } : {}),
      source: "runtime",
      invocation: { modelInvocable: false, userInvocable: false },
      provider: "skill-mcp-manager-session",
    };
    const register = (service) => {
      if (service === undefined || service === null || typeof service.register !== "function") return null;
      try {
        const dispose = service.register(payload);
        return typeof dispose === "function" ? dispose : null;
      } catch {
        return null;
      }
    };
    const skillCtx = agent?.ctx;
    if (skillCtx === undefined) return null;
    try {
      const direct = register(skillCtx.skills);
      if (direct !== null) return direct;
    } catch {
      /* this agent context does not inject skills — fall through */
    }
    if (typeof skillCtx.inject !== "function") return null;
    const holder = { dispose: null };
    try {
      skillCtx.inject(["skills"], (scoped) => {
        holder.dispose = register(scoped?.skills);
      });
    } catch {
      return null;
    }
    if (holder.dispose === null) {
      // The injection has not resolved yet; hand back a disposer that resolves late.
      return () => {
        if (typeof holder.dispose === "function") holder.dispose();
      };
    }
    const dispose = holder.dispose;
    return dispose;
  }
  // Reconcile the agent's shadows with its denied skill names: drop the shadows
  // of names allowed again (the real definition wins back), add one per name
  // still denied. Runs on every pre-step, so a policy change lands on the next
  // turn without touching the provider catalogs on disk.
  // Enforcement layer: the host's `skill` loader is shared, so a shadow alone
  // would depend on layer precedence. A pre-execute listener on the AGENT context
  // is dispatched only for that agent's calls (scope-filtered), and refuses a
  // denied name outright. Kept per agent; released with the agent's own context.
  const sessionSkillGuards = new WeakMap();

  // `mcp__<server>__<tool>` — how the host names a tool an MCP server registered
  // natively. Plugin-mounted servers are not ours to unmount, so this is the one
  // place that can honour a per-conversation decision about them.
  const NATIVE_MCP_TOOL_RE = /^mcp__([A-Za-z0-9_-]+)__/;

  function registerSessionSkillGuard(agent, sessionId) {
    if (sessionSkillGuards.has(agent)) return;
    if (typeof agent?.ctx?.on !== "function") return;
    const guard = async (exec, next) => {
      const toolName = exec?.name;
      if (typeof toolName !== "string" || toolName === "") return next();
      if (toolName === "skill") {
        const requested = exec?.arguments?.name ?? exec?.arguments?.skill;
        if (typeof requested === "string" && !isSessionAllowed(sessionId, "skills", requested)) return "deny";
        return next();
      }
      const native = NATIVE_MCP_TOOL_RE.exec(toolName);
      if (native !== null && !isSessionAllowed(sessionId, "mcp", native[1])) return "deny";
      return next();
    };
    let dispose;
    try {
      dispose = agent.ctx.on("tools/pre-execute", guard);
    } catch (error) {
      // A host that refuses the listener costs the hard guarantee, not the turn.
      ctx.logger.warn(`skill-mcp-manager: cannot install the conversation guard: ${String(error?.message ?? error)}`);
      dispose = undefined;
    }
    sessionSkillGuards.set(agent, typeof dispose === "function" ? dispose : () => {});
  }

  // The last policy this agent's shadows were reconciled against. A shadow write is
  // a real registration, so it must not run on every pre-step for nothing.
  const sessionSkillApplied = new WeakMap();

  async function applySessionSkillPolicy(agent, signal) {
    const sessionId = sessionIdOf(agent);
    if (sessionId === null) return;
    registerSessionSkillGuard(agent, sessionId);
    const allowed = new Set(sessionEntry(sessionId).skills);
    const signature = [...allowed].sort().join("\u0000");
    const shadows = shadowsOf(agent);
    if (sessionSkillApplied.get(agent) === signature && shadows.size > 0) return;
    // Everything the conversation can see, minus what it is allowed to use, gets a
    // shadow so the model-facing catalog stops advertising it. Default-closed means
    // this is "all of them" on a fresh conversation.
    let blocked;
    try {
      const entries = await sessionSkillEntries(sessionId, liveSessionOf(sessionId));
      blocked = entries.filter((item) => !item.enabled).map((item) => item.name);
    } catch {
      blocked = [];
    }
    const denied = new Set(blocked);
    for (const [name, dispose] of [...shadows]) {
      if (denied.has(name)) continue;
      try {
        dispose();
      } catch {
        /* the agent layer is already gone */
      }
      shadows.delete(name);
    }
    sessionSkillApplied.set(agent, signature);
    if (denied.size === 0) return;
    // The agent-scoped context inherits the registry service; fall back to the
    // host context for a host shape that does not expose it on the agent.
    const skills = agentSkills(agent);
    for (const name of denied) {
      if (shadows.has(name)) continue;
      let definition;
      if (typeof skills?.get === "function") {
        try {
          // Same scope the host uses for its own catalog and `skill` tool.
          definition = await skills.get(name, { scope: agent, ...(signal === undefined ? {} : { signal }) });
        } catch {
          definition = undefined;
        }
      }
      const dispose = skillShadow(agent, name, definition);
      if (dispose !== null) shadows.set(name, dispose);
    }
  }

  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    // A brand-new conversation starts from its workspace default, then the runtime is
    // mounted against that policy — the order matters, or the first turn would run
    // with everything off even though the workspace asked for more.
    try {
      await seedFromWorkspaceDefault(agent, signal);
    } catch (error) {
      ctx.logger.warn(`skill-mcp-manager: workspace default skipped: ${String(error?.message ?? error)}`);
    }
    await ensureSessionRuntime(agent);
    // Policy work must never fail a turn: a broken skill service or an unusual agent
    // shape costs the per-conversation switches, not the conversation.
    try {
      await applySessionSkillPolicy(agent, signal);
    } catch (error) {
      ctx.logger.warn(`skill-mcp-manager: conversation policy skipped: ${String(error?.message ?? error)}`);
    }
    signal.throwIfAborted();
    const decision = await next();
    if (decision.kind === "reject") return decision;
    signal.throwIfAborted();
    const sessionId = sessionIdOf(agent);
    const visible = registry.entries.filter((entry) => entry.tier !== "disabled"
      && isSessionAllowed(sessionId, "mcp", entry.name));
    if (visible.length === 0) return decision;
    const message = renderCatalog(catalogEntries(visible, sessionOf(agent)));
    const text = message.content[0].text;
    if (visibleCatalogText(agent) === text) return decision;
    if (pendingCatalogText(decision.messages) === text) return decision;
    return { kind: "enter", messages: [...decision.messages, message] };
  });

  // Entries are the projection the model-facing prose derives from (same-source
  // principle, like the built-in skill-catalog). Nothing else is persisted.
  function catalogEntries(visible, session) {
    return visible.map((entry) => ({
      name: entry.name,
      // A failed eager entry stays eager in the registry. Sessions that do not
      // have it mounted are told to load first, using the existing on-demand
      // line rather than a new catalog shape.
      tier: entry.tier === "eager" && eagerConnectFailed.has(entry.name) && !session.connections.has(entry.name)
        ? "on-demand"
        : entry.tier,
      description: truncate(entry.serverDescription ?? "", catalogDescriptionMaxLength),
      notes: entry.notes ?? "",
      tools: enabledTools(entry, entry.tools).map((tool) => ({
        name: tool.name,
        description: truncate(tool.description ?? "", toolDescriptionMaxLength),
      })),
    }));
  }

  // SessionSeq guard, mirroring the built-in skill-catalog.
  function sessionSeq(value) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`);
    }
    return value;
  }

  // The producer-owned source kind, and no declared `form`: the host renders a
  // context without a recognized form as the model-facing text itself
  // (OpaqueBody), so what a human expands is exactly what the model read.
  //
  // Session format v4 retired the bare `kind:"plugin"` + `plugin` pair: its
  // writer refuses that source outright ("format v4 message requires a
  // producer-owned source kind"), which failed every turn while this plugin
  // injected its catalog (2026-09-28). `plugin:<name>` is the kind the kernel's
  // own v3→v4 edge derives for a plugin it does not know (`producerKind()`
  // falls back to `plugin:${plugin}`), so rows written before this change read
  // back under exactly this shape and stay recognisable below.
  const CATALOG_SOURCE = { kind: "plugin:dsh-skill-mcp-manager" };

  // The model-facing text of one of this plugin's catalog messages, or
  // undefined for anything else. Identity is `source.kind` alone: the v3→v4
  // edge rewrites legacy `{kind:"plugin", plugin}` rows to this kind, so both
  // generations answer the same way. Records whose text is unreadable (older
  // formats, hand-edited logs) count as "not this plugin's catalog" and never
  // as a visible catalog.
  function catalogMessageText(message) {
    if (message?.source?.kind !== CATALOG_SOURCE.kind) return undefined;
    const block = Array.isArray(message.content) ? message.content[0] : undefined;
    return typeof block?.text === "string" && block.text !== "" ? block.text : undefined;
  }

  // The host Session exposes no `events` array (the public API is eventAt/seq/
  // snapshotEvents) — walk the durable log backwards via eventAt and return the
  // text of the newest catalog still visible on the session surface.
  function visibleCatalogText(agent) {
    const visible = new Set(agent?.session?.surface?.nodes ?? []);
    const session = agent?.session;
    if (typeof session?.seq !== "number" || typeof session?.eventAt !== "function") return undefined;
    for (let index = session.seq - 1; index >= 0; index -= 1) {
      const event = session.eventAt(sessionSeq(index));
      if (event?.type !== "user/message") continue;
      const text = catalogMessageText(event.data);
      if (text === undefined) continue;
      if (visible.has(event.seq)) return text;
    }
    return undefined;
  }

  function pendingCatalogText(messages) {
    if (!Array.isArray(messages)) return undefined;
    for (const message of messages) {
      const text = catalogMessageText(message);
      if (text !== undefined) return text;
    }
    return undefined;
  }

  function renderCatalog(entries) {
    const lines = [];
    for (const entry of entries) {
      let line = `- \`${entry.name}\` (${entry.tier}): ${entry.description !== "" ? entry.description : "(no description)"}`;
      if (entry.tier === "on-demand" && entry.notes) line += ` (notes: ${entry.notes})`;
      lines.push(line);
      for (const tool of entry.tools) {
        lines.push(`  - ${tool.name}${tool.description ? `: ${tool.description}` : ""}`);
      }
    }
    const text = [
      "<system-reminder>",
      "The following MCP servers are available in this session:",
      "",
      "<mcp_catalog>",
      ...lines,
      "</mcp_catalog>",
      "",
      "用法：mcp_load / mcp_register / mcp_call 是能力库自带的管理工具，直接调用即可——它们不是某个 MCP 服务器的工具，切勿经 mcp_call 通道去转调它们。eager 服务器直接调 mcp__<server>__<tool>。on-demand 服务器先 mcp_load 拿工具名/参数，再 mcp_call {name, tool, args} 调用；未 mcp_load 直接 mcp_call 会报错。带 tools 的条目说明已有缓存；无 tools 的需先 mcp_load。disabled 服务器和工具均已隐藏。",
      "</system-reminder>",
    ].join("\n");
    return createUserMessage({
      content: [{ type: "text", text }],
      // The source stays minimal: SourceFields displays every source field, so
      // carrying entries there would render the same information twice, and a
      // digest member would be refused by the migration audit.
      source: { ...CATALOG_SOURCE },
    });
  }

  // ── effect-scoped registration (synchronous, before any await) ──
  const toolDisposers = [
    ctx.tools.register(mcpRegister),
    ctx.tools.register(mcpLoad),
    ctx.tools.register(mcpCall),
  ];
  // /prepare-uninstall command (optional: only when ctx.commands is composed).
  const commands = ctx.get("commands");
  const commandDisposer = commands !== undefined
    ? commands.register({
        name: "prepare-uninstall",
        description: "Hand managed MCP entries back to the native dsh-mcp-client before uninstalling this plugin",
        handler: () => prepareUninstall(),
      })
    : () => {};
  ctx.effect(() => {
    return async () => {
      commandDisposer();
      for (const dispose of toolDisposers) dispose();
      for (const session of [...liveSessions]) {
        liveSessions.delete(session);
        await disposeSession(session);
      }
    };
  });

  // ── skill provider (M1) ──
  registerRecursiveSkillProvider(ctx, dataDir);

  // ── startup ──
  registry = await loadRegistry(dataDir);
  // Per-conversation capability policy. Small local file, read once here so the
  // first pre-step of a resumed conversation already honours it.
  sessionCaps = await loadSessionCaps();
  await loadSkillGroups();
  workspaceDefaults = await loadWorkspaceDefaults();
  capOrder = await loadCapOrder();
  try {
    const settings = await loadSettings(dataDir);
    if (typeof settings.toolDescriptionMaxLength === "number" && settings.toolDescriptionMaxLength > 0) {
      toolDescriptionMaxLength = settings.toolDescriptionMaxLength;
    }
    if (LOCAL_COMMAND_APPROVALS.has(settings.localCommandApproval)) {
      localCommandApproval = settings.localCommandApproval;
    }
    if (Array.isArray(settings.lanHostAllowlist)) {
      try {
        lanHostAllowlist = normalizeLanHostAllowlist(settings.lanHostAllowlist);
      } catch {
        /* a corrupt allowlist must not block startup; the default is empty */
      }
    }
    if (settings.stdioMaxBufferSizeMb !== undefined) {
      // A corrupt value falls back to the SDK default via the same normalizer
      // the settings route uses.
      applyStdioMaxBufferSizeSetting(settings.stdioMaxBufferSizeMb);
    }
  } catch {
    /* settings.json unreadable — keep the config default */
  }
  const imported = await reconcile();
  await warmSnapshots();
  ctx.logger.info(`skill-mcp-manager: ready (${registry.entries.length} MCP entries, imported ${imported}, dataDir=${dataDir})`);
}

export { Config, apply, inject, name, PLUGIN_VERSION };
