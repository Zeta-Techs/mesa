import assert from "node:assert/strict";
import test from "node:test";
import {
  checkOutline,
  citedKeys,
  excludedKeys,
  figurePanels,
  mergeMesaChecks,
  MESA_CHECKER,
  noteStates,
  reviewKeys,
  outlineThinStatus,
} from "../src/outline-check.ts";

// 精简样例（虚构的键与题名）：三节、一张覆盖检查表、两张拼图
const OUTLINE = [
  "# 综述大纲",
  "",
  "> 覆盖声明：基于 5 篇精读笔记。人工移出的 @Zed2023 不引用。",
  "",
  "## 正式章节结构",
  "",
  "### 1 引言",
  "- 拟引用——可写正文：[@Ann2020] [@Bo2021a]；仅线索：无。",
  "- 用图计划：拼图 1（论点一）= (a) [@Ann2020] Fig.1b/f + (b) [@Bo2021a] Fig.2",
  "",
  "**2.1 机制**",
  "- 拟引用——可写正文（论证与表行）：[@Ann2020] [@Cy2019]（点名） [@Dee2024]；仅线索：[@Eve2018] [@Bo2021a]（仅摘要）。",
  "- 用图计划：拼图 2（论点二）= (a) [@Ann2020] Fig.1a–c + (b) [@Dee2024] Figs.7–8",
  "",
  "**2.2 应用**",
  "- 拟引用（可写）：[@Ann2020] [@Ghost2022]",
  "- 拟引用（线索）：[@Cy2019] [@Cy2019]",
  "- 用图计划：仅引用 [@Ann2020] Fig.1b",
  "",
  "## 覆盖检查",
  "",
  "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
  "|---|---|---|---|---|---|",
  "| 1 引言 | 2（@Ann2020 @Bo2021a） | 0 | 2021 | 够 | |",
  "| 2.1 机制 | 2 | 2（@Eve2018 @Eve2018） | 2024 | 薄 | 补读：[@Eve2018] |",
  "| 2 全章 | 5 | 2 | 2024 | 够 | |",
  "",
  "## 本轮改了什么",
  "1. 删掉 @Zed2023 那句。",
].join("\n");

const INDEX = JSON.stringify([
  { id: "10.1/ann", bibKey: "Ann2020", reviewStatus: "reviewed", fulltextStatus: "fulltext" },
  { id: "10.1/bo", bibKey: "Bo2021a", reviewStatus: "reviewed", fulltextStatus: "fulltext" },
  { id: "10.1/cy", bibKey: "Cy2019", reviewStatus: "reviewed", fulltextStatus: "fulltext" },
  { id: "10.1/dee", bibKey: "Dee2024", reviewStatus: "pending", fulltextStatus: "fulltext", skimmed: true },
  { id: "10.1/eve", bibKey: "Eve2018", reviewStatus: "pending", fulltextStatus: "fulltext", skimmed: true },
]);

const BIB = ["Ann2020", "Bo2021a", "Cy2019", "Dee2024", "Eve2018"]
  .map((k) => `@article{${k},\n  title = {T},\n  year = {${k.match(/\d{4}/)![0]}},\n}\n`)
  .join("\n");

const INCLUDED = JSON.stringify([
  { id: "10.1/ann", decision: "included" },
  { id: "10.1/zed", decision: "excluded", authors: ["Zed, Ada", "Other, B"], year: "2023", title: "被排除的一篇" },
]);

const run = () => checkOutline({ outline: OUTLINE, indexes: [INDEX], bibs: [BIB], included: INCLUDED });

test("键：认带字母后缀的键，括号注释不吃键，句末点不进键，WB₂@WS₂ 与无年份裸写不算", () => {
  assert.deepEqual(citedKeys("[@Bo2021a]（仅摘要）、[@Kim2025]（点名）"), ["Bo2021a", "Kim2025"]);
  assert.deepEqual(citedKeys("见 @Lee2021。另 WB₂@WS₂ 与 Ni@C、邮件 a@b.com"), ["Lee2021"]);
  assert.deepEqual(citedKeys("[@smith; @jones2020, p. 3]"), ["smith", "jones2020"]);
  // 化学式里的单数字（@MoS2、@TiO2、@Ni2P）、交叉引用（@fig-1、[@tbl-2]）、行内代码和代码块都不算引用键
  assert.deepEqual(citedKeys("负载在 @MoS2 与 (Pt)@TiO2、@Ni2P 上，见 @fig-1 和 [@tbl-2] 以及 `[@Fake2020]`"), []);
  assert.deepEqual(citedKeys("```markdown\n[@CodeBlock2024]\n```\n正文 [@Real2024]"), ["Real2024"]);
});

