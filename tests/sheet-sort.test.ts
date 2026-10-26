import assert from "node:assert/strict";
import test from "node:test";
import { compareSheetCells, normRange, rangeTsv, sortedRowOrder } from "../src/sheet-preview.ts";

test("排序：数按数比（千分位、百分号），字按中文，空格在最后", () => {
  assert.ok(compareSheetCells("9", "10") < 0);
  assert.ok(compareSheetCells("1,200", "300") > 0);
  assert.ok(compareSheetCells("5%", "0.1") < 0);
  assert.ok(compareSheetCells("", "a") > 0);
  assert.ok(compareSheetCells("样品2", "样品10") < 0);
});

test("排序：表头不动、同值保持原顺序、降序", () => {
  const rows = [["名称", "值"], ["b", "2"], ["a", "10"], ["c", "2"]];
  assert.deepEqual(sortedRowOrder(rows, 1, "asc", true), [0, 1, 3, 2]);
  assert.deepEqual(sortedRowOrder(rows, 1, "desc", true), [0, 2, 1, 3]);
  assert.deepEqual(sortedRowOrder([["b"], ["a"], ["c"]], 0, "asc", false), [1, 0, 2]);
});

test("框选复制：制表符分隔，带换行的格加引号", () => {
  const rows = [["a", "b", "c"], ["1", "x\ny", "3"]];
  const r = normRange({ r: 1, c: 1 }, { r: 0, c: 0 });
  assert.deepEqual(r, { r0: 0, c0: 0, r1: 1, c1: 1 });
  assert.equal(rangeTsv(rows, r), 'a\tb\n1\t"x\ny"');
});
