// Route-level coverage for the two skill features that talk to the host:
// importing from other agents' directories (/skills/import) and the custom group
// store (/skill-groups). Both are driven through the real HTTP handlers with an
// isolated home/workspace/target, exactly like the page drives them.

import { mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const tmp = join(process.cwd(), `.test-skill-route-${process.pid}`);
await rm(tmp, { recursive: true, force: true });
const home = join(tmp, "home");
const workspace = join(tmp, "ws");
const dshSkills = join(tmp, "dsh-skills");
const dataDir = join(tmp, "data");
await mkdir(dataDir, { recursive: true });
const seedSkill = async (dir, name, description) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
};
await seedSkill(join(home, ".agents", "skills", "home-agent-skill"), "home-agent-skill", "from ~/.agents");
await seedSkill(join(home, ".claude", "skills", "home-claude-skill"), "home-claude-skill", "from ~/.claude");
await seedSkill(join(workspace, ".agents", "skills", "project-agent-skill"), "project-agent-skill", "from <ws>/.agents");

const routes = [];
const webServer = { register(route) { routes.push(route); return () => {}; } };
const effects = [];
const preSteps = [];
const ctx = {
  tools: { register() { return () => {}; } },
  skills: {
    registerProvider() { return () => {}; },
    async list() { return []; },
    async get() { return undefined; },
  },
  on(event, handler) {
    if (event === "agent/pre-step") preSteps.push(handler);
    return () => {};
  },
  effect(fn) { const d = fn(); if (typeof d === "function") effects.push(d); return () => {}; },
  // The real host hands webServer to the plugin through a lazy inject; only that
  // one is simulated here (the loader/layout seats are not part of these routes).
  inject(names, callback) {
    const list = Array.isArray(names) ? names : [names];
    if (list.includes("webServer")) callback(ctx);
    return () => {};
  },
  webServer,
  get(name) {
    if (name === "webServer") return webServer;
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };
const routeByPath = (path) => routes.find((route) => route.path === path.split("?")[0]);

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method, url,
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() { return { async next() { return i < chunks.length ? { value: chunks[i++], done: false } : { done: true }; } }; },
  };
}
function makeRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (chunk) => { res.body = chunk; };
  return res;
}
const bodyOf = (res) => (res.body ? JSON.parse(res.body) : {});
const call = async (method, path, body) => {
  const res = makeRes();
  await routeByPath(path).handler(makeReq(method, path, body), res);
  return { status: res.status, body: bodyOf(res) };
};

const config = { dataDir, profile: "__test__", importNativeMcp: false, importHomeDir: home, skillsDir: dshSkills };
await apply(ctx, config);
await new Promise((resolve) => setTimeout(resolve, 50));

// 1) the import scan sees the other agents' directories, per workspace
{
  const res = await call("GET", "/skill-mcp-manager/skills/import?cwd=" + encodeURIComponent(workspace));
  const sources = res.body.sources ?? [];
  const byId = new Map(sources.map((source) => [source.id, source]));
  console.log("sources:", sources.map((s) => s.id + ":" + (s.skills ?? []).length).join(", "));
  check(res.status === 200, "the scan must answer 200");
  check(res.body.target === dshSkills, "the copy target must be the configured skill root, got " + String(res.body.target));
  const homeAgents = byId.get("user-agents");
  check(homeAgents !== undefined && (homeAgents.skills ?? []).some((s) => s.name === "home-agent-skill"), "~/.agents/skills must be scanned");
  const homeClaude = byId.get("user-claude");
  check(homeClaude !== undefined && (homeClaude.skills ?? []).some((s) => s.name === "home-claude-skill"), "~/.claude/skills must be scanned");
  const project = byId.get("project-agents");
  check(project !== undefined && (project.skills ?? []).some((s) => s.name === "project-agent-skill"), "the workspace's .agents/skills must be scanned");
  const offered = (project?.skills ?? []).find((s) => s.name === "project-agent-skill");
  check(offered !== undefined && offered.blocked !== true, "a fresh skill must not be blocked");

  // 2) the copy happens, and only for a directory the scan offered
  const imported = await call("POST", "/skill-mcp-manager/skills/import", { items: [offered.dir], cwd: workspace });
  console.log("import ->", imported.status, JSON.stringify(imported.body.imported?.map((i) => i.name)));
  check(imported.status === 200, "the import must answer 200, got " + imported.status + " " + JSON.stringify(imported.body));
  check((imported.body.imported ?? []).length === 1, "exactly one skill must be imported");
  const copied = await stat(join(dshSkills, "project-agent-skill", "SKILL.md")).catch(() => undefined);
  check(copied !== undefined && copied.isFile(), "the skill must land in the configured root");
  const raw = await readFile(join(dshSkills, "project-agent-skill", "SKILL.md"), "utf8");
  check(raw.includes("from <ws>/.agents"), "the copied SKILL.md must keep its content");

  const refused = await call("POST", "/skill-mcp-manager/skills/import", { items: [join(tmp, "random-dir")], cwd: workspace });
  console.log("refuse arbitrary path ->", refused.status, JSON.stringify(refused.body).slice(0, 120));
  check(refused.status === 400, "a path the scan never offered must be refused, got " + refused.status);
  check(/not a skill directory offered/.test(String(refused.body.error ?? "")), "the refusal must say why, got " + String(refused.body.error));
}

