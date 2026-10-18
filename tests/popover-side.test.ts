import assert from "node:assert/strict";
import test from "node:test";
import { pickPopoverSide } from "../src/popover-side.ts";

test("弹层方向：下面放得下就往下，贴底时往上，都放不下挑大的一边", () => {
  // 开聊前输入框在屏幕中间
  assert.equal(pickPopoverSide({ top: 300, bottom: 400 }, 900, 320), "below");
  // 开聊后输入框贴底
  assert.equal(pickPopoverSide({ top: 760, bottom: 860 }, 900, 320), "above");
  // 窗口很矮，两边都放不下
  assert.equal(pickPopoverSide({ top: 100, bottom: 160 }, 400, 320), "below");
  assert.equal(pickPopoverSide({ top: 240, bottom: 300 }, 400, 320), "above");
});
