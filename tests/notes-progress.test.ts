import assert from "node:assert/strict";
import test from "node:test";
import {
  excludedIncludedIds,
  figurePlan,
  figurePlanLine,
  notesProgress,
  notesProgressLine,
  searchPdfProbes,
  searchProgress,
  searchProgressLine,
} from "../src/notes-progress.ts";

test("精读进度：reviewed 才算写完，按全文/摘要分开数", () => {
  const index = JSON.stringify([
    { id: "a", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/01.md" },
    { id: "b", reviewStatus: "reviewed", fulltextStatus: "abstract-only", notePath: "notes/02.md" },
    { id: "c", reviewStatus: "pending", fulltextStatus: "fulltext", notePath: "notes/03.md" },
    { id: "d", reviewStatus: "blocked", fulltextStatus: "unavailable" },
    { id: "e" },
  ]);
  const p = notesProgress(index);
  assert.deepEqual(p, { total: 5, reviewed: 2, fulltext: 1, abstractOnly: 1, blocked: 1, skimmed: 0 });
  assert.equal(notesProgressLine(p!), "已写笔记 2 / 5 篇 · 全文 1 · 仅摘要 1 · 卡住 1");
});

test("精读进度：包在对象里的记录也认；空表与坏 JSON 不出这一行", () => {
  const wrapped = JSON.stringify({ records: [{ id: "a", reviewStatus: "REVIEWED", fulltextStatus: "fulltext" }] });
  assert.equal(notesProgressLine(notesProgress(wrapped)!), "已写笔记 1 / 1 篇 · 全文 1");
  assert.equal(notesProgress("[]"), null);
  assert.equal(notesProgress("{ not json"), null);
  assert.equal(notesProgress(JSON.stringify({ version: 1 })), null);
});

test("精读进度：一篇没写时只报总数", () => {
  const index = JSON.stringify([{ id: "a", reviewStatus: "pending" }, { id: "b", reviewStatus: "pending" }]);
  assert.equal(notesProgressLine(notesProgress(index)!), "已写笔记 0 / 2 篇");
});

test("抽查候选：全文与仅摘要各取一篇，再从尾部补齐，只挑写完的", async () => {
  const { spotCheckPicks } = await import("../src/notes-progress.ts");
  const rows = [
    { id: "1", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/01.md" },
    { id: "2", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/02.md" },
    { id: "3", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/03.md" },
    { id: "4", reviewStatus: "reviewed", fulltextStatus: "abstract-only", notePath: "notes/04.md" },
    { id: "5", reviewStatus: "pending", fulltextStatus: "fulltext", notePath: "notes/05.md" },
    { id: "6", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "" },
  ];
  const picks = spotCheckPicks(JSON.stringify(rows));
  assert.deepEqual(picks.map((p) => p.notePath), ["notes/02.md", "notes/04.md", "notes/03.md"]);
  assert.deepEqual(picks.map((p) => p.fulltext), [true, false, true]);
  assert.deepEqual(picks.map((p) => p.id), ["2", "4", "3"]);
  // 同一份索引每次挑同样几篇
  assert.deepEqual(spotCheckPicks(JSON.stringify(rows)), picks);
  assert.deepEqual(spotCheckPicks("[]"), []);
  assert.deepEqual(spotCheckPicks("坏"), []);
  // 只写完两篇：有几篇给几篇
  assert.equal(spotCheckPicks(JSON.stringify(rows.slice(0, 2))).length, 2);
});

test("精读进度：评审里排除的篇不进分母", () => {
  const included = JSON.stringify([
    { id: "a", decision: "included" },
    { id: "b", decision: "excluded" },
    { id: "c", decision: "pending" },
  ]);
  const excluded = excludedIncludedIds(included);
  assert.deepEqual([...excluded], ["b"]);
  const index = JSON.stringify([
    { id: "a", reviewStatus: "reviewed", fulltextStatus: "fulltext" },
    { id: "b", reviewStatus: "pending" },
    { id: "c", reviewStatus: "pending" },
  ]);
  assert.equal(notesProgress(index)?.total, 3);
  assert.equal(notesProgress(index, excluded)?.total, 2);
  assert.equal(excludedIncludedIds("坏 JSON").size, 0);
});

test("精读进度：旧索引写 done 也算写完", () => {
  const index = JSON.stringify([
    { id: "a", reviewStatus: "done", fulltextStatus: "fulltext", notePath: "notes/a.md" },
    { id: "b", reviewStatus: "done", fulltextStatus: "abstract-only", notePath: "notes/b.md" },
    { id: "c", reviewStatus: "pending" },
  ]);
  const p = notesProgress(index);
  assert.equal(p?.reviewed, 2);
  assert.equal(p?.fulltext, 1);
  assert.equal(p?.abstractOnly, 1);
});

test("检索篇数：纳入按 pdf 字段分有无全文，待确认单列，排除不算", () => {
  const json = JSON.stringify([
    { id: "a", decision: "included", pdf: "papers/a.pdf" },
    { id: "b", decision: "include", pdf: "" },
    { id: "c", decision: "included" },
    { id: "d", decision: "pending" },
    { id: "e", decision: "excluded", pdf: "papers/e.pdf" },
  ]);
  const p = searchProgress(json);
  assert.deepEqual(p, { included: 3, pending: 1, withPdf: 1 });
  assert.equal(searchProgressLine(p!), "纳入 3 篇 · 待确认 1 · 已有全文 1 · 缺全文 2");
  assert.equal(searchProgressLine({ included: 2, pending: 0, withPdf: 2 }), "纳入 2 篇 · 已有全文 2");
  assert.equal(searchProgress("[]"), null);
  assert.equal(searchProgress(JSON.stringify([{ id: "x", decision: "excluded" }])), null);
  assert.equal(searchProgress("{坏"), null);
});

test("检索篇数：台账没记 pdf、papers/ 里对上了的也算已有全文；探针只给纳入且没记 pdf 的", () => {
  const json = JSON.stringify([
    { id: "a", decision: "included", pdf: "papers/a.pdf", title: "A" },
    { id: "b", decision: "included", title: "B", doi: "10.1/b" },
    { id: "c", decision: "included", title: "C", url: "https://x/c" },
    { id: "d", decision: "excluded", title: "D" },
  ]);
  assert.deepEqual(searchPdfProbes(json), [
    { id: "b", title: "B", url: "https://doi.org/10.1/b" },
    { id: "c", title: "C", url: "https://x/c" },
  ]);
  assert.equal(searchProgressLine(searchProgress(json, new Set(["b"]))!), "纳入 3 篇 · 已有全文 2 · 缺全文 1");
  assert.deepEqual(searchPdfProbes("{坏"), []);
});

test("用图计划：拼图按编号去重，仅引用只数真引用，技能样例里的备选不算", () => {
  const outline = [
    "## 2. 背景",
    "- 用图：拼 图1（论点）= (a) [@k1] Fig.2c + (b) [@k2] Fig.3a",
    "- 正文再提一次 拼 图1 的位置",
    "## 3. 机理",
    "- 用图：拼图2（论点）= (a) [@k3] Fig.1 + (b) [@k4] Fig.2",
    "- 用图：仅引用 [@k5] Fig.4",
    "- 用图：拼 图3（论点）= …（凑不成则仅引用 [@k6] Fig.2）",
    "- 表：表 1（活性对比）= 列：材料、条件；行：[@k1]、[@k2]",
    "- 表：表 2（稳定性）= 列：循环数；行：[@k3]",
    "- 附表 9（证据综合）不算对照表",
  ].join("\n");
  const p = figurePlan(outline);
  assert.deepEqual(p, { composites: 3, citeOnly: 1, tables: 2 });
  assert.equal(figurePlanLine(p!), "用图计划：初稿要拼 3 张图 · 直接引原图 1 处 · 对照表 2 张");
  assert.equal(figurePlan("# 大纲\n没有用图计划"), null);
});

test("检索篇数标了类型时括号里写综述几篇；大纲定框架几问、薄几节", async () => {
  const { outlineProgress, outlineProgressParts } = await import("../src/notes-progress.ts");
  const json = JSON.stringify([
    { id: "a", decision: "included", kind: "review" },
    { id: "b", decision: "included", kind: "research" },
    { id: "c", decision: "included", kind: "research" },
  ]);
  assert.equal(searchProgressLine(searchProgress(json)!), "纳入 3 篇（综述 1） · 缺全文 3");
  const outline = [
    "## 定框架记录",
    "| 问 | 问题 | 人的选择 | 日期 |",
    "|---|---|---|---|",
    "| ① | 核心问题 | 照原样 | 11-05 |",
    "| 2 | 角度 | 角度 1、3 | 11-05 |",
    "| 3 | 读者 |  | |",
    "## 覆盖检查",
    "| 节 | 可写正文篇数 | 仅线索篇数 | 最新一篇年份 | 判断 | 建议 |",
    "|---|---|---|---|---|---|",
    "| 3.2 | 2 | 3 | 2020 | 薄 | 补检：x |",
    "| 3.4 | 0 | 1 | 2019 | 薄·不补：不是重点 | |",
    "| 4 | 6 | 2 | 2025 | 够 | |",
  ].join("\n");
  const p = outlineProgress(outline)!;
  assert.deepEqual(p, { answered: 2, thin: 1 });
  assert.deepEqual(outlineProgressParts(p), ["定框架 2/6 问", "薄 1 节待补料"]);
  assert.equal(outlineProgress("# 旧大纲\n用图：拼 图1"), null);
});

test("速读表行数：去掉表头与分隔行；没有表返回 null", async () => {
  const { skimRowCount } = await import("../src/notes-progress.ts");
  const md = "# 速读表\n\n| 键 | 年份 | 主题 |\n|---|---|---|\n| @a | 2023 | x |\n| @b | 2024 | y |\n";
  assert.equal(skimRowCount(md), 2);
  assert.equal(skimRowCount("# 速读表\n\n| 键 | 年份 |\n|:--|--:|\n"), 0);
  assert.equal(skimRowCount("# 空"), null);
});

test("速读表行数：按主题分几张表逐张去表头；另有的小计表不算", async () => {
  const { skimRowCount } = await import("../src/notes-progress.ts");
  const head = "| 键 | 年份 | 主题 | 研究问题 | 方法 | 主要结论 | 新在哪 | 全文 |\n|---|---|---|---|---|---|---|---|\n";
  const md = [
    "# 速读表",
    "## 原位表征",
    head + "| @a | 2023 | x | q | m | c | n | 有 |\n| @b | 2024 | x | q | m | c | n | 无 |",
    "## 动力学",
    head + "| @c | 2025 | y | q | m | c | n | 有 |",
    "## 小计",
    "| 主题 | 篇数 |\n|---|---|\n| 原位表征 | 2 |\n| 动力学 | 1 |",
  ].join("\n\n");
  assert.equal(skimRowCount(md), 3);
});

test("精读进度：只速读的（skimmed 且没写成笔记）不进分母，单列；补读写成笔记的照常算", () => {
  const index = JSON.stringify([
    { id: "r1", reviewStatus: "reviewed", fulltextStatus: "fulltext", kind: "review" },
    { id: "r2", reviewStatus: "pending", kind: "review" },
    { id: "s1", reviewStatus: "pending", skimmed: true },
    { id: "s2", reviewStatus: "pending", skimmed: true },
    { id: "s3", reviewStatus: "reviewed", fulltextStatus: "fulltext", skimmed: true },
  ]);
  const p = notesProgress(index)!;
  assert.equal(p.total, 3);
  assert.equal(p.skimmed, 2);
  assert.equal(notesProgressLine(p), "已写笔记 2 / 3 篇 · 全文 2 · 只速读 2");
  const allSkim = JSON.stringify([{ id: "s1", reviewStatus: "pending", skimmed: true }]);
  assert.equal(notesProgressLine(notesProgress(allSkim)!), "只速读 1 篇，还没有要写单篇笔记的");
});
