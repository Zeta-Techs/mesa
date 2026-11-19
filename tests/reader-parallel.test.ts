import assert from "node:assert/strict";
import test from "node:test";
import type { PdfParagraph } from "../src/pdf-paragraphs.ts";
import {
  anchorForViewport,
  batchNeighbors,
  paragraphAt,
  parallelProgress,
  planBatches,
  translationOrder,
  type ParaStatus,
} from "../src/reader-parallel.ts";

function para(page: number, i: number, text: string, y: number, opts: { kind?: PdfParagraph["kind"]; hash?: string; x?: number } = {}): PdfParagraph {
  return {
    id: `${page}:${i}`,
    page,
    text,
    kind: opts.kind ?? "body",
    hash: opts.hash ?? `${page}-${i}`,
    boxes: [{ x: opts.x ?? 0.1, y, w: 0.35, h: 0.1 }],
  };
}

const pages = new Map<number, PdfParagraph[]>([
  [1, [para(1, 0, "Title", 0.1, { kind: "heading" }), para(1, 1, "a".repeat(1500), 0.2), para(1, 2, "0.1", 0.3, { kind: "fragment" }), para(1, 3, "b".repeat(1500), 0.5)]],
  [2, [para(2, 0, "c".repeat(300), 0.1), para(2, 1, "same text", 0.3, { hash: "dup" }), para(2, 2, "same text", 0.6, { hash: "dup" })]],
  [3, [para(3, 0, "d".repeat(100), 0.2, { x: 0.55 })]],
]);

test("translationOrder：全文，从当前页往后到底再回头，夹在页数内", () => {
  assert.deepEqual(translationOrder(3, 5), [3, 4, 5, 1, 2]);
  assert.deepEqual(translationOrder(0, 3), [1, 2, 3]);
  assert.deepEqual(translationOrder(9, 4), [4, 1, 2, 3]);
  assert.deepEqual(translationOrder(1, 0), []);
});

test("planBatches：一批不跨页不超字数，碎片不翻，同一原文只排一次，已在翻的跳过", () => {
  const busy = new Set(["3-0"]);
  const stateOf = (h: string): ParaStatus => (busy.has(h) ? "loading" : "idle");
  const batches = planBatches(pages, [1, 2, 3], stateOf, 2500);
  assert.deepEqual(
    batches.map((b) => [b.page, b.paras.map((p) => p.id)]),
    [
      [1, ["1:0", "1:1"]],
      [1, ["1:3"]],
      [2, ["2:0", "2:1"]],
    ],
  );
});

test("batchNeighbors：前一段末尾与后一段开头（跨页，碎片跳过）", () => {
  const n = batchNeighbors(pages, { page: 1, paras: [pages.get(1)![3]] }, 5, 4);
  assert.deepEqual(n, { before: "aaaaa", after: "cccc" });
  assert.deepEqual(batchNeighbors(pages, { page: 1, paras: [pages.get(1)![0]] }), { before: "", after: "a".repeat(300) });
});

test("anchorForViewport：本页第一段底边在视口顶以下的；本页翻完了往后找", () => {
  assert.equal(anchorForViewport(pages, 1, 0.25)?.id, "1:1");
  assert.equal(anchorForViewport(pages, 1, 0.9)?.id, "2:0");
  assert.equal(anchorForViewport(pages, 3, 0.95)?.id, "3:0");
  assert.equal(anchorForViewport(new Map(), 1, 0), null);
});

test("paragraphAt：指着外框里（放宽半个百分点），碎片不算", () => {
  assert.equal(paragraphAt(pages, 1, 0.2, 0.25)?.id, "1:1");
  assert.equal(paragraphAt(pages, 1, 0.2, 0.35), null);
  assert.equal(paragraphAt(pages, 3, 0.546, 0.25)?.id, "3:0");
});

test("跨页续写的那截：指着它、视口顶落在它上面，都算它并进去的那段；题录和参考文献不列", () => {
  const cont: PdfParagraph = { ...para(5, 0, "tail of it", 0.1), kind: "continued", of: "4:1" };
  const doc = new Map<number, PdfParagraph[]>([
    [4, [para(4, 0, "Head.", 0.1, { kind: "heading" }), para(4, 1, "unfinished paragraph", 0.6)]],
    [5, [cont, para(5, 1, "Next one.", 0.4), para(5, 2, "a@b.com", 0.7, { kind: "meta" }), para(5, 3, "References", 0.8, { kind: "reference" })]],
  ]);
  assert.equal(paragraphAt(doc, 5, 0.2, 0.15)?.id, "4:1");
  assert.equal(anchorForViewport(doc, 5, 0.05)?.id, "4:1");
  assert.equal(anchorForViewport(doc, 5, 0.3)?.id, "5:1");
  assert.equal(paragraphAt(doc, 5, 0.2, 0.75), null, "题录不接");
  assert.deepEqual(parallelProgress(doc, () => "idle").total, 3);
});

test("parallelProgress：按不同原文计数，碎片不计", () => {
  const st = new Map<string, ParaStatus>([["1-0", "done"], ["1-1", "failed"], ["dup", "loading"]]);
  assert.deepEqual(parallelProgress(pages, (h) => st.get(h) ?? "idle"), { done: 1, total: 6, failed: 1, busy: 1 });
});
