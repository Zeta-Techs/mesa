import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationDraftFromSelection,
  appendReviewAnnotation,
  scanWritingReview,
  sortWritingPreviewPaths,
  writingReturnPrompt,
  writingScanSourcePath,
} from "../src/draft-review.ts";

test("扫描：摘要待核实、G 编号、待绘制、手写序号", () => {
  const text = `## Abstract
Hello [待核实] world

## 1. Introduction
The gap (G1) remains.
**Figure 1 (待绘制).**
`;
  const hits = scanWritingReview(text);
  assert.deepEqual(
    hits.map((h) => h.id),
    ["abstract-unverified", "gap-ids", "placeholder-fig", "manual-numbers"],
  );
});

test("大纲框架推演里的 G1 不算正文泄漏", () => {
  const text = `## 1. 引言
卖点。

## 框架推演
- G1［方法］：机理未统一
`;
  assert.equal(
    scanWritingReview(text, { allowGapIds: true }).some((h) => h.id === "gap-ids"),
    false,
  );
});

test("稿件页：源稿优先，Word 先于 PDF", () => {
  assert.deepEqual(
    sortWritingPreviewPaths([
      "output/draft.pdf",
      "manuscript/draft.md",
      "output/draft.docx",
    ]),
    ["manuscript/draft.md", "output/draft.docx", "output/draft.pdf"],
  );
  assert.equal(
    writingScanSourcePath(["output/draft.pdf", "manuscript/draft.md", ".ccode/a.md"]),
    "manuscript/draft.md",
  );
  assert.equal(
    writingScanSourcePath(["papers/screening.md", "papers/included.md", "TASK.md"]),
    null,
  );
  // 大纲的章节号不报（大纲不渲染）；稿件照报
  assert.deepEqual(scanWritingReview("### 1 引言\n", { allowGapIds: true, allowNumberedHeadings: true }), []);
  assert.equal(scanWritingReview("### 1 引言\n")[0]?.id, "manual-numbers");
  // 大纲步也交写作规范：它不是稿件，扫的是 outline.md
  assert.equal(
    writingScanSourcePath(["manuscript/sections.json", "manuscript/style-sheet.md", "outline.md"]),
    "outline.md",
  );
});

test("空划选不开批注，有文字才记住选段", () => {
  assert.equal(annotationDraftFromSelection("  \n"), null);
  assert.equal(annotationDraftFromSelection(" 核心只写镁负极 "), "核心只写镁负极");
});

test("划选批注追加进已有意见，同一段不重复", () => {
  const once = appendReviewAnnotation("摘要去掉未核实句。", {
    fileName: "outline.md",
    excerpt: "核心只写镁负极与界面",
    comment: "改成只在背景提一句",
  });
  assert.match(once, /摘要去掉未核实句/);
  assert.match(
    once,
    /「核心只写镁负极与界面」（outline\.md）：改成只在背景提一句/,
  );
  const again = appendReviewAnnotation(once, {
    fileName: "outline.md",
    excerpt: "核心只写镁负极与界面",
    comment: "改成只在背景提一句",
  });
  assert.equal(again, once);
  const long = "甲".repeat(180);
  const clipped = appendReviewAnnotation("", {
    fileName: "draft.md",
    excerpt: long,
    comment: "改成见 Fig.1",
  });
  assert.match(clipped, /（draft\.md）：改成见 Fig\.1/);
  assert.ok(!clipped.includes("甲".repeat(161)));
});

test("退回提示词带上意见和红线", () => {
  const prompt = writingReturnPrompt({
    notes: "删 G1，不要凑字数。",
    hits: [{ id: "gap-ids", label: "正文含空白编号（G1…）" }],
    rewrite: false,
  });
  assert.match(prompt, /不要整篇从零重写/);
  assert.match(prompt, /删 G1/);
  assert.match(prompt, /空白编号/);
  assert.match(writingReturnPrompt({ notes: "", hits: [], rewrite: true }), /重写本步稿件/);
});
