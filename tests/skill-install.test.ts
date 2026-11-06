import assert from "node:assert/strict";
import test from "node:test";
import { planIsEmpty, planSkillInstall } from "../src/skill-install.ts";
import type { SkillDto } from "../src/types.ts";

const skill = (name: string, apps: Record<string, boolean>, extra: Partial<SkillDto> = {}) =>
  ({ id: `id-${name}`, name, source: "builtin", apps, staleCopies: [], ...extra }) as unknown as SkillDto;

test("planSkillInstall：没启用的打开、副本过期的重拷、已就绪的不动、库里没有的单列", () => {
  const lib = [
    skill("lit-search", { "claude-code": false }),
    skill("lit-notes", { "claude-code": true }, { staleCopies: ["claude-code"] }),
    skill("data-eda", { "claude-code": true }),
    skill("mine", { "claude-code": false }, { source: "ccode" }),
  ];
  const plan = planSkillInstall(lib, ["lit-search", "lit-notes", "data-eda", "gone"], "claude-code");
  assert.deepEqual(plan.enable.map((s) => s.name), ["lit-search"]);
  assert.deepEqual(plan.resync.map((s) => s.name), ["lit-notes"]);
  assert.deepEqual(plan.missing, ["gone"]);
});

test("planSkillInstall：names 为 null 只取内置；这家没有技能目录的算装不了", () => {
  const lib = [skill("lit-search", { "claude-code": false }), skill("mine", { "claude-code": false }, { source: "ccode" })];
  assert.deepEqual(planSkillInstall(lib, null, "claude-code").enable.map((s) => s.name), ["lit-search"]);
  const none = planSkillInstall(lib, ["lit-search"], "unknown-agent");
  assert.deepEqual(none.missing, ["lit-search"]);
  assert.ok(planIsEmpty(none));
});
