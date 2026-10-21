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
