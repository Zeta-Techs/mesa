import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clearFindMarks, findAllOffsets, markFindHits, setCurrentHit } from "../src/md-find.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");

function host(html: string): HTMLElement {
  const el = dom.window.document.createElement("div");
  el.innerHTML = html;
  return el as unknown as HTMLElement;
}

test("查找不分大小写、弯直引号同一个", () => {
  assert.deepEqual(findAllOffsets("Data data DATA", "data"), [0, 5, 10]);
  assert.deepEqual(findAllOffsets("it’s fine", "it's"), [0]);
  assert.deepEqual(findAllOffsets("aaa", ""), []);
});

test("跨加粗的命中也标出来，清除后原文一字不差", () => {
  const h = host("<p>镁<strong>硫电</strong>池与镁硫电池</p><pre><code>镁硫电池</code></pre>");
  const before = h.innerHTML;
  const hits = markFindHits(h, "镁硫电池");
  assert.equal(hits.length, 3);
  // 第一处跨三个文本节点
  assert.equal(hits[0]!.length, 3);
  assert.equal(hits[0]!.map((m) => m.textContent).join(""), "镁硫电池");
  const cur = setCurrentHit(hits, 1);
  assert.ok(cur?.classList.contains("md-find-current"));
  assert.equal(h.querySelectorAll(".md-find-current").length, 1);
  clearFindMarks(h);
  assert.equal(h.innerHTML, before);
  assert.equal(h.querySelectorAll("mark").length, 0);
});

test("同一文本节点多处命中按文档顺序编号", () => {
  const h = host("<p>ab ab ab</p>");
  const hits = markFindHits(h, "ab");
  assert.equal(hits.length, 3);
  const marks = [...h.querySelectorAll("mark")];
  assert.deepEqual(hits.map((g) => marks.indexOf(g[0]!)), [0, 1, 2]);
});

test("引用胶囊不参与查找（异步改字会冲掉标记）", () => {
  const h = host('<p>见 <span class="md-cite">Smith 2020</span> 与 Smith</p>');
  assert.equal(markFindHits(h, "smith").length, 1);
});