test("排除的篇：没进引文库的按第一作者姓 + 年份推键；同键已在引文库的不算", () => {
  const ex = excludedKeys(INCLUDED);
  assert.equal(ex.derived.get("zed2023"), "被排除的一篇");
  const r = checkOutline({ outline: "- 拟引用——可写正文：[@Zed2023]", bibs: ["@article{Zed2023,\n year={2023}}"], indexes: [JSON.stringify([{ bibKey: "Zed2023", reviewStatus: "reviewed", fulltextStatus: "fulltext" }])], included: INCLUDED });
  assert.equal(r.items.filter((i) => i.kind === "outline-cite").length, 0);
});

test("拦下：引了已排除的（覆盖声明里裸写 @键 也算，改动记录一节不查）、引文库里没有的键", () => {
  const blocked = run().items.filter((i) => i.status === "blocked");
  assert.deepEqual(blocked.map((i) => i.title).sort(), ["references.bib 里没有 @Ghost2022", "引了已排除的文献 @Zed2023"]);
  const zed = blocked.find((i) => i.title.includes("Zed2023"))!;
  assert.equal(zed.target?.line, 3);
  assert.ok(!zed.evidence?.detail?.includes("29"), "改动记录里那一处不算");
  assert.ok(blocked.every((i) => i.checker === MESA_CHECKER));
});

test("待你判断：分档与笔记状态不符、同一节重复列键", () => {
  const titles = run().items.filter((i) => i.status === "needs_human").map((i) => i.title);
  assert.ok(titles.includes("可写正文里列了只速读的 @Dee2024"));
  assert.ok(titles.includes("仅线索里的 @Bo2021a 已有全文精读笔记"));
  assert.ok(titles.some((t) => t.startsWith("2.2 拟引用重复列了 @Cy2019")), "两档都列、同档列两次都算重复");
  assert.ok(!titles.some((t) => t.includes("Ghost2022") && t.includes("可写正文")), "不在引文库的已拦下，不再报分档");
  assert.ok(run().items.every((i) => i.status !== "passed"));
});

test("同一块子图进了两张拼图：1b/f 与 1a–c 展开后在 1b 上重叠；仅引用不算", () => {
  assert.deepEqual(figurePanels("1b/f"), ["1b", "1f"]);
  assert.deepEqual(figurePanels("1a–c"), ["1a", "1b", "1c"]);
  assert.deepEqual(figurePanels("7–8"), ["7", "8"]);
  assert.deepEqual(figurePanels("19"), ["19"]);
  const fig = run().items.filter((i) => i.kind === "outline-figure");
  assert.equal(fig.length, 1);
  assert.match(fig[0].title, /@Ann2020 Fig\.1b 在拼图 1 和拼图 2/);
  assert.equal(fig[0].target?.line, 13);
});

test("覆盖检查：Mesa 按笔记状态数、上级节号合并下级，与 AI 写的并排；全列了的格子逐个对键", () => {
  const { rows, items } = run();
  const intro = rows.find((r) => r.label.startsWith("1 "))!;
  assert.deepEqual(intro.mesa?.writable, ["Ann2020", "Bo2021a"]);
  assert.equal(intro.mismatch, false);
  const mech = rows.find((r) => r.label.startsWith("2.1"))!;
  // 2.1：Ann、Cy 全文；Dee、Eve 只速读；Bo2021a 列在线索但已全文 → 可写正文
  assert.deepEqual(mech.mesa?.writable.sort(), ["Ann2020", "Bo2021a", "Cy2019"]);
  assert.deepEqual(mech.mesa?.hint.sort(), ["Dee2024", "Eve2018"]);
  assert.equal(mech.mesa?.latest, 2024);
  assert.equal(mech.mismatch, true);
  const all = rows.find((r) => r.label.startsWith("2 全章"))!;
  assert.equal(all.mesa?.writable.length, 3, "2 合并 2.1 与 2.2，Ghost2022 不在笔记里算线索");
  const count = items.find((i) => i.id === "outline-count-2.1")!;
  assert.match(count.title, /AI 写 2 \/ 2，Mesa 数 3 \/ 2/);
  assert.match(count.evidence?.detail ?? "", /@Eve2018 写了两次，漏了 @Dee2024/);
  assert.equal(count.target?.line, 25);
});

