import test from "node:test";
import assert from "node:assert/strict";
import { DISCUSS_FOCUS, discussFocus, discussOpeningPrompt } from "../src/discuss-prompt.ts";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

test("开场是苏格拉底式：一次一问、复述确认、不问模板已定的流程", () => {
  const p = discussOpeningPrompt({ stepName: "文献检索与筛选", relPath: ".ccode/drafts/x.md", workspaceName: "lit-search" });
  assert.match(p, /一次只问一个问题/);
  assert.match(p, /复述给我确认/);
  assert.match(p, /不要拿来问我/);
  assert.match(p, /## 已定方向/);
  assert.match(p, /## 待拍板/);
  assert.match(p, /最想回答的一个问题/);
  assert.match(p, /不要把模板里的可选事项改成开工前必须办的前置/);
  assert.doesNotMatch(p, /还没定的是/);
});

test("没定的全局设定与种子并进开场", () => {
  const p = discussOpeningPrompt({
    stepName: "s", relPath: "t.md", workspaceName: "zzz",
    openSettings: ["综述角度：（领域全景 / 聚焦某个子问题）", " "],
    seeds: ["主指标测到什么"],
  });
  assert.match(p, /还没定的是：综述角度：（领域全景 \/ 聚焦某个子问题）。/);
  assert.match(p, /主指标测到什么；这一步交出的东西/);
});

test("英文综述五步都有专属提问方向", () => {
  const review = PIPELINE_TEMPLATES.find((t) => t.id === "review")!;
  for (const step of review.steps) {
    assert.ok(DISCUSS_FOCUS[step.workspaceName ?? ""], `${step.name} 缺提问方向`);
    assert.ok(discussFocus(step.workspaceName).length >= 3);
  }
});
