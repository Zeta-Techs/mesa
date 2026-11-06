import assert from "node:assert/strict";
import test from "node:test";
import { assetCounts, assetFilesFor, matrixCounts, overviewRow, overviewSummary, reworkLine } from "../src/materials-overview.ts";

test("资料全貌：按技能槽认资料，机械数现状", () => {
  const included = JSON.stringify([
    { id: "a", decision: "included", pdf: "papers/a.pdf", kind: "review" },
    { id: "b", decision: "included" },
    { id: "c", decision: "excluded" },
  ]);
  assert.equal(assetCounts("search", { included }), "纳入 2 篇（综述 1） · 已有全文 1 · 缺全文 1");
  const index = JSON.stringify([
    { id: "a", reviewStatus: "reviewed", fulltextStatus: "fulltext" },
    { id: "b", skimmed: true, reviewStatus: "pending" },
    { id: "c", reviewStatus: "reviewed" },
  ]);
  assert.equal(assetCounts("notes", { included, index }), "已写笔记 1 / 1 篇 · 全文 1 · 只速读 1");
  assert.equal(assetCounts("outline", { outline: "# 大纲\n" }), "有大纲");
  assert.equal(assetCounts("search", { included: "坏的" }), null);
  assert.equal(assetCounts("other", {}), null);
});

test("资料全貌：一步一行，没开工不出；落后写清落后于谁", () => {
  assert.equal(overviewRow({ name: "初稿", asset: "", key: "pending", counts: null }), null);
  const done = overviewRow({ name: "精读", asset: "笔记", key: "done", mergedAt: "2026-11-06T03:00:00Z", counts: "已写笔记 3 / 3 篇" })!;
  assert.match(done.state, /^已保存 11-0[67]$/);
  assert.deepEqual(done.align, { text: "已对齐", tone: "ok" });
  const behind = overviewRow({ name: "大纲", asset: "大纲", key: "done", staleUpstream: "精读", counts: null })!;
  assert.deepEqual(behind.align, { text: "落后于「精读」，还没跟进", tone: "warn" });
  const live = overviewRow({ name: "大纲", asset: "大纲", key: "active", staleUpstream: "检索", counts: null })!;
  assert.equal(live.state, "进行中");
  assert.deepEqual(live.align, { text: "「检索」有新内容还没并进来", tone: "warn" });
  assert.equal(overviewSummary([done, behind], 1), "2 步开过工 · 1 步没跟上上游 · 1 张补料单在途");
  assert.equal(overviewSummary([done], 0), "1 步开过工 · 都对齐了");
});

test("资料全貌：在途的补料单写清补到哪、链等谁；补完且链走完就不列", () => {
  const saved: Record<string, string> = {};
  const at = (s: string) => saved[s] ?? null;
  const r = { fromStep: "大纲", toStep: "检索", sentAt: "2026-11-06T01:00:00Z", chain: ["精读", "大纲"] };
  assert.match(reworkLine(r, at)!.text, /在补 · 补完保存后接着跟进「精读」「大纲」/);
  saved["检索"] = "2026-11-06T02:00:00Z";
  const next = reworkLine(r, at)!;
  assert.match(next.text, /已补完 · 链：轮到「精读」跟进/);
  assert.equal(next.chainActive, true);
  const waiting = reworkLine({ ...r, chainState: { started: [{ step: "精读", at: "2026-11-06T02:01:00Z" }], stopped: false } }, at)!;
  assert.match(waiting.text, /链：等「精读」评审、保存/);
  assert.equal(reworkLine({ ...r, chainState: { started: [], stopped: true } }, at), null, "补完了、链停了：不列");
  assert.equal(reworkLine({ ...r, chain: [] }, at), null, "补完了、没有链：不列");
});

test("资料全貌：其余科研步骤也机械数——实验矩阵、清洗待裁决、分析的图与结论条目", () => {
  const matrix = JSON.stringify([
    { id: "A", status: "done" }, { id: "B", status: "failed" }, { id: "C", status: "not-run" }, { id: "D", status: "planned" },
  ]);
  assert.deepEqual(matrixCounts(matrix), { total: 4, done: 1, failed: 1, notRun: 1 });
  assert.equal(matrixCounts(JSON.stringify({ combinations: [{ id: "A", status: "完成" }] }))?.done, 1, "包一层也认");
  assert.equal(assetCounts("design", { matrix }), "实验矩阵 4 组");
  assert.equal(assetCounts("experiment", { matrix }), "矩阵 4 组：完成 1 · 失败 1 · 没跑 1 · 待跑 1");
  assert.equal(assetCounts("clean", { decisions: "- V001 | 位置 | 裁决：待裁决 | 依据：\n- V002 | 裁决：保留 |" }), "1 条规则待你裁决");
  assert.equal(assetCounts("clean", { decisions: "- V002 | 裁决：保留 |" }), "规则都裁决过了");
  assert.equal(assetCounts("clean", { decisions: null }), null, "还没有裁决单就不说");
  assert.equal(
    assetCounts("analysis", { figures: JSON.stringify([{ file: "a" }, { file: "b" }]), reports: ["## 结论条目\n- C001 | 一 | 来源 | 强度\n- C002 | 二 | x | y", "无"] }),
    "图 2 张 · 结论条目 2 条",
  );
  assert.equal(assetCounts("writing", {}), null);
  // 分析步的报告按它交的 .md 取，通配的不要
  assert.deepEqual(
    assetFilesFor("analysis", ["analysis/findings.md", "figures/*", "analysis/results.json", "chapters/results.md"]).map((f) => f.path),
    ["figures/manifest.json", "analysis/findings.md", "chapters/results.md"],
  );
  assert.deepEqual(assetFilesFor("other"), []);
});
