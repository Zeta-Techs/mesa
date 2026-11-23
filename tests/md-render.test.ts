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

test("Pandoc 上下标：~sub~ 与 ^sup^ 渲染为 <sub>/<sup>，不再把化学式画成删除线", () => {
  const src =
    "oxo-borate (BO~3~^3−^ or B(OH)~4~^−^), (^11^B-NMR), M~10~(BO~3~)~2~(OH)~14~, η~10~ = 174 mV, |ΔG~H\\*~| = 0.249 eV, Ar^+^, SCN^−^, 0.29 mmol L^−1^, ~~删除线~~, ~10 mV and ~20 mV.";
  const html = sanitizeDocumentHtml(renderMarkdownDocument(src));
  assert.doesNotMatch(html, /<del>10<\/del>|<del>3<\/del>|<del>H\*<\/del>/);
  assert.match(html, /<del>删除线<\/del>/);
  assert.match(html, /BO<sub>3<\/sub><sup>3−<\/sup>/);
  assert.match(html, /B\(OH\)<sub>4<\/sub><sup>−<\/sup>/);
  assert.match(html, /\(<sup>11<\/sup>B-NMR\)/);
  assert.match(html, /M<sub>10<\/sub>\(BO<sub>3<\/sub>\)<sub>2<\/sub>\(OH\)<sub>14<\/sub>/);
  assert.match(html, /η<sub>10<\/sub> = 174 mV/);
  assert.match(html, /\|ΔG<sub>H\*<\/sub>\| = 0\.249 eV/);
  assert.match(html, /Ar<sup>\+<\/sup>/);
  assert.match(html, /SCN<sup>−<\/sup>/);
  assert.match(html, /L<sup>−1<\/sup>/);
  assert.match(html, /~10 mV and ~20 mV/);
});

test("Quarto 标题属性、表题、带引文图注、交叉引用与 ::: {#refs} 渲染干净且块映射对齐", () => {
  const src = [
    "## Abstract {.unnumbered}",
    "",
    "Overview of @sec-intro–@sec-scale and (@fig-1) and Table @tbl-1 on NiCoFeB@NiNC.",
    "",
    "## Introduction {#sec-intro}",
    "",
    "See Section @sec-scale.",
    "",
    "### Three-Tier Evidence Scale {#sec-scale}",
    "",
    "| Class | Value |",
    "|---|---|",
    "| Boride | H~2~O |",
    "",
    ": Diagnostic criteria for working-state borides (BO~3~^3−^). {#tbl-1}",
    "",
    '![Schematic overview of BO~2~^−^ [FTIR] from [@Lu2024; @Wang2026].](../figures/fig1/fig1.png){#fig-1 out-width="100%"}',
    "",
    "::: {#refs}",
    ":::",
  ].join("\n");

  const html = sanitizeDocumentHtml(renderMarkdownDocument(src));
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;

  // 1. 标题属性剥除 + id 与章节编号保留
  const h2s = [...host.querySelectorAll("h2")];
  assert.equal(h2s[0]?.textContent, "Abstract");
  assert.equal(h2s[0]?.getAttribute("data-sec-num"), null);
  assert.equal(h2s[1]?.id, "sec-intro");
  assert.equal(h2s[1]?.textContent, "Introduction");
  assert.equal(h2s[1]?.getAttribute("data-sec-num"), "1");
  const h3 = host.querySelector("h3")!;
  assert.equal(h3.id, "sec-scale");
  assert.equal(h3.textContent, "Three-Tier Evidence Scale");
  assert.equal(h3.getAttribute("data-sec-num"), "1.1");

  // 2. 交叉引用变成页内锚点链接，化学式里的 @NiNC 不误判
  const xrefs = [...host.querySelectorAll("a.md-xref")].map((a) => [
    a.getAttribute("href"),
    a.textContent,
  ]);
  assert.deepEqual(xrefs, [
    ["#sec-intro", "Section 1"],
    ["#sec-scale", "Section 1.1"],
    ["#fig-1", "Figure 1"],
    ["#tbl-1", "1"],
    ["#sec-scale", "1.1"],
  ]);
  assert.match(host.textContent ?? "", /NiCoFeB@NiNC/);

  // 3. 表题去掉前导冒号与 {#tbl-1}，带 Table 1. 前缀与上下标
  const tblCap = host.querySelector("p.md-table-caption")!;
  assert.equal(tblCap.id, "tbl-1");
  assert.match(tblCap.innerHTML, /<span class="md-caption-label">Table 1\.<\/span>/);
  assert.match(tblCap.innerHTML, /BO<sub>3<\/sub><sup>3−<\/sup>/);
  assert.doesNotMatch(tblCap.textContent ?? "", /\{#tbl-1\}|^:/);

  // 4. 含嵌套方括号 [FTIR] / [@Lu2024] 的 Quarto 图块正常解析成 <img + 图注>
  const fig = host.querySelector("p.md-figure")!;
  assert.equal(fig.id, "fig-1");
  const img = fig.querySelector("img")!;
  assert.equal(img.getAttribute("src"), "../figures/fig1/fig1.png");
  const figCap = fig.querySelector(".md-fig-caption")!;
  assert.match(figCap.innerHTML, /<span class="md-caption-label">Figure 1\.<\/span>/);
  assert.match(figCap.innerHTML, /BO<sub>2<\/sub><sup>−<\/sup>/);
  assert.doesNotMatch(fig.textContent ?? "", /out-width/);

  // 5. ::: {#refs} 围栏不渲染可见乱码，也不破坏块映射
  assert.doesNotMatch(host.textContent ?? "", /:::/);
  const blocks = mdBlocks(src).filter((b) => b.tag !== null);
  assert.equal(blocks.length, host.children.length);
});
