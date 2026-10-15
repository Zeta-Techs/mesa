import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheHitRate,
  compact,
  fmtCost,
  sessionDisplayTitle,
  shortSessionId,
  weekOverWeek,
  type TrendDay,
} from "../src/stats-insight.ts";

function day(iso: string, cost: number, hasUsage = true): TrendDay {
  return { day: iso, costUsd: cost, hasUsage };
}

test("weekOverWeek：本周近 7 天、上周再往前 7 天", () => {
  const days: TrendDay[] = [
    day("2026-08-11", 10), // 上周
    day("2026-08-14", 20),
    day("2026-08-18", 30), // 本周
    day("2026-08-24", 40),
  ];
  const wow = weekOverWeek(days, "2026-08-24");
  assert.ok(wow);
  // 本周 08-18..24 = 30+40；上周 08-11..17 = 10+20
  assert.equal(wow.thisWeek, 70);
  assert.equal(wow.lastWeek, 30);
  assert.equal(wow.percent, 133);
});

test("weekOverWeek：上周窗口没有任何用量行 → 不出徽章", () => {
  const days = [day("2026-08-20", 50), day("2026-08-24", 10)];
  assert.equal(weekOverWeek(days, "2026-08-24"), null);
});

test("weekOverWeek：上周花费为 0（有用量但官方/未计价）不算百分比", () => {
  const days: TrendDay[] = [
    { day: "2026-08-12", costUsd: 0, hasUsage: true },
    day("2026-08-24", 80),
  ];
  const wow = weekOverWeek(days, "2026-08-24");
  assert.ok(wow);
  assert.equal(wow.lastWeek, 0);
  assert.equal(wow.thisWeek, 80);
  assert.equal(wow.percent, null);
});

test("weekOverWeek：只填零的空天不算「有上周数据」", () => {
  const days: TrendDay[] = [
    { day: "2026-08-12", costUsd: 0, hasUsage: false },
    day("2026-08-24", 10),
  ];
  assert.equal(weekOverWeek(days, "2026-08-24"), null);
});

test("weekOverWeek：日期非法或空序列返回 null", () => {
  assert.equal(weekOverWeek([], "2026-08-24"), null);
  assert.equal(weekOverWeek([day("2026-08-24", 1)], "nope"), null);
});

test("cacheHitRate：cache / (input + cache)", () => {
  assert.equal(cacheHitRate(100, 300), 0.75);
  assert.equal(cacheHitRate(0, 0), null);
  assert.equal(cacheHitRate(50, 0), 0);
  assert.equal(cacheHitRate(0, 10), 1);
});

test("shortSessionId：去横线取末 8 位", () => {
  assert.equal(shortSessionId("abc"), "abc");
  assert.equal(shortSessionId("ses-sion-12345678"), "12345678");
  assert.equal(shortSessionId("abcdef12-34567890"), "34567890");
});

test("sessionDisplayTitle：自定义 > 扫描 > 短 id", () => {
  assert.equal(
    sessionDisplayTitle({
      customTitle: " 手改标题 ",
      scannedTitle: "扫描",
      sessionId: "abcdefghij",
    }),
    "手改标题",
  );
  assert.equal(
    sessionDisplayTitle({
      customTitle: "  ",
      scannedTitle: "扫描到的",
      sessionId: "abcdefghij",
    }),
    "扫描到的",
  );
  assert.equal(
    sessionDisplayTitle({ customTitle: null, scannedTitle: null, sessionId: "abcdefghij" }),
    "cdefghij",
  );
});

test("compact 统计页数字方言：K/M 两档", () => {
  assert.equal(compact(999), "999");
  assert.equal(compact(1_234), "1.2K");
  assert.equal(compact(12_000), "12K");
  assert.equal(compact(1_234_567), "1.2M");
  assert.equal(compact(796_597_060), "796.6M");
});

test("fmtCost：~ 无价格、≥ 含未计价、$/¥ 换算", () => {
  assert.equal(fmtCost(null, "$", 7.2, false), "~");
  assert.equal(fmtCost(1.24, "$", 7.2, false), "$1.24");
  assert.equal(fmtCost(1.24, "¥", 7.2, false), "¥8.93");
  assert.equal(fmtCost(1.24, "¥", 7.2, true), "≥¥8.93");
});
