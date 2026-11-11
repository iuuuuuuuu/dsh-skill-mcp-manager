// Skill groups: the host decides which plugin (or 系统) a skill belongs to, the
// card grid folds plugin groups by default, and one master switch writes the
// same frontmatter flag to every writable skill of that plugin. Covers the
// classification (provider is the authority, path only names the package), the
// group toggle writing real files, and the shipped/read-only skills that must be
// reported instead of written.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const tmp = join(process.cwd(), `.test-skill-group-${process.pid}`);
const dataDir = join(tmp, "data");
const root = join(tmp, "skills");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

const skillFile = (dir, name, extra = "") => `---\nname: ${name}\ndescription: ${name} fixture\n${extra}---\n\n# ${name}\n`;
const files = {
  "user-own": join(root, "user-own", "SKILL.md"),
  "plugin-one": join(root, "plugin-one", "SKILL.md"),
  "plugin-two": join(root, "plugin-two", "SKILL.md"),
  // a link:-installed plugin layout: package root + skills/<name>/SKILL.md, so
  // the group can be labelled with the package that owns it
  "linked": join(tmp, "linked-plugin", "skills", "linked", "SKILL.md"),
  // a shipped skill: its path contains node_modules, so it is read-only and must
  // never be written by the group switch
  "shipped": join(tmp, "node_modules", "@scope", "pkg", "skills", "shipped", "SKILL.md"),
};
for (const [name, path] of Object.entries(files)) {
  if (name === "shipped") continue; // deliberately not created: it must not be read
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, skillFile(path, name), "utf8");
}
await writeFile(join(tmp, "linked-plugin", "package.json"), JSON.stringify({ name: "@fixture/linked-plugin", version: "1.0.0" }), "utf8");

const definitions = {
  "user-own": { name: "user-own", description: "user fixture", path: files["user-own"], source: "user-dsh", provider: "filesystem" },
  "plugin-one": { name: "plugin-one", description: "plugin fixture", path: files["plugin-one"], source: "custom", provider: "agent-notes" },
  "plugin-two": { name: "plugin-two", description: "plugin fixture", path: files["plugin-two"], source: "custom", provider: "agent-notes" },
  "shipped": { name: "shipped", description: "shipped fixture", path: files.shipped, source: "custom", provider: "dsh-badge" },
  "linked": { name: "linked", description: "linked plugin fixture", path: files.linked, source: "custom", provider: "linked-server" },
};
for (const d of Object.values(definitions)) d.invocation = { modelInvocable: true, userInvocable: true };

const routes = [];
const effects = [];
const ctx = {
  tools: { register() { return () => {}; } },
  skills: {
    registerProvider() { return () => {}; },
    async list() { return Object.keys(definitions).map((name) => ({ name, description: definitions[name].description })); },
    async get(name) { return definitions[name]; },
  },
  on() { return () => {}; },
  effect(fn) { const d = fn(); if (typeof d === "function") effects.push(d); return () => {}; },
  get(name) {
    if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 50));

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method, url,
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

const listRoute = routeByPath("/skill-mcp-manager/skills");
const groupRoute = routeByPath("/skill-mcp-manager/skills/toggle-group");
if (groupRoute === undefined) failed.push("missing route /skill-mcp-manager/skills/toggle-group");

// 1) classification: provider decides the group, path only names the package
{
  const res = makeRes();
  await listRoute.handler(makeReq("GET", "/skill-mcp-manager/skills"), res);
  const skills = bodyOf(res).skills ?? [];
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  console.log("origins:", skills.map((s) => `${s.name}=${s.origin?.kind}/${s.origin?.key}`).join(", "));
  if (byName["user-own"]?.origin?.kind !== "system") failed.push("filesystem provider must group as 系统");
  if (byName["plugin-one"]?.origin?.kind !== "plugin") failed.push("a named provider must group as 插件");
  if (byName["plugin-one"]?.origin?.key !== "agent-notes") failed.push("plugin group key must be the provider name");
  if (byName["plugin-one"]?.origin?.package !== null) failed.push("a path outside node_modules has no package name");
  if (byName["linked"]?.origin?.package !== "@fixture/linked-plugin") failed.push("a link:-installed plugin must be named from its package.json, got " + String(byName["linked"]?.origin?.package));
  if (byName["shipped"]?.origin?.package !== "@scope/pkg") failed.push("package name must be read from the node_modules path, got " + String(byName["shipped"]?.origin?.package));
  if (byName["shipped"]?.readonly !== true) failed.push("a node_modules skill must stay read-only");
  if (byName["plugin-one"]?.origin?.runtime === true) failed.push("a plain path must not be flagged as runtime-generated");
}

