import assert from "node:assert/strict";
import test from "node:test";
import { buildSpotCheckPrompt, spotCheckFocus, spotQuote, type SpotCheckItem } from "../src/spot-check.ts";

const items: SpotCheckItem[] = [
  { notePath: "notes/012-镁正极.md", fulltext: true, id: "p12" },
  { notePath: "notes\\020-电解液.md", fulltext: false, id: "p20" },
  { notePath: "notes/031-界面.md", fulltext: true, id: "p31" },
];

test("抽查问题单：按篇分组、带出处，没问题的篇不出现，空说明给兜底一句", () => {
  const prompt = buildSpotCheckPrompt(items, [
    { item: 0, source: "pdf", page: 3, quote: "capacity of 250 mAh/g", comment: "笔记写成 205" },
    { item: 2, source: "note", page: null, quote: "图 4 显示循环 500 圈", comment: "" },
    { item: 0, source: "note", page: null, quote: "一句话总结", comment: "结论反了" },
  ]);
  assert.match(prompt, /抽查了 3 篇/);
  assert.match(prompt, /1\. notes\/012-镁正极\.md（全文精读）/);
  assert.match(prompt, /原文第 3 页「capacity of 250 mAh\/g」：笔记写成 205/);
  assert.match(prompt, /笔记「一句话总结」：结论反了/);
  assert.match(prompt, /2\. notes\/031-界面\.md（全文精读）/);
  assert.match(prompt, /没写说明，请对照原文判断/);
  assert.doesNotMatch(prompt, /020-电解液/);
  // 同篇两条挂在同一编号下，不另起一篇
  assert.equal(prompt.match(/012-镁正极/g)?.length, 1);
  // 要求改这几篇、保留用户内容、复查同类
  assert.match(prompt, /「标注」「译段」「我的想法」原样保留/);
  assert.match(prompt, /复查其他已写的笔记/);
});

test("抽查：仅摘要的篇看的是有没有写成读过全文；划段折叠空白并限长", () => {
  assert.match(spotCheckFocus(false), /摘要以外/);
  assert.match(spotCheckFocus(true), /图号/);
  assert.equal(spotQuote("  a\n  b\tc  "), "a b c");
  assert.equal(spotQuote("x".repeat(400)).length, 301);
});
