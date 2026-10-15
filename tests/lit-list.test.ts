import assert from "node:assert/strict";
import test from "node:test";
import {
  compareNotes,
  compareNotesBySeq,
  displayFileTitle,
  pickContinueNotePath,
  listPreviewToggleLabel,
  litReadState,
  litRowMatches,
  splitNoteSeq,
} from "../src/lit-list.ts";

test("展示名去掉类型后缀，只剩后缀时保留原名", () => {
  assert.equal(displayFileTitle("foo.pdf"), "foo");
  assert.equal(
    displayFileTitle("A Delicately Designed Sulfide.md"),
    "A Delicately Designed Sulfide",
  );
  assert.equal(displayFileTitle("references.bib"), "references");
  assert.equal(displayFileTitle(".md"), ".md");
});

test("笔记序号前缀拆成列，100 排在 02 后面", () => {
  assert.deepEqual(splitNoteSeq("01-有机硫氧化还原介体TTF.md"), {
    seq: "01",
    title: "有机硫氧化还原介体TTF",
  });
  assert.deepEqual(splitNoteSeq("100-原位硫化碳限域钴.md"), {
    seq: "100",
    title: "原位硫化碳限域钴",
  });
  assert.deepEqual(splitNoteSeq("inbox.md"), { seq: null, title: "inbox" });
  const names = ["100-z.md", "02-a.md", "01-b.md"];
  names.sort(compareNotesBySeq);
  assert.deepEqual(names, ["01-b.md", "02-a.md", "100-z.md"]);
});

test("继续精读打开序号最早的笔记，跳过索引和生词本", () => {
  assert.equal(
    pickContinueNotePath(["glossary.md", "02-b.md", "01-a.md", "index.json", "inbox.md"]),
    "01-a.md",
  );
  assert.equal(pickContinueNotePath(["index.md", "glossary.md"]), null);
  assert.equal(pickContinueNotePath([]), null);
});

test("文献状态与搜索/筛选", () => {
  // 2026-10-13 双台账：状态=已读 > 已在清单（included.md 正典）> 已积累（reading-list.md）> 未读
  assert.equal(litReadState(true, true, true), "read");
  assert.equal(litReadState(true, false, false), "read");
  assert.equal(litReadState(false, false, true), "queued");
  assert.equal(litReadState(false, true, false), "accumulated");
  assert.equal(litReadState(false, false, false), "unread");
  assert.equal(
    litRowMatches("Tunnel Copper", "papers/a.pdf", "read", "copper", "all"),
    true,
  );
  assert.equal(
    litRowMatches("Tunnel Copper", "papers/a.pdf", "read", "zzz", "all"),
    false,
  );
  assert.equal(
    litRowMatches("Tunnel Copper", "papers/a.pdf", "read", "", "unread"),
    false,
  );
  assert.equal(
    litRowMatches("Tunnel Copper", "papers/a.pdf", "queued", "", "queued"),
    true,
  );
});

test("预览条：展开前报剩余篇数，展开后改收起", () => {
  assert.equal(listPreviewToggleLabel(false, 143), "显示全部（还有 143 篇）");
  assert.equal(listPreviewToggleLabel(true, 143), "收起");
  assert.equal(
    listPreviewToggleLabel(false, 8, "条"),
    "显示全部（还有 8 条）",
  );
});

test("笔记排序：最近优先，同分走编号", () => {
  const rows = [
    { name: "02-b.md", modified: "2026-08-01T00:00:00Z" },
    { name: "01-a.md", modified: "2026-09-01T00:00:00Z" },
  ];
  const recent = [...rows].sort((a, b) => compareNotes(a, b, "recent"));
  assert.equal(recent[0].name, "01-a.md");
  const seq = [...rows].sort((a, b) => compareNotes(a, b, "seq"));
  assert.equal(seq[0].name, "01-a.md");
});
