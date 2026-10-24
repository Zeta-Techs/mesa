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

test("同一套「AI 写、人填、交回」推到各模板：论文投稿前清单、投稿材料清单、数据字典（2026-10-24）", async () => {
  const { PIPELINE_TEMPLATES } = await import("../src/pipeline-presets.ts");
  const titles = PIPELINE_TEMPLATES.flatMap((t) => t.steps.flatMap((s) => (s.humanTasks ?? []).map((h) => h.title)));
  for (const [title, file] of [
    ["核对 G5 证据就绪、作者信息与投稿目标", "submission/pre-submission-checklist.md"],
    ["按 G5 确认无阻塞问题、补齐声明并决定是否提交", "submission/checklist.md"],
    ["解答「待确认」字段的业务含义", "data-dictionary.md"],
  ] as const) {
    assert.ok(titles.includes(title), title);
    const task = handbackTask(title);
    assert.ok(task, title);
    assert.equal(task.panel, "sections");
    assert.match(task.prompt(file), new RegExp(file.replace(/[.]/g, "\.")));
  }
  assert.match(handbackTask("按 G5 确认无阻塞问题、补齐声明并决定是否提交")!.prompt("submission/checklist.md"), /不要替我提交/);
  assert.equal(handbackTask("换原图与申请转载许可")!.panel, "permissions");
});