// 3) custom groups: create / assign / move / delete, all persisted
{
  const empty = await call("GET", "/skill-mcp-manager/skill-groups");
  check(empty.status === 200 && (empty.body.groups ?? []).length === 0, "the store starts empty");

  const created = await call("POST", "/skill-mcp-manager/skill-groups", { action: "create", name: "前端" });
  console.log("create ->", created.status, JSON.stringify(created.body.groups));
  check(created.status === 200, "create must answer 200, got " + created.status + " " + JSON.stringify(created.body));
  check((created.body.groups ?? []).length === 1, "one group expected");
  const groupId = created.body.groups?.[0]?.id;
  check(typeof groupId === "string" && groupId !== "", "the created group must carry an id");

  const assigned = await call("POST", "/skill-mcp-manager/skill-groups", { action: "assign", skill: "project-agent-skill", group: groupId });
  console.log("assign ->", assigned.status, JSON.stringify(assigned.body.members));
  check(assigned.body.members?.["project-agent-skill"] === groupId, "the assignment must be recorded");

  const second = await call("POST", "/skill-mcp-manager/skill-groups", { action: "create", name: "后端" });
  const moved = await call("POST", "/skill-mcp-manager/skill-groups", { action: "move", id: second.body.groups?.[1]?.id, direction: -1 });
  console.log("move ->", moved.status, JSON.stringify(moved.body.groups?.map((g) => g.name)));
  check(moved.body.groups?.[0]?.name === "后端", "moving up must reorder the groups");

  const file = JSON.parse(await readFile(join(dataDir, "skill-groups.json"), "utf8"));
  check((file.groups ?? []).length === 2, "the store must be on disk");
  check(file.members?.["project-agent-skill"] === groupId, "the membership must be on disk");

  const bad = await call("POST", "/skill-mcp-manager/skill-groups", { action: "nope" });
  check(bad.status === 400, "an unknown action must be refused, got " + bad.status);

  const deleted = await call("POST", "/skill-mcp-manager/skill-groups", { action: "delete", id: groupId });
  console.log("delete ->", deleted.status, JSON.stringify(deleted.body));
  check((deleted.body.groups ?? []).length === 1, "the group must be gone");
  check(deleted.body.members?.["project-agent-skill"] === undefined, "its member must become ungrouped");

  // 4) a fresh apply() reads the file back
  const routes2 = [];
  const webServer2 = { register(route) { routes2.push(route); return () => {}; } };
  const ctx2 = {
    ...ctx,
    webServer: webServer2,
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names];
      if (list.includes("webServer")) callback(ctx2);
      return () => {};
    },
    get(name) {
      if (name === "webServer") return webServer2;
      return undefined;
    },
  };
  await apply(ctx2, config);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const res = makeRes();
  await routes2.find((route) => route.path === "/skill-mcp-manager/skill-groups").handler(makeReq("GET", "/skill-mcp-manager/skill-groups"), res);
  const reloaded = bodyOf(res);
  console.log("reloaded:", JSON.stringify(reloaded.groups?.map((g) => g.name)));
  check((reloaded.groups ?? []).length === 1, "groups must survive a restart, got " + JSON.stringify(reloaded.groups));
  check(reloaded.groups?.[0]?.name === "后端", "the surviving group keeps its name");
}

for (const disposer of effects) { try { await disposer(); } catch { /* best effort */ } }
await rm(tmp, { recursive: true, force: true });
if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("SKILL ROUTE SMOKE FAILED");
  process.exit(1);
}
console.log("SKILL ROUTE SMOKE PASSED");