test("篇数对得上、键不对时标题直接写哪篇；长节名不截在英文单词中间", () => {
  const outline = [
    "**3.1 非晶系 reverse electron transfer 模型**",
    "- 拟引用——可写正文：[@Ann2020]；仅线索：[@Dee2024] [@Eve2018]。",
    "## 覆盖检查",
    "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
    "|---|---|---|---|---|---|",
    "| 3.1 非晶系 reverse electron transfer 模型 | 1 | 2（@Dee2024 @Dee2024） | 2024 | 够 | |",
  ].join("\n");
  const item = checkOutline({ outline, indexes: [INDEX], bibs: [BIB] }).items.find((i) => i.id === "outline-count-3.1")!;
  assert.equal(item.title, "覆盖检查「3.1 非晶系 reverse electron…」仅线索一格：@Dee2024 写了两次，漏了 @Eve2018");
});

test("薄节：补读点名的篇都有了全文笔记就算补料已到；补检看新笔记的 forSections", () => {
  assert.deepEqual(outlineThinStatus(OUTLINE, [INDEX]), { thin: 1, arrived: 0 });
  const later = JSON.stringify([{ bibKey: "Eve2018", reviewStatus: "reviewed", fulltextStatus: "fulltext" }]);
  assert.deepEqual(outlineThinStatus(OUTLINE, [INDEX, later]), { thin: 0, arrived: 1 }, "项目根那份更新了也算");
  const search = OUTLINE.replace("补读：[@Eve2018]", "补检：近三年工作");
  assert.deepEqual(outlineThinStatus(search, [INDEX]), { thin: 1, arrived: 0 });
  const found = JSON.stringify([{ bibKey: "New2026", reviewStatus: "reviewed", fulltextStatus: "fulltext", forSections: ["2.1"] }]);
  assert.deepEqual(outlineThinStatus(search, [INDEX, found]), { thin: 0, arrived: 1 });
  assert.equal(outlineThinStatus("# 无表"), null);
});

