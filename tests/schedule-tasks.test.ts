import assert from "node:assert/strict";
import test from "node:test";
import {
  frequencyLabel,
  hhmm,
  reconcileRunningSchedules,
  runDoneNotifyBody,
  runDoneNotifyTitle,
  scheduleStatusMark,
  schedulesForProject,
  summaryPreview,
  truncateText,
} from "../src/schedule-tasks.ts";
import type { ScheduleDto } from "../src/types.ts";

function schedule(projectRoot: string, id = "s-1"): ScheduleDto {
  return {
    id,
    name: "文献雷达",
    projectRoot,
    skill: "lit-watch",
    profileId: null,
    frequency: "daily",
    weekday: null,
    hour: 9,
    minute: 0,
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    history: [],
  };
}

test("hhmm：补零并钳制到合法范围", () => {
  assert.equal(hhmm(9, 5), "09:05");
  assert.equal(hhmm(23, 59), "23:59");
  assert.equal(hhmm(25, 61), "23:59");
  assert.equal(hhmm(-1, -1), "00:00");
  assert.equal(hhmm(Number.NaN, Number.NaN), "00:00");
});

test("frequencyLabel：每天 / 每周几 白话", () => {
  assert.equal(frequencyLabel("daily", null, 9, 0), "每天 09:00");
  assert.equal(frequencyLabel("weekly", 1, 9, 30), "每周一 09:30");
  assert.equal(frequencyLabel("weekly", 7, 18, 5), "每周日 18:05");
});

test("frequencyLabel：weekly 缺 weekday 或越界时回落「每周 HH:MM」", () => {
  assert.equal(frequencyLabel("weekly", null, 9, 0), "每周 09:00");
  assert.equal(frequencyLabel("weekly", 0, 9, 0), "每周 09:00");
  assert.equal(frequencyLabel("weekly", 8, 9, 0), "每周 09:00");
});

test("frequencyLabel：未知周期按每天处理（不静默丢失）", () => {
  assert.equal(frequencyLabel("monthly", 3, 9, 0), "每天 09:00");
});

test("schedulesForProject：只留 projectRoot 命中的任务", () => {
  const list = [
    schedule("/repo/a", "s-1"),
    schedule("/repo/b", "s-2"),
    schedule("/repo/a", "s-3"),
  ];
  assert.deepEqual(
    schedulesForProject(list, "/repo/a", false).map((s) => s.id),
    ["s-1", "s-3"],
  );
  assert.deepEqual(schedulesForProject(list, "/repo/c", false), []);
});

test("schedulesForProject：尾部斜杠与分隔符差异不影响归属", () => {
  const list = [schedule("/repo/a", "s-1"), schedule("C:\\repo\\b\\", "s-2")];
  assert.deepEqual(
    schedulesForProject(list, "/repo/a/", false).map((s) => s.id),
    ["s-1"],
  );
  assert.deepEqual(
    schedulesForProject(list, "C:/repo/b", true).map((s) => s.id),
    ["s-2"],
  );
});

test("schedulesForProject：verbatim 前缀与 Windows 大小写漂移不再丢任务", () => {
  // 存量 schedules.json 可能带 \\?\ verbatim 前缀；目录改大小写后注册路径漂移。
  // 字符串全等会把任务在前端列表里弄丢（后端照跑）——必须走 path-utils 方言层
  const list = [
    schedule("\\\\?\\C:\\repo\\A", "s-verbatim"),
    schedule("C:\\Repo\\B", "s-case"),
  ];
  assert.deepEqual(
    schedulesForProject(list, "C:/repo/a", true).map((s) => s.id),
    ["s-verbatim"],
  );
  assert.deepEqual(
    schedulesForProject(list, "c:/REPO/b", true).map((s) => s.id),
    ["s-case"],
  );
  // 非 Windows 不折大小写（与后端 path_key 的 cfg(windows) 口径一致）
  assert.deepEqual(schedulesForProject(list, "C:/repo/a", false), []);
});

test("runDoneNotifyTitle：任务名、成功与失败", () => {
  assert.equal(runDoneNotifyTitle("我的课题", "ok", "文献雷达"), "文献雷达 · 我的课题");
  assert.equal(runDoneNotifyTitle("我的课题", "ok", "数据检查"), "数据检查 · 我的课题");
  assert.equal(
    runDoneNotifyTitle("我的课题", "timeout", "文献雷达"),
    "文献雷达 · 我的课题（超时）",
  );
  assert.equal(
    runDoneNotifyTitle("我的课题", "error", "文献雷达"),
    "文献雷达 · 我的课题（失败）",
  );
  assert.equal(scheduleStatusMark("timeout").label, "超时");
  assert.equal(scheduleStatusMark("ok").glyph, "✓");
});

test("runDoneNotifyBody：取首个非空行并截断", () => {
  assert.equal(
    runDoneNotifyBody("\n  检索 3 条关键词，新命中 2 篇\n第二行"),
    "检索 3 条关键词，新命中 2 篇",
  );
  const long = "文".repeat(200);
  const body = runDoneNotifyBody(long);
  assert.equal(body.length, 121);
  assert.ok(body.endsWith("…"));
  assert.equal(runDoneNotifyBody(""), "");
});

test("truncateText：折叠空白、限长加省略号", () => {
  assert.equal(truncateText("a  b\n\nc", 10), "a b c");
  assert.equal(truncateText("12345678901", 10), "1234567890…");
  assert.equal(truncateText("  ", 10), "");
});

test("summaryPreview：多行简报折叠为单行预览", () => {
  const preview = summaryPreview({
    at: "2026-08-13T09:00:00Z",
    status: "ok",
    summary: "检索 3 条关键词\n新命中 2 篇，推荐 1 篇\narXiv 未达",
  });
  assert.equal(preview, "检索 3 条关键词 新命中 2 篇，推荐 1 篇 arXiv 未达");
});

test("reconcileRunningSchedules：挂载/刷新并入后端实报的运行中任务", () => {
  const out = reconcileRunningSchedules(new Set(), new Set(), new Set(["s-1"]));
  assert.deepEqual([...out], ["s-1"]);
});

test("reconcileRunningSchedules：刚点立即运行未登记 Run 的不清掉（防闪烁）", () => {
  // 本地有点击态，但前后两次后端快照都没报在跑（Run 行还没建出来）→ 保留
  const out = reconcileRunningSchedules(new Set(["s-1"]), new Set(), new Set());
  assert.deepEqual([...out], ["s-1"]);
});

test("reconcileRunningSchedules：后端曾报在跑、现在不再跑的清除（事件漏收兜底）", () => {
  const out = reconcileRunningSchedules(
    new Set(["s-1", "s-2"]),
    new Set(["s-1"]),
    new Set(["s-2"]),
  );
  assert.deepEqual([...out].sort(), ["s-2"]);
  // 清除后下一轮换 snapshot，本地已无该 id，不会被反复加回
  const again = reconcileRunningSchedules(out, new Set(["s-2"]), new Set());
  assert.deepEqual([...again], []);
});

test("reconcileRunningSchedules：空集合对账返回空", () => {
  assert.deepEqual([...reconcileRunningSchedules(new Set(), new Set(), new Set())], []);
});
