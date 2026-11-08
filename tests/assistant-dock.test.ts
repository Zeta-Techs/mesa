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

test("快捷键问哪个项目：项目页看过的优先，没看过且只有一个项目就是它，否则交给工作台挑", async () => {
  const { assistantShortcutTarget } = await import("../src/assistant-dock.ts");
  assert.equal(assistantShortcutTarget("/p/a", ["/p/a", "/p/b"]), "/p/a");
  assert.equal(assistantShortcutTarget(null, ["/p/b"]), "/p/b");
  assert.equal(assistantShortcutTarget(null, ["/p/a", "/p/b"]), null);
  assert.equal(assistantShortcutTarget(undefined, []), null);
});

test("问答记录按天分隔：今天 / 昨天 / 同年月日带星期 / 跨年带年份", async () => {
  const { assistantDayLabel, sameLocalDay } = await import("../src/assistant-dock.ts");
  const now = new Date(2026, 10, 8, 15, 0);
  assert.equal(assistantDayLabel(new Date(2026, 10, 8, 1, 0).toISOString(), now), "今天");
  assert.equal(assistantDayLabel(new Date(2026, 10, 7, 23, 0).toISOString(), now), "昨天");
  assert.equal(assistantDayLabel(new Date(2026, 10, 5, 9, 0).toISOString(), now), "11月5日 周四");
  assert.equal(assistantDayLabel(new Date(2025, 11, 31, 9, 0).toISOString(), now), "2025年12月31日 周三");
  assert.equal(sameLocalDay(new Date(2026, 10, 8, 0, 1).toISOString(), new Date(2026, 10, 8, 23, 59).toISOString()), true);
});
