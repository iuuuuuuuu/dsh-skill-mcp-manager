// Import-from-another-agent smoke test.
//
// Drives the real HTTP routes against a mock skills service with a throwaway
// directory tree: ~/.agents, ~/.claude, ~/.codex (global) plus a workspace's own
// .agents/.claude roots. Verifies the review sheet (source list, duplicate and
// already-imported conflicts, nested-directory pruning), the copy itself, the
// cache invalidation that makes a copy visible at once, and the refusal to copy
// anything the scan did not offer.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { apply } from "../lib/index.js";

const root = await mkdtemp(join(tmpdir(), "smx-import-"));
const home = join(root, "home");
const project = join(root, "project");
const skillRoot = join(root, "dsh", "skills");
const dataDir = join(root, "data");

async function makeSkill(dir, name, description, body = "Use it well.") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---
name: ${name}
description: ${description}
---

${body}
`, "utf8");
  return dir;
}

// Global sources: alpha duplicates a skill DSH already serves from .agents,
// beta is new, gamma sits in a subdirectory and holds another skill of its own.
const agentsAlpha = await makeSkill(join(home, ".agents", "skills", "alpha"), "alpha", "Local agent skill");
const claudeBeta = await makeSkill(join(home, ".claude", "skills", "beta"), "beta", "Claude skill", "Beta body.");
const codexGamma = await makeSkill(join(home, ".codex", "skills", "gamma"), "gamma", "Codex skill");
const codexNested = await makeSkill(join(home, ".codex", "skills", "gamma", "inner"), "gamma-inner", "Nested skill");
await writeFile(join(claudeBeta, "notes.md"), "resource file\n", "utf8");
// Not a skill: a flat markdown file is never imported.
await writeFile(join(home, ".claude", "skills", "loose.md"), "---\nname: loose\n---\n", "utf8");

// Project source, only visible with that workspace's cwd.
const projectDelta = await makeSkill(join(project, ".agents", "skills", "delta"), "delta", "Project skill");

const VISIBLE = {
  alpha: {
    name: "alpha",
    description: "Local agent skill",
    path: join(agentsAlpha, "SKILL.md"),
    source: "user-agents",
    provider: "filesystem",
    invocation: { modelInvocable: true, userInvocable: true },
  },
};

let listedWith = null;
let invalidations = 0;
const routes = [];
const commands = [];
const PRESET_SCOPE = { kind: "preset-standing" };

const ctx = {
  tools: { register() { return () => {}; } },
  skills: {
    registerProvider() { return () => {}; },
    async list(options = {}) {
      listedWith = options;
      // The mock service mimics the filesystem provider: the project root only
      // contributes when the lookup carries a cwd.
      const names = Object.keys(VISIBLE);
      if (options.cwd !== undefined) names.push("delta");
      return names.map((name) => ({ name, description: "", invocation: { modelInvocable: true, userInvocable: true } }));
    },
    async get(name, options = {}) {
      if (name === "delta" && options.cwd !== undefined) {
        return { ...VISIBLE.alpha, name: "delta", path: join(projectDelta, "SKILL.md"), source: "project-agents" };
      }
      return VISIBLE[name];
    },
    invalidateCache() { invalidations += 1; },
  },
  on() { return () => {}; },
  effect(fn) { fn(); return () => {}; },
  get(name) {
    if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
    if (name === "commands") return { register(definition) { commands.push(definition); return () => {}; } };
    if (name === "agentPresets") return { standingKeyFor: async () => PRESET_SCOPE };
    if (name === "workspaceRegistry") {
      return { list: () => [{ id: "ws-1", title: "默认工作区", path: project }] };
    }
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

await apply(ctx, {
  dataDir,
  profile: "__test__",
  importNativeMcp: false,
  skillsDir: skillRoot,
  importHomeDir: home,
});
await new Promise((resolve) => setTimeout(resolve, 100));

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method,
    url,
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
const check = (condition, message) => { if (!condition) failed.push(message); };

// ── review sheet ───────────────────────────────────────────────────────────
const importRoute = routeByPath("/skill-mcp-manager/skills/import");
check(importRoute !== undefined, "import route must be registered");
const scanRes = makeRes();
await importRoute.handler(makeReq("GET", "/skill-mcp-manager/skills/import?cwd=" + encodeURIComponent(project)), scanRes);
const scan = bodyOf(scanRes);
check(scanRes.status === 200, "import scan status != 200");
check(scan.target === skillRoot, "scan must report the import target, got " + scan.target);
check(scan.cwd === project, "scan must echo the workspace, got " + scan.cwd);
check(scan.warning === "", "a healthy skill service must not warn, got " + scan.warning);

const sourceOf = (id) => (scan.sources || []).find((source) => source.id === id);
const itemOf = (sourceId, name) => {
  const source = sourceOf(sourceId);
  return source === undefined ? undefined : source.skills.find((item) => item.name === name);
};

check((scan.sources || []).length === 6, "six sources expected (3 user + 3 project), got " + (scan.sources || []).length);
check(sourceOf("user-agents") !== undefined, "the .agents source must be listed");
check(sourceOf("project-claude") !== undefined, "the project .claude source must be listed with a cwd");

const alpha = itemOf("user-agents", "alpha");
check(alpha !== undefined, "alpha must be reviewed");
check(alpha && alpha.conflict !== null && alpha.conflict.includes("DSH 已有同名技能"), "alpha is already served by DSH and must be flagged, got " + JSON.stringify(alpha && alpha.conflict));
check(alpha && alpha.blocked === false, "a same-name skill outside the target root is importable, only warned about");
const beta = itemOf("user-claude", "beta");
check(beta !== undefined, "beta must be reviewed");
check(beta && beta.conflict === null, "beta must be importable, got " + JSON.stringify(beta && beta.conflict));
const gamma = itemOf("user-codex", "gamma");
check(gamma !== undefined && gamma.conflict === null, "gamma must be importable");
const inner = itemOf("user-codex", "gamma-inner");
check(inner !== undefined, "the nested skill must still be listed");
check(inner && inner.conflict !== null && inner.conflict.includes("已包含在"), "the nested skill must be refused as covered by its parent, got " + JSON.stringify(inner && inner.conflict));
check(inner && inner.blocked === true, "the nested skill must be blocked, not merely warned about");
const loose = (sourceOf("user-claude")?.skills || []).find((item) => item.name === "loose");
check(loose === undefined, "a flat markdown file must never be offered as a skill");
const delta = itemOf("project-agents", "delta");
check(delta !== undefined, "the project source must offer delta");
check(delta && delta.blocked === false, "delta must be importable");
check(delta && delta.conflict !== null && delta.conflict.includes("DSH 已有同名技能"), "a project skill is already visible through its workspace and must be flagged, got " + JSON.stringify(delta && delta.conflict));
check(listedWith !== null && listedWith.cwd === project, "the list must be looked up with the workspace cwd, got " + JSON.stringify(listedWith));

// ── copy ───────────────────────────────────────────────────────────────────
const importRes = makeRes();
await importRoute.handler(makeReq("POST", "/skill-mcp-manager/skills/import", {
  cwd: project,
  items: [beta.dir, delta.dir, alpha.dir],
}), importRes);
const imported = bodyOf(importRes);
check(importRes.status === 200, "import status != 200: " + importRes.body);
check(imported.imported.length === 3, "three skills must be copied, got " + JSON.stringify(imported.imported));
check(imported.skipped.length === 0, "nothing must be skipped here, got " + JSON.stringify(imported.skipped));
check((await readFile(join(skillRoot, "alpha", "SKILL.md"), "utf8")).includes("name: alpha"), "an explicitly chosen same-name skill must still be copied");
check(invalidations === 1, "a successful import must invalidate the skill cache once, got " + invalidations);
const copiedBeta = await readFile(join(skillRoot, "beta", "SKILL.md"), "utf8");
check(copiedBeta.includes("name: beta"), "beta must be copied");
check((await readFile(join(skillRoot, "beta", "notes.md"), "utf8")).includes("resource file"), "the whole bundle must be copied, resources included");
check((await readFile(join(skillRoot, "delta", "SKILL.md"), "utf8")).includes("name: delta"), "delta must be copied");

// ── second pass: everything is now either imported or refused ──────────────
const rescanRes = makeRes();
await importRoute.handler(makeReq("GET", "/skill-mcp-manager/skills/import?cwd=" + encodeURIComponent(project)), rescanRes);
const rescan = bodyOf(rescanRes);
const rescannedAlpha = (rescan.sources || []).find((source) => source.id === "user-agents").skills.find((item) => item.name === "alpha");
check(rescannedAlpha && rescannedAlpha.blocked === true && rescannedAlpha.conflict.includes("已导入"), "an imported skill must be reported as 已导入 next time, got " + JSON.stringify(rescannedAlpha));
const secondRes = makeRes();
await importRoute.handler(makeReq("POST", "/skill-mcp-manager/skills/import", { cwd: project, items: [beta.dir] }), secondRes);
const second = bodyOf(secondRes);
check(second.imported.length === 0, "a repeated import must copy nothing, got " + JSON.stringify(second.imported));
check(second.skipped.length === 1 && second.skipped[0].reason.includes("已导入"), "a repeated import must report 已导入, got " + JSON.stringify(second.skipped));

// ── refusals ───────────────────────────────────────────────────────────────
const strayRes = makeRes();
await importRoute.handler(makeReq("POST", "/skill-mcp-manager/skills/import", { cwd: project, items: [root] }), strayRes);
check(strayRes.status === 400, "a path the scan never offered must be refused, got " + strayRes.status);
const emptyRes = makeRes();
await importRoute.handler(makeReq("POST", "/skill-mcp-manager/skills/import", { cwd: project, items: [] }), emptyRes);
check(emptyRes.status === 400, "an empty item list must be refused");

// ── workspaces ride on the skill list ──────────────────────────────────────
const listRes = makeRes();
await routeByPath("/skill-mcp-manager/skills").handler(makeReq("GET", "/skill-mcp-manager/skills?cwd=" + encodeURIComponent(project)), listRes);
const listed = bodyOf(listRes);
check(listed.workspaces.length === 1 && listed.workspaces[0].path === project, "the skill list must carry the workspaces, got " + JSON.stringify(listed.workspaces));
check(listed.cwd === project, "the skill list must echo the workspace");
check(listed.skills.some((skill) => skill.name === "delta" && skill.scope === "project-agents"), "a project skill must be listed with its scope badge, got " + JSON.stringify(listed.skills.map((s) => s.name + ":" + s.scope)));

console.log("import target:", scan.target);
console.log("sources:", (scan.sources || []).map((source) => source.id + "=" + source.skills.length).join(", "));
console.log("imported:", imported.imported.map((item) => item.name + " -> " + item.target).join(", "));

await rm(root, { recursive: true, force: true });
await rm(dataDir, { recursive: true, force: true });

if (failed.length > 0) {
  for (const message of failed) console.log("FAIL: " + message);
  console.log("SKILL IMPORT SMOKE FAILED");
  process.exit(1);
}
console.log("SKILL IMPORT SMOKE PASSED");
