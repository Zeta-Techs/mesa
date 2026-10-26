import assert from "node:assert/strict";
import test from "node:test";
import { nearBottom, progressiveLimit } from "../src/progressive-rows.ts";

test("分段渲染画到必须露出的那一行为止，不超过总数", () => {
  assert.equal(progressiveLimit(150, 1300), 150);
  assert.equal(progressiveLimit(150, 80), 80);
  // 选中项在第 400 行：画到它
  assert.equal(progressiveLimit(150, 1300, 399), 400);
  // 选中项在已画范围内：不变
  assert.equal(progressiveLimit(300, 1300, 10), 300);
  assert.equal(progressiveLimit(150, 1300, -1), 150);
});

test("离底不到三屏才接下一段，窗口矮时按 600px 下限", () => {
  const m = { scrollHeight: 10000, clientHeight: 800 };
  // 剩余 = 10000 - top - 800；三屏 = 2400
  assert.equal(nearBottom({ ...m, scrollTop: 0 }), false);
  assert.equal(nearBottom({ ...m, scrollTop: 6799 }), false);
  assert.equal(nearBottom({ ...m, scrollTop: 6800 }), true);
  const short = { scrollHeight: 3000, clientHeight: 100 };
  assert.equal(nearBottom({ ...short, scrollTop: 2300 }), true);
  assert.equal(nearBottom({ ...short, scrollTop: 2299 }), false);
});