// 2) the master switch writes every writable skill of that plugin
{
  const res = makeRes();
  await groupRoute.handler(makeReq("POST", "/skill-mcp-manager/skills/toggle-group", { provider: "agent-notes", enabled: false }), res);
  const body = bodyOf(res);
  console.log("disable group ->", res.status, JSON.stringify(body));
  if (res.status !== 200 || body.ok !== true) failed.push("group disable did not answer 200 {ok:true}");
  if ((body.updated ?? []).length !== 2) failed.push(`group disable updated ${(body.updated ?? []).length} skills, expected 2`);
  for (const name of ["plugin-one", "plugin-two"]) {
    const text = await readFile(files[name], "utf8");
    if (!text.includes("disable-model-invocation: true")) failed.push(`${name} frontmatter was not disabled`);
  }
  const userText = await readFile(files["user-own"], "utf8");
  if (userText.includes("disable-model-invocation")) failed.push("the group switch wrote to a skill of another group");
}

// 3) switching the group back on removes the flag again
{
  const res = makeRes();
  await groupRoute.handler(makeReq("POST", "/skill-mcp-manager/skills/toggle-group", { provider: "agent-notes", enabled: true }), res);
  const body = bodyOf(res);
  console.log("enable group ->", res.status, JSON.stringify(body));
  if ((body.updated ?? []).length !== 2) failed.push("group enable updated the wrong number of skills");
  for (const name of ["plugin-one", "plugin-two"]) {
    const text = await readFile(files[name], "utf8");
    if (text.includes("disable-model-invocation")) failed.push(`${name} frontmatter still disabled after enabling`);
  }
}

// 4) shipped skills are reported, never written
{
  const res = makeRes();
  await groupRoute.handler(makeReq("POST", "/skill-mcp-manager/skills/toggle-group", { provider: "dsh-badge", enabled: false }), res);
  const body = bodyOf(res);
  console.log("readonly group ->", res.status, JSON.stringify(body));
  if ((body.updated ?? []).length !== 0) failed.push("a read-only group must not be written");
  if (!(body.skipped ?? []).includes("shipped")) failed.push("the read-only skill was not reported in skipped");
}

// 5) 系统 has no master switch, and an unknown provider is refused
{
  for (const provider of ["filesystem", "nobody"]) {
    const res = makeRes();
    await groupRoute.handler(makeReq("POST", "/skill-mcp-manager/skills/toggle-group", { provider, enabled: false }), res);
    const body = bodyOf(res);
    console.log(`${provider} group ->`, res.status, JSON.stringify(body));
    if (res.status !== 400 || body.ok !== false) failed.push(`provider "${provider}" should be refused with 400`);
  }
}

// 6) a deactivated plugin context must read as something a person can act on:
// the desktop shell can leave routes serving from a fiber that is no longer
// active, and cordis' raw "inactive context" error says nothing to a user.
{
  const liveSkills = {
    registerProvider() { return () => {}; },
    async list() { return [{ name: "late", description: "late fixture" }]; },
    async get() { return undefined; },
  };
  let active = true;
  const lateCtx = {
    tools: { register() { return () => {}; } },
    get skills() {
      if (!active) throw new Error('cannot get required service "skills" in inactive context');
      return liveSkills;
    },
    on() { return () => {}; },
    effect() { return () => {}; },
    get() { return undefined; },
    logger: { warn() {}, error() {}, info() {} },
  };
  const lateRoutes = [];
  lateCtx.get = (name) => (name === "webServer" ? { register(route) { lateRoutes.push(route); return () => {}; } } : undefined);
  const lateDir = join(tmp, "data-late");
  await mkdir(lateDir, { recursive: true });
  await apply(lateCtx, { dataDir: lateDir, profile: "__test__", importNativeMcp: false });
  active = false; // the fiber stops being active; the route is still mounted
  const res = makeRes();
  await lateRoutes.find((route) => route.path === "/skill-mcp-manager/skills").handler(makeReq("GET", "/skill-mcp-manager/skills"), res);
  const body = bodyOf(res);
  console.log("deactivated ctx ->", res.status, JSON.stringify(body));
  if (res.status !== 400) failed.push("a deactivated context must answer 400");
  if (!String(body.error ?? "").includes("重启 DSH")) failed.push("the inactive-context error must be translated into something actionable, got " + String(body.error));
  if (String(body.error ?? "").includes("inactive context")) failed.push("the raw cordis message must not leak to the page");
}

for (const disposer of effects) { try { await disposer(); } catch { /* best effort */ } }
await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("SKILL GROUP SMOKE FAILED");
  process.exit(1);
}
console.log("SKILL GROUP SMOKE PASSED");
