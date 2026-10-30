import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { claudeAliasMap, claudeCustomOption, normalizeRoleModels, rolesFor } from "../src/role-models.ts";

test("Claude 别名槽与 agents.rs claude_slot_models 同口径（共读 tests/fixtures/claude-slots.json）", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/claude-slots.json", import.meta.url), "utf8"));
  for (const c of fixture.cases) {
    const map = claudeAliasMap(c.models, c.roles);
    const got = Object.fromEntries(["sonnet", "opus", "haiku", "fable"].map((s) => {
      const hit = map.find((a) => a.alias === s);
      return [s, hit ? (hit.model ?? c.fill) : null];
    }));
    assert.deepEqual(got, c.expect, c.name);
    assert.equal(claudeCustomOption(c.models, c.roles, c.fill), c.custom, c.name);
  }
});

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

test("旧绑定转显式映射：按名单顺序算出 sonnet / opus / fable，haiku 没设时取第 3 个；已显式的不动", async () => {
  const { explicitClaudeRoles } = await import("../src/role-models.ts");
  assert.deepEqual(explicitClaudeRoles(["a", "b", "c", "d"], {}), {
    slots: { sonnet: "a", opus: "b", fable: "d" },
    small: "c",
  });
  assert.deepEqual(explicitClaudeRoles(["a"], { small: "a" }).slots, { sonnet: "a" });
  const done = { slots: { opus: "b" } };
  assert.deepEqual(explicitClaudeRoles(["a", "b"], done), done);
});

test("「1M」勾选：能力库确知的锁着；用户声明的可取消；取消时只撤上下文、别的声明留着", async () => {
  const { oneMState, oneMOverrideEntry } = await import("../src/model-caps-override.ts");
  assert.deepEqual(oneMState(1_048_576, undefined), { checked: true, locked: true });
  assert.deepEqual(oneMState(200_000, { context: 1_000_000 }), { checked: true, locked: false });
  assert.deepEqual(oneMState(null, undefined), { checked: false, locked: false });
  assert.equal(oneMOverrideEntry("m", false, undefined), null);
  assert.deepEqual(oneMOverrideEntry("m", false, { thinking: true }), {
    prefix: "m", thinking: true, context: null, vision: null, output: null, api_backend: null,
  });
  assert.equal(oneMOverrideEntry("m", true, undefined)?.context, 1_000_000);
});
