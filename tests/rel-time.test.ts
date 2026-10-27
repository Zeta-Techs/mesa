import assert from "node:assert/strict";
import test from "node:test";
import { absTime, relTime, shortWhen } from "../src/rel-time.ts";

// 只做内容语义断言，不做墙钟时序硬断言（共享 runner 调度延迟不可控）
function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60000).toISOString();
}

test("relTime 空值与非法输入返回空串", () => {
  assert.equal(relTime(null), "");
  assert.equal(relTime(""), "");
  assert.equal(relTime("not-a-date"), "");
});

test("relTime 按分钟/小时/天分档", () => {
  assert.equal(relTime(isoMinutesAgo(0)), "刚刚");
  assert.match(relTime(isoMinutesAgo(5)), /^\d+ 分钟前$/);
  assert.match(relTime(isoMinutesAgo(120)), /^\d+ 小时前$/);
  assert.match(relTime(isoMinutesAgo(60 * 24 * 3)), /^\d+ 天前$/);
});

test("relTime 超过 30 天回落为日期", () => {
  const out = relTime(isoMinutesAgo(60 * 24 * 40));
  assert.match(out, /\d{4}/);
  assert.ok(!out.includes("前"));
});

test("absTime 输出绝对时间，非法输入返回空串", () => {
  assert.match(absTime("2026-08-01T12:30:00Z"), /2026/);
  assert.equal(absTime(null), "");
  assert.equal(absTime("not-a-date"), "");
});

test("shortWhen：7 天内相对，更早写月日，跨年带年份", () => {
  const now = new Date(2026, 9, 27, 12, 0).getTime();
  const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi).toISOString();
  assert.equal(shortWhen(at(2026, 9, 27, 11, 59), now), "1 分钟前");
  assert.equal(shortWhen(new Date(now - 20_000).toISOString(), now), "刚刚");
  assert.equal(shortWhen(at(2026, 9, 27, 9), now), "3 小时前");
  assert.equal(shortWhen(at(2026, 9, 24), now), "3 天前");
  assert.equal(shortWhen(at(2026, 8, 10), now), "9月10日");
  assert.equal(shortWhen(at(2025, 11, 30), now), "2025年12月30日");
  assert.equal(shortWhen(null, now), "");
});
