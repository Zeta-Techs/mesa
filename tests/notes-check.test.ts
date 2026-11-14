import assert from "node:assert/strict";
import test from "node:test";
import { checkNotes, isUntouchedNote, noteFulltextClaim, noteSections, normNotePath, NOTE_SECTIONS } from "../src/notes-check.ts";

// 精简样例（虚构的键、题名与笔记）
const full = (title: string, status: string, skip: string[] = []) =>
  [`# ${title}`, "", "> 来源：papers/x.pdf", "", status, "", ...NOTE_SECTIONS.filter((s) => !skip.includes(s)).flatMap((s) => [`## ${s}`, "内容", ""])].join("\n");

const BIB = ["Ann2020", "Bo2021", "Cy2019", "Dee2024", "Eve2018", "Fay2022"].map((k) => `@article{${k},\n  year = {2020},\n}\n`).join("\n");

const INDEX = JSON.stringify([
  { id: "10.1/ann", bibKey: "Ann2020", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/ann.md" },
  // 笔记写成了，索引还标着只速读（HER Huang2027 那一类）
  { id: "10.1/bo", bibKey: "Bo2021", reviewStatus: "pending", fulltextStatus: "fulltext", skimmed: true, notePath: "notes/bo.md" },
  // 标了已精读，笔记不存在
  { id: "10.1/cy", bibKey: "Cy2019", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/gone.md" },
  // 开头写仅摘要，索引是全文；缺两段
  { id: "10.1/dee", bibKey: "Dee2024", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "./notes/dee.md" },
  { id: "10.1/eve", bibKey: "Eve2018", reviewStatus: "pending", skimmed: true, notePath: null },
  { id: "10.1/eve2", bibKey: "Eve2018", reviewStatus: "pending", skimmed: true, notePath: null },
  { id: "10.1/ghost", bibKey: "Ghost2023", reviewStatus: "done", fulltextStatus: "abstract-only", notePath: "/Users/x/proj/notes/ghost.md" },
]);

const INCLUDED = JSON.stringify([
  { id: "10.1/ann", decision: "included" },
  { id: "10.1/eve", decision: "included" },
  { id: "10.1/fay", decision: "included", title: "A paper nobody read" },
  { id: "10.1/zed", decision: "excluded", authors: ["Zed, Ada"], year: "2023", title: "Rapid preparation of a dropped catalyst paper" },
]);

const NOTES = [
  { path: "notes/ann.md", text: full("Ann", "全文 · 正式版") },
  { path: "notes/bo.md", text: full("Bo", "全文 · agent 草稿") },
  { path: "notes/dee.md", text: full("Dee", "仅摘要·待全文", ["局限", "疑问与待跟进"]) },
  { path: "notes/ghost.md", text: full("Ghost", "仅摘要") },
  { path: "notes/stray.md", text: full("Stray", "全文") },
  { path: "notes/Rapid-preparation-of-a-dropped-catalyst-paper.md", text: full("Rapid preparation of a dropped catalyst paper", "全文") },
  { path: "notes/angles.md", text: "# 可写点\n\n## 角度 1\n" },
];

const run = (over: Partial<Parameters<typeof checkNotes>[0]> = {}) =>
  checkNotes({
    index: INDEX,
    files: [...NOTES.map((n) => n.path), "notes/index.json", "notes/skim.md"],
    notes: NOTES,
    bib: BIB,
    included: INCLUDED,
    extraction: "| 体系 | 出处 |\n|---|---|\n| A | [@Ann2020] |\n| B | [@Zed2023] p.3 |\n| C | [@Nope2020] |",
    skim: "| 键 | 年份 |\n|---|---|\n| @Eve2018 | 2018 |",
    ...over,
  });

test("笔记小工具：八段认 ## 标题（可带序号）；开头仅摘要 / 全文；绝对路径取 notes/ 起", () => {
  assert.deepEqual(noteSections("## 1. 一句话总结\n## 方法（简）\n### 主要结果"), ["一句话总结", "方法", "主要结果"]);
  assert.equal(noteFulltextClaim("# T\n> 来源：x.pdf\n仅摘要·待全文\n## 一句话总结"), "abstract");
  assert.equal(noteFulltextClaim("# T\n> 来源：x.pdf\n全文 · 正式版\n## 一句话总结"), "fulltext");
  assert.equal(noteFulltextClaim("# T\n## 一句话总结\n全文"), null, "只看第一个 ## 之前");
  assert.equal(normNotePath("/Users/a/p/notes/x.md"), "notes/x.md");
  assert.equal(normNotePath(".\\notes\\x.md"), "notes/x.md");
});

test("拦下：标了已精读笔记却不在、索引键不在引文库、索引同一个键两次", () => {
  const blocked = run().filter((i) => i.status === "blocked").map((i) => i.title);
  assert.ok(blocked.includes("@Cy2019 标了已精读，笔记 notes/gone.md 不存在"));
  assert.ok(blocked.includes("笔记索引里 @Eve2018 出现了 2 次"));
  assert.ok(blocked.some((t) => t.startsWith("笔记索引里 1 个键在 references.bib 里没有：@Ghost2023")));
  assert.ok(run().every((i) => i.status !== "passed" && i.checker === "mesa"));
});

test("待你判断：笔记写成了索引还标只速读（HER Huang2027 那一类）", () => {
  const hit = run().find((i) => i.id === "notes-unmarked-Bo2021")!;
  assert.equal(hit.status, "needs_human");
  assert.equal(hit.title, "@Bo2021 的笔记已经写成，索引却标着只速读");
  assert.match(hit.evidence?.detail ?? "", /八段中的 8 段.*skimmed=true/);
  // 只写了两三段的不算写成
  const thin = run({ notes: NOTES.map((n) => (n.path === "notes/bo.md" ? { ...n, text: "# Bo\n## 一句话总结\n## 方法\n" } : n)) });
  assert.ok(!thin.some((i) => i.id === "notes-unmarked-Bo2021"));
});

test("待你判断：已精读的缺段、仅摘要与索引不符、没有索引指向的笔记（已排除篇的、非单篇笔记的不报）", () => {
  const titles = run().map((i) => i.title);
  assert.ok(titles.includes("@Dee2024 的笔记缺 2 段：局限、疑问与待跟进"));
  assert.ok(titles.includes("@Dee2024 笔记开头写「仅摘要」，索引却是全文"));
  assert.ok(!titles.some((t) => t.includes("Ghost2023") && t.includes("仅摘要")), "仅摘要与 abstract-only 一致");
  assert.ok(titles.includes("笔记 notes/stray.md 没有索引条目指向它"));
  assert.ok(!titles.some((t) => t.includes("Rapid-preparation")), "已排除篇的笔记照旧留着");
  assert.ok(!titles.some((t) => t.includes("angles.md")));
});

test("待你判断：纳入了却没笔记也不在速读表；抽取表引了已排除 / 不在库的键", () => {
  const items = run();
  const uncovered = items.find((i) => i.id === "notes-uncovered")!;
  assert.equal(uncovered.title, "纳入的 1 篇既没有笔记、也不在速读表里");
  assert.match(uncovered.evidence?.detail ?? "", /「A paper nobody read」/);
  const ex = items.filter((i) => i.kind === "notes-extraction").map((i) => `${i.title}@${i.target?.line}`).sort();
  assert.deepEqual(ex, ["抽取表引了不在 references.bib 里的 @Nope2020@5", "抽取表引了已排除的 @Zed2023@4"].sort());
});

test("没有索引、引文库时不乱报；索引损坏时拦下；阅读区空骨架与雷达日常积累笔记不误报孤儿", () => {
  assert.deepEqual(checkNotes({ index: null, files: [], notes: [] }), []);
  const bad = checkNotes({ index: "{broken json", files: [], notes: [] });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].id, "notes-bad-index");
  assert.equal(bad[0].status, "blocked");

  assert.equal(noteFulltextClaim("# T\n> 来源：x.pdf\n全文状态：abstract-only\n## 一句话总结"), "abstract");
  assert.equal(noteFulltextClaim("# T\n> 来源：x.pdf\n全文：无\n## 一句话总结"), "abstract");
  assert.equal(noteFulltextClaim("# T\n> 来源：x.pdf\n待补全文\n## 一句话总结"), null);
  assert.deepEqual(noteSections("## 一、一句话总结\n## **（2）方法** {#sec-m}"), ["一句话总结", "方法"]);

  const skeleton = ["# Radar Paper", "", "> 来源：papers/Radar Paper.pdf · 开始阅读 2026-10-13", "", ...NOTE_SECTIONS.map((s) => `## ${s}\n`)].join("\n");
  assert.equal(isUntouchedNote(skeleton), true);
  const radarWritten = ["# Unrelated Radar Paper", "", "> 来源：papers/Unrelated Radar Paper.pdf · 开始阅读 2026-10-13", "", ...NOTE_SECTIONS.map((s) => `## ${s}\n正文笔记内容\n`)].join("\n");
  assert.equal(isUntouchedNote(radarWritten), false);

  const extra = run({
    files: [...NOTES.map((n) => n.path), "notes/skeleton.md", "notes/radar.md"],
    notes: [...NOTES, { path: "notes/skeleton.md", text: skeleton }, { path: "notes/radar.md", text: radarWritten }],
    bibs: [BIB, "@article{Ghost2023,\n year={2023}\n}"],
    skim: "| 键 | 年份 |\n|---|---|\n| Eve2018 | 2018 |",
  });
  assert.ok(!extra.some((i) => i.id.includes("skeleton.md")), "阅读区空模板骨架不报孤儿");
  assert.ok(!extra.some((i) => i.id.includes("radar.md")), "不在纳入清单里的雷达日常笔记不催进 index.json");
  assert.ok(!extra.some((i) => i.id === "notes-missing-bib"), "多处 references.bib 合并后不再误报缺键");
  assert.equal(extra.find((i) => i.id === "notes-uncovered")?.title, "纳入的 1 篇既没有笔记、也不在速读表里", "速读表裸写键名 Eve2018 也能识别");
});
