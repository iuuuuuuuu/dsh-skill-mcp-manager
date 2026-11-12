// Workspace-provided MCP servers.
//
// The host has no notion of a workspace-scoped MCP server: configuration comes from
// profile patches and plugin bundles only. So the convention lives here — a project
// can ship its own servers next to the code, and they stay workspace-local: nothing
// is written into the user's registry or profile patch.
//
// Supported files, first found wins per server name:
//   <workspace>/.dsh/mcp.json
//   <workspace>/.mcp.json          (the Claude Code / Cursor convention)
//   <workspace>/.agents/mcp.json
// Two shapes are accepted in each:
//   { "servers": [ { name, transport, command, args, env } ] }   full control
//   { "mcpServers": { name: { command, args, env } | { url, headers } } }  the common map

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Files a workspace may use to declare MCP servers, in precedence order. */
export const WORKSPACE_MCP_FILES = [".dsh/mcp.json", ".mcp.json", ".agents/mcp.json"];

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function stringMap(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
  }
  return out;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

/**
 * Normalize one declared server into the shape the runtime connects with.
 * @param {string} name - server name (the model-facing namespace).
 * @param {object} raw - the declared object.
 * @returns {{entry: object}|{error: string}} the entry, or why it was refused.
 */
export function normalizeWorkspaceServer(name, raw) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { error: `server name "${String(name)}" must match [A-Za-z0-9_-]{1,32}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `server "${name}" must be an object` };
  }
  const command = typeof raw.command === "string" && raw.command !== "" ? raw.command : null;
  const url = typeof raw.url === "string" && raw.url !== "" ? raw.url : null;
  const declaredTransport = typeof raw.transport === "string" && raw.transport !== "" ? raw.transport : null;
  if (declaredTransport !== null && declaredTransport !== "stdio" && declaredTransport !== "streamable-http") {
    return { error: `server "${name}" has unsupported transport "${declaredTransport}"` };
  }
  // Say the specific thing when a transport was declared, and the general thing when
  // the transport has to be inferred from whichever address was given.
  if (declaredTransport === "stdio") {
    if (command === null) return { error: `server "${name}" is stdio but has no command` };
  } else if (declaredTransport === "streamable-http") {
    if (url === null) return { error: `server "${name}" is streamable-http but has no url` };
  } else if (command === null && url === null) {
    return { error: `server "${name}" needs either "command" or "url"` };
  }
  if (command !== null && url !== null) {
    return { error: `server "${name}" declares both "command" and "url"` };
  }
  const transport = declaredTransport ?? (command !== null ? "stdio" : "streamable-http");
  // A workspace server is always on-demand: it must never register host-native tools
  // behind the user's back, and the per-conversation switch stays the only way in.
  return {
    entry: {
      name,
      tier: "on-demand",
      transport,
      ...(command === null ? {} : { command, args: stringList(raw.args), env: stringMap(raw.env) }),
      ...(url === null ? {} : { url, headers: stringMap(raw.headers) }),
      ...(typeof raw.cwd === "string" && raw.cwd !== "" ? { cwd: raw.cwd } : {}),
      notes: typeof raw.notes === "string" ? raw.notes : "",
      tools: [],
      disabledTools: [],
    },
  };
}

/**
 * Parse one mcp.json document into entries.
 * @param {unknown} json - parsed document.
 * @returns {{servers: object[], errors: string[]}} accepted servers and refused ones.
 */
export function parseWorkspaceMcpDocument(json) {
  const servers = [];
  const errors = [];
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { servers, errors: ["the document must be a JSON object"] };
  }
  const list = Array.isArray(json.servers) ? json.servers : null;
  if (list !== null) {
    for (const item of list) {
      if (item === null || typeof item !== "object") { errors.push("a \"servers\" item is not an object"); continue; }
      const name = typeof item.name === "string" ? item.name : undefined;
      const result = normalizeWorkspaceServer(name, item);
      if (result.entry === undefined) errors.push(result.error);
      else servers.push(result.entry);
    }
  }
  const map = json.mcpServers !== null && typeof json.mcpServers === "object" && !Array.isArray(json.mcpServers) ? json.mcpServers : null;
  if (map !== null) {
    for (const [name, item] of Object.entries(map)) {
      const result = normalizeWorkspaceServer(name, item);
      if (result.entry === undefined) errors.push(result.error);
      else servers.push(result.entry);
    }
  }
  if (list === null && map === null) {
    return { servers, errors: ["the document declares neither \"servers\" nor \"mcpServers\""] };
  }
  // First declaration of a name wins, so a more specific file can shadow a generic one.
  const seen = new Set();
  const unique = [];
  for (const server of servers) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    unique.push(server);
  }
  return { servers: unique, errors };
}

/**
 * Read every workspace MCP document under one root.
 * @param {string} workspace - absolute workspace path.
 * @returns {Promise<{servers: object[], files: string[], errors: string[]}>} what the workspace declares.
 */
export async function readWorkspaceMcp(workspace) {
  const servers = [];
  const files = [];
  const errors = [];
  if (typeof workspace !== "string" || workspace === "") return { servers, files, errors };
  const seen = new Set();
  for (const relative of WORKSPACE_MCP_FILES) {
    const file = join(workspace, relative);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // a workspace without MCP files is the normal case
    }
    files.push(relative);
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      errors.push(`${relative}: ${String(error?.message ?? error)}`);
      continue;
    }
    const parsed = parseWorkspaceMcpDocument(json);
    for (const message of parsed.errors) errors.push(`${relative}: ${message}`);
    for (const server of parsed.servers) {
      if (seen.has(server.name)) {
        errors.push(`${relative}: "${server.name}" is already declared by a more specific file`);
        continue;
      }
      seen.add(server.name);
      servers.push({ ...server, file: relative });
    }
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, files, errors };
}