import assert from "node:assert/strict";
import test from "node:test";
import { groupByAgent } from "../src/agent-model-groups.ts";

const opt = (agentId: string, profileId: string, model: string) => ({
  key: `${profileId}::${model}`,
  agentId,
  profileId,
  profileName: profileId.toUpperCase(),
  model,
});

test("两层菜单分组：先按 Agent、再按连接，保持传入顺序", () => {
  const groups = groupByAgent([
    opt("kimi", "glm", "glm-5.3"),
    opt("codex", "glm", "glm-5.3-flash"),
    opt("kimi", "glm", "glm-5.3-flashx"),
    opt("codex", "zeta", "gpt-6-luna"),
    opt("kimi", "official", ""),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.agentId, g.count, g.profiles.map((p) => [p.profileId, p.options.map((o) => o.model)])]),
    [
      ["kimi", 3, [["glm", ["glm-5.3", "glm-5.3-flashx"]], ["official", [""]]]],
      ["codex", 2, [["glm", ["glm-5.3-flash"]], ["zeta", ["gpt-6-luna"]]]],
    ],
  );
  // 同名连接 id 在不同 Agent 下各算各的
  assert.equal(groups[0].profiles[0].profileName, "GLM");
});

test("没有选项时分组为空", () => {
  assert.deepEqual(groupByAgent([]), []);
});
