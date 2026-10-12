import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTabDragDx,
  rubberbandTabDx,
  tabDragTarget,
} from "../src/tab-drag.ts";

// 等宽三槽（130px + 4px gap）：left 0 / 134 / 268
const SLOTS = [
  { left: 0, width: 130 },
  { left: 134, width: 130 },
  { left: 268, width: 130 },
];

test("目标槽位：源中心越过谁的中线就占谁的位", () => {
  // 拖第一个：不过槽1中线（199）归 0，过了归 1，过槽2中线（333）归 2
  assert.equal(tabDragTarget(SLOTS, 0, 0), 0);
  assert.equal(tabDragTarget(SLOTS, 0, 100), 0); // cx=165 < 199
  assert.equal(tabDragTarget(SLOTS, 0, 140), 1); // cx=205 > 199
  assert.equal(tabDragTarget(SLOTS, 0, 270), 2); // cx=335 > 333
  // 拖最后一个往左：过槽1中线归 1，再左归 0
  assert.equal(tabDragTarget(SLOTS, 2, 0), 2);
  assert.equal(tabDragTarget(SLOTS, 2, -100), 1); // cx=233 < 333, > 199
  assert.equal(tabDragTarget(SLOTS, 2, -260), 0); // cx=73 < 199
});

test("回归：只有两个标签时左拖右到底必须让位（钳制上限 = 末槽中线，>= 才够得着）", () => {
  const two = [SLOTS[0], SLOTS[1]];
  const dx = clampTabDragDx(two, 0, 9999);
  // 钳制上限 = 源右缘到末槽右缘 = 134；此时 cx = 65+134 = 199 = 槽1中线
  assert.equal(dx, 134);
  assert.equal(tabDragTarget(two, 0, dx), 1, "严格 > 会在这里永远得到 0");
});

test("回归：多标签拖到最右一个同样够得着", () => {
  const dx = clampTabDragDx(SLOTS, 0, 9999);
  assert.equal(dx, 268);
  assert.equal(tabDragTarget(SLOTS, 0, dx), 2);
});

test("钳制：源标签不出内容范围（首槽左缘 / 末槽右缘）", () => {
  assert.equal(clampTabDragDx(SLOTS, 0, -50), 0, "首标签左拖原地不动");
  assert.equal(clampTabDragDx(SLOTS, 2, -9999), -268, "末标签左缘到首槽左缘");
  assert.equal(clampTabDragDx(SLOTS, 1, -9999), -134);
  assert.equal(clampTabDragDx(SLOTS, 1, 9999), 134);
  assert.equal(clampTabDragDx([], 0, 100), 0);
});

test("钳制后的极值位置目标判定不越界", () => {
  for (let from = 0; from < SLOTS.length; from++) {
    const lo = clampTabDragDx(SLOTS, from, -9999);
    const hi = clampTabDragDx(SLOTS, from, 9999);
    assert.equal(tabDragTarget(SLOTS, from, lo), 0);
    assert.equal(tabDragTarget(SLOTS, from, hi), SLOTS.length - 1);
  }
});

test("橡胶带：界内与钳制值恒等（只放宽越界视觉）", () => {
  assert.equal(rubberbandTabDx(SLOTS, 0, 50), 50);
  assert.equal(rubberbandTabDx(SLOTS, 0, 0), 0);
  assert.equal(rubberbandTabDx(SLOTS, 1, -100), -100);
  assert.equal(rubberbandTabDx([], 0, 100), 0);
});

test("橡胶带：越界位移单调递增但被衰减，恒不超过同向无限拖的渐近线", () => {
  const max = 268; // 首标签右拖钳制上限
  // 公式渐近线 = max + dimension（398px 条宽）：拖得无限远也最多再多走一条宽
  const far = rubberbandTabDx(SLOTS, 0, 100000);
  assert.ok(far > max + 10, "越界后仍能继续拉动一点");
  assert.ok(far < max + 398 + 1, "但被皮筋衰减在渐近线内");
  // 单调：拖得越远走得越远
  assert.ok(rubberbandTabDx(SLOTS, 0, 400) > rubberbandTabDx(SLOTS, 0, 300));
  // 衰减率递减：第二段 100px 的增量小于第一段
  const gain1 = rubberbandTabDx(SLOTS, 0, 500) - rubberbandTabDx(SLOTS, 0, 400);
  const gain2 = rubberbandTabDx(SLOTS, 0, 600) - rubberbandTabDx(SLOTS, 0, 500);
  assert.ok(gain2 < gain1, "越界越深每像素跟随越少（阻力递增）");
});

test("橡胶带：左向越界同样衰减", () => {
  const lo = rubberbandTabDx(SLOTS, 2, -100000);
  assert.ok(lo < -268 - 10, "左越界仍能拉动一点");
  assert.ok(lo > -268 - 398 - 1, "渐近线内");
});

test("橡胶带不改变槽位判定：视觉极值位置的目标与钳制极值一致", () => {
  for (let from = 0; from < SLOTS.length; from++) {
    const clamped = clampTabDragDx(SLOTS, from, 9999);
    assert.equal(tabDragTarget(SLOTS, from, clamped), SLOTS.length - 1);
    // 橡胶带放宽后的视觉位移喂给判定，结论不因放宽而变
    const visual = rubberbandTabDx(SLOTS, from, 100000);
    assert.equal(tabDragTarget(SLOTS, from, visual), SLOTS.length - 1);
    assert.equal(
      tabDragTarget(SLOTS, from, rubberbandTabDx(SLOTS, from, -100000)),
      0,
    );
  }
});
