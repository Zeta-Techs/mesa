import assert from "node:assert/strict";
import test from "node:test";
import { dragSelection, edgeScrollStep } from "../src/drag-select.ts";

const keys = ["a", "b", "c", "d", "e"];
const sorted = (s: Set<string>) => [...s].sort();

test("往下拖：从按下那行到当前行整段勾上，范围外原样保留", () => {
  assert.deepEqual(sorted(dragSelection(new Set(["e"]), keys, 1, 3, true)), ["b", "c", "d", "e"]);
});

test("往上拖与往下拖同一口径", () => {
  assert.deepEqual(sorted(dragSelection(new Set(), keys, 3, 1, true)), ["b", "c", "d"]);
});

test("按下的是已勾的行：划过的整段去掉", () => {
  assert.deepEqual(sorted(dragSelection(new Set(keys), keys, 0, 2, false)), ["d", "e"]);
});

test("拖回头：退出范围的行回到按下前的样子", () => {
  const base = new Set(["d"]);
  // 先拖到 e 再回到 b：c 之后的行照 base，d 仍勾着、e 不勾
  assert.deepEqual(sorted(dragSelection(base, keys, 1, 2, true)), ["b", "c", "d"]);
  assert.deepEqual(sorted(dragSelection(base, keys, 1, 1, true)), ["b", "d"]);
});

test("越界下标截断，空列表不出错，不改动 base", () => {
  const base = new Set<string>();
  assert.deepEqual(sorted(dragSelection(base, keys, 3, 99, true)), ["d", "e"]);
  assert.deepEqual(sorted(dragSelection(base, [], 0, 2, true)), []);
  assert.equal(base.size, 0);
});

test("边缘自动滚：中间不滚，越贴边越快，列表太矮不滚", () => {
  assert.equal(edgeScrollStep(300, 0, 600), 0);
  assert.ok(edgeScrollStep(590, 0, 600) > edgeScrollStep(560, 0, 600));
  assert.ok(edgeScrollStep(560, 0, 600) > 0);
  assert.ok(edgeScrollStep(5, 0, 600) < 0);
  assert.equal(edgeScrollStep(700, 0, 600), 18);
  assert.equal(edgeScrollStep(50, 0, 80), 0);
});
