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

test("边界按看得见的区域：运行页在顶栏下面时，往上开的空间从容器上沿算", () => {
  // 锚点在 705，容器上沿 35（顶栏 0–35 盖着）：上面只有 705-35-8=662，减 12 余量
  const view = { top: 35, bottom: 1340 };
  assert.equal(popoverRoom({ top: 705, bottom: 745 }, view, "above", 800), 650);
  assert.equal(popoverRoom({ top: 705, bottom: 745 }, 1340, "above", 800), 685, "旧算法按窗口顶算，多出来的 35 正好顶进顶栏");
  // 方向也按可见区挑：容器下沿更靠上时，下面放不下就往上
  assert.equal(pickPopoverSide({ top: 400, bottom: 440 }, { top: 35, bottom: 700 }, 300), "above");
  assert.equal(pickPopoverSide({ top: 400, bottom: 440 }, 1000, 300), "below");
});
