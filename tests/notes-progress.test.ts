import assert from "node:assert/strict";
import test from "node:test";
import { excludedIncludedIds, notesProgress, notesProgressLine } from "../src/notes-progress.ts";

test("精读进度：reviewed 才算写完，按全文/摘要分开数", () => {
  const index = JSON.stringify([
    { id: "a", reviewStatus: "reviewed", fulltextStatus: "fulltext", notePath: "notes/01.md" },
    { id: "b", reviewStatus: "reviewed", fulltextStatus: "abstract-only", notePath: "notes/02.md" },
    { id: "c", reviewStatus: "pending", fulltextStatus: "fulltext", notePath: "notes/03.md" },
    { id: "d", reviewStatus: "blocked", fulltextStatus: "unavailable" },
    { id: "e" },
  ]);
  const p = notesProgress(index);
  assert.deepEqual(p, { total: 5, reviewed: 2, fulltext: 1, abstractOnly: 1, blocked: 1 });
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
