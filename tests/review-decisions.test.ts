import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReportVerdict,
  applyVerifyVerdict,
  continueAfterDecisionsPrompt,
  isInlineDecisionTaskTitle,
  itemSuggestion,
  parseReviewItems,
  reviewItemsCleared,
} from "../src/review-decisions.ts";

const REPORT = `## 严重问题

R001 位置：manuscript/draft.md:12
问题：摘要把 12% 写成 21%。
类别：数据

## 一般问题

### R002 位置：manuscript/draft.md:40
问题：转场空转。

## 建议

无
`;

test("Agent 预留的空「决定：」行不进正文，点选时就地替换（2026-10-24 HER 润色实证）", () => {
  const text = `## 严重问题

**R001** 位置：§2（draft.md:45）。问题：论证方向与所引数字相反。
决定：

**R002** 位置：§5。问题：误述失活分类。
决定：
`;
  const items = parseReviewItems(text, "report");
  assert.deepEqual(items.map((i) => i.id), ["R001", "R002"]);
  assert.doesNotMatch(items[0].body, /决定/);
  assert.equal(items[0].verdict, null);
  const after = applyReportVerdict(text, "R001", "修改", "按原文三档列数字");
  assert.match(after, /数字相反。\n决定：修改：按原文三档列数字\n\n\*\*R002\*\*/);
  assert.equal(after.match(/决定：/g)?.length, 2);
  assert.equal(parseReviewItems(after, "report")[0].verdict, "修改");
});

test("审查报告按编号拆条，决定行不算进正文", () => {
  const once = applyReportVerdict(REPORT, "R001", "接受");
  const twice = applyReportVerdict(once, "R001", "修改", "改回 12%");
  const items = parseReviewItems(twice, "report");
  assert.deepEqual(
    items.map((item) => item.id),
    ["R001", "R002"],
  );
  assert.equal(items[0]?.verdict, "修改");
  assert.equal(items[0]?.note, "改回 12%");
  assert.equal(items[1]?.verdict, null);
  assert.equal(reviewItemsCleared(items), false);
  assert.match(twice, /决定：修改：改回 12%/);
  assert.equal(twice.split("决定：").length, 2);
});

test("待核实清单把三个按钮写成确认、删除、改正为", () => {
  const source =
    "- V001 | 位置：review-final.md:4 | 原文摘要：容量 21% | 来源：[@lee] | 裁决：待裁决 | 依据：\n" +
    "- V002 | 位置：review-final.md:9 | 原文摘要：循环 200 次 | 来源：[@wu] | 裁决：待裁决 | 依据：\n";
  const accepted = applyVerifyVerdict(source, "V001", "接受");
  const revised = applyVerifyVerdict(accepted, "V002", "修改", "180 次");
  const items = parseReviewItems(revised, "verify");
  assert.equal(items[0]?.verdict, "接受");
  assert.equal(items[1]?.verdict, "修改");
  assert.match(revised, /V001 \| 位置：review-final\.md:4 \| 原文摘要：容量 21% \| 来源：\[@lee\] \| 裁决：确认 \| 依据：/);
  assert.match(revised, /裁决：改正为180 次 \| 依据：180 次/);
  assert.equal(reviewItemsCleared(items), true);
  assert.equal(reviewItemsCleared(parseReviewItems(source, "verify")), false);
});

test("拒绝写删除该论断，旧的确认和删除也能读回来", () => {
  const line = "- V003 | 裁决：待裁决 | 依据：\n";
  const next = applyVerifyVerdict(line, "V003", "拒绝");
  assert.match(next, /裁决：删除该论断/);
  const old = "- V004 | 裁决：确认 | 依据：DOI 10.1/a\n";
  assert.equal(parseReviewItems(old, "verify")[0]?.verdict, "接受");
});

test("全部接受只给还没决定的条目写接受", () => {
  const once = applyReportVerdict(REPORT, "R001", "拒绝");
  const items = parseReviewItems(once, "report");
  let next = once;
  for (const item of items) {
    if (item.verdict == null) next = applyReportVerdict(next, item.id, "接受");
  }
  const after = parseReviewItems(next, "report");
  assert.equal(after.find((item) => item.id === "R001")?.verdict, "拒绝");
  assert.equal(after.find((item) => item.id === "R002")?.verdict, "接受");
});

test("点完接回对话，不把人送去评审", () => {
  assert.match(continueAfterDecisionsPrompt("manuscript/review-report.md", "report"), /决定：/);
  assert.match(continueAfterDecisionsPrompt("manuscript/verification-decisions.md", "verify"), /删除该论断/);
  // 裁决在渲染之后做：确认要去掉标记，改完要重渲、重出域稿（2026-10-24）
  assert.match(continueAfterDecisionsPrompt("manuscript/verification-decisions.md", "verify"), /\[待核实\] 标记删掉/);
  assert.match(continueAfterDecisionsPrompt("manuscript/verification-decisions.md", "verify"), /重渲 PDF 和 Word.*endnote\.docx/);
  // 决定是 Mesa 写进工作区文件的：Agent 要随这一轮一起提交，否则挡保存进项目（2026-10-24）
  assert.match(continueAfterDecisionsPrompt("manuscript/review-report.md", "report"), /review-report\.md 里的决定是 Mesa 替人写进去的，随这一轮改动一起提交/);
  assert.match(continueAfterDecisionsPrompt("manuscript/verification-decisions.md", "verify"), /随这一轮改动一起提交/);
  assert.equal(isInlineDecisionTaskTitle("逐条决定审查报告"), true);
  assert.equal(isInlineDecisionTaskTitle("逐条裁决 [待核实] 与存疑条目"), true);
  assert.equal(isInlineDecisionTaskTitle("在 Word 里换样式（打开域稿）"), false);
});

test("条目自带的改法取出来给「修改」预填（2026-10-24 用户：建议应该预填好）", () => {
  const report = parseReviewItems(`## 严重问题

**R005** 位置：§5。问题：无来源定量估计。类别：数据。建议改法：挂 [@Zhai2022] 口径，或删数字改
 "substantial and grows linearly with current"。
决定：
`, "report");
  assert.equal(itemSuggestion(report[0], "report"), '挂 [@Zhai2022] 口径，或删数字改 "substantial and grows linearly with current"。');
  const verify = parseReviewItems(
    "- V004 | 位置：manuscript/review-final.md:67 | 原文摘要：110 °C | 来源：[@k] | 建议：改成油浴设定 110 °C，去掉待核实 | 裁决：待裁决 | 依据：\n",
    "verify",
  );
  assert.equal(itemSuggestion(verify[0], "verify"), "改成油浴设定 110 °C，去掉待核实");
  assert.equal(itemSuggestion(parseReviewItems("- V001 | 位置：a | 裁决：待裁决 | 依据：\n", "verify")[0], "verify"), "");
  // 修改的落盘：裁决写改正为，建议栏原样留着
  const ruled = applyVerifyVerdict("- V004 | 位置：a | 建议：改成油浴设定 | 裁决：待裁决 | 依据：\n", "V004", "修改", "改成油浴设定");
  assert.match(ruled, /建议：改成油浴设定 \| 裁决：改正为改成油浴设定 \| 依据：改成油浴设定/);
});
