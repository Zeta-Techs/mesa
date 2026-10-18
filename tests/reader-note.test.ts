import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  NOTE_ANNOT_QUOTE_MAX,
  annotationSavedToast,
  buildNoteDraftPrompt,
  findPdfRefs,
  formatNoteAnnotation,
  normalizeAnnotationQuote,
  noteDraftEmpty,
  parseNoteAnnotations,
  quoteFromAnnotationText,
  quoteFromTranslationBlock,
} from "../src/reader-note.ts";

test("摘句归一与 reader.rs annotation_quote 同口径", () => {
  assert.equal(
    normalizeAnnotationQuote("electro-\n  chemical  「window」\nopen"),
    "electro-chemical “window” open",
  );
  assert.equal(normalizeAnnotationQuote("pages 3-\n5"), "pages 3- 5");
  assert.equal(Array.from(normalizeAnnotationQuote("字".repeat(800))).length, NOTE_ANNOT_QUOTE_MAX);
});

test("标注行格式与解析往返；只认「## 标注」小节里的行", () => {
  assert.equal(formatNoteAnnotation(3, "the cell"), "- p.3 「the cell」");
  assert.equal(
    formatNoteAnnotation(12, "Mg anode", "  这里\n存疑 "),
    "- p.12 「Mg anode」 —— 这里 存疑",
  );
  const text = [
    "# 标题",
    "",
    "## 可引用点",
    "- p.9 「不在标注小节」",
    "",
    "## 标注",
    "",
    "- p.3 「the cell」",
    "- p.12 「Mg anode」 —— 这里「钝化」说法存疑",
    "- 手写的别的东西",
    "* p 7 「宽松写法」",
    "",
    "## 译段",
    "- p.5 「也不算」",
  ].join("\n");
  assert.deepEqual(parseNoteAnnotations(text), [
    { page: 3, quote: "the cell", comment: "", line: 8 },
    { page: 12, quote: "Mg anode", comment: "这里「钝化」说法存疑", line: 9 },
    { page: 7, quote: "宽松写法", comment: "", line: 11 },
  ]);
});

test("八小节全空才算空笔记；写过内容/自由格式都不算", () => {
  const template =
    "# T\n\n> 来源：papers/a.pdf · 开始阅读 2026-10-18\n\n## 一句话总结\n\n## 研究问题\n\n## 方法\n\n## 主要结果\n\n## 局限\n\n## 可引用点\n\n## 与本课题的关系\n\n## 疑问与待跟进\n\n## 译段\n\n> x（第 2 页）\n\n甲\n\n## 我的想法\n测试\n";
  assert.equal(noteDraftEmpty(template), true);
  assert.equal(noteDraftEmpty(template.replace("## 方法\n\n", "## 方法\n\n电解液配方……\n\n")), false);
  assert.equal(noteDraftEmpty("# 自由笔记\n\n随便记点\n"), false);
  // 小节里只有三级标题不算正文
  assert.equal(noteDraftEmpty("## 方法\n\n### 子节\n"), true);
});

test("起草指令点名 PDF、笔记与要保留的机管小节", () => {
  const p = buildNoteDraftPrompt("/p/papers/a.pdf", "/p/notes/a.md");
  assert.match(p, /lit-notes/);
  assert.match(p, /\/p\/papers\/a\.pdf/);
  assert.match(p, /\/p\/notes\/a\.md/);
  assert.match(p, /「标注」「译段」「我的想法」/);
});

test("标注 toast：编辑态有未保存改动时明说", () => {
  assert.equal(annotationSavedToast(false, false), "已高亮，记在笔记「标注」里");
  assert.match(annotationSavedToast(true, true), /批注.*保存后可见/);
});

test("页码/图表引用识别", () => {
  const pick = (t: string) =>
    findPdfRefs(t).map((r) => [t.slice(r.start, r.end), r.page ?? r.figure ?? r.table]);
  assert.deepEqual(pick("见 p.3 与 pp. 12–14，Fig. 2a 和 Table 1"), [
    ["p.3", 3],
    ["pp. 12–14", 12],
    ["Fig. 2a", "2a"],
    ["Table 1", "1"],
  ]);
  assert.deepEqual(pick("（第 2 页）如图 3 所示，表 4；Figure 10；page 7"), [
    ["第 2 页", 2],
    ["图 3", "3"],
    ["表 4", "4"],
    ["Figure 10", "10"],
    ["page 7", 7],
  ]);
  // 单词中间的 p. 不算；Table I 罗马数字
  assert.deepEqual(pick("app.3 Sup. 4 Table IV"), [["Table IV", "IV"]]);
});

test("摘句提取：标注行「」之间、译段引用块去掉页码尾", () => {
  assert.equal(quoteFromAnnotationText("p.3 「the cell」 —— 批注"), "the cell");
  assert.equal(quoteFromAnnotationText("没有引号"), "");
  assert.equal(
    quoteFromTranslationBlock("The electrolytes were\nprepared（第 2 页）"),
    "The electrolytes were prepared",
  );
});

test("md 阅读视图链接化：幂等、跳过代码与链接、带上标注/译段原文", async () => {
  const dom = new JSDOM("<div id='h'></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, NodeFilter: g.NodeFilter, Element: g.Element };
  g.document = dom.window.document;
  g.NodeFilter = dom.window.NodeFilter;
  g.Element = dom.window.Element;
  try {
    const { linkifyPdfRefs, pdfRefFromTarget } = await import("../src/md-pdf-refs.ts");
    const host = dom.window.document.getElementById("h")!;
    host.innerHTML = [
      "<p>结果见 Fig. 2 和 <code>p.9</code>，<a href='#'>p.8</a></p>",
      "<ul><li>p.3 「the cell」 —— 批注</li></ul>",
      "<blockquote><p>The electrolytes were prepared（第 2 页）</p></blockquote>",
    ].join("");
    linkifyPdfRefs(host);
    linkifyPdfRefs(host);
    const refs = Array.from(host.querySelectorAll<HTMLElement>(".md-pdf-ref"));
    assert.deepEqual(
      refs.map((r) => r.textContent),
      ["Fig. 2", "p.3", "第 2 页"],
    );
    assert.deepEqual(pdfRefFromTarget(refs[0]), { figure: "2", label: "Fig. 2" });
    assert.deepEqual(pdfRefFromTarget(refs[1]), { page: 3, quote: "the cell", label: "p.3" });
    assert.deepEqual(pdfRefFromTarget(refs[2]), {
      page: 2,
      quote: "The electrolytes were prepared",
      label: "第 2 页",
    });
    assert.equal(pdfRefFromTarget(host.querySelector("code")), null);
  } finally {
    g.document = saved.document;
    g.NodeFilter = saved.NodeFilter;
    g.Element = saved.Element;
    dom.window.close();
  }
});
