import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptanceEntryHeadline,
  acceptanceEntryRow,
  acceptanceEntryKey,
  acceptanceKindLabel,
  freezeReviewedSha,
  reviewedShaAfterCommit,
  gitAdmissionPayload,
  mergeAdmissionText,
  deliveryFollowupText,
  shortVersionId,
  watchAdoptText,
  watchLedgerFailed,
} from "../src/acceptance-log.ts";

test("pipeline merge is file admission, not scientific accept", () => {
  assert.equal(acceptanceKindLabel("pipeline_merge"), "文件已进入项目");
  assert.equal(acceptanceKindLabel("coding_merge"), "文件已进入项目");
  assert.equal(acceptanceKindLabel("goal_adopt"), "已接受");
  assert.doesNotMatch(acceptanceKindLabel("pipeline_merge"), /结论/);
});

test("shortVersionId keeps 8 hex and run:seq tail", () => {
  assert.equal(shortVersionId("abcdef0123456789"), "abcdef01");
  assert.equal(shortVersionId("run-1:3"), "3");
  assert.equal(shortVersionId(""), "");
});

test("headline includes kind and short sha", () => {
  assert.equal(
    acceptanceEntryHeadline({
      kind: "pipeline_merge",
      goalName: "文献精读 / lit",
      versionId: "aabbccddeeff0011",
    }),
    "文件已进入项目 · 文献精读 / lit · aabbccdd",
  );
});

test("merge admission is file in, not scientific accept", () => {
  assert.equal(
    mergeAdmissionText({ ledgerWritten: true, versionId: "aabbccddeeff0011" }),
    "文件已进入项目 · aabbccdd",
  );
  assert.equal(
    mergeAdmissionText({ ledgerWritten: false, versionId: "aabbccddeeff0011" }),
    "文件已进入项目，验收记录未写下",
  );
  assert.doesNotMatch(
    mergeAdmissionText({ ledgerWritten: true, versionId: "abc" }),
    /结论/,
  );
  assert.equal(watchAdoptText(true), "巡检已采纳");
  assert.equal(watchAdoptText(false), "巡检已采纳，验收记录未写下");
  assert.ok(
    watchLedgerFailed("文件已采纳，但验收记录落盘失败：disk。请再执行一次采纳以补记"),
  );
  assert.equal(watchLedgerFailed("保护路径拒绝"), false);
});

test("open-review sha stays frozen; retry omits expect", () => {
  assert.equal(freezeReviewedSha(null, "aaa"), "aaa");
  assert.equal(freezeReviewedSha("aaa", "bbb"), "aaa");
  assert.equal(freezeReviewedSha("aaa", "bbb", true), "bbb");
  assert.equal(freezeReviewedSha("  ", "ccc"), "ccc");
  assert.deepEqual(gitAdmissionPayload({ retry: true, reviewedSha: "aaa" }), {});
  assert.deepEqual(
    gitAdmissionPayload({ retry: false, reviewedSha: "aaa" }),
    { expectReviewedSha: "aaa" },
  );
  assert.ok(!("expectReviewedSha" in gitAdmissionPayload({ retry: true })));
  assert.throws(() => gitAdmissionPayload({ retry: false }), /先打开/);
});

test("commit-and-merge binds only the commit just made", () => {
  const head = "a".repeat(40);
  assert.equal(reviewedShaAfterCommit("aaaaaaa", head), head);
  assert.throws(() => reviewedShaAfterCommit("bbbbbbb", head), /提交已完成/);
  assert.throws(() => reviewedShaAfterCommit(null, head), /重新检查/);
});

test("acceptance entry key does not collapse empty run/goal ids", () => {
  assert.notEqual(
    acceptanceEntryKey({
      kind: "coding_merge",
      runId: "",
      goalId: "",
      versionId: "aaa",
      decidedAt: "t1",
    }),
    acceptanceEntryKey({
      kind: "pipeline_merge",
      runId: "",
      goalId: "",
      versionId: "bbb",
      decidedAt: "t2",
    }),
  );
});

test("successful merge still explains skipped non-Git deliverables", () => {
  assert.equal(deliveryFollowupText(undefined), "");
  assert.equal(deliveryFollowupText({}), "");
  assert.match(deliveryFollowupText({ conflicts: ["papers/report.pdf"] }), /未覆盖.*papers\/report.pdf/);
  assert.match(deliveryFollowupText({ failed: ["磁盘写入失败"] }), /仍需处理.*不能归档/);
});

test("验收记录一行：技能名换人话、版本号只进悬浮、系统备注不重复", () => {
  assert.deepEqual(
    acceptanceEntryRow({ kind: "watch_adopt", goalName: "lit-watch", versionId: "f04cb236-dfe0-48ce", note: "定时巡检采纳" }),
    { title: "文献雷达 · 巡检已采纳", version: "f04cb236", note: "" },
  );
  assert.deepEqual(
    acceptanceEntryRow({ kind: "pipeline_merge", goalName: "文献检索与筛选", note: "清单核对过" }),
    { title: "文献检索与筛选 · 文件已进入项目", version: "", note: "清单核对过" },
  );
  assert.equal(acceptanceEntryRow({ goalName: " " }).title, "目标 · 已接受");
});
