import assert from "node:assert/strict";
import test from "node:test";
import {
  catchupNotify,
  frequencyLabel,
  hhmm,
  lastRunAction,
  lastRunBrief,
  nextRunLabel,
  otherProjectSchedules,
  scheduleInboxCandidates,
  shouldNotifyRunDone,
  skipLine,
  slotLabel,
  triggerTag,
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

// ===== 2026-10-23 定时任务完善 =====

test("frequencyLabel：工作日 / 每 N 小时 / 仅手动", () => {
  assert.equal(frequencyLabel("weekdays", null, 9, 0), "工作日 09:00");
  assert.equal(frequencyLabel("hourly", null, 0, 15, 6), "每 6 小时，在 :15");
  assert.equal(frequencyLabel("hourly", null, 0, 5, 1), "每小时，在 :05");
  // 间隔越界回落每小时
  assert.equal(frequencyLabel("hourly", null, 0, 0, 5), "每小时，在 :00");
  assert.equal(frequencyLabel("manual", null, 9, 0), "仅手动");
});

test("slotLabel / nextRunLabel：今天、明天、其他日期；停用不显示", () => {
  const now = new Date(2026, 9, 23, 10, 0);
  assert.equal(slotLabel("2026-10-23T14:00:00", now), "今天 14:00");
  assert.equal(slotLabel("2026-10-24T09:00:00", now), "明天 09:00");
  assert.equal(slotLabel("2026-10-22T09:00:00", now), "昨天 09:00");
  assert.equal(slotLabel("2026-10-26T09:05:00", now), "10月26日 09:05");
  assert.equal(slotLabel(null, now), "");
  assert.equal(nextRunLabel({ enabled: true, nextRunAt: "2026-10-24T09:00:00" }, now), "下次 明天 09:00");
  assert.equal(nextRunLabel({ enabled: false, nextRunAt: "2026-10-24T09:00:00" }, now), null);
  assert.equal(nextRunLabel({ enabled: true, nextRunAt: null }, now), null);
});

test("跳过行与来由小标", () => {
  assert.equal(skipLine({ skipReason: "unreviewed", skipCount: 3 }), "已跳过 3 次：上一轮还没评审");
  assert.equal(skipLine({ skipReason: "missed_asleep", skipCount: 1 }), "已跳过：电脑在睡眠");
  assert.equal(scheduleStatusMark("skipped").label, "已跳过");
  assert.equal(
    summaryPreview({ at: "x", status: "skipped", summary: "已跳过：应用没开", skipReason: "missed_closed", skipCount: 2 }),
    "已跳过 2 次：应用没开",
  );
  assert.equal(
    summaryPreview({ at: "x", status: "ok", summary: "新命中 0 篇", noop: true }),
    "无新内容 · 新命中 0 篇",
  );
  const now = new Date(2026, 9, 23, 23, 0);
  assert.equal(triggerTag({ trigger: "catchup", scheduledFor: "2026-10-23T09:00:00" }, now), "补跑 · 原定 今天 09:00");
  assert.equal(triggerTag({ trigger: "manual", scheduledFor: null }, now), "手动");
  assert.equal(triggerTag({ trigger: "schedule", scheduledFor: "2026-10-23T09:00:00" }, now), null);
});

test("shouldNotifyRunDone：无新内容不打扰，自动暂停一定说", () => {
  assert.equal(shouldNotifyRunDone({ status: "ok", noop: true }), false);
  assert.equal(shouldNotifyRunDone({ status: "ok", noop: false }), true);
  assert.equal(shouldNotifyRunDone({ status: "error" }), true);
  assert.equal(shouldNotifyRunDone({ status: "ok", noop: true, autoPaused: "连续 3 次" }), true);
  assert.equal(
    runDoneNotifyTitle("课题", "error", "查模型", true),
    "查模型 · 课题（已自动暂停）",
  );
});

test("catchupNotify：原定时刻与之前错过的次数", () => {
  const now = new Date(2026, 9, 23, 23, 0);
  const n = catchupNotify("文献雷达", "课题", "2026-10-23T09:00:00", 2, now);
  assert.equal(n.title, "补跑：文献雷达 · 课题");
  assert.match(n.body, /原定 今天 09:00，之前还错过 2 次/);
});

test("scheduleInboxCandidates：其他巡检待评审只认新记录；自动暂停单独一条；雷达不进", () => {
  const generic: ScheduleDto = {
    ...schedule("/repo/a", "g-1"),
    skill: "model-watch",
    name: "查模型",
    history: [
      { at: "t3", status: "skipped", summary: "", skipReason: "unreviewed" },
      { at: "t2", status: "ok", summary: "改了表", noop: false, runId: "r2", isolationPath: "/iso" },
    ],
  };
  const legacy: ScheduleDto = {
    ...generic,
    id: "g-2",
    history: [{ at: "t1", status: "ok", summary: "旧", runId: "r1", isolationPath: "/iso" }],
  };
  const noop: ScheduleDto = {
    ...generic,
    id: "g-3",
    history: [{ at: "t1", status: "ok", summary: "", noop: true, runId: "r3", isolationPath: "/iso" }],
  };
  const paused: ScheduleDto = {
    ...schedule("/repo/b", "r-1"),
    enabled: false,
    pausedReason: "连续 3 次没跑成",
    history: [{ at: "t1", status: "ok", summary: "", noop: false, runId: "r4", isolationPath: "/iso" }],
  };
  const out = scheduleInboxCandidates([generic, legacy, noop, paused]);
  assert.deepEqual(
    out.map((c) => [c.kind, c.scheduleId, c.runId ?? null]),
    [
      ["review", "g-1", "r2"],
      ["paused", "r-1", null],
    ],
  );
});

test("otherProjectSchedules：排除本项目", () => {
  const list = [schedule("/repo/a", "s-1"), schedule("/repo/b", "s-2")];
  assert.deepEqual(otherProjectSchedules(list, "/repo/a/", false).map((s) => s.id), ["s-2"]);
});

test("lastRunBrief / lastRunAction：上次结果一句话与入口", () => {
  const base = { at: "t", summary: "检索 3 条\n第二行" };
  assert.deepEqual(lastRunBrief({ ...base, status: "ok", newEntries: 3 }, true), { text: "3 篇新命中", tone: "ok" });
  assert.deepEqual(lastRunBrief({ ...base, status: "ok", newEntries: 3, adopted: true }, true), { text: "3 篇新命中 · 已采纳", tone: "ok" });
  assert.deepEqual(lastRunBrief({ ...base, status: "ok", noop: true }, false), { text: "无新内容", tone: "muted" });
  assert.deepEqual(
    lastRunBrief({ ...base, status: "ok", noop: false, isolationPath: "/iso", runId: "r" }, false),
    { text: "有新产物待评审", tone: "ok" },
  );
  assert.deepEqual(lastRunBrief({ ...base, status: "error", summary: "\n连接不存在\n细节" }, false), { text: "失败：连接不存在", tone: "err" });
  assert.equal(lastRunBrief({ ...base, status: "timeout" }, false).tone, "warn");
  assert.equal(lastRunBrief({ ...base, status: "skipped", skipReason: "unreviewed", skipCount: 2 }, false).text, "已跳过 2 次：上一轮还没评审");
  // 入口：待评审优先，其次看过程；旧的 0 命中雷达记录不给评审
  assert.equal(lastRunAction({ ...base, status: "ok", isolationPath: "/iso", agent: "codex", sessionId: "s" }), "review");
  assert.equal(lastRunAction({ ...base, status: "ok", isolationPath: "/iso", newEntries: 0, agent: "codex", sessionId: "s" }), "process");
  assert.equal(lastRunAction({ ...base, status: "ok", isolationPath: "/iso", adopted: true }), null);
  assert.equal(lastRunAction({ ...base, status: "error", agent: "codex", sessionId: "s" }), "process");
});

