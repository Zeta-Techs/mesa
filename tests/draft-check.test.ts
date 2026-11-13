import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { checkDraft, draftProgressParts, imageRefs, manuscriptCitations, pickManuscript, styleAbbreviations, supersededWritingIds } from "../src/draft-check.ts";

// 精简样例（虚构的稿件、键与题名）
const DRAFT = [
  "---",
  'title: "Mini review"',
  "number-sections: true",
  "---",
  "",
  "# Mini review",
  "",
  "## Abstract",
  "",
  "Transition metal borides (TMB) are studied here [待核实].",
  "",
  "## 1 Introduction",
  "",
  "Hydrogen evolution reaction (HER) matters [@Ann2020]. TMB catalysts [@Bo2021; @Ghost2022]. See @fig-one, @500 mA and a@b.com.",
  "",
  "## Mechanisms",
  "",
  "HER on borides [@Eve2018] and [@Zed2023]. SMSI appears here first [@Eve2018].",
  "",
  "![Figure 1](../figures/fig1.png)",
  "",
  "Figure 1. Volcano plot. Adapted from the literature.",
  "",
  "Figure 3. Something else [@Ann2020].",
  "",
  "Table 1. Comparison.",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "Table 1. Duplicate table caption.",
  "",
  "```",
  "[@InCode2020]",
  "```",
  "",
  "## Strategies",
  "",
  "[待确认] Strong metal–support interaction matters. ![](../figures/fig9.png)",
  "",
  "## Conclusions",
  "",
  "[推测] Outlook.",
  "",
].join("\n");

const BIB = ["Ann2020", "Bo2021", "Eve2018", "Ann2020"].map((k) => `@article{${k},\n  title = {T},\n  year = {2020},\n}\n`).join("\n");
const INDEX = JSON.stringify([
  { id: "1", bibKey: "Ann2020", reviewStatus: "reviewed", fulltextStatus: "fulltext" },
  { id: "2", bibKey: "Eve2018", reviewStatus: "pending", skimmed: true },
]);
const INCLUDED = JSON.stringify([{ id: "z", decision: "excluded", authors: ["Zed, Ada"], year: "2023", title: "A dropped paper" }]);
const SECTIONS = JSON.stringify([{ id: "S1", title: "Mechanisms" }, { id: "S2", title: "Strategies" }, { id: "S3", title: "Missing chapter" }]);
const STYLE = [
  "| 术语/缩写 | 写法约定 | 首次定义位置 |",
  "|---|---|---|",
  "| hydrogen evolution reaction / oxygen evolution reaction | HER、OER，首次出现给全称 | 1 引言 |",
  "| transition metal boride (TMB) | 首次全称+缩写 | 1 引言 |",
  "| strong metal–support interaction (SMSI) | 首次全称+缩写 | 4.3 |",
  "| reverse electron transfer | 保留英文原词 | 3.1 |",
].join("\n");
const OUTLINE = "拼图 7 张 + 仅引用 2 张（小结，不是计划）\n- 用图计划：拼图 1（甲）= (a) [@Ann2020] Fig.1 + (b) [@Bo2021] Fig.2\n- 用图计划：拼图 2（乙）= (a) [@Ann2020] Fig.3\n- 表计划：表 1（比较）= 列：x；行：[@Ann2020]";

const run = (kind: "writing" | "final" = "writing", text = DRAFT) =>
  checkDraft({
    kind,
    file: "manuscript/draft.md",
    text,
    bib: BIB,
    included: INCLUDED,
    index: INDEX,
    sections: SECTIONS,
    styleSheet: STYLE,
    outline: OUTLINE,
    existingImages: new Set(["figures/fig1.png"]),
  });
const byId = (id: string) => run().find((i) => i.id === id);

