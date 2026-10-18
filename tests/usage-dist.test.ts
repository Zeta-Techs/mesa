import test from "node:test";
import assert from "node:assert/strict";
import {
  barWidthPct,
  DIST_PREVIEW,
  shareOf,
  sharePctLabel,
  toTsv,
  visibleDistRows,
} from "../src/usage-dist.ts";

test("占比：总量为 0 / 负数不出 NaN，封顶 1", () => {
  assert.equal(shareOf(5, 0), 0);
  assert.equal(shareOf(0, 10), 0);
  assert.equal(shareOf(5, 10), 0.5);
  assert.equal(shareOf(20, 10), 1);
});

test("进度条：有量至少露 1.5%，无量为 0", () => {
  assert.equal(barWidthPct(0), 0);
  assert.equal(barWidthPct(0.001), 1.5);
  assert.equal(barWidthPct(0.4), 40);
});

test("占比文字：极小份额写 <0.1%", () => {
  assert.equal(sharePctLabel(0), "0%");
  assert.equal(sharePctLabel(0.0004), "<0.1%");
  assert.equal(sharePctLabel(0.1234), "12.3%");
});

test("先露几行：多于阈值+2 才折叠，并报出藏了几行（不静默截断）", () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  assert.deepEqual(visibleDistRows(rows, false), { shown: rows.slice(0, DIST_PREVIEW), hidden: 15 });
  assert.deepEqual(visibleDistRows(rows, true).hidden, 0);
  const few = Array.from({ length: DIST_PREVIEW + 2 }, (_, i) => i);
  assert.equal(visibleDistRows(few, false).hidden, 0, "只多一两行就不折");
});

test("复制表格：制表符分隔，格内换行与制表符压成空格", () => {
  assert.equal(
    toTsv(["名称", "费用"], [["a\tb", "$1"], ["多\n行", "~"]]),
    "名称\t费用\na b\t$1\n多 行\t~",
  );
});
