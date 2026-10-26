import assert from "node:assert/strict";
import test from "node:test";
import { delimitedRows, hasFileThumb, textThumbHtml, textThumbKind } from "../src/file-thumb.ts";

test("按文字出缩略图的类型：文章 / 代码 / CSV / TSV，PPT 和未知后缀不读", () => {
  assert.equal(textThumbKind("notes/a.md"), "prose");
  assert.equal(textThumbKind("refs.bib"), "prose");
  assert.equal(textThumbKind("scripts/clean.PY"), "code");
  assert.equal(textThumbKind("data.csv"), "csv");
  assert.equal(textThumbKind("data.tsv"), "tsv");
  assert.equal(textThumbKind("slides.pptx"), null);
  assert.equal(textThumbKind("Makefile"), null);
});

test("能不能出缩略图：图片、PDF / Word / 表格、文字都能，PPT、压缩包不能", () => {
  for (const p of ["a.png", "a.pdf", "a.docx", "a.xlsx", "a.md", "a.csv", "a.py"]) assert.ok(hasFileThumb(p), p);
  for (const p of ["a.pptx", "a.zip", "a.doc"]) assert.equal(hasFileThumb(p), false, p);
});

test("CSV 开头几行拆格子：跳空行、去两端引号、行数封顶", () => {
  assert.deepEqual(delimitedRows('a,b\n\n"x", y\n', ","), [["a", "b"], ["x", "y"]]);
  assert.equal(delimitedRows(Array.from({ length: 50 }, (_, i) => `${i}`).join("\n"), ",", 5).length, 5);
});

test("文字缩略图：只取开头几行、转义尖括号，代码用等宽", () => {
  const html = textThumbHtml("<b>1</b>\n2\n3", "code", 2);
  assert.match(html, /&lt;b&gt;1&lt;\/b&gt;\n2</);
  assert.doesNotMatch(html, /\n3/);
  assert.match(html, /monospace/);
  assert.doesNotMatch(textThumbHtml("正文", "prose"), /monospace/);
});
