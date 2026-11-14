import assert from "node:assert/strict";
import test from "node:test";
import { checkBatchNote, checkChipText, checkConsultSeed, checkNoted, checkReviewNote, checkLocation, checkQuoteLine, countChecks, groupChecks, type CheckItem } from "../src/research-checks.ts";

const mk = (id: string, status: CheckItem["status"], extra: Partial<CheckItem> = {}): CheckItem => ({
  id,
  kind: "quote_in_source",
  status,
  title: id,
  ...extra,
});

test("核验清单：拦下在前、待你判断其次、通过最后；待你判断不折进通过", () => {
  const items = [mk("a", "passed"), mk("b", "needs_human"), mk("c", "blocked"), mk("d", "passed")];
  assert.deepEqual(
    groupChecks(items).map((g) => [g.status, g.items.map((i) => i.id)]),
    [["blocked", ["c"]], ["needs_human", ["b"]], ["passed", ["a", "d"]]],
  );
  assert.deepEqual(countChecks(items), { passed: 2, blocked: 1, needsHuman: 1 });
  assert.equal(checkChipText(items), "核验 4 项 · 拦下 1 · 待你判断 1");
  assert.equal(checkChipText([mk("a", "passed")]), "核验 1 项 · 通过");
  assert.equal(checkChipText([mk("a", "passed"), mk("b", "needs_human")]), "核验 2 项 · 待你判断 1");
});

test("核验清单：位置与摘录的写法", () => {
  assert.equal(checkLocation(mk("a", "passed", { target: { file: "manuscript/x.md", line: 3 } })), "manuscript/x.md:3");
  assert.equal(checkLocation(mk("a", "passed", { target: { file: "references.bib" } })), "references.bib");
  assert.equal(checkLocation(mk("a", "passed")), "");
  assert.equal(checkQuoteLine(mk("a", "passed", { evidence: { quote: "原句", page: 12 } })), "「原句」（标注 p.12）");
  assert.equal(checkQuoteLine(mk("a", "passed", { evidence: { quote: " 原句 " } })), "「原句」");
  assert.equal(checkQuoteLine(mk("a", "passed", { evidence: { detail: "x" } })), "");
});

test("请几家研讨这一条：标题、落点、摘录、说明进问题；落点前后 15 行与来源文件进材料", () => {
  const seed = checkConsultSeed(
    mk("c1", "needs_human", {
      title: "这句引用摘录撑不住正文的论断",
      target: { file: "manuscript/draft.md", line: 10 },
      evidence: { source: "notes/smith2020.md", quote: "effects were modest", page: 4, detail: "摘录说的是小效应" },
    }),
  );
  assert.match(seed.question, /这句引用摘录撑不住正文的论断/);
  assert.match(seed.question, /位置：manuscript\/draft\.md:10/);
  assert.match(seed.question, /「effects were modest」（标注 p\.4）/);
  assert.match(seed.question, /判断由我来定/);
  assert.deepEqual(seed.materials, [
    { path: "manuscript/draft.md", range: "1-25" },
    { path: "notes/smith2020.md", range: "" },
  ]);
  const web = checkConsultSeed(mk("c2", "needs_human", { evidence: { source: "https://doi.org/x.pdf" } }));
  assert.deepEqual(web.materials, []);
});

test("核验一条加进意见：标题 + 位置，写成能照着改的一句", () => {
  assert.equal(
    checkReviewNote({ id: "a", kind: "k", status: "needs_human", title: "可写正文里列了只速读的 @Moloudi2022", target: { file: "outline.md", line: 96 } }),
    "- 可写正文里列了只速读的 @Moloudi2022（outline.md:96）：请改",
  );
  assert.equal(checkReviewNote({ id: "b", kind: "k", status: "blocked", title: "缺键" }), "- 缺键：请改");
});

test("全部加进意见：只带拦下和待你判断，开头一句要 AI 逐条判断、不照单全改；按标题认已加过", () => {
  const items: CheckItem[] = [
    { id: "a", kind: "k", status: "blocked", title: "缺键 @A", target: { file: "outline.md", line: 4 } },
    { id: "b", kind: "k", status: "needs_human", title: "重复 @B" },
    { id: "c", kind: "k", status: "passed", title: "通过的" },
  ];
  const note = checkBatchNote(items);
  assert.equal(note.split("\n").length, 3);
  assert.match(note.split("\n")[0], /逐条判断/);
  assert.ok(note.includes("- 缺键 @A（outline.md:4）") && note.includes("- 重复 @B") && !note.includes("通过的"));
  assert.equal(checkBatchNote([items[2]]), "");
  assert.ok(checkNoted(note, items[0]));
  assert.ok(checkNoted(checkReviewNote(items[1]), items[1]));
  assert.ok(!checkNoted(note, items[2]));
  // 同标题不同文件（如三张示意图的 REBUILD / COLD-READ）只认各自的位置，不串台
  const fig1: CheckItem = { id: "REBUILD", kind: "schematic_rebuild", status: "blocked", title: "图纸重建出的 SVG 与现有文件不一致", target: { file: "figures/fig1/fig1.svg" } };
  const fig2: CheckItem = { ...fig1, target: { file: "figures/fig2/fig2.svg" } };
  const fig1Note = checkReviewNote(fig1);
  assert.ok(checkNoted(fig1Note, fig1));
  assert.ok(!checkNoted(fig1Note, fig2));
});
