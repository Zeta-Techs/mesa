import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync } from "node:fs";
import { BUILTIN_TASKS, builtinTaskCatalogLines, builtinTaskGoalText, builtinTaskMethod, findBuiltinTask } from "../src/builtin-tasks.ts";

test("内置科研任务：四个，名字唯一，点名的技能都是随包内置技能", () => {
  assert.deepEqual(BUILTIN_TASKS.map((t) => t.name), ["组会汇报", "进展周报", "实验规划", "审改已有稿件"]);
  const bundled = new Set(readdirSync(new URL("../src-tauri/resources/skills/", import.meta.url)));
  for (const t of BUILTIN_TASKS) {
    for (const sk of t.skills) assert.ok(bundled.has(sk), `${t.name} 点名的 ${sk} 不是随包技能`);
    assert.ok(t.clarify.length >= 2 && t.method.length >= 3 && t.deliverables.length && t.done.length, t.name);
  }
});

test("内置科研任务：按名找、清单、做法与目标文字", () => {
  assert.equal(findBuiltinTask("「组会汇报」")?.id, "group-meeting");
  assert.equal(findBuiltinTask("内置任务「实验规划」")?.id, "experiment-plan");
  assert.equal(findBuiltinTask("别的"), null);
  assert.equal(builtinTaskCatalogLines().length, 4);
  const plan = findBuiltinTask("实验规划")!;
  assert.match(builtinTaskMethod(plan), /不写「建议采用」/);
  assert.match(builtinTaskGoalText(plan), /（按内置任务「实验规划」记下）$/);
});

test("审改已有稿件：原稿只读、引文域只体检不改写，交付前查残留痕迹", () => {
  const t = findBuiltinTask("审改已有稿件")!;
  assert.equal(t.id, "manuscript-revision");
  const method = builtinTaskMethod(t);
  assert.match(method, /audit_docx\.py marks/);
  assert.match(method, /audit_docx\.py cites/);
  assert.match(method, /不覆盖原稿/);
  assert.match(method, /不重编号、不增删引文/);
  assert.match(method, /修订、批注为 0/);
  assert.ok(t.clarify.some((c) => c.includes("修订模式加批注")));
  assert.ok(t.deliverables.every((d) => d.startsWith("output/")), "派生产物只写 output/");
});
