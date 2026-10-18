import assert from "node:assert/strict";
import test from "node:test";
import { stepEvidenceLabel, stepEvidenceSummary, stepEvidenceSummaryOf } from "../src/step-evidence.ts";

test("步骤卡只认报告里写明的质量状态和未决标记", () => {
  const text = [
    "## 验收摘要",
    "- 质量状态：已生成待审",
    "正文有 [待核实] 两处，其中一处是 [待核实]。",
    "规则还标了 [待确认]。",
  ].join("\n");
  assert.equal(
    stepEvidenceLabel(stepEvidenceSummary(text)),
    "已生成待审 · 待核实 2 · 待确认 1",
  );
});

test("没有状态也没有标记时步骤卡不显示", () => {
  assert.equal(stepEvidenceLabel(stepEvidenceSummary("普通段落")), null);
});

test("阻塞和限定范围的证据通过保持原词", () => {
  assert.equal(
    stepEvidenceSummary("质量状态：证据通过（限定范围）").status,
    "证据通过（限定范围）",
  );
  assert.equal(stepEvidenceSummary("质量状态：**阻塞**").status, "阻塞");
});

test("定稿步：审查报告里描述的 [待核实] 不算稿子里剩下的", () => {
  const files = [
    { path: "manuscript/review-report.md", text: "质量状态：已生成待审\nR003 摘要里有 [待核实] [待核实]" },
    { path: "manuscript/changelog.md", text: "删掉一处 [待核实]" },
    { path: "manuscript/review-final.md", text: "正文没有未决标记" },
  ];
  const s = stepEvidenceSummaryOf(files);
  assert.equal(s.status, "已生成待审");
  assert.equal(s.unverified, 0);
  // 稿子里真有的照数
  const withMark = stepEvidenceSummaryOf([...files.slice(0, 2), { path: "manuscript/review-final.md", text: "A [待核实]" }]);
  assert.equal(withMark.unverified, 1);
  // 只有审查类文件时（没有正文）退回全部计数
  assert.equal(stepEvidenceSummaryOf(files.slice(0, 1)).unverified, 2);
});
