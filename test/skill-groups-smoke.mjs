// User-defined skill groups: naming rules, ordering, membership and what
// survives a round-trip through the JSON file.

import {
  GROUP_NAME_MAX, emptyGroups, normalizeGroups, createGroup, renameGroup, deleteGroup, assignSkill, moveGroup,
} from "../lib/skill-groups.js";

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };

// 1) normalize: junk is dropped, order is rebuilt, dangling members disappear
{
  const state = normalizeGroups({
    groups: [
      { id: "g2", name: "后端", order: 5 },
      { id: "bogus" },
      { id: "g1", name: "  前端  ", order: 0 },
      { id: "g1", name: "duplicate id", order: 9 },
      null,
    ],
    members: { alpha: "g2", beta: "nope", gamma: "g1", "": "g1" },
  });
  console.log("normalized:", JSON.stringify(state));
  check(state.groups.length === 2, "only the two valid groups must survive, got " + state.groups.length);
  check(state.groups[0].id === "g1" && state.groups[1].id === "g2", "groups must be re-ordered by their order field");
  check(state.groups[0].name === "前端", "names must be trimmed");
  check(state.groups.every((group, index) => group.order === index), "order must be re-indexed from 0");
  check(state.members.alpha === "g2" && state.members.gamma === "g1", "valid memberships must survive");
  check(!("beta" in state.members), "a membership pointing at an unknown group must be dropped");
  check(!("" in state.members), "an empty skill name must be dropped");
  check(normalizeGroups(null).groups.length === 0, "null normalizes to an empty store");
  check(normalizeGroups([]).groups.length === 0, "an array normalizes to an empty store");
  check(emptyGroups().groups.length === 0 && Object.keys(emptyGroups().members).length === 0, "emptyGroups must be empty");
}

// 2) create: ids are sequential and unique, names are unique case-insensitively
{
  let state = emptyGroups();
  ({ state } = createGroup(state, "前端"));
  const second = createGroup(state, "后端");
  state = second.state;
  console.log("created:", JSON.stringify(state.groups));
  check(state.groups.length === 2, "two groups expected");
  check(state.groups[0].id === "g1" && state.groups[1].id === "g2", "ids must be g1, g2 — got " + state.groups.map((g) => g.id).join(","));
  check(state.groups[1].order === 1, "the second group must land at order 1");
  const cases = [
    ["", /不能为空/],
    ["   ", /不能为空/],
    ["前端", /已存在/],
    ["  FRONT  ", null],
    ["x".repeat(GROUP_NAME_MAX + 1), /最多/],
  ];
  for (const [name, pattern] of cases) {
    let error = "";
    try {
      createGroup(state, name);
    } catch (err) {
      error = String(err?.message ?? err);
    }
    if (pattern === null) {
      // "FRONT" is a different name than "前端", so it must be accepted
      check(error === "", `"${name}" must be accepted, got: ${error}`);
    } else {
      check(pattern.test(error), `"${name}" must be rejected with ${pattern}, got: ${error}`);
    }
  }
  const dup = (() => { try { createGroup(createGroup(state, "Design").state, "design"); return ""; } catch (err) { return String(err?.message ?? err); } })();
  check(/已存在/.test(dup), "group names must be unique case-insensitively, got: " + dup);
}

// 3) rename / assign / unassign
{
  let state = createGroup(emptyGroups(), "前端").state;
  const groupId = state.groups[0].id;
  state = renameGroup(state, groupId, "界面");
  check(state.groups[0].name === "界面", "rename must change the name");
  state = assignSkill(state, "web-search", groupId);
  check(state.members["web-search"] === groupId, "assign must record the membership");
  state = assignSkill(state, "web-search", null);
  check(!("web-search" in state.members), "assigning null must ungroup");
  let error = "";
  try { assignSkill(state, "web-search", "g99"); } catch (err) { error = String(err?.message ?? err); }
  check(/不存在/.test(error), "assigning to an unknown group must be refused, got: " + error);
  error = "";
  try { renameGroup(state, "g99", "x"); } catch (err) { error = String(err?.message ?? err); }
  check(/不存在/.test(error), "renaming an unknown group must be refused, got: " + error);
}

// 4) delete: members become ungrouped, the skill itself is untouched
{
  let state = createGroup(emptyGroups(), "A").state;
  state = createGroup(state, "B").state;
  const [a, b] = state.groups;
  state = assignSkill(state, "skill-one", a.id);
  state = assignSkill(state, "skill-two", b.id);
  state = deleteGroup(state, a.id);
  console.log("after delete:", JSON.stringify(state));
  check(state.groups.length === 1 && state.groups[0].id === b.id, "only the other group must remain");
  check(!("skill-one" in state.members), "members of a deleted group must become ungrouped");
  check(state.members["skill-two"] === b.id, "members of other groups must be untouched");
  let error = "";
  try { deleteGroup(state, a.id); } catch (err) { error = String(err?.message ?? err); }
  check(/不存在/.test(error), "deleting twice must be refused, got: " + error);
}

// 5) move: order changes, edges are no-ops
{
  let state = createGroup(emptyGroups(), "first").state;
  state = createGroup(state, "second").state;
  state = createGroup(state, "third").state;
  const ids = state.groups.map((g) => g.id);
  check(ids.join(",") === "g1,g2,g3", "initial order must be g1,g2,g3");
  state = moveGroup(state, "g3", -1);
  check(state.groups.map((g) => g.id).join(",") === "g1,g3,g2", "moving up must swap with the previous slot");
  check(state.groups.map((g) => g.order).join(",") === "0,1,2", "orders must be re-indexed after a move");
  state = moveGroup(state, "g1", -1);
  check(state.groups[0].id === "g1", "moving the first group up must be a no-op");
  state = moveGroup(state, "g2", 1);
  check(state.groups[2].id === "g2", "moving the last group down must be a no-op");
  let error = "";
  try { moveGroup(state, "g9", 1); } catch (err) { error = String(err?.message ?? err); }
  check(/不存在/.test(error), "moving an unknown group must be refused, got: " + error);
}

// 6) JSON round-trip keeps everything the file needs
{
  let state = createGroup(emptyGroups(), "前端").state;
  state = assignSkill(state, "web-search", state.groups[0].id);
  const roundTrip = normalizeGroups(JSON.parse(JSON.stringify(state)));
  check(JSON.stringify(roundTrip) === JSON.stringify(state), "a JSON round-trip must be lossless");
}

if (failed.length > 0) {
  for (const line of failed) console.log("FAIL:", line);
  console.log("SKILL GROUPS SMOKE FAILED");
  process.exit(1);
}
console.log("SKILL GROUPS SMOKE PASSED");
