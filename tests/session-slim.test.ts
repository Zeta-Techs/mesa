import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateBodyAfter,
  formatMB,
  slimBlockReason,
  slimMenuAvailable,
  slimNotice,
  slimResultText,
} from "../src/session-slim.ts";
import type { SlimInspectDto } from "../src/types.ts";

const MB = 1024 * 1024;

function inspect(over: Partial<SlimInspectDto> = {}): SlimInspectDto {
  return {
    supported: true,
    fileBytes: 68 * MB,
    scanned: true,
    mediaCount: 65,
    mediaBytes: 32 * MB,
    bodyBytes: 33 * MB,
    level: "danger",
    removable: 59,
    keep: 6,
    recentlyWritten: false,
    ...over,
  };
}

test("formatMB：十位数取整，个位数留一位小数", () => {
  assert.equal(formatMB(33 * MB), "33 MB");
  assert.equal(formatMB(3.74 * MB), "3.7 MB");
  assert.equal(formatMB(0), "0.0 MB");
});

test("提示条：danger 用红色并点名 413，warn 用黄色，ok 不出现", () => {
  const danger = slimNotice(inspect());
  assert.equal(danger?.tone, "err");
  assert.match(danger!.detail, /413/);
  assert.match(danger!.detail, /65 张截图/);
  assert.equal(slimNotice(inspect({ level: "warn" }))?.tone, "warn");
  assert.equal(slimNotice(inspect({ level: "ok" })), null);
});

test("提示条：不支持、没扫描、没有可移除的旧截图时一律不出现", () => {
  assert.equal(slimNotice(null), null);
  assert.equal(slimNotice(inspect({ supported: false })), null);
  assert.equal(slimNotice(inspect({ scanned: false })), null);
  assert.equal(slimNotice(inspect({ removable: 0 })), null);
});

test("菜单项：未到告警线也可用（方便提前处理），没有可移除的则不给", () => {
  assert.equal(slimMenuAvailable(inspect({ level: "ok" })), true);
  assert.equal(slimMenuAvailable(inspect({ removable: 0 })), false);
  assert.equal(slimMenuAvailable(inspect({ scanned: false })), false);
  assert.equal(slimMenuAvailable(null), false);
});

test("拦路：Mesa 终端里在跑 / 最近一分钟有写入都不能动手", () => {
  assert.equal(slimBlockReason(inspect(), false), null);
  assert.match(slimBlockReason(inspect(), true)!, /正在 Mesa 里运行.*停下 Agent/);
  assert.match(slimBlockReason(inspect({ recentlyWritten: true }), false)!, /最近一分钟/);
});

test("预告：按平均每张的大小估瘦身后体积，不会为负", () => {
  const i = inspect();
  const after = estimateBodyAfter(i);
  assert.ok(after < i.bodyBytes && after > 0);
  assert.equal(estimateBodyAfter(inspect({ mediaCount: 0, mediaBytes: 0 })), 33 * MB);
  assert.equal(estimateBodyAfter(inspect({ bodyBytes: 1, mediaBytes: 99 * MB })), 0);
});

test("结果文案：写清移除/保留张数与前后大小", () => {
  const text = slimResultText({
    removed: 59,
    kept: 6,
    bytesBefore: 68 * MB,
    bytesAfter: 10 * MB,
    bodyBefore: 34 * MB,
    bodyAfter: 5 * MB,
    backupPath: "/x",
  });
  assert.match(text, /移除 59 张/);
  assert.match(text, /保留最近 6 张/);
  assert.match(text, /34 MB → 5\.0 MB/);
});
