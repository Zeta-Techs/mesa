import assert from "node:assert/strict";
import test from "node:test";
import type { IncludedRecord } from "../src/screening-review.ts";
import {
  blockerPrimaryText,
  extraDecisionsFromSummary,
  groupReviewFiles,
  isScreeningReviewFile,
  isScreeningReviewStep,
  appendEndnoteImportRecord,
  appendZoteroImportRecord,
  recordToEndnoteRis,
  recordToZoteroRis,
  appendToFetchEntry,
  matchPaperPdf,
  paperHasDoiPdf,
  pdfNameFromReason,
  displayCitationTitle,
  parseIncludedRecords,
  pendingConfirmCleared,
  arrangeScreeningRows,
  includeAllPendingJson,
  patchIncludedJsonMany,
  patchIncludedJson,
  patchIncludedMd,
  syncIncludedSummary,
  removeToFetchEntry,
  removeRisRecord,
  notePathForRecord,
  bibMentionsRecord,
  removeReason,
  restorePendingReason,
  defaultScreeningTableFilter,
  filterIncludedRecords,
  isScreeningListFile,
  preferredDiffPath,
  preferredReviewPath,
  reviewFileGroup,
  stackedReviewPaths,
  screeningCountLine,
  screeningSearchLog,
  screeningCounts,
  screeningDecisionLines,
  screeningLaterLines,
  screeningNowLine,
  shouldPrioritizeScreeningFiles,
  sortReviewPaths,
} from "../src/screening-review.ts";

test("待确认清完：每篇都是纳入或排除才算；空清单和空白判定不算", () => {
  const row = (decision: string) => ({ ...emptyRecord, id: decision, title: decision, decision });
  assert.equal(pendingConfirmCleared([row("included"), row("excluded")]), true);
  assert.equal(pendingConfirmCleared([row("included"), row("pending")]), false);
  assert.equal(pendingConfirmCleared([row("included"), row("")]), false);
  assert.equal(pendingConfirmCleared([]), false);
});

test("检索过程只取检索日志，不取验收摘要", () => {
  const text = [
    "## 验收摘要",
    "质量状态：已生成待审。",
    "### G1 问题与可行性",
    "回答后改变什么。",
    "## 检索日志",
    "| 日期 | 库 | 命中 |",
    "| --- | --- | --- |",
    "| 2026-09-24 | OpenAlex | 30 |",
    "## 逐条判定",
    "不在过程页。",
  ].join("\n");
  const log = screeningSearchLog(text);
  assert.match(log, /OpenAlex/);
  assert.doesNotMatch(log, /验收摘要|G1|逐条判定/);
  const bare = "| 库 | 命中 |\n| --- | --- |\n| PubMed | 4 |\n## 下一节\n别的";
  assert.match(screeningSearchLog(bare), /PubMed/);
  assert.doesNotMatch(screeningSearchLog(bare), /别的/);
  assert.equal(screeningSearchLog("没有表"), "");
});

test("检索步按工作区名或产物识别", () => {
  assert.equal(isScreeningReviewStep({ workspaceName: "lit-search" }), true);
  assert.equal(isScreeningReviewStep({ workspaceName: "lit-survey-search" }), true);
  assert.equal(isScreeningReviewStep({ workspaceName: "exp-run" }), false);
  assert.equal(
    isScreeningReviewStep({
      workspaceName: "custom",
      expectedArtifacts: ["papers/screening.md", "papers/included.json"],
    }),
    true,
  );
  assert.equal(
    isScreeningReviewStep({
      workspaceName: "lit-notes",
      expectedArtifacts: ["notes/*.md", "papers/included.json"],
    }),
    false,
  );
});

