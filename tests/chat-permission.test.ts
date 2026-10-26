import assert from "node:assert/strict";
import test from "node:test";
import { nextPermissionTier, permissionExample } from "../src/chat-permission.ts";

test("权限示例按项目类型取，四档都有一句", () => {
  const coding = permissionExample("coding");
  assert.equal(coding.target, "npm test");
  assert.equal(coding.outcomes.full, "直接跑，删文件也不问");
  assert.equal(permissionExample("research").target, "manuscript/draft.md");
  assert.equal(permissionExample("office").outcomes.auto, "直接改；删文件这类才问");
  const general = permissionExample("general");
  for (const id of ["discuss", "ask", "auto", "full"] as const) assert.ok(general.outcomes[id]);
});

test("只讨论：Claude Code / CodeBuddy / Gemini / Kimi 是计划模式，写成「先出方案，你点头再…」；其余各家照旧", () => {
  for (const agent of ["codebuddy", "gemini", "kimi", "qwen", "opencode"]) {
    assert.equal(permissionExample("coding", agent).outcomes.discuss, "先出方案，你点头再跑", agent);
  }
  for (const agent of ["grok", "cursor"]) {
    assert.equal(permissionExample("coding", agent).outcomes.discuss, "不跑，告诉你怎么跑", agent);
  }
  assert.equal(permissionExample("coding", "claude-code").outcomes.discuss, "先出方案，你点头再跑");
  assert.equal(permissionExample("research", "claude-code").outcomes.discuss, "先出方案，你点头再改");
  assert.equal(permissionExample("general", "claude-code").outcomes.discuss, "先出方案，你点头再建");
  assert.equal(permissionExample("coding", "codex").outcomes.discuss, "不跑，告诉你怎么跑");
  assert.equal(permissionExample("general", null).outcomes.discuss, "不建，告诉你怎么做");
  assert.equal(permissionExample("general", "claude-code").outcomes.auto, "直接建；删文件这类才问");
});

test("⇧Tab 轮换：按顺序走、跳过没有的档、到头回到第一档", () => {
  const all = () => true;
  assert.equal(nextPermissionTier("discuss", all), "ask");
  assert.equal(nextPermissionTier("full", all), "discuss");
  assert.equal(nextPermissionTier(null, all), "discuss");
  // Cursor 那种没有只讨论 / 帮我批准的
  const noDiscussAuto = (id: string) => id === "ask" || id === "full";
  assert.equal(nextPermissionTier("ask", noDiscussAuto), "full");
  assert.equal(nextPermissionTier("full", noDiscussAuto), "ask");
  assert.equal(nextPermissionTier("ask", (id) => id === "ask"), null, "只有当前一档可用：不动");
});
