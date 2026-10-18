import assert from "node:assert/strict";
import test from "node:test";
import { claudeAliasMap, normalizeRoleModels, rolesFor } from "../src/role-models.ts";

test("只有 Claude Code / Grok / OpenCode 有模型分工，Claude 才有子 Agent", () => {
  assert.deepEqual(rolesFor("claude-code").map((r) => r.key), ["small", "subagent"]);
  assert.deepEqual(rolesFor("grok").map((r) => r.key), ["small"]);
  assert.deepEqual(rolesFor("codex"), []);
});

test("保存前归一：不在名单里的分工作废，空串当没设", () => {
  assert.deepEqual(normalizeRoleModels({ small: " glm-5.3-flash ", subagent: "gone" }, ["glm-5.3", "glm-5.3-flash"]), {
    small: "glm-5.3-flash",
    subagent: null,
  });
  assert.deepEqual(normalizeRoleModels(undefined, []), { small: null, subagent: null });
});

test("Claude 别名对应：前四个依次占槽，haiku 跟后台小模型，空槽跟主模型（null）", () => {
  assert.deepEqual(
    claudeAliasMap(["glm-5.3", "glm-5.2"], { small: "glm-5.2" }).map((a) => [a.alias, a.model]),
    [
      ["sonnet", "glm-5.3"],
      ["opus", "glm-5.2"],
      ["haiku", "glm-5.2"],
      ["fable", null],
    ],
  );
  assert.equal(claudeAliasMap(["glm-5.3"], {})[2].why, "名单不够四个，空的跟主模型");
  assert.deepEqual(claudeAliasMap([], undefined), []);
});
