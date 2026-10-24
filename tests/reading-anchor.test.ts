import assert from "node:assert/strict";
import test from "node:test";
import { firstCrossing, pickAnchor, type AnchorEl } from "../src/reading-anchor.ts";

// 假元素：只有位置和子元素，够选锚用
function box(top: number, height: number, children: AnchorEl[] = []): AnchorEl & { name?: string } {
  return { children, getBoundingClientRect: () => ({ top, bottom: top + height, height }) };
}
function column(heights: number[], start = 0): AnchorEl[] {
  let y = start;
  return heights.map((h) => {
    const b = box(y, h);
    y += h;
    return b;
  });
}

test("第一个底边越过顶线的那块；从上次的位置往两边找，结果和从头扫一样", () => {
  const kids = column([100, 100, 100, 100, 100]);
  for (const hint of [0, 2, 4, 99]) {
    assert.equal(firstCrossing(kids, 250, hint), 2);
    assert.equal(firstCrossing(kids, 200, hint), 2, "底边正好压线不算越过");
    assert.equal(firstCrossing(kids, 0, hint), 0);
  }
  assert.equal(firstCrossing(kids, 600), -1);
  assert.equal(firstCrossing([], 0), -1);
});

test("没有高度的（display:none 的位置是 0）跳过，不打乱往回找", () => {
  const kids = [box(0, 100), box(0, 0), box(100, 100), box(0, 0), box(200, 100)];
  assert.equal(firstCrossing(kids, 150, 4), 2);
  assert.equal(firstCrossing(kids, 250, 0), 4);
});

test("整块在顶线以下就锚它；跨着顶线就往里找一层，锚住里面越过顶线的那块", () => {
  const inner = column([50, 50, 50, 50], 100);
  const turn = box(100, 200, inner);
  const root = box(0, 400, [box(0, 100), turn, box(300, 100)]);
  // 顶线 100：turn 整块在下面
  assert.equal(pickAnchor(root, 100)?.el, turn);
  // 顶线 180：turn 跨线，锚它里面第二块（150–200）
  const p = pickAnchor(root, 180);
  assert.equal(p?.el, inner[1]);
  assert.equal(p?.rootIndex, 1, "hint 记的是最外一层的位置");
  // 跨线那块里面没有越过顶线的子元素（只剩内边距）：锚它自己
  const padded = box(0, 300, column([50, 50], 0));
  assert.equal(pickAnchor(box(0, 300, [padded]), 200)?.el, padded);
});
