import assert from "node:assert/strict";
import test from "node:test";
import { artifactPaths, builtinTaskStep, suggestPackParams, workOrderScheduleIntent, workOrderToStep } from "../src/work-order-pack.ts";
import { findBuiltinTask } from "../src/builtin-tasks.ts";
import { paramValueProblem } from "../src/task-packs.ts";

const order = {
  target: "goal" as const,
  step: null,
  title: "第三批组会汇报",
  task: "把 2026-11-01 到 2026-11-05 的记录整理成 10 分钟组会，11 月 4 日那次重复单列一页",
  done: "每页结论有出处；页数与时长相符",
  inputs: ["lab/2026-11-02.md", "data/raw/"],
  deliver: "新建 `slides/` 目录，放 output/group-meeting/2026-11-06/slides.html",
  skills: ["slides-deck"],
  assumptions: "听众是组内",
  schedule: "每周五 17:00",
};

test("派活单 → 一步步骤合同：简报带依据与假设，交付物认路径，验收拆条，技能合并", () => {
  const step = workOrderToStep(order, { method: "按内置任务「组会汇报」的做法：…", extraSkills: ["figure-forge", "slides-deck"] });
  assert.equal(step.name, "第三批组会汇报");
  assert.match(step.brief, /依据材料：\n- lab\/2026-11-02\.md\n- data\/raw\//);
  assert.match(step.brief, /先定下的假设.*听众是组内/);
  assert.match(step.brief, /按内置任务「组会汇报」的做法/);
  assert.deepEqual(step.expectedArtifacts, ["slides/", "output/group-meeting/2026-11-06/slides.html"]);
  assert.deepEqual(step.acceptanceCriteria, ["每页结论有出处", "页数与时长相符"]);
  assert.deepEqual(step.skills, ["slides-deck", "figure-forge"]);
  assert.deepEqual(step.run, []);
  assert.deepEqual(artifactPaths("交一份报告"), [], "认不出路径就空着");
  assert.deepEqual(artifactPaths("../x.md 和 /etc/a.md 和 v1.2"), [], "项目外与版本号不算");
});

test("参数建议：时间范围、日期、时长、这次用的文件；同一个值只出一次，类型合法", () => {
  const step = workOrderToStep(order);
  const params = suggestPackParams(step, order.inputs);
  assert.deepEqual(
    params.map((p) => [p.label, p.value, p.kind ?? ""]),
    [
      ["时间范围", "2026-11-01 到 2026-11-05", ""],
      ["日期", "11 月 4 日", ""],
      ["日期", "2026-11-06", ""],
      ["时长", "10 分钟", ""],
      ["依据材料 1", "lab/2026-11-02.md", "file"],
      ["依据材料 2", "data/raw/", "path"],
    ],
  );
  for (const p of params) assert.equal(paramValueProblem(p.kind, p.value), null, `${p.label} 的预填值要合它的类型`);
  assert.deepEqual(params.map((p) => p.key), ["p1", "p2", "p3", "p4", "p5", "p6"]);
});

test("内置科研任务 → 步骤合同；做成定时的描述带多久一次与「没新内容不改文件」", () => {
  const plan = builtinTaskStep(findBuiltinTask("实验规划")!);
  assert.equal(plan.workspaceName, "experiment-plan");
  assert.match(plan.brief, /开工前先写清/);
  assert.deepEqual(plan.skills, ["stats-check"]);
  const intent = workOrderScheduleIntent(order, null);
  assert.match(intent, /多久一次：每周五 17:00/);
  assert.match(intent, /文件名里带上日期/);
  assert.match(intent, /没有新内容时不要改任何文件/);
});
