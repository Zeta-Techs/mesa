import assert from "node:assert/strict";
import test from "node:test";
import {
  clampLimits,
  fetchableItems,
  loginTargets,
  needsExtension,
  normalizeDoi,
  rowJobLabel,
  statusLabel,
  WAIT_EXTENSION,
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
    summarizeJobs([job("queued"), job("browser"), job("done"), job("failed"), job("needs_approval")]),
    "找免费版 1 · 在浏览器里下 1 · 已下载 1 · 没下到 1 · 等你点开始 1",
  );
  assert.equal(statusLabel("needs_pick"), "等 AI 选链接");
});

test("clampLimits：调高不过天花板，间隔不短于下限", () => {
  const ceiling = { perPublisherDaily: 60, totalDaily: 150, minGapSecs: 20, maxGapSecs: 20 };
  assert.deepEqual(clampLimits({ perPublisherDaily: 999, totalDaily: 0, minGapSecs: 5, maxGapSecs: 1 }, ceiling), {
    perPublisherDaily: 60,
    totalDaily: 1,
    minGapSecs: 20,
    maxGapSecs: 20,
  });
});

test("rowJobLabel / needsExtension：每行写 Mesa 走到哪；有篇在浏览器一级而扩展没连上才提示装扩展", () => {
  const job = (status: string, stage = "oa", waiting: string | null = null): PaperFetchJob => ({
    id: status, doi: "10.1/x", projectRoot: "/p", title: "", requester: "agent", status, stage, createdAt: 0, updatedAt: 0, candidates: [], waiting,
  });
  assert.equal(rowJobLabel(undefined), null);
  assert.deepEqual(rowJobLabel(job("queued")), { text: "Mesa 找免费版", warn: false });
  assert.deepEqual(rowJobLabel(job("queued", "publisher")), { text: "Mesa 经学校订阅下", warn: false });
  assert.deepEqual(rowJobLabel(job("browser", "browser", WAIT_EXTENSION)), { text: "Mesa 等扩展连上", warn: true });
  assert.deepEqual(rowJobLabel(job("browser", "browser")), { text: "Mesa 在浏览器里下", warn: false });
  assert.deepEqual(rowJobLabel(job("failed")), { text: "Mesa 没下到", warn: true });
  assert.equal(rowJobLabel(job("done")), null);
  assert.equal(needsExtension([job("browser", "browser")], false), true);
  assert.equal(needsExtension([job("browser", "browser")], true), false);
  assert.equal(needsExtension([job("queued")], false), false);
});

test("loginTargets：要在浏览器里下的按出版商各挑一篇，没走到浏览器的不列", () => {
  const job = (doi: string, status: string, stage: string, publisher: string): PaperFetchJob => ({
    id: doi, doi, projectRoot: "/p", title: "", requester: "agent", status, stage, createdAt: 0, updatedAt: 0, candidates: [], publisher,
  });
  assert.deepEqual(
    loginTargets([
      job("10.1002/a", "browser", "browser", "Wiley"),
      job("10.1002/b", "browser", "browser", "Wiley"),
      job("10.1016/c", "failed", "browser", "Elsevier"),
      job("10.1021/d", "queued", "oa", "ACS"),
      job("10.1039/e", "done", "browser", "RSC"),
    ]),
    [
      { publisher: "Wiley", doi: "10.1002/a" },
      { publisher: "Elsevier", doi: "10.1016/c" },
    ],
  );
});
