import assert from "node:assert/strict";
import test from "node:test";
import {
  aiProfileChoices,
  parseAiProfileChoice,
  selectedAiProfileChoice,
} from "../src/ai-profile-choice.ts";

const glm = {
  id: "p-glm",
  name: "GLM",
  agent: "claude-code",
  models: ["glm-5.3", "glm-5.3-flashx"],
};

test("同一配置的每个模型各占一条", () => {
  const choices = aiProfileChoices([
    glm,
    { id: "p-empty", name: "", agent: "codex", models: [] },
  ]);
  assert.deepEqual(
    choices.map((c) => c.label),
    ["GLM（claude-code · glm-5.3）", "GLM（claude-code · glm-5.3-flashx）", "（codex）"],
  );
  assert.equal(choices[1].profileId, "p-glm");
  assert.equal(choices[1].model, "glm-5.3-flashx");
  assert.deepEqual(parseAiProfileChoice(choices[1].value), {
    profileId: "p-glm",
    model: "glm-5.3-flashx",
  });
  assert.deepEqual(parseAiProfileChoice(""), { profileId: "", model: "" });
});

test("已存模型还在就选中它，不在就落回第一个", () => {
  assert.equal(
    selectedAiProfileChoice("p-glm", "glm-5.3-flashx", [glm]),
    aiProfileChoices([glm])[1].value,
  );
  assert.equal(
    selectedAiProfileChoice("p-glm", "gone", [glm]),
    aiProfileChoices([glm])[0].value,
  );
  assert.equal(selectedAiProfileChoice("", "glm-5.3", [glm]), "");
  assert.equal(selectedAiProfileChoice(null, null, []), "");
});

test("配置列表还没到时保留已存选择", () => {
  const value = selectedAiProfileChoice("p-glm", "glm-5.3-flashx", []);
  assert.deepEqual(parseAiProfileChoice(value), {
    profileId: "p-glm",
    model: "glm-5.3-flashx",
  });
});

test("选项里的 agent 写展示名而不是内部 id", () => {
  const choices = aiProfileChoices([glm], (id) => (id === "claude-code" ? "Claude Code" : id));
  assert.equal(choices[0].label, "GLM（Claude Code · glm-5.3）");
  assert.equal(aiProfileChoices([glm])[0].label, "GLM（claude-code · glm-5.3）", "不传映射原样显示 id");
});