test("同时有 screening 与 included 时按筛选排文件", () => {
  const paths = [
    "papers/included.json",
    "scripts/build_outputs.py",
    "papers/to-fetch.md",
    "papers/included.md",
    "papers/screening.md",
    "papers/zotero-sync.md",
  ];
  assert.equal(shouldPrioritizeScreeningFiles(paths), true);
  assert.equal(shouldPrioritizeScreeningFiles(["notes/a.md", "papers/included.json"]), false);
  assert.deepEqual(sortReviewPaths(paths), [
    "papers/included.md",
    "papers/screening.md",
    "papers/to-fetch.md",
    "papers/included.json",
    "papers/zotero-sync.md",
    "scripts/build_outputs.py",
  ]);
  assert.equal(preferredReviewPath(paths), "papers/included.md");
  assert.equal(preferredDiffPath(paths), "papers/to-fetch.md");
  assert.equal(preferredDiffPath(["papers/included.md", "papers/included.json"]), null);
  assert.deepEqual(stackedReviewPaths(paths, null), [
    "papers/to-fetch.md",
    "papers/screening.md",
    "papers/zotero-sync.md",
    "scripts/build_outputs.py",
  ]);
  assert.equal(stackedReviewPaths(paths, "papers/included.md")[0], "papers/to-fetch.md");
  assert.ok(stackedReviewPaths(paths, "papers/included.md").includes("papers/included.md"));
  assert.equal(isScreeningListFile("papers/included.md"), true);
  assert.equal(isScreeningListFile("papers/screening.md"), false);
  assert.equal(preferredReviewPath(["papers/included.json", "scripts/a.py"]), "papers/included.json");
  assert.equal(reviewFileGroup("papers/included.json"), "machine");
  assert.equal(reviewFileGroup("scripts/rename_downloads.py"), "machine");
  assert.equal(reviewFileGroup(".ccode/help-wanted.md"), "machine");
  assert.equal(reviewFileGroup("artifacts/api-cache/01.json"), "machine");
  assert.equal(reviewFileGroup("enrich_metadata.py"), "machine");
  assert.equal(reviewFileGroup(".gitignore"), "machine");
  assert.equal(reviewFileGroup("papers/endnote-import.ris"), "other");
  assert.equal(isScreeningReviewFile("papers/screening.md"), true);
  assert.equal(isScreeningReviewFile("papers/to-fetch.ris"), true);
  assert.equal(isScreeningReviewFile("scripts/build_outputs.py"), false);
  assert.equal(isScreeningReviewFile("TASK.md"), false);
  assert.equal(isScreeningReviewFile(".gitignore"), false);
  const groups = groupReviewFiles(paths.map((path) => ({ path })));
  assert.deepEqual(
    groups.map((g) => [g.id, g.files.map((f) => f.path)]),
    [
      ["list", ["papers/included.md", "papers/screening.md"]],
      ["fetch", ["papers/to-fetch.md"]],
      ["machine", ["papers/included.json", "papers/zotero-sync.md", "scripts/build_outputs.py"]],
    ],
  );
});

const emptyRecord: IncludedRecord = {
  id: "",
  title: "",
  decision: "included",
  reason: "",
  authors: "",
  year: "",
  source: "",
  url: "",
  volume: "",
  issue: "",
  pages: "",
  date: "",
  epubDate: "",
  articleType: "",
  issn: "",
  journalAbbreviation: "",
  abstract: "",
  keywords: "",
  language: "",
};

