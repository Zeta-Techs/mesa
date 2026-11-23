import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  citationFormFamily,
  citationCarryAsk,
  citationRerenderPrompt,
  currentJournal,
  isCitationStyleTask,
  journalAsk,
  journalFromSettings,
  parseTargetJournal,
  styleFamilyOf,
  CITATION_STYLE_CHOICES,
  targetJournalDoc,
  topJournals,
} from "../src/citation-style-choice.ts";

test("文献里出现最多的期刊排在前面", () => {
  const bib = `
@article{a, journal = {Nature}}
@article{b, journal = {Nature Energy}}
@article{c, journal = {nature}}
@article{d, journaltitle = {Energy Storage Materials}}
`;
  const rows = topJournals(bib);
  assert.equal(rows[0]?.name, "Nature");
  assert.equal(rows[0]?.count, 2);
  assert.equal(rows.length, 3);
});

test("初稿期刊取正文里的按期刊，不取文末选定行", () => {
  const text = "## 选定\n\n按期刊：Energy Storage Materials（Elsevier 编号制）。\n\n选定：作者-年\n";
  assert.equal(currentJournal(text), "Energy Storage Materials");
  assert.match(targetJournalDoc("Energy Storage Materials", "沿用已定"), /来源：沿用已定/);
});

test("再渲同时重做 PDF、普通 Word 和两份域稿", () => {
  const prompt = citationRerenderPrompt(journalAsk("Nature"));
  assert.match(prompt, /Nature/);
  assert.match(prompt, /作者须知/);
  assert.match(prompt, /最近 2–3 篇综述/);
  assert.match(prompt, /output\/endnote\.docx/);
  assert.match(prompt, /output\/zotero\.docx/);
  assert.doesNotMatch(prompt, /quarto/);
  const carry = citationCarryAsk("Energy Storage Materials");
  assert.match(carry, /沿用/);
  assert.match(carry, /Energy Storage Materials/);
  assert.match(citationCarryAsk(null), /先告诉我刊名/);
});

test("目标期刊文件读得出刊名", () => {
  const doc = targetJournalDoc("Nature Energy", "本次选定");
  assert.equal(parseTargetJournal(doc), "Nature Energy");
  assert.equal(parseTargetJournal("# 目标期刊\n\n还没定\n"), null);
});

// 2026-11-23 硼化物定稿：开项目时填了「目标期刊：EER」，定稿步「更换引用样式」仍没有「沿用已定」
test("项目规则里开项目时填的目标期刊读得出刊名，没填的选项提示不算", () => {
  assert.equal(journalFromSettings(["综述角度：聚焦某个子问题", "去向：投期刊（目标期刊：EER）"]), "EER");
  assert.equal(journalFromSettings(["目标期刊：Nature Energy"]), "Nature Energy");
  assert.equal(journalFromSettings(["去向：投期刊"]), null);
  assert.equal(journalFromSettings(["目标期刊：（冲高一档 / 求稳妥投；决定字数与格式）"]), null);
  assert.equal(journalFromSettings([]), null);
});

test("引用样式只有「更换」一种形态，界面认得出新旧标题", () => {
  assert.equal(isCitationStyleTask("更换引用样式"), true);
  assert.equal(isCitationStyleTask("填写引用样式"), true);
  assert.equal(isCitationStyleTask("逐条决定审查报告"), false);
});

test("样式族按 csl 正文判定", () => {
  assert.equal(styleFamilyOf('x <category citation-format="author-date"/>'), "author-date");
  assert.equal(
    styleFamilyOf('<category citation-format="numeric"/><citation><layout prefix="[" suffix="]"/></citation>'),
    "numeric-bracket",
  );
  assert.equal(
    styleFamilyOf('<category citation-format="numeric"/><citation><layout vertical-align="sup"/></citation>'),
    "numeric-superscript",
  );
  assert.equal(styleFamilyOf("<style/>"), null, "认不出来不猜");
  assert.equal(citationFormFamily("bracket"), "numeric-bracket");
  assert.equal(citationFormFamily("plain"), "author-date");
});

test("GB/T 7714（2026-11-02）：随包 csl 认作上标编号，选它时指向技能目录里的那份文件", () => {
  const csl = readFileSync("src-tauri/resources/skills/quarto-render/gbt7714-numeric.csl", "utf8");
  assert.equal(styleFamilyOf(csl), "numeric-superscript");
  assert.equal(citationFormFamily("gbt7714"), "numeric-superscript");
  assert.match(csl, /creativecommons\.org\/licenses\/by-sa\/3\.0/, "第三方 csl 保留许可声明");
  const form = CITATION_STYLE_CHOICES.flatMap((c) => [...c.forms]).find((f) => f.id === "gbt7714");
  assert.ok(form);
  assert.match(form.ask, /gbt7714-numeric\.csl/);
});
