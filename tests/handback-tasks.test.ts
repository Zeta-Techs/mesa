import assert from "node:assert/strict";
import test from "node:test";
import { handbackTask } from "../src/handback-tasks.ts";

test("AI 写好、人来填的清单认得出来，交回的话指向落点文件并要求重渲、提交（2026-10-24）", () => {
  const perm = handbackTask("换原图与申请转载许可");
  assert.ok(perm);
  assert.equal(perm.open, "打开清单");
  assert.match(perm.prompt("submission/figure-permissions.md"), /submission\/figure-permissions\.md[\s\S]*figures\/sources\.md[\s\S]*重渲[\s\S]*提交/);
  const decl = handbackTask("填作者、单位与投稿声明");
  assert.ok(decl);
  assert.equal(decl.open, "打开填写");
  assert.match(decl.prompt("submission/declarations.md"), /Authors[\s\S]*author[\s\S]*不改写[\s\S]*重渲[\s\S]*提交/);
  assert.equal(handbackTask("更换引用样式"), null);
  assert.equal(handbackTask("逐条决定审查报告"), null);
});