test("小工具：引用键同 cite_check（交叉引用、纯数字、邮箱、代码块不算）；图片路径按主稿目录解析；写作规范里的缩写", () => {
  assert.deepEqual(
    manuscriptCitations(DRAFT).map((c) => c.key),
    ["Ann2020", "Bo2021", "Ghost2022", "Eve2018", "Zed2023", "Eve2018", "Ann2020"],
  );
  assert.deepEqual(imageRefs(DRAFT, "manuscript/draft.md").map((r) => r.path), ["figures/fig1.png", "figures/fig9.png"]);
  // 图注写在 ![…] 里、带 [@键] 和方括号也认得出
  assert.deepEqual(imageRefs("![**Gap.** (a) data [@Ann2020] [n=3].](../figures/fig2.png){#fig-gap}", "manuscript/draft.md").map((r) => r.path), ["figures/fig2.png"]);
  assert.deepEqual(
    styleAbbreviations(STYLE).map((a) => `${a.abbr}|${a.full}|${a.section}`),
    ["HER|hydrogen evolution reaction|1", "OER|oxygen evolution reaction|1", "TMB|transition metal boride|1", "SMSI|strong metal–support interaction|4.3"],
  );
});

test("主稿：步骤要交的排前，过程文件与写作规范不算，只取真在的", () => {
  const listed = ["manuscript/checklist.md", "manuscript/draft.md", "manuscript/section-status.md", "manuscript/style-sheet.md", "manuscript/typeface.md"];
  assert.equal(pickManuscript(["manuscript/draft.md", "manuscript/style-sheet.md"], listed), "manuscript/draft.md");
  assert.equal(pickManuscript(["manuscript/review-final.md"], [...listed, "manuscript/review-final.md"]), "manuscript/review-final.md");
  assert.equal(pickManuscript(["manuscript/review-final.md"], ["manuscript/style-sheet.md"]), null);
  assert.equal(pickManuscript(["manuscript/chapters/*.tex"], ["manuscript/main.tex"]), null, "LaTeX 不查");
});

test("拦下：键解析不了、引了已排除的、库里重复键、手写编号 + number-sections、图表编号重复跳号、引了不存在的图", () => {
  const blocked = run().filter((i) => i.status === "blocked").map((i) => i.title).sort();
  assert.deepEqual(blocked, [
    "Figure 的编号跳号",
    "Table 的编号重复",
    "[@Ghost2022] 在引文库里找不到",
    "引了已排除的文献 @Zed2023",
    "引文库里 Ann2020 重复出现",
    "开了 number-sections 又手写了标题编号（1 处），渲染后会编两次号",
    "正文引的图 figures/fig9.png 不存在",
  ].sort());
  assert.ok(run().every((i) => i.status !== "passed" && i.checker === "mesa"));
});

test("待你判断：引了只速读的（出处数和所在节）、图注出处、待定标记汇总、节对 sections.json、缩写、大纲用图计划", () => {
  assert.equal(byId("draft-skim-Eve2018")?.title, "正文引了只速读的 @Eve2018（2 处，在 2）");
  assert.match(byId("draft-cap-src-Figure1-22")?.title ?? "", /Figure 1 的图注写了「Adapted from the literature」/);
  assert.equal(byId("draft-unsure")?.title, "还有 3 处待定标记：[待核实] 1、[待确认] 1、[推测] 1");
  assert.equal(byId("draft-sections")?.title, "稿件的节和 sections.json 对不上：缺 1 节");
  const abbr = byId("draft-abbr")!;
  assert.equal(abbr.title, "1 个缩写和写作规范对不上");
  assert.match(abbr.evidence?.detail ?? "", /SMSI：规定第 4\.3 节首次定义，第一次出现在第 2 节/);
  assert.equal(byId("draft-plan")?.title, "大纲计划的拼图 2 在稿件里没找到");
});

