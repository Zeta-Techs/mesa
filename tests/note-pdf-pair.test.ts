import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_PAIR_TTL_MS,
  cachedNotePaired,
  checkNotePaired,
  isMarkdownNote,
  resetNotePairCache,
} from "../src/note-pdf-pair.ts";

// 「沉浸阅读」入口只给配得上 PDF 的 md 笔记（2026-10-25）：预览 / 文件行悬停 / 右键三处同一份缓存
test("配得上记 true、配不上记 false；同一路径同时只问一次，过期后重问", async () => {
  resetNotePairCache();
  const asked: string[] = [];
  const ask = async (p: string) => {
    asked.push(p);
    if (p.endsWith("CHANGELOG.md")) throw new Error("未找到与这份笔记配对的 PDF");
    return { pdfPath: "/p/papers/a.pdf" };
  };
  const t0 = 1_000_000;
  const [a, b] = await Promise.all([checkNotePaired("/p/notes/a.md", ask, t0), checkNotePaired("/p/notes/a.md", ask, t0)]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.deepEqual(asked, ["/p/notes/a.md"], "并发只问一次");
  assert.equal(await checkNotePaired("/p/CHANGELOG.md", ask, t0), false);
  assert.equal(cachedNotePaired("/p/CHANGELOG.md"), false);
  // 缓存期内不再问
  await checkNotePaired("/p/notes/a.md", ask);
  assert.equal(asked.length, 2);
  // 过期后重问
  assert.equal(cachedNotePaired("/p/notes/a.md", Date.now() + NOTE_PAIR_TTL_MS + 1), undefined);
  await checkNotePaired("/p/notes/a.md", ask, Date.now() + NOTE_PAIR_TTL_MS + 1);
  assert.equal(asked.length, 3);
  resetNotePairCache();
});

test("只有 .md / .markdown 走配对", () => {
  assert.equal(isMarkdownNote("/p/notes/A.MD"), true);
  assert.equal(isMarkdownNote("/p/x.markdown"), true);
  assert.equal(isMarkdownNote("/p/papers/a.pdf"), false);
});
