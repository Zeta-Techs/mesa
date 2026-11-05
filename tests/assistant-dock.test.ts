import assert from "node:assert/strict";
import test from "node:test";
import { assistantWhere, canDockAssistant, clampAssistantWidth, ASSISTANT_WIDTH_DEFAULT } from "../src/assistant-dock.ts";

test("项目助手侧栏宽度：夹在 340–640，双击（负数）回默认", () => {
  assert.equal(clampAssistantWidth(200), 340);
  assert.equal(clampAssistantWidth(500.4), 500);
  assert.equal(clampAssistantWidth(900), 640);
  assert.equal(clampAssistantWidth(-1), ASSISTANT_WIDTH_DEFAULT);
  assert.equal(clampAssistantWidth(Number.NaN), ASSISTANT_WIDTH_DEFAULT);
});

test("够宽才常驻：主区让出侧栏后还剩 720", () => {
  assert.equal(canDockAssistant(1240, 420), true);
  assert.equal(canDockAssistant(1100, 420), false);
});

test("此刻在看哪：项目页写项目、页签、聚焦的步骤；看着别的项目写明不是这个", () => {
  assert.equal(assistantWhere({ page: "workbench", assistantProject: "A", viewing: null, tab: null }), "工作台");
  assert.equal(
    assistantWhere({ page: "workspaces", assistantProject: "HER", viewing: { project: "HER", samePath: true, step: "文献检索与筛选" }, tab: "schedules", workMode: "research" }),
    "项目页 · 「HER」 · 「定时任务」页签 · 聚焦在步骤「文献检索与筛选」",
  );
  assert.equal(
    assistantWhere({ page: "workspaces", assistantProject: "HER", viewing: { project: "HER", samePath: true, step: null }, tab: "tasks", workMode: "research" }),
    "项目页 · 「HER」 · 「科研任务」页签",
  );
  assert.match(assistantWhere({ page: "workspaces", assistantProject: "HER", viewing: { project: "B", samePath: false, step: null }, tab: "files" }), /别的项目「B」/);
});