test("渲染会走样的写法：下标写成 _、交叉引用前多写 Tables、手写章节号、一句堆三处原图号", () => {
  const text = [
    "---",
    "number-sections: true",
    "---",
    "## Background {#sec-bg}",
    "ΔG_H* near zero and η~10~ fine [@Ann2020]. Keys like @Ann_2020x and `a_b` and $x_1$ are skipped.",
    "Values are compared in Tables @tbl-her and @tbl-oer; Section 3.3 and Sections 2.1–2.2 discuss it, @sec-bg is fine.",
    "See Fig. 7(b) of [@Ann2020], Figs. 5(d–e) of [@Bo2021], and Fig. 2 of [@Eve2018].",
    "Only Fig. 1 of [@Ann2020] here.",
  ].join("\n");
  const items = checkDraft({ kind: "writing", file: "manuscript/draft.md", text });
  const get = (id: string) => items.find((i) => i.id === id);
  assert.equal(get("draft-underscore")?.title, "1 处把下标写成了「_」（ΔG_H*）");
  assert.equal(get("draft-xref-prefix")?.status, "blocked");
  assert.equal(get("draft-xref-prefix")?.title, "交叉引用前多写了 Tables（1 处），渲染后会显示两遍");
  assert.equal(get("draft-hand-secref")?.title, "正文手写了 2 处章节号（Section 3.3 一类），其中 3.3、2.1、2.2 对不上现在的标题");
  assert.equal(get("draft-fig-pile")?.target?.line, 7);
  // 没开 number-sections 不报手写章节号
  assert.equal(checkDraft({ kind: "writing", file: "m.md", text: text.replace("number-sections: true", "toc: true") }).some((i) => i.id === "draft-hand-secref"), false);
});

test("证据面：只速读篇带数值的句子单独点出；仅摘要篇撑数值没标待核实；引用集中在一篇上", () => {
  const index = JSON.stringify([
    { id: "1", bibKey: "Ann2020", reviewStatus: "reviewed", fulltextStatus: "fulltext" },
    { id: "2", bibKey: "Eve2018", reviewStatus: "pending", skimmed: true },
    { id: "3", bibKey: "Abs2021", reviewStatus: "reviewed", fulltextStatus: "abstract-only" },
  ]);
  const paras = [
    "Tafel slopes of 75–84 mV dec^−1^ were reported [@Eve2018].",
    "Eve also studied borides broadly [@Eve2018].",
    "It reached 75 mV at 10 mA cm^−2^ [@Abs2021].",
    "The abstract reports 80 mV [@Abs2021].",
    ...Array.from({ length: 40 }, (_, i) => `Point ${i} holds [@Ann2020${i < 12 ? "" : `; @K${i}`}].`.replace("[@Ann2020; ", i < 12 ? "[@Ann2020; " : "[")),
  ];
  const items = checkDraft({ kind: "writing", file: "m.md", text: paras.join("\n\n"), index });
  const get = (id: string) => items.find((i) => i.id === id);
  assert.match(get("draft-skim-Eve2018")?.title ?? "", /，1 句带数值$/);
  assert.equal(get("draft-skim-Eve2018")?.target?.line, 1);
  assert.equal(get("draft-abstract-num-Abs2021")?.title, "只读到摘要的 @Abs2021 撑了 1 句带数值的话，句中没标 [待核实]");
  assert.equal(get("draft-abstract-num-Abs2021")?.target?.line, 5);
  assert.match(get("draft-concentration")?.title ?? "", /^@Ann2020 出现在 12 段/);
  assert.equal(get("draft-concentration")?.status, "needs_human");
});

test("定稿另拦占位；写作扫描里被取代的那两条只报一次", () => {
  const text = DRAFT.replace("[推测] Outlook.", "[推测] Outlook. Figure 4 (待绘制)");
  assert.equal(run("writing", text).some((i) => i.id === "draft-placeholder"), false);
  const fin = run("final", text);
  assert.equal(fin.find((i) => i.id === "draft-placeholder")?.status, "blocked");
  assert.deepEqual([...supersededWritingIds(fin)].sort(), ["writing-manual-numbers", "writing-placeholder-fig"]);
});

// ---------- 与随技能分发的脚本对照：同一份样例，两边拦下 / 待你判断的说法要一致 ----------

