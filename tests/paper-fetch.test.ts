import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchableItems,
  normalizeDoi,
  rowJobLabel,
  statusLabel,
  summarizeJobs,
  type PaperFetchJob,
} from "../src/paper-fetch.ts";

test("normalizeDoi：去 doi.org 前缀与尾标点、转小写，不像 DOI 的给 null", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1002/ADMA.123)."), "10.1002/adma.123");
  assert.equal(normalizeDoi("doi: 10.1016/j.cell.2020.01.001"), "10.1016/j.cell.2020.01.001");
  assert.equal(normalizeDoi("https://example.com/paper.pdf"), null);
  assert.equal(normalizeDoi("10.12/x"), null);
});

test("fetchableItems：只交没存、带 DOI 的，同一篇只交一次", () => {
  const items = [
    { line: 1, title: "A", url: "https://doi.org/10.1021/a", done: false },
    { line: 2, title: "B", url: "10.1021/b", done: true },
    { line: 3, title: "C", url: "10.1021/c", done: false },
    { line: 4, title: "D", url: "https://example.com/d", done: false },
    { line: 5, title: "A 重复", url: "10.1021/A", done: false },
  ];
  assert.deepEqual(fetchableItems(items, { 3: "c.pdf" }), [{ doi: "10.1021/a", title: "A" }]);
});

test("summarizeJobs：按状态汇总一行，没有活给空串", () => {
  const job = (status: string): PaperFetchJob => ({
    id: status,
    doi: "10.1/x",
    projectRoot: "/p",
    title: "",
    requester: "agent",
    status,
    stage: "oa",
    createdAt: 0,
    updatedAt: 0,
    candidates: [],
  });
  assert.equal(summarizeJobs([]), "");
  assert.equal(
    summarizeJobs([job("queued"), job("manual"), job("done"), job("failed"), job("needs_approval")]),
    "找免费版 1 · 已下载 1 · 点官网下 1 · 没下到 1 · 等你点开始 1",
  );
  assert.equal(statusLabel("needs_pick"), "等 AI 选链接");
});

test("rowJobLabel：每行写 Mesa 到哪了；没有免费版的指去官网", () => {
  const job = (status: string): PaperFetchJob => ({
    id: status, doi: "10.1/x", projectRoot: "/p", title: "", requester: "agent", status, stage: "oa", createdAt: 0, updatedAt: 0, candidates: [],
  });
  assert.equal(rowJobLabel(undefined), null);
  assert.deepEqual(rowJobLabel(job("queued")), { text: "Mesa 找免费版", warn: false });
  assert.deepEqual(rowJobLabel(job("manual")), { text: "没有免费版，点官网", warn: false });
  assert.deepEqual(rowJobLabel(job("needs_approval")), { text: "等你点开始", warn: true });
  assert.deepEqual(rowJobLabel(job("failed")), { text: "Mesa 没下到", warn: true });
  assert.equal(rowJobLabel(job("done")), null);
  assert.equal(statusLabel("manual"), "点官网自己下");
});
