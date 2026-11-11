import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  headingsFromElement,
  MD_TOC_MIN,
  revealMdHeading,
  sectionAnchorForLine,
  slugifyHeading,
} from "../src/md-toc.ts";

test("slugifyHeading：汉字保留，空白折成横线，空标题回落 section", () => {
  assert.equal(slugifyHeading("方法"), "方法");
  assert.equal(slugifyHeading("1. 研究问题"), "1-研究问题");
  assert.equal(slugifyHeading("  Hello World  "), "hello-world");
  assert.equal(slugifyHeading("***"), "section");
});

test("headingsFromElement 收集标题并补 id，重复标题加序号", () => {
  const dom = new JSDOM("<div id='root'><h1>引言</h1><h2>方法</h2><h2>方法</h2><p>不是标题</p></div>");
  const root = dom.window.document.getElementById("root")!;
  const headings = headingsFromElement(root);
  assert.equal(headings.length, 3);
  assert.deepEqual(headings.map((h) => h.id), ["引言", "方法", "方法-2"]);
  assert.equal(root.querySelectorAll("h1[id], h2[id]").length, 3);
});

test("headingsFromElement 保留已有 id", () => {
  const dom = new JSDOM("<div><h1 id='keep'>标题</h1></div>");
  const root = dom.window.document.querySelector("div")!;
  assert.equal(headingsFromElement(root)[0]?.id, "keep");
});

test("revealMdHeading 展开祖先 details", () => {
  const dom = new JSDOM(
    "<div id='root'><details><summary>折</summary><h2 id='inside'>内</h2></details></div>",
  );
  const root = dom.window.document.getElementById("root")!;
  const details = root.querySelector("details")!;
  assert.equal(details.hasAttribute("open"), false);
  const el = revealMdHeading(root, "inside");
  assert.ok(el);
  assert.equal(details.hasAttribute("open"), true);
  assert.equal(revealMdHeading(root, "missing"), null);
});

test("目录门槛是 3", () => {
  assert.equal(MD_TOC_MIN, 3);
});

test("源文件某行落在哪一节：往上找最近的标题或独占一行的加粗小节名", () => {
  const md = ["# 综述大纲", "", "### 1 引言", "- 要点", "", "**2.1 碱性 HER 动力学**", "- 拟引用——可写正文：[@A]", "## 覆盖检查", "| 节 |"].join("\n");
  assert.equal(sectionAnchorForLine(md, 4), "1 引言");
  assert.equal(sectionAnchorForLine(md, 7), "2.1 碱性 HER 动力学");
  assert.equal(sectionAnchorForLine(md, 9), "覆盖检查");
  assert.equal(sectionAnchorForLine(md, 1), "综述大纲");
  assert.equal(sectionAnchorForLine("正文\n没有标题", 2), null);
});
