import assert from "node:assert/strict";
import test from "node:test";
import {
  activeMainDays,
  activityDatePhrase,
  buildRollingGrid,
  buildYearGrid,
  heatCellPx,
  heatRailLeft,
  heatWideAside,
  HEAT_CELL_MAX_PX,
  HEAT_CELL_MIN_PX,
  HEAT_RAIL_AT,
  HEAT_WIDE_REMAINDER_PX,
  levelOf,
  levelThresholds,
  mainTokens,
  rollingBounds,
  shiftDay,
  streaks,
  weekdayIndex,
  yearBounds,
  yearStats,
} from "../src/usage-activity.ts";
import type { UsageActivityDayDto } from "../src/types.ts";

function day(
  d: string,
  opts: Partial<UsageActivityDayDto> = {},
): UsageActivityDayDto {
  return {
    day: d,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    sessions: 1,
    officialTokens: 0,
    internalTokens: 0,
    internalSessions: 0,
    costUsd: null,
    costPartial: false,
    ...opts,
  };
}

test("yearBounds：当年截到今天，往年整年", () => {
  assert.deepEqual(yearBounds(2026, "2026-10-12"), {
    start: "2026-01-01",
    end: "2026-10-12",
  });
  assert.deepEqual(yearBounds(2025, "2026-10-12"), {
    start: "2025-01-01",
    end: "2025-12-31",
  });
});

test("buildYearGrid：2026-01-01 是周四 → 首列 3 个 pad，周一开头；整年 + future 标记", () => {
  const g = buildYearGrid(2026, "2026-10-12");
  // 2026-01-01 周四：周一 12/28、周二 29、周三 31 都属 2025 → 首列前 3 格 null
  assert.equal(g.weeks[0].filter((x) => x === null).length, 3);
  assert.equal(g.weeks[0][3]?.day, "2026-01-01");
  // 整年网格（翻年宽度不跳变）：365 天、53 列
  assert.equal(g.dayCount, 365);
  assert.equal(g.weeks.length, 53);
  // 今天之后标记 future（组件渲染成空格）；之前不标
  const today = g.weeks.flatMap((c) => c).find((x) => x?.day === "2026-10-12");
  assert.ok(today && !today.future);
  const next = g.weeks.flatMap((c) => c).find((x) => x?.day === "2026-10-13");
  assert.ok(next?.future);
  // 每个非空格都坐在自己的周几行上（行 0=周一 … 行 6=周日）
  g.weeks.forEach((col) => {
    col.forEach((cell, r) => {
      if (cell) assert.equal(weekdayIndex(cell.day), r);
    });
  });
  // 整月都在未来的月份不标（11/12 月）；10 月要标
  const labels = g.monthMarks.map((m) => m.label);
  assert.ok(labels.includes("10月"));
  assert.ok(!labels.includes("11月") && !labels.includes("12月"));
});

test("buildYearGrid：往年整年、跨月共周不丢标签、相邻标签不重叠", () => {
  const g = buildYearGrid(2025, "2026-10-12");
  assert.equal(g.dayCount, 365);
  const labels = g.monthMarks.map((m) => m.label);
  // 12 个月里 12 月首周太贴近 11 月标签时允许跳过，但至少 1/6/12 月要在
  assert.ok(labels.includes("1月") && labels.includes("6月"));
  for (let i = 1; i < g.monthMarks.length; i++) {
    assert.ok(
      g.monthMarks[i].weekIndex - g.monthMarks[i - 1].weekIndex >= 2,
      "相邻月标签首列间隔 <2",
    );
  }
  // 每个标签 span 覆盖的周内确实有该月的日期（按周一归属）
  for (const m of g.monthMarks) {
    const month = Number(m.label.replace("月", ""));
    const anchor = g.weeks[m.weekIndex].find((x) => x);
    assert.equal(Number(anchor!.day.slice(5, 7)), month);
  }
});

