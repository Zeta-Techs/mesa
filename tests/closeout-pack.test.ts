import assert from "node:assert/strict";
import test from "node:test";
import {
  closeoutFigureCards,
  closeoutNoteLabel,
  closeoutNoteRows,
  closeoutPackVisible,
  closeoutScanEntries,
  groupCloseoutFiles,
  isCloseoutStep,
  isCloseoutVisible,
  type CloseoutFile,
} from "../src/closeout-pack.ts";
import { reviewPaneTabs } from "../src/step-review.ts";

function file(rel: string): CloseoutFile {
  return { rel, name: rel.split("/").pop() ?? rel, abs: `/wt/${rel}`, label: "" };
}

test("完结清单按脉络分组，渲染复制的图和样式不出现", () => {
  assert.equal(isCloseoutVisible("output/figures/fig1.png"), false);
  assert.equal(isCloseoutVisible("manuscript/citation.csl"), false);
  const groups = groupCloseoutFiles([
    file("manuscript/changelog.md"),
    file("output/figures/fig1.png"),
    file("output/endnote.docx"),
    file("references.bib"),
    file("output/review-final.pdf"),
    file("manuscript/citation-check.md"),
    file("manuscript/review-final.md"),
    file("manuscript/draft.md"),
    file("outline.md"),
    file("figures/fig1.png"),
    file("notes/lee2021.md"),
    file("papers/included.md"),
    file("output/review-final.docx"),
    file("output/zotero.docx"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.files.map((item) => item.label)]),
    [
      ["最终稿", ["定稿 PDF", "普通 Word", "EndNote 域稿", "Zotero 域稿"]],
      ["可以接着改的稿", ["定稿源稿", "初稿", "大纲"]],
      ["图", ["fig1.png"]],
      ["文献从哪来", ["纳入清单", "文献库"]],
      ["核对与修改", ["引用检查", "修改记录"]],
      ["精读笔记", ["lee2021.md"]],
    ],
  );
});

test("笔记按题名列出，并配上对应 PDF", () => {
  const rows = closeoutNoteRows(
    [file("notes/alotaibi2026probing.md"), file("notes/orphan.md")],
    [
      {
        bibKey: "alotaibi2026probing",
        notePath: "notes/alotaibi2026probing.md",
        title: "Probing compatibility of dual-salt electrolytes",
        doi: "10.1000/probe",
      },
    ],
    [{ rel: "probe.pdf", name: "10.1000_probe.pdf", abs: "/proj/10.1000_probe.pdf", label: "" }],
  );
  const probing = rows.find((row) => row.note.name.startsWith("alotaibi"));
  assert.equal(probing?.title, "Probing compatibility of dual-salt electrolytes");
  assert.equal(probing?.pdf?.name, "10.1000_probe.pdf");
  assert.equal(rows.find((row) => row.note.name === "orphan.md")?.pdf, null);
});

test("笔记文件名拆成作者、年份和题词", () => {
  assert.equal(closeoutNoteLabel("alotaibi2026probing.md"), "alotaibi 2026 probing");
  assert.equal(closeoutNoteLabel("handoff.md"), "handoff");
});

test("同一张图的说明和图片并成一条", () => {
  const cards = closeoutFigureCards([
    file("figures/fig2.md"),
    file("figures/fig1.png"),
    file("figures/fig1.md"),
    file("figures/README.md"),
    file("figures/fig10.png"),
  ]);
  assert.deepEqual(
    cards.map((item) => item.label),
    ["图 1", "图 2", "图 10", "拼图说明"],
  );
  assert.equal(cards[0]?.name, "fig1.png");
});

test("后面还有没做完的步骤时不出现完结文件", () => {
  const polish = { workspaceName: "polish", expectedArtifacts: ["output/review-final.pdf"] };
  const extra = { workspaceName: "slides", expectedArtifacts: ["slides/deck.html"] };
  assert.equal(closeoutPackVisible([polish], [true]), true);
  assert.equal(closeoutPackVisible([polish, extra], [true, false]), false);
  assert.equal(closeoutPackVisible([polish, extra], [true, true]), true);
  assert.equal(closeoutPackVisible([{ workspaceName: "draft" }], [true]), false);
});

test("完结清单在项目卡，不进评审页签", () => {
  assert.deepEqual(
    reviewPaneTabs("files", ["manuscript/review-final.md"])?.map((tab) => tab.label),
    ["稿件", "过程", "文件"],
  );
  assert.equal(isCloseoutStep({ workspaceName: "polish" }), true);
  assert.equal(isCloseoutStep({ workspaceName: "draft" }), false);
  const entries = closeoutScanEntries([
    { expectedArtifacts: ["output/review-final.pdf", "output/figures/fig1.png"] },
  ]);
  assert.ok(entries.includes("output/review-final.pdf"));
  assert.ok(entries.includes("papers/included.md"));
  assert.equal(entries.includes("output/figures/fig1.png"), false);
});

test("索引里没有的笔记（沉浸阅读建的）按来源行配 PDF、题名取 PDF 文件名", () => {
  const notes = [{ rel: "notes/A-Mg-hybrid-electrolyte.md", name: "A-Mg-hybrid-electrolyte.md", abs: "/p/notes/A-Mg-hybrid-electrolyte.md", label: "" }];
  const pdfs = [{ rel: "A Mg hybrid electrolyte.pdf", name: "A Mg hybrid electrolyte.pdf", abs: "/p/papers/A Mg hybrid electrolyte.pdf", label: "" }];
  const rows = closeoutNoteRows(notes, [], pdfs, [
    { noteName: "A-Mg-hybrid-electrolyte.md", pdfRel: "papers/A Mg hybrid electrolyte.pdf" },
  ]);
  assert.equal(rows[0].title, "A Mg hybrid electrolyte");
  assert.equal(rows[0].pdf?.abs, "/p/papers/A Mg hybrid electrolyte.pdf");
  // 来源行也没有：连字符还原成空格
  const bare = closeoutNoteRows(notes, [], pdfs);
  assert.equal(bare[0].title, "A Mg hybrid electrolyte");
  assert.equal(bare[0].pdf, null);
});
