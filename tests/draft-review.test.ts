import assert from "node:assert/strict";
import test from "node:test";
import {
  appendReviewLine,
  writingHitChecks,
  annotationDraftFromSelection,
  appendReviewAnnotation,
  imageAnnotationExcerpt,
  reviewNoteQuotes,
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
  // 超长收成「开头…结尾」，反查时按首尾标全整段
  const span = appendReviewAnnotation("", {
    fileName: "draft.md",
    excerpt: `${"头".repeat(120)}中段${"尾".repeat(60)}`,
    comment: "改",
  });
  assert.ok(span.startsWith(`- 「${"头".repeat(100)}…${"尾".repeat(50)}」`));
  assert.deepEqual(reviewNoteQuotes(span), [
    { file: "draft.md", quote: `${"头".repeat(100)}…${"尾".repeat(50)}` },
  ]);
});

test("给图加意见：引文写图名，带红框的标注图路径随意见写进同一行", () => {
  assert.equal(imageAnnotationExcerpt("papers/figs/拼图.png"), "图 拼图.png");
  assert.equal(imageAnnotationExcerpt("  "), "图 （无名图）");
  const line = appendReviewAnnotation("", {
    fileName: "draft.md",
    excerpt: `${imageAnnotationExcerpt("papers/figs/拼图.png")}（框了 2 处）`,
    comment: "b 和 c 顺序反了 〔框1：横向 10%–40%、纵向 20%–50%〕",
    markPath: "/tmp/mark-1.png",
  });
  assert.equal(
    line,
    "- 「图 拼图.png（框了 2 处）」（draft.md）：b 和 c 顺序反了 〔框1：横向 10%–40%、纵向 20%–50%〕（标注图，红框处就是要改的位置：/tmp/mark-1.png）",
  );
});

test("意见栏引文反查：逐行解析，截断的省略号去掉当短前缀；图的行照常解析（正文里找不到就不高亮）", () => {
  const quotes = reviewNoteQuotes(
    [
      "- 「这段话 有问题」（draft.md）：要改",
      "- 「开头一百六十字的段落被截过…」（outline.md）：太长了",
      "- 「图 拼图.png（框了 1 处）」（draft.md）：图的问题",
      "- 普通一行不解析",
    ].join("\n"),
  );
  assert.deepEqual(quotes, [
    { file: "draft.md", quote: "这段话 有问题" },
    { file: "outline.md", quote: "开头一百六十字的段落被截过" },
    { file: "draft.md", quote: "图 拼图.png（框了 1 处）" },
  ]);
  assert.deepEqual(reviewNoteQuotes(""), []);
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

test("意见追加一行不重复；扫描结果并进核验清单只到待你判断", () => {
  assert.equal(appendReviewLine("", "- a"), "- a");
  assert.equal(appendReviewLine("- a", "- a"), "- a");
  assert.equal(appendReviewLine("- a\n", "- b"), "- a\n- b");
  const items = writingHitChecks([{ id: "gap-ids", label: "正文含空白编号（G1…）" }], "manuscript/draft.md");
  assert.deepEqual(items[0], {
    id: "writing-gap-ids",
    kind: "writing-scan",
    status: "needs_human",
    title: "正文含空白编号（G1…）",
    target: { file: "manuscript/draft.md" },
    checker: "mesa",
  });
});