test("levelThresholds/levelOf：非零天四分位，同值归 1 档，0 不进分位", () => {
  const t = levelThresholds([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(t, [2, 4, 6]);
  assert.equal(levelOf(0, t), 0);
  assert.equal(levelOf(1, t), 1);
  assert.equal(levelOf(2, t), 1);
  assert.equal(levelOf(3, t), 2);
  assert.equal(levelOf(5, t), 3);
  assert.equal(levelOf(7, t), 4);
  // 全同值：三阈值相等 → 全 1 档（GitHub 单 commit 日即最浅档）
  const same = levelThresholds([5, 5, 5, 5]);
  assert.equal(levelOf(5, same), 1);
  // 单非零日
  const one = levelThresholds([9]);
  assert.equal(levelOf(9, one), 1);
  // 空输入不炸
  assert.deepEqual(levelThresholds([]), [1, 2, 3]);
});

test("streaks：今天活跃含今天；宽限从昨天前推；断档清零；跨年不断", () => {
  const mk = (dates: string[]) => new Set(dates);
  // 今天有活动：含今天
  assert.equal(streaks(mk(["2026-10-12", "2026-10-11"]), "2026-10-12").current, 2);
  // 今天还没活动：从昨天前推不清零（宽限）
  assert.equal(streaks(mk(["2026-10-11", "2026-10-10"]), "2026-10-12").current, 2);
  // 昨天也没有：当前清零
  assert.equal(streaks(mk(["2026-10-08"]), "2026-10-12").current, 0);
  // 跨年连续：2025-12-30 → 2026-01-02 共 4 天
  const cross = streaks(mk(["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]), "2026-01-02");
  assert.equal(cross.current, 4);
  assert.equal(cross.longest, 4);
  assert.equal(cross.longestFrom, "2025-12-30");
  assert.equal(cross.longestTo, "2026-01-02");
  // 最长连续跨断档取最长段
  const gap = streaks(
    mk(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-10", "2026-01-11"]),
    "2026-02-01",
  );
  assert.equal(gap.longest, 3);
  assert.equal(gap.longestFrom, "2026-01-01");
  // 空集
  assert.equal(streaks(new Set(), "2026-10-12").longest, 0);
});

test("口径：internal-only 日不算活跃日；mainTokens 四类合计", () => {
  const days = [
    day("2026-10-11", { input: 100, output: 10, cacheRead: 1000, cacheWrite: 5 }),
    day("2026-10-12", { sessions: 0, internalTokens: 88, internalSessions: 1 }),
  ];
  assert.equal(mainTokens(days[0]), 1115);
  const active = activeMainDays(days);
  assert.ok(active.has("2026-10-11"));
  assert.ok(!active.has("2026-10-12"), "internal-only 日不进活跃口径");
});

test("yearStats：窗口边界计入/不计入，峰值日正确", () => {
  const days = [
    day("2025-12-31", { input: 50 }),
    day("2026-01-01", { input: 10, output: 5 }),
    day("2026-08-14", { input: 100, output: 50, cacheRead: 200 }),
    day("2026-12-31", { input: 999 }), // 当年未来（窗口 end=今天）不该计入
  ];
  const s = yearStats(days, "2026-01-01", "2026-10-12");
  assert.equal(s.activeDays, 2);
  assert.equal(s.peakTokens, 350);
  assert.equal(s.peakDay, "2026-08-14");
});

test("activityDatePhrase：中文日期 + 周几 + 今天注记", () => {
  assert.equal(activityDatePhrase("2026-10-12", "2026-10-12"), "10月12日 周一（今天）");
  assert.equal(activityDatePhrase("2026-10-14", "2026-10-12"), "10月14日 周三");
  assert.equal(activityDatePhrase("2026-01-04", "2026-10-12"), "1月4日 周日");
});

test("shiftDay 跨月跨年", () => {
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDay("2025-02-28", 1), "2025-03-01");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
});

test("heatCellPx：11–16 夹紧，16 是地砖上限不得再抬", () => {
  assert.equal(heatCellPx(400, 53), HEAT_CELL_MIN_PX);
  // 常规卡宽约 918：floor((918-20)/53)-3 = 13，吃满而不是停在更小档
  assert.equal(heatCellPx(918, 53), 13);
  // 最大化窗口也停在 16，不再长成地砖
  assert.equal(heatCellPx(1720, 53), HEAT_CELL_MAX_PX);
  assert.equal(heatCellPx(4000, 53), HEAT_CELL_MAX_PX);
});

test("heatRailLeft：主区 1020 起左栏双列", () => {
  assert.equal(heatRailLeft(HEAT_RAIL_AT - 1), false);
  assert.equal(heatRailLeft(HEAT_RAIL_AT), true);
});

test("heatWideAside：16px 舒适网格右侧 ≥220 才挂统计，40px 回差防抖", () => {
  const weeks = 53;
  // 有胶囊：门槛 = 256+24 + 20+(16+3)*53 + 220 = 1527
  const enter = 256 + 24 + 20 + 19 * weeks + HEAT_WIDE_REMAINDER_PX;
  assert.equal(enter, 1527);
  assert.equal(heatWideAside(enter - 1, weeks, true, false), false);
  assert.equal(heatWideAside(enter, weeks, true, false), true);
  // 已在超宽档：差 40px 内不退（1527-40=1487 起仍为宽）
  assert.equal(heatWideAside(enter - 40, weeks, true, true), true);
  assert.equal(heatWideAside(enter - 41, weeks, true, true), false);
  // 未进超宽档时，同样的中间值仍是窄——回差是单向的
  assert.equal(heatWideAside(enter - 20, weeks, true, false), false);
  // 低于左栏门槛绝不挂右侧
  assert.equal(heatWideAside(HEAT_RAIL_AT, weeks, true, false), false);
  // 无胶囊时左栏不占位，门槛更早
  const enterNoChips = 20 + 19 * weeks + HEAT_WIDE_REMAINDER_PX;
  assert.equal(heatWideAside(enterNoChips, weeks, false, false), true);
  assert.equal(heatWideAside(enterNoChips - 1, weeks, false, false), false);
});