const python = process.platform === "win32" ? "python" : "python3";
const skill = (name: string, file: string) => resolve(`src-tauri/resources/skills/${name}/scripts/${file}`);
const sample = () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-draft-check-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(join(root, "manuscript/draft.md"), DRAFT);
  writeFileSync(join(root, "references.bib"), BIB);
  return root;
};
const jsonl = (root: string, name: string): { id: string; status: string }[] =>
  readFileSync(join(root, ".ccode/checks", name), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("对照 cite_check.py refs：解析不了的键、库里重复键两边一致", () => {
  const root = sample();
  try {
    const r = spawnSync(python, [skill("bib-check", "cite_check.py"), "refs", "--root", root, "--offline", "--manuscript", "manuscript/draft.md"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.ok(r.status === 1, r.stderr + r.stdout);
    const script = jsonl(root, "cite-refs.jsonl").filter((i) => i.status === "blocked").map((i) => i.id).sort();
    const mine = checkDraft({ kind: "writing", file: "manuscript/draft.md", text: DRAFT, bib: BIB })
      .filter((i) => i.kind === "citation_resolve" || i.kind === "citation_duplicate")
      .map((i) => (i.kind === "citation_duplicate" ? `DUP-${i.id.replace("draft-bib-dup-", "")}` : `REF-${i.id.replace("draft-ref-", "")}`))
      .sort();
    assert.deepEqual(mine, script);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("对照 ms_check.py：标题编号、图表编号、图注出处两边一致", () => {
  const root = sample();
  try {
    const r = spawnSync(python, [skill("research-writing", "ms_check.py"), "manuscript/draft.md", "--root", root], { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.ok(r.status === 1, r.stderr + r.stdout);
    const keep = /^(HEAD-NUM|CAP-NUM-|CAP-SRC-)/;
    const script = jsonl(root, "ms-check.jsonl")
      .filter((i) => keep.test(i.id) && i.status !== "passed")
      .map((i) => `${i.id.replace(/@.*$/, "").replace(/^CAP-SRC-(\w+?)(\d+)-\d+$/, "CAP-SRC-$1$2")}:${i.status}`)
      .sort();
    const mine = checkDraft({ kind: "writing", file: "manuscript/draft.md", text: DRAFT })
      .filter((i) => ["headings", "caption-number", "caption-source"].includes(i.kind))
      .map((i) =>
        i.kind === "headings"
          ? `HEAD-NUM:${i.status}`
          : i.kind === "caption-number"
            ? `CAP-NUM-${i.id.replace("draft-cap-num-", "")}:${i.status}`
            : `CAP-SRC-${i.id.replace(/^draft-cap-src-(\w+?\d+)-\d+$/, "$1")}:${i.status}`,
      )
      .sort();
    assert.deepEqual(mine, script);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("初稿统计行：章级标题下有正文才算已写，sections.json 里还没出标题的节算进总数", () => {
  const text = [
    "# Mini review",
    "## Introduction",
    "<!-- 最后写 -->",
    "## 1. Cathode materials",
    "Layered oxides dominate [@smith2020; @lee2021]. See @fig-map.",
    "### 1.1 Doping",
    "Doping helps [待核实].",
    "## 2. Anodes",
    "[待写]",
    "## References",
    "x",
  ].join("\n");
  const sections = JSON.stringify([{ title: "Cathode materials" }, { title: "Anodes" }, { title: "Electrolytes" }]);
  // 章：Introduction（只有注释）、Cathode（已写）、Anodes（只有占位）+ Electrolytes 还没出标题；References 不算
  assert.deepEqual(draftProgressParts(text, sections), ["已写 1 / 4 节", "引用 2 处", "待定标记 1"]);
  // 写满了只写总数；没引用、没待定标记就不列
  assert.deepEqual(draftProgressParts("# T\n## A\ntext\n## B\nmore"), ["已写 2 节"]);
  assert.equal(draftProgressParts("no headings here"), null);
});
