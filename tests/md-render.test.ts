import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import {
  lexMarkdownDocument,
  matchFootnoteDef,
  renderMarkdownDocument,
  splitMdFrontmatter,
} from "../src/md-render.ts";
import { mdBlocks } from "../src/md-block-map.ts";
import { sanitizeDocumentHtml } from "../src/document-html.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as { window?: typeof dom.window }).window = dom.window;

const QMD = `---
title: "My Paper"
format: pdf
bibliography: references.bib
---

# Intro

Text [@smith2020] and footnote[^1].

[^1]: note *here*
`;

test("YAML 头拆成字段，不再渲染成横线 + 二级标题", () => {
  const doc = splitMdFrontmatter(QMD);
  assert.ok(doc.front);
  assert.deepEqual(
    doc.front!.fields.map((f) => [f.key, f.value]),
    [
      ["title", "My Paper"],
      ["format", "pdf"],
      ["bibliography", "references.bib"],
    ],
  );
  // 拆掉 5 行头 + 1 行空行，正文从第 7 行开始
  assert.equal(doc.lineOffset, 6);
  assert.ok(doc.body.startsWith("# Intro"));
  const html = renderMarkdownDocument(doc.body);
  assert.doesNotMatch(html, /<hr>\s*<h2>/);
  assert.match(html, /<h1>Intro<\/h1>/);
});

test("文首分隔线 + 正文不是 YAML 头", () => {
  const text = "---\n就是一段话\n---\n\n正文";
  const doc = splitMdFrontmatter(text);
  assert.equal(doc.front, null);
  assert.equal(doc.body, text);
  assert.equal(doc.lineOffset, 0);
});

test("CRLF 与 BOM 文件也能拆", () => {
  const doc = splitMdFrontmatter("﻿---\r\ntitle: x\r\n---\r\nbody\r\n");
  assert.equal(doc.front?.fields[0]?.value, "x");
  assert.equal(doc.lineOffset, 3);
  assert.equal(doc.body, "body\n");
});

test("脚注：正文上标编号，定义收到文末并带回跳", () => {
  const html = sanitizeDocumentHtml(
    renderMarkdownDocument("甲[^b] 乙[^a] 再提[^b]\n\n[^a]: 第一条\n[^b]: 第二条 **粗**\n"),
  );
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;
  const refs = [...host.querySelectorAll(".md-fn-ref a")].map((a) => a.textContent);
  assert.deepEqual(refs, ["1", "2", "1"]);
  const items = [...host.querySelectorAll(".md-footnotes li")];
  assert.equal(items.length, 2);
  assert.equal(items[0]!.id, "fn-b");
  assert.match(items[0]!.innerHTML, /<strong>粗<\/strong>/);
  assert.ok(items[0]!.querySelector("a.md-fn-back"));
  // 定义行本身不再出现在正文里
  assert.doesNotMatch(host.textContent ?? "", /\[\^a\]:/);
});

test("没被引用的脚注定义照样列出，不吞字", () => {
  const html = renderMarkdownDocument("正文\n\n[^x]: 孤立的说明\n");
  assert.match(html, /孤立的说明/);
});

test("脚注只在文档模式生效：聊天等普通 parse 原样保留", () => {
  const html = marked.parse("说明[^1]\n\n[^1]: 原文\n", { async: false }) as string;
  // 与接入前一致（marked 自己把它当链接定义），不出上标、不出脚注节
  assert.doesNotMatch(html, /md-fn-ref|md-footnotes/);
});

test("多行缩进续行属于同一条脚注", () => {
  const m = matchFootnoteDef("[^n]: 第一行\n    第二行\n\n    第二段\n后文");
  assert.ok(m);
  assert.equal(m!.id, "n");
  assert.equal(m!.text, "第一行\n第二行\n\n第二段");
});

test("块映射与文档渲染同口径：脚注定义不占顶层元素", () => {
  const src = "# 标题\n\n段落[^1]\n\n[^1]: 注\n\n末段\n";
  const blocks = mdBlocks(src).filter((b) => b.tag !== null);
  assert.deepEqual(
    blocks.map((b) => [b.tag, b.line]),
    [
      ["h1", 1],
      ["p", 3],
      ["p", 7],
    ],
  );
  assert.ok(lexMarkdownDocument(src).some((t) => t.type === "footnoteDef"));
});
