import assert from "node:assert/strict";
import test from "node:test";
import { pickPopoverSide, popoverRoom } from "../src/popover-side.ts";

test("弹层方向：下面放得下就往下，贴底时往上，都放不下挑大的一边", () => {
  // 开聊前输入框在屏幕中间
  assert.equal(pickPopoverSide({ top: 300, bottom: 400 }, 900, 320), "below");
  // 开聊后输入框贴底
  assert.equal(pickPopoverSide({ top: 760, bottom: 860 }, 900, 320), "above");
  // 窗口很矮，两边都放不下
  assert.equal(pickPopoverSide({ top: 100, bottom: 160 }, 400, 320), "below");
  assert.equal(pickPopoverSide({ top: 240, bottom: 300 }, 400, 320), "above");
});

test("弹层限高：锚点那一边的空间减去离边余量，封顶不超过 cap", () => {
  // 输入框在屏幕中间往下开：下面 900-400-8=492，减 12 余量
  assert.equal(popoverRoom({ top: 300, bottom: 400 }, 900, "below", 600), 480);
  // 大屏封顶
  assert.equal(popoverRoom({ top: 300, bottom: 400 }, 2000, "below", 480), 480);
  // 贴底往上：上面 760-8=752，封顶
  assert.equal(popoverRoom({ top: 760, bottom: 860 }, 900, "above", 480), 480);
  // 空间不够不出负数
  assert.equal(popoverRoom({ top: 5, bottom: 30 }, 40, "above", 480), 0);
});
