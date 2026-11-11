// Import skills that already live in another agent's directory tree into the
// DSH-owned skill root (~/.dsh/skills by default).
//
// The point is to COPY, never to link: the source belongs to another tool (its
// own lifecycle may rewrite or delete it), while an imported skill becomes a
// skill DSH itself owns — editable, toggleable and deletable from 能力库.
//
// This module is pure: it only knows directories and files. Duplicate-name
// decisions need the live skill registry, so they stay in lib/index.js.

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cp, mkdir, readdir } from "node:fs/promises";
import { readSkillFile } from "./skill.js";

// Directories belonging to other agents, in the order the import sheet lists
// them. `user` roots are per-machine, `project` roots are per workspace; both
// carry a <name>/SKILL.md bundle layout, which is what this plugin manages.
const SOURCE_KINDS = [
  { id: "agents", label: "本地 Agent · .agents", segment: ".agents" },
  { id: "claude", label: "Claude Code · .claude", segment: ".claude" },
  { id: "codex", label: "Codex · .codex", segment: ".codex" },
];

// Every place worth scanning. A missing directory is still returned (with
// `exists: false`) so the sheet can show "this agent has no skills" instead of
// silently hiding the source.
export function importSourceDirs({ home, cwd }) {
  const sources = [];
  for (const kind of SOURCE_KINDS) {
    sources.push({
      id: "user-" + kind.id,
      kind: "user",
      label: kind.label,
      dir: join(home, kind.segment, "skills"),
    });
  }
  if (typeof cwd === "string" && cwd !== "" && isAbsolute(cwd)) {
    for (const kind of SOURCE_KINDS) {
      sources.push({
        id: "project-" + kind.id,
        kind: "project",
        label: kind.label,
        dir: join(cwd, kind.segment, "skills"),
      });
    }
  }
  return sources;
}

// Walk one source root for <dir>/SKILL.md bundles at any depth, using the same
// frontmatter rules as the managed provider (a flat <name>.md is never a skill).
// Returns [] for a missing directory.
export async function skillsInDir(root) {
  const rootDir = resolve(root);
  const items = [];
  const parsedRoot = await describeSkillDir(rootDir, toKebabCase(basename(rootDir)), "");
  if (parsedRoot !== undefined) items.push(parsedRoot);

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childDir = join(dir, entry.name);
      const rel = relative(rootDir, childDir);
      const parsed = await describeSkillDir(childDir, toKebabCase(rel), rel);
      if (parsed !== undefined) items.push(parsed);
      await walk(childDir);
    }
  }
  await walk(rootDir);
  return items;
}

async function describeSkillDir(dir, fallbackName, rel) {
  const path = join(dir, "SKILL.md");
  const parsed = await readSkillFile(path, undefined, fallbackName);
  if (parsed === undefined) return undefined;
  return {
    name: parsed.name,
    description: parsed.description,
    dir,
    dirName: basename(dir),
    rel,
  };
}

// A skill directory that itself contains another skill directory would be
// copied twice (once as the parent, once as the child). Keep the outermost and
// report the rest as covered by it.
export function pruneNested(items) {
  const kept = [];
  const nested = [];
  const ordered = [...items].sort((left, right) => left.dir.length - right.dir.length);
  for (const item of ordered) {
    const parent = kept.find((candidate) => isInside(item.dir, candidate.dir));
    if (parent === undefined) kept.push(item);
    else nested.push({ ...item, parentDir: parent.dir });
  }
  return { kept, nested };
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Copy one bundle directory. Fails loudly when the target already exists so an
// import can never overwrite a skill the user owns.
export async function copySkillDir(srcDir, destDir) {
  await mkdir(dirname(destDir), { recursive: true });
  await cp(srcDir, destDir, { recursive: true, force: false, errorOnExist: true });
  return destDir;
}

function toKebabCase(relPath) {
  return String(relPath)
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((segment) => segment.length > 0)
    .join("-");
}

// The directory name decides where the copy lands inside the target root, so it
// must be a single path segment that the managed layout can carry.
export function isValidTargetName(name) {
  return typeof name === "string"
    && name.length > 0
    && name.length <= 64
    && !/[\\/:*?"<>|]/.test(name)
    && !name.startsWith(".")
    && name !== "..";
}
