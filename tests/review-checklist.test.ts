import assert from "node:assert/strict";
import test from "node:test";
import {
  parseReviewItems,
  removeReviewItem,
  updateReviewItemComment,
} from "../src/review-checklist.ts";

test("parseReviewItems：区分划字、框图、机检与手动批注，并保留原文行号", () => {
  const notes = [
    "请逐条判断以下核验项：",
    "- 「阴极脱硼发生在 -0.2 V」（manuscript/draft.md）：语气收稳，补上文献条件",
    "- 「图 fig3.png」（figures/fig3.png）：子图 (b) 坐标轴太糊（标注图，红框处就是要改的位置：/tmp/m1.png）",
    "- [核验] outline.md:42 覆盖检查篇数对不上，按 Mesa 复算修正",
    "- 摘要最后一句太长，压成一句话",
  ].join("\n");

  const items = parseReviewItems(notes);
  assert.equal(items.length, 4, "应跳过批量引导行，只解析 4 条实际批注");
  assert.equal(items[0].kind, "quote");
  assert.equal(items[0].file, "manuscript/draft.md");
  assert.equal(items[0].excerpt, "阴极脱硼发生在 -0.2 V");
  assert.equal(items[0].comment, "语气收稳，补上文献条件");

  assert.equal(items[1].kind, "image");
  assert.equal(items[1].file, "figures/fig3.png");
  assert.equal(items[1].markPath, "/tmp/m1.png");
  assert.equal(items[1].comment, "子图 (b) 坐标轴太糊");

  assert.equal(items[2].kind, "check");
  assert.equal(items[2].file, "outline.md");
  assert.equal(items[2].line, 42);

  assert.equal(items[3].kind, "plain");
  assert.equal(items[3].file, null);
  assert.equal(items[3].comment, "摘要最后一句太长，压成一句话");
});

test("updateReviewItemComment 与 removeReviewItem：精确就地更新并保住引文与标注图后缀", () => {
  const notes = [
    "- 「图 fig3.png」（figures/fig3.png）：待补（标注图，红框处就是要改的位置：/tmp/m1.png）",
    "- 摘要压短",
  ].join("\n");
  const items = parseReviewItems(notes);
  const edited = updateReviewItemComment(notes, items[0].lineIndex, "把 (b) 放大并补单位");
  assert.match(edited, /「图 fig3\.png」（figures\/fig3\.png）：把 \(b\) 放大并补单位（标注图，红框处就是要改的位置：\/tmp\/m1\.png）/);
  const afterRemove = removeReviewItem(edited, items[1].lineIndex);
  assert.equal(parseReviewItems(afterRemove).length, 1);
  assert.doesNotMatch(afterRemove, /摘要压短/);
});