test("清单题名只改显示：苹果字符和能整段拆开的化学式", () => {
  assert.equal(
    displayCitationTitle("In Situ Derived Co\uF8FFB Nanoarray: A High\u2010Efficiency 3D Catalyst"),
    "In Situ Derived Co–B Nanoarray: A High-Efficiency 3D Catalyst",
  );
  assert.equal(
    displayCitationTitle("Amorphous Cobalt Boride (Co 2 B) as a Catalyst"),
    "Amorphous Cobalt Boride (Co₂B) as a Catalyst",
  );
  assert.equal(
    displayCitationTitle("Canonic\u2010Like HER Activity of Cr 1\u2013 x Mo x B 2 Solid Solution"),
    "Canonic-Like HER Activity of Cr₁₋ₓMoₓB₂ Solid Solution",
  );
  assert.equal(
    displayCitationTitle("Hierarchical Nanostructured Co–Mo–B/CoMoO 4\u2013 x Amorphous Composite"),
    "Hierarchical Nanostructured Co–Mo–B/CoMoO₄₋ₓ Amorphous Composite",
  );
  assert.equal(
    displayCitationTitle("nickel boron by CeO x doping as a catalyst"),
    "nickel boron by CeOₓ doping as a catalyst",
  );
  assert.equal(displayCitationTitle("Novel 2D Material of MBenes"), "Novel 2D Material of MBenes");
  assert.equal(
    displayCitationTitle("Complex Cobalt-Sulfo-Boride Compound"),
    "Complex Cobalt-Sulfo-Boride Compound",
  );
  assert.equal(displayCitationTitle("current density of 2A cm \u22122"), "current density of 2 A cm⁻²");
  assert.equal(
    displayCitationTitle("Metal boride better than Pt: HCP Pd 2 B as a catalyst"),
    "Metal boride better than Pt: HCP Pd₂B as a catalyst",
  );
  assert.equal(
    displayCitationTitle("Highly Active MAB Phases Ni n +1 ZnB n ( n = 1, 2)"),
    "Highly Active MAB Phases Niₙ₊₁ZnBₙ (n = 1, 2)",
  );
  assert.equal(
    displayCitationTitle("Reversible S<sup>0</sup>/MgS<sub>x</sub> and Ca2+"),
    "Reversible S⁰/MgSₓ and Ca²⁺",
  );
  // 2026-10-11 实证回归：电荷上标允许后跟连字符形容词；<sub>/<sup> 前的排版空格吃掉
  assert.equal(
    displayCitationTitle("Deep cycling enabled by a robust Mg2+-Conducting interphase"),
    "Deep cycling enabled by a robust Mg²⁺-Conducting interphase",
  );
  assert.equal(
    displayCitationTitle("LiCl-Assisted MgCl <sub>2</sub> Solubilization Mechanism"),
    "LiCl-Assisted MgCl₂ Solubilization Mechanism",
  );
  assert.equal(
    displayCitationTitle("Mg(CF<sub>3</sub>SO<sub>3</sub>)<sub>2</sub> -Based Electrolyte"),
    "Mg(CF₃SO₃)₂-Based Electrolyte",
  );
  assert.equal(
    displayCitationTitle("Reversible S<sup>0</sup>/MgS<sub><i>x</i></sub> Redox Chemistry"),
    "Reversible S⁰/MgSₓ Redox Chemistry",
  );
  // 2026-10-11 对抗审查二轮：标识符停车、散文年份/温度不粘接、复合物电荷不翻转、双连字符不造负电荷
  assert.equal(displayCitationTitle("10.1016/s0022-0728(99)00146-1"), "10.1016/s0022-0728(99)00146-1");
  assert.equal(displayCitationTitle("DOI: 10.1039/D2EE04121A study"), "DOI: 10.1039/D2EE04121A study");
  assert.equal(displayCitationTitle("In 2020, we demonstrated"), "In 2020, we demonstrated");
  assert.equal(displayCitationTitle("At 300 K, the sample"), "At 300 K, the sample");
  assert.equal(displayCitationTitle("such as Mg2Cl3+ species"), "such as Mg₂Cl₃⁺ species");
  assert.equal(displayCitationTitle("C60--covered electrodes"), "C₆₀--covered electrodes");
  assert.equal(
    displayCitationTitle("Hexagonal MBene (Hf 2 BO 2 ): A Promising Platform"),
    "Hexagonal MBene (Hf₂BO₂): A Promising Platform",
  );
  assert.equal(
    displayCitationTitle("Crystalline β-MoB 2 Nanosheets"),
    "Crystalline β-MoB₂ Nanosheets",
  );
  assert.equal(
    displayCitationTitle("zirconium diboride (Zr1-TMB2; TM = Ni, Co, and Fe)"),
    "zirconium diboride (Zr₁₋ₓTMₓB₂; TM = Ni, Co, and Fe)",
  );
  assert.equal(displayCitationTitle("Fe2B/MXene@NF electrocatalyst"), "Fe₂B/MXene@NF electrocatalyst");
  assert.equal(
    displayCitationTitle("MBene Mo 2 ErB 3 T 2.5 (T = O, F, and Cl)"),
    "MBene Mo₂ErB₃T₂.₅ (T = O, F, and Cl)",
  );
  assert.equal(displayCitationTitle("a Current Density of 2A cm −2"), "a Current Density of 2 A cm⁻²");
  assert.equal(displayCitationTitle("CoMoO 4– x"), "CoMoO₄₋ₓ");
  assert.equal(displayCitationTitle("Ni/MoBT x for"), "Ni/MoBTₓ for");
  assert.equal(displayCitationTitle("CeO x –NiB"), "CeOₓ –NiB");
  assert.equal(displayCitationTitle("Ni n +1 ZnB n"), "Niₙ₊₁ZnBₙ");
  assert.equal(displayCitationTitle("CoxMnyB nanosheet"), "CoₓMnᵧB nanosheet");
  assert.equal(displayCitationTitle("(WB 2 -191)"), "(WB₂-191)");
  assert.equal(displayCitationTitle("TMB 12 :"), "TMB₁₂:");
  assert.equal(displayCitationTitle("Ni(OH)2/NF"), "Ni(OH)₂/NF");
  assert.equal(
    displayCitationTitle("Fe50-xMn30Cr10Co10Bx (x = 0, 3, 5, 10 at.-%)"),
    "Fe₅₀₋ₓMn₃₀Cr₁₀Co₁₀Bₓ (x = 0, 3, 5, 10 at.-%)",
  );
  assert.equal(displayCitationTitle("Y(TM1TM2)B4-Type"), "Y(TM₁TM₂)B₄-Type");
});

