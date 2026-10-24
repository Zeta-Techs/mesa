import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { docThumbKind, docTypeLabel, htmlPageThumb, sheetThumbHtml } from "../src/doc-thumb.ts";

test("附件预览：PDF / Word / 表格能出预览，csv 与 PPT、旧版 doc 不出", () => {
  assert.equal(docThumbKind("/a/论文.PDF"), "pdf");
  assert.equal(docThumbKind("C:\\a\\报告.docx"), "docx");
  assert.equal(docThumbKind("/a/data.xlsx"), "sheet");
  assert.equal(docThumbKind("/a/old.xls"), "sheet");
  assert.equal(docThumbKind("/a/data.csv"), null);
  assert.equal(docThumbKind("/a/talk.pptx"), null);
  assert.equal(docThumbKind("/a/old.doc"), null);
  assert.equal(docThumbKind("/a/README"), null);
});

test("文件卡类型字", () => {
  assert.equal(docTypeLabel("/a/x.pdf"), "PDF");
  assert.equal(docTypeLabel("/a/x.doc"), "Word 文档");
  assert.equal(docTypeLabel("/a/x.xlsx"), "Excel 表格");
  assert.equal(docTypeLabel("/a/x.pptx"), "PPT 演示");
  assert.equal(docTypeLabel("/a/x.zip"), "ZIP");
  assert.equal(docTypeLabel("/a/Makefile"), "文件");
});

test("表格预览：单元格转义，行列截断", () => {
  const html = sheetThumbHtml([["<b>", "a&b"], ["1", "2", "3"]], 1, 1);
  assert.equal(html, "<table><tr><td>&lt;b&gt;</td></tr></table>");
});

test("一段 HTML 排进一张纸：出 SVG 图片地址，块数封顶", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, XMLSerializer: g.XMLSerializer };
  g.document = dom.window.document;
  g.XMLSerializer = dom.window.XMLSerializer;
  try {
    const url = htmlPageThumb(`<h1>标题</h1>${"<p>段</p>".repeat(80)}<table><tr><td>x</td></tr></table>`);
    assert.match(url, /^data:image\/svg\+xml;charset=utf-8,/);
    const svg = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    assert.match(svg, /<foreignObject[^>]*><div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/);
    assert.match(svg, /标题/);
    assert.equal((svg.match(/<p>/g) ?? []).length, 39, "只留前 40 块");
    assert.doesNotMatch(svg, /<table/);
  } finally {
    g.document = saved.document;
    g.XMLSerializer = saved.XMLSerializer;
  }
});
