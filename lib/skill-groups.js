// User-defined skill groups (④B): a persistent, ordered grouping the user controls,
// independent of the origin (系统 / 插件) bucketing the page also shows.
//
// Kept as plain functions over a small state object so every rule (unique names,
// ordering, what happens to members when a group is deleted) is testable without
// a host or a browser. The host only owns the file.

/** Maximum group name length, in characters after trimming. */
export const GROUP_NAME_MAX = 40;

/** @returns {{groups: {id: string, name: string, order: number}[], members: Record<string, string>}} an empty store. */
export function emptyGroups() {
  return { groups: [], members: {} };
}

/**
 * Coerce loose JSON into the store shape, dropping anything unrecognisable.
 * @param {unknown} raw - parsed file contents (or anything else).
 * @returns {{groups: object[], members: Record<string, string>}} a valid store.
 */
export function normalizeGroups(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return emptyGroups();
  const groups = [];
  const ids = new Set();
  const list = Array.isArray(raw.groups) ? raw.groups : [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const id = typeof item.id === "string" && item.id !== "" ? item.id : undefined;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (id === undefined || name === "" || ids.has(id)) continue;
    ids.add(id);
    groups.push({ id, name: name.slice(0, GROUP_NAME_MAX), order: Number.isFinite(item.order) ? item.order : groups.length });
  }
  groups.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  groups.forEach((group, index) => { group.order = index; });
  const members = {};
  const known = new Set(groups.map((group) => group.id));
  const rawMembers = raw.members !== null && typeof raw.members === "object" && !Array.isArray(raw.members) ? raw.members : {};
  for (const [skill, groupId] of Object.entries(rawMembers)) {
    if (typeof skill !== "string" || skill === "") continue;
    if (typeof groupId !== "string" || !known.has(groupId)) continue;
    members[skill] = groupId;
  }
  return { groups, members };
}

function validateName(state, name, exceptId) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed === "") throw new Error("分组名不能为空");
  if (trimmed.length > GROUP_NAME_MAX) throw new Error(`分组名最多 ${GROUP_NAME_MAX} 个字符`);
  const clash = state.groups.some((group) => group.id !== exceptId && group.name.toLowerCase() === trimmed.toLowerCase());
  if (clash) throw new Error(`分组 "${trimmed}" 已存在`);
  return trimmed;
}

function nextId(state) {
  let max = 0;
  for (const group of state.groups) {
    const match = /^g(\d+)$/.exec(group.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return `g${max + 1}`;
}

/**
 * Add a group at the end of the order.
 * @param {object} state - current store.
 * @param {string} name - display name.
 * @returns {{state: object, group: {id: string, name: string, order: number}}} the new store and the created group.
 */
export function createGroup(state, name) {
  const current = normalizeGroups(state);
  const clean = validateName(current, name);
  const group = { id: nextId(current), name: clean, order: current.groups.length };
  current.groups.push(group);
  return { state: current, group };
}

/**
 * Rename one group.
 * @param {object} state - current store.
 * @param {string} id - group id.
 * @param {string} name - new display name.
 * @returns {object} the new store.
 */
export function renameGroup(state, id, name) {
  const current = normalizeGroups(state);
  const group = current.groups.find((item) => item.id === id);
  if (group === undefined) throw new Error(`分组 "${String(id)}" 不存在`);
  group.name = validateName(current, name, id);
  return current;
}

/**
 * Delete one group; its members become ungrouped (a skill is never deleted here).
 * @param {object} state - current store.
 * @param {string} id - group id.
 * @returns {object} the new store.
 */
export function deleteGroup(state, id) {
  const current = normalizeGroups(state);
  if (!current.groups.some((group) => group.id === id)) throw new Error(`分组 "${String(id)}" 不存在`);
  current.groups = current.groups.filter((group) => group.id !== id);
  current.groups.forEach((group, index) => { group.order = index; });
  for (const [skill, groupId] of Object.entries(current.members)) {
    if (groupId === id) delete current.members[skill];
  }
  return current;
}

/**
 * Put a skill in a group, or remove it from every group when `groupId` is null.
 * @param {object} state - current store.
 * @param {string} skill - skill name.
 * @param {string|null} groupId - target group, or null for ungrouped.
 * @returns {object} the new store.
 */
export function assignSkill(state, skill, groupId) {
  const current = normalizeGroups(state);
  if (typeof skill !== "string" || skill === "") throw new Error("skill is required");
  if (groupId === null || groupId === undefined || groupId === "") {
    delete current.members[skill];
    return current;
  }
  if (!current.groups.some((group) => group.id === groupId)) throw new Error(`分组 "${String(groupId)}" 不存在`);
  current.members[skill] = groupId;
  return current;
}

/**
 * Move one group one slot up or down.
 * @param {object} state - current store.
 * @param {string} id - group id.
 * @param {-1|1} direction - negative moves toward the front.
 * @returns {object} the new store.
 */
export function moveGroup(state, id, direction) {
  const current = normalizeGroups(state);
  const index = current.groups.findIndex((group) => group.id === id);
  if (index === -1) throw new Error(`分组 "${String(id)}" 不存在`);
  const target = index + (direction < 0 ? -1 : 1);
  if (target < 0 || target >= current.groups.length) return current;
  const [group] = current.groups.splice(index, 1);
  current.groups.splice(target, 0, group);
  current.groups.forEach((item, at) => { item.order = at; });
  return current;
}
