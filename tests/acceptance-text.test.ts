import { test } from "node:test";
import assert from "node:assert/strict";
import { criterionText, readableBrief } from "../src/acceptance-text.ts";

test("criterionText：machine 条目翻成白话，人工条件原样", () => {
  const t = (c: string) => criterionText(c).text;
  assert.deepEqual(criterionText("所有产物非空"), { machine: false, text: "所有产物非空" });
  assert.equal(criterionText("machine:file:references.bib").machine, true);
  assert.equal(t("machine:count:notes/*.md>=1"), "notes/*.md 至少 1 个");
  assert.equal(t("machine:count:notes/*.md>=3::except=index.md,handoff.md"), "notes/*.md 至少 3 个（不算 index.md、handoff.md）");
  assert.equal(t("machine:file:references.bib"), "有 references.bib");
  assert.equal(t("machine:glob:papers/*.pdf"), "有符合 papers/*.pdf 的文件");
  assert.equal(t("machine:contains:notes/handoff.md::写作约束"), "notes/handoff.md 里写了「写作约束」");
  assert.equal(t("machine:contains:papers/included.md::—"), "papers/included.md 不是空的");
  assert.equal(t("machine:not-contains:a.md::TODO"), "a.md 里没有「TODO」");
  assert.equal(t("machine:records:notes/index.json::id,bibKey"), "notes/index.json 每一条都有 id、bibKey");
  assert.equal(t("machine:same-ids:papers/included.json::notes/index.json"), "papers/included.json 与 notes/index.json 的条目一一对应");
  assert.equal(t("machine:future-rule:x"), "future-rule:x");
});

test("readableBrief：技能占位写成技能名", () => {
  assert.equal(readableBrief("按 {skill:lit-notes} 技能执行"), "按 「lit-notes」技能执行");
  assert.equal(readableBrief("全程按 {skill:lit-notes} 执行"), "全程按 「lit-notes」技能 执行");
});