test("笔记合并取最靠前的状态；Mesa 核对排在核验文件前面", () => {
  const merged = noteStates([JSON.stringify([{ bibKey: "A", reviewStatus: "reviewed", fulltextStatus: "fulltext" }]), JSON.stringify([{ bibKey: "A", skimmed: true }])]);
  assert.equal(merged.get("A")?.tier, "fulltext");
  const mesa = run().items.slice(0, 1);
  assert.equal(mergeMesaChecks(null, []), null);
  const out = mergeMesaChecks({ items: [{ id: "x", kind: "k", status: "passed", title: "t" }], files: ["a.jsonl"], skipped: 1 }, mesa)!;
  assert.equal(out.items[0], mesa[0]);
  assert.equal(out.skipped, 1);

  // Mesa 核对已覆盖的确定性规则（DUP / REF / HEAD-NUM / CAP-NUM / CAP-SRC）去掉核验脚本里的重复条，其余（DOI、通过项等）照留
  const mesaDup: Parameters<typeof mergeMesaChecks>[1] = [
    { id: "draft-ref-Ghost2022", kind: "citation_resolve", status: "blocked", title: "t1", target: { file: "manuscript/draft.md", line: 3 }, checker: MESA_CHECKER },
    { id: "outline-missing-bib-OutlineGhost2021", kind: "outline-cite", status: "blocked", title: "t1b", target: { file: "outline.md", line: 4 }, checker: MESA_CHECKER },
    { id: "draft-excluded-Zed2023", kind: "citation_excluded", status: "blocked", title: "t2", target: { file: "manuscript/draft.md", line: 5 }, checker: MESA_CHECKER },
    { id: "draft-bib-dup-Ann2020", kind: "citation_duplicate", status: "blocked", title: "t3", target: { file: "references.bib" }, checker: MESA_CHECKER },
    { id: "draft-heading-number", kind: "headings", status: "blocked", title: "t4", target: { file: "manuscript/draft.md", line: 10 }, checker: MESA_CHECKER },
    { id: "draft-cap-num-Figure", kind: "caption-number", status: "blocked", title: "t5", target: { file: "manuscript/draft.md", line: 20 }, checker: MESA_CHECKER },
    { id: "draft-cap-src-Figure1-20", kind: "caption-source", status: "needs_human", title: "t6", target: { file: "manuscript/draft.md", line: 20 }, checker: MESA_CHECKER },
  ];
  const scriptItems = [
    { id: "REF-Ghost2022", kind: "citation_resolve", status: "blocked" as const, title: "dup ref", checker: "script:cite_check" },
    { id: "REF-OutlineGhost2021", kind: "citation_resolve", status: "blocked" as const, title: "dup outline ref", checker: "script:cite_check" },
    { id: "REF-Zed2023", kind: "citation_resolve", status: "blocked" as const, title: "dup excluded ref", checker: "script:cite_check" },
    { id: "REF-Bo2021a", kind: "citation_resolve", status: "passed" as const, title: "ok ref", checker: "script:cite_check" },
    { id: "DUP-Ann2020", kind: "citation_duplicate", status: "blocked" as const, title: "dup bib", checker: "script:cite_check" },
    { id: "HEAD-NUM@manuscript/draft.md", kind: "headings", status: "blocked" as const, title: "dup head", checker: "script:ms_check" },
    { id: "CAP-NUM-Figure@manuscript/draft.md", kind: "caption-number", status: "blocked" as const, title: "dup cap num", checker: "script:ms_check" },
    { id: "CAP-NUM-Table@manuscript/draft.md", kind: "caption-number", status: "passed" as const, title: "ok table num", checker: "script:ms_check" },
    { id: "CAP-SRC-Figure1-20@manuscript/draft.md", kind: "caption-source", status: "needs_human" as const, title: "dup cap src", checker: "script:ms_check" },
    { id: "DOI-Bo2021a", kind: "doi_resolve", status: "passed" as const, title: "ok doi", checker: "script:cite_check" },
  ];
  const deduped = mergeMesaChecks({ items: scriptItems, files: ["cite-refs.jsonl", "ms-check.jsonl"], skipped: 0 }, mesaDup)!;
  assert.deepEqual(
    deduped.items.filter((i) => i.checker !== MESA_CHECKER).map((i) => i.id),
    ["REF-Bo2021a", "CAP-NUM-Table@manuscript/draft.md", "DOI-Bo2021a"],
  );
});

test("拼图里用了综述的图：按笔记 bibKey 或引文库 DOI 认出 kind=review 的篇，一张拼图报一条；仅引用、研究论文不报", () => {
  const included = JSON.stringify([
    { id: "10.1/rev", kind: "review", title: "一篇综述" },
    { id: "10.1/acc", kind: "review", title: "一篇 Account" },
    { id: "10.1/res", kind: "research", title: "研究论文" },
    { id: "10.1/old", kind: "review", decision: "excluded", title: "排除的综述" },
  ]);
  const indexes = [JSON.stringify([{ id: "10.1/rev", bibKey: "Gupta2019" }, { id: "10.1/res", bibKey: "Kim2025" }])];
  const bibs = ["@article{Lee2021,\n doi = {10.1/ACC},\n year={2021}}\n@article{Kim2025,\n doi={10.1/res}}"];
  assert.deepEqual([...reviewKeys(included, indexes, bibs)].sort(), ["gupta2019", "lee2021"]);
  const outline = [
    "- 用图计划：拼图 1（论点）= (a) [@Gupta2019] Fig.1 + (b) [@Kim2025] Fig.3c",
    "- 用图计划：拼图 2（论点）= (a) [@Lee2021] Fig.2 + (b) [@Gupta2019] Fig.20 + (c) [@Kim2025] Fig.4",
    "- 用图计划：仅引用 [@Gupta2019] Fig.6a–b",
    "- 用图计划：拼图 3（论点）= (a) [@Kim2025] Fig.1a + (b) [@Kim2025] Fig.2b",
  ].join("\n");
  const fig = checkOutline({ outline, bibs, indexes, included }).items.filter((i) => i.id.startsWith("outline-review-figure-"));
  assert.deepEqual(fig.map((i) => i.title), [
    "拼图 1 用了综述里的图：@Gupta2019 Fig.1",
    "拼图 2 用了综述里的图：@Lee2021 Fig.2、@Gupta2019 Fig.20",
  ]);
  assert.ok(fig.every((i) => i.status === "needs_human" && i.checker === MESA_CHECKER));
  assert.equal(fig[1].target?.line, 2);
});