test("纳入 JSON 计数与待拍板去重", () => {
  const records = parseIncludedRecords(JSON.stringify({
    items: [
      { id: "doi:1", title: "A", decision: "included", reason: "对题" },
      { id: "doi:2", title: "B", decision: "pending", reason: "相邻体系" },
      { id: "skip" },
    ],
  }));
  assert.equal(records.length, 2);
  const counts = screeningCounts(records, 3);
  assert.equal(screeningCountLine(counts), "纳入 1 · 待确认 1 · 待获取 3 · 共 2 篇");
  const aliased = parseIncludedRecords(JSON.stringify([
    { id: "doi:9", title: "Short include", decision: "include", reason: "纳入" },
    { id: "doi:8", title: "Short exclude", decision: "exclude", reason: "排除" },
  ]));
  assert.deepEqual(aliased.map((row) => row.decision), ["included", "excluded"]);
  assert.equal(screeningCounts(aliased, 0).included, 1);
  const extras = extraDecisionsFromSummary(
    "1. 回答了什么：完成筛选。\n5. 需要人决定：确认 pending 项；获取付费全文；如需写 Zotero 库须另行明确授权。",
  );
  assert.deepEqual(extras, [
    "确认 pending 项",
    "获取付费全文",
    "如需写 Zotero 库须另行明确授权",
  ]);
  assert.deepEqual(screeningDecisionLines(counts, extras), [
    "确认 1 篇 pending 是否纳入",
    "获取 3 篇付费全文",
    "如需写 Zotero 库须另行明确授权",
  ]);
  assert.equal(screeningNowLine(counts), "现在：核对 1 篇待确认");
  assert.deepEqual(screeningLaterLines(counts, extras), [
    "3 篇付费全文，保存进项目后再获取",
    "如需写 Zotero 库须另行明确授权",
  ]);
  assert.equal(
    screeningNowLine({ total: 2, included: 2, pending: 0, toFetch: 0 }),
    "现在：看完纳入清单，记下筛选决定",
  );
  assert.deepEqual(parseIncludedRecords("not json"), []);
  assert.equal(
    matchPaperPdf(
      { title: "Bridging Fundamentals", id: "doi:10.1000/xyz", url: "https://doi.org/10.1000/xyz" },
      [{ name: "author-10.1000_xyz.pdf", path: "/p/a.pdf" }],
    ),
    "/p/a.pdf",
  );
  assert.equal(
    matchPaperPdf(
      { title: "Bridging Fundamentals and Practice", id: "", url: "" },
      [{ name: "bridging-fundamentals-and-practice.pdf", path: "/p/b.pdf" }],
    ),
    "/p/b.pdf",
  );
  assert.equal(
    matchPaperPdf({ title: "No Match Paper", id: "", url: "" }, [{ name: "other.pdf", path: "/p/c.pdf" }]),
    null,
  );
  assert.equal(
    paperHasDoiPdf({ id: "doi:10.1000/xyz", url: "" }, [{ name: "author-10.1000_xyz.pdf" }]),
    true,
  );
  assert.equal(
    paperHasDoiPdf({ id: "doi:10.1000/xyz", url: "" }, [{ name: "bridging-fundamentals.pdf" }]),
    false,
  );
  const named =
    "Selenium sulfide cathode with copper foam interlayer for promising magnesium electrochemistry..pdf";
  assert.equal(
    pdfNameFromReason(`待确认：已有项目PDF：${named}`),
    named,
  );
  assert.equal(
    matchPaperPdf(
      {
        title: "Selenium sulfide cathode",
        id: "",
        url: "",
        reason: `已有项目PDF：${named}`,
      },
      [{ name: named, path: "/p/papers/" + named }],
    ),
    "/p/papers/" + named,
  );
  const fetchMd = appendToFetchEntry("# 待获取全文\n\n1. Old — 10.0/aaa\n", {
    ...emptyRecord,
    id: "doi:10.0/bbb",
    title: "New Paper",
    url: "https://doi.org/10.0/bbb",
  });
  assert.match(fetchMd, /2\. New Paper — /);
  assert.equal(
    appendToFetchEntry(fetchMd, {
      ...emptyRecord,
      id: "doi:10.0/bbb",
      title: "New Paper",
      url: "https://doi.org/10.0/bbb",
    }),
    fetchMd,
  );
  const removedFetch = removeToFetchEntry(
    "1. Old — 10.0/aaa\n2. New Paper — 10.0/bbb\n3. Keep — 10.0/ccc\n",
    { ...emptyRecord, id: "doi:10.0/bbb", title: "New Paper", url: "https://doi.org/10.0/bbb" },
  );
  assert.match(removedFetch, /1\. Old/);
  assert.match(removedFetch, /3\. Keep/);
  assert.doesNotMatch(removedFetch, /New Paper/);
  assert.equal(removeToFetchEntry(removedFetch, { ...emptyRecord, id: "", title: "", url: "" }), removedFetch);
  const ris = [
    "TY  - JOUR",
    "TI  - New Paper",
    "DO  - 10.0/bbb",
    "ER  - ",
    "",
    "TY  - JOUR",
    "TI  - Keep",
    "DO  - 10.0/ccc",
    "ER  - ",
  ].join("\r\n");
  const removedRis = removeRisRecord(ris, {
    ...emptyRecord,
    id: "doi:10.0/bbb",
    title: "New Paper",
    url: "",
  });
  assert.doesNotMatch(removedRis, /New Paper/);
  assert.match(removedRis, /TI  - Keep/);
  assert.equal(removeRisRecord(removedRis, { ...emptyRecord, id: "", title: "No Such", url: "" }), removedRis);
  assert.equal(removeReason("纳入：评审确认。题目相关"), "排除：人工移出。题目相关");
  assert.equal(restorePendingReason("排除：人工移出。题目相关"), "待确认：从排除恢复。题目相关");
  assert.equal(
    notePathForRecord(JSON.stringify([{ id: "doi:1", notePath: "notes/1.md" }, { id: "doi:2", notePath: "" }]), "doi:1"),
    "notes/1.md",
  );
  assert.equal(notePathForRecord(JSON.stringify([{ id: "doi:2", notePath: "  " }]), "doi:2"), null);
  assert.equal(bibMentionsRecord("@a{x, doi = {10.1000/bbb}, title = {Other}}", { ...emptyRecord, id: "doi:10.1000/bbb", title: "New Paper", url: "" }), true);
  assert.equal(bibMentionsRecord("@a{x, title = {Something else}}", { ...emptyRecord, id: "", title: "New Paper", url: "" }), false);
  const patched = patchIncludedJson(
    JSON.stringify([{ id: "doi:2", title: "B", decision: "pending", reason: "相邻" }]),
    "doi:2",
    "included",
    "纳入：评审确认",
  );
  assert.match(patched, /"decision": "included"/);
  const md = patchIncludedMd(
    "# 筛选\n\n## Pending 清单\nB — 2026 — doi:2\n",
    "B",
    "included",
    "B — 2026 — doi:2",
  );
  assert.match(md, /## 纳入清单\nB —/);
  const titled = patchIncludedMd(
    "# 纳入文献清单\n\n终判纳入 2 篇。\n\n1. A — 2020\n",
    "B",
    "included",
    "1. B — 2021",
  );
  assert.match(titled, /终判纳入 2 篇。\n1\. B — 2021\n\n1\. A — 2020/);
  assert.equal((titled.match(/^## 纳入/m) ?? []).length, 0);
  assert.equal((md.match(/B —/g) ?? []).length, 1);
  assert.equal(defaultScreeningTableFilter(counts), "pending");
  assert.deepEqual(
    filterIncludedRecords(records, "pending").map((r) => r.title),
    ["B"],
  );
  assert.equal(defaultScreeningTableFilter({ total: 2, included: 2, pending: 0, toFetch: 0 }), "included");
  const many = patchIncludedJsonMany(
    JSON.stringify([
      { id: "doi:1", title: "A", decision: "pending", reason: "相邻" },
      { id: "doi:2", title: "B", decision: "pending", reason: "也相邻" },
      { id: "doi:3", title: "C", decision: "included", reason: "已定" },
    ]),
    ["doi:1", "doi:2"],
    "excluded",
    (previous) => `排除：评审确认。${previous}`,
  );
  const manyRows = JSON.parse(many) as { id: string; decision: string }[];
  assert.equal(manyRows[0].decision, "excluded");
  assert.equal(manyRows[1].decision, "excluded");
  assert.equal(manyRows[2].decision, "included");
  const arranged = arrangeScreeningRows(
    [
      { id: "a", if: "2.0" },
      { id: "b", if: null },
      { id: "c", if: "20" },
      { id: "d", if: "9" },
    ],
    (row) => ({ impactFactor: row.if }),
    "if-desc",
    5,
  );
  assert.deepEqual(arranged.map((row) => row.id), ["c", "d", "b"]);
  assert.deepEqual(
    arrangeScreeningRows(
      [{ id: "a", if: "1" }, { id: "b", if: "8" }],
      (row) => ({ impactFactor: row.if }),
      "listed",
      null,
    ).map((row) => row.id),
    ["a", "b"],
  );
  const all = includeAllPendingJson(JSON.stringify([
    { id: "doi:1", title: "A", decision: "included", reason: "已定" },
    { id: "doi:2", title: "B", decision: "pending", reason: "相邻" },
    { id: "doi:3", title: "C", decision: "pending", reason: "" },
  ]));
  const rows = JSON.parse(all) as { id: string; decision: string; reason: string }[];
  assert.equal(rows[0].reason, "已定");
  assert.equal(rows[1].decision, "included");
  assert.match(rows[1].reason, /^纳入：评审确认/);
  assert.equal(rows[2].decision, "included");
  assert.equal(rows[2].reason, "纳入：评审确认");
  const row = {
    ...emptyRecord,
    id: "doi:10.1016/j.jallcom.2024.1",
    title: "Fresh Paper",
    authors: "Zhang, Caicai; Xu, Ao",
    year: "2024",
    source: "Journal of Alloys and Compounds",
    url: "https://doi.org/10.1016/j.jallcom.2024.1",
    volume: "1010",
    pages: "177309",
    abstract: "Already stored at search time.",
  };
  const added = appendEndnoteImportRecord("TY  - JOUR\r\nTI  - Old\r\nER  - \r\n", row);
  assert.match(added, /AU  - Zhang, Caicai\r\nAU  - Xu, Ao/);
  assert.match(added, /DO  - 10\.1016\/j\.jallcom\.2024\.1/);
  assert.match(added, /M2  - 177309/);
  assert.match(added, /M3  - Journal Article/);
  assert.doesNotMatch(added, /JO  - /);
  assert.equal(appendEndnoteImportRecord(added, row), added);
  const zotero = appendZoteroImportRecord("", row);
  assert.match(zotero, /T2  - Journal of Alloys and Compounds/);
  assert.match(zotero, /SP  - 177309/);
  assert.doesNotMatch(zotero, /JO  - /);
  assert.doesNotMatch(zotero, /M2  - /);
  assert.doesNotMatch(zotero, /M3  - /);
  assert.equal(recordToZoteroRis(row).includes("JO  -"), false);
  assert.equal(recordToEndnoteRis(row).includes("M2  - 177309"), true);
  const marked = recordToZoteroRis({ ...row, title: "Amorphous Cobalt Boride (Co 2 B)", abstract: "Uses Co 2 B." });
  assert.match(marked, /TI  - Amorphous Cobalt Boride \(Co₂B\)/);
  assert.match(marked, /AB  - Uses Co₂B\./);
  assert.match(marked, /PY  - 2024/);
  assert.match(marked, /VL  - 1010/);
  const source = [
    "TY  - JOUR",
    "TI  - Fresh Paper",
    "AU  - Zhang, Caicai",
    "T2  - Journal of Alloys and Compounds",
    "J2  - J. Alloys Compd.",
    "PY  - 2024",
    "VL  - 1010",
    "IS  - 2",
    "SP  - 177309",
    "EP  - 177320",
    "SN  - 0925-8388",
    "DO  - 10.1016/j.jallcom.2024.1",
    "AB  - Sulfur rich spheres.",
    "ER  - ",
  ].join("\n");
  const thin = { ...row, volume: "", pages: "", abstract: "" };
  const copied = appendEndnoteImportRecord("", thin, source);
  assert.match(copied, /VL  - 1010/);
  assert.match(copied, /M2  - 177309/);
  assert.match(copied, /J2  - J\. Alloys Compd\./);
  assert.match(copied, /AB  - Sulfur rich spheres\./);
  assert.match(copied, /M3  - Journal Article/);
});

test("纳入清单开头的篇数按 json 现数改，文献行不动", () => {
  const md = [
    "# 纳入文献清单",
    "终判纳入 **337** 篇（另有待确认 15 篇）。",
    "1. Alpha paper — Smith — 2020",
    "2. 待确认的那篇 — Lee — 2021",
  ].join("\n");
  const records = [
    { ...emptyRecord, title: "Alpha paper", decision: "included" as const },
    { ...emptyRecord, title: "Beta", decision: "excluded" as const },
  ];
  const next = syncIncludedSummary(md, records);
  assert.match(next, /终判纳入 \*\*1\*\* 篇（另有待确认 0 篇）/);
  assert.match(next, /1\. Alpha paper/);
  assert.match(next, /2\. 待确认的那篇/);
});

test("Git 拦截直接写原因，不报问题计数", () => {
  assert.equal(blockerPrimaryText([]), "");
  assert.equal(
    blockerPrimaryText([{ text: "主文件夹里还有没保存的改动" }]),
    "主文件夹里还有没保存的改动",
  );
  assert.equal(
    blockerPrimaryText([
      { text: "主文件夹里还有没保存的改动" },
      { text: "与主分支存在冲突" },
    ]),
    "主文件夹里还有没保存的改动（另有 1 项）",
  );
});
