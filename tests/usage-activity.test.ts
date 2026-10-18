import assert from "node:assert/strict";
import test from "node:test";
import {
  activeMainDays,
  activityDatePhrase,
  buildRollingGrid,
  heatCellPx,
  HEAT_CELL_MAX_PX,
  HEAT_CELL_MIN_PX,
  levelOf,
  levelThresholds,
  mainTokens,
  rollingBounds,
  shiftDay,
  streaks,
  weekdayIndex,
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

test("rollingBounds / buildRollingGrid：去年同月 1 日到今天，右边停在今天，两个 10 月都标", () => {
  assert.deepEqual(rollingBounds("2026-10-15"), {
    start: "2025-10-01",
    end: "2026-10-15",
  });
  const g = buildRollingGrid("2026-10-15");
  const cells = g.weeks.flatMap((c) => c).filter((x): x is { day: string } => x !== null);
  assert.equal(cells[0]?.day, "2025-10-01");
  assert.equal(cells[cells.length - 1]?.day, "2026-10-15");
  assert.ok(cells.every((c) => c.day >= "2025-10-01" && c.day <= "2026-10-15"));
  // 2025-10-01 周三：首列周一、周二是窗口外，不画格
  assert.equal(g.weeks[0][0], null);
  assert.equal(g.weeks[0][1], null);
  assert.equal(g.weeks[0][2]?.day, "2025-10-01");
  // 今天之后的日子不在网格里（不补完 10 月，也不补到 12 月）
  assert.equal(cells.some((c) => c.day > "2026-10-15"), false);
  const labels = g.monthMarks.map((m) => m.label);
  assert.equal(labels[0], "10月");
  assert.equal(labels[labels.length - 1], "10月");
  assert.ok(labels.includes("1月") && labels.includes("6月"));
  assert.ok(g.monthMarks[0].weekIndex < g.monthMarks[g.monthMarks.length - 1].weekIndex);
  g.weeks.forEach((col) => {
    col.forEach((cell, r) => {
      if (cell) assert.equal(weekdayIndex(cell.day), r);
    });
  });
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

test("heatCellPx：11–28 夹紧，28 以上不再抬", () => {
  assert.equal(heatCellPx(400, 53), HEAT_CELL_MIN_PX);
  // 常规卡宽约 918：floor((918-20)/53)-3 = 13，吃满而不是停在更小档
  assert.equal(heatCellPx(918, 53), 13);
  // 单模布局（2026-10-16）：胶囊全上卡头、主区无左栏，满宽都给格子
  // ——1440 限宽页卡内约 1360：floor((1360-20)/53)-3 = 22
  assert.equal(heatCellPx(1360, 53), 22);
  // 再宽也停在上限，不再长成地砖
  assert.equal(heatCellPx(1720, 53), HEAT_CELL_MAX_PX);
  assert.equal(heatCellPx(4000, 53), HEAT_CELL_MAX_PX);
});
