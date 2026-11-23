import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReportVerdict,
  applyVerifyVerdict,
  clearReportVerdict,
  clearVerifyVerdict,
  continueAfterDecisionsPrompt,
  countReviewVerdicts,
  decisionCandidatePaths,
  isInlineDecisionTaskTitle,
  itemSuggestion,
  parseReviewItems,
  resolveDecisionHandoffState,
  reviewItemDisplayBody,
  reviewItemMatchesQuery,
  reviewItemSourceTag,
  reviewItemSummary,
  reviewItemsCleared,
  reviewVerdictsSignature,
  tokenizeDecisionSummary,
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
  assert.match(continueAfterDecisionsPrompt("manuscript/verification-decisions.md", "verify"), /the abstract reports/);
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

  // 审查报告实测常写「建议：」（HER 定稿审查报告 R001–R010），且小节标题不粘进上一条末尾
  const herReport = parseReviewItems(`## 严重问题

R003 位置：\`manuscript/draft.md:266\`。问题：时长超写。类别：事实。建议：改为 10–12 h。

## 一般问题

R004 位置：\`manuscript/draft.md:37\`。问题：语态偏导读。类别：写作。建议：改为面向同行表述。

## 建议

无
`, "report");
  assert.equal(herReport.length, 2);
  assert.doesNotMatch(reviewItemSummary(herReport[0], "report"), /## 一般问题/);
  assert.doesNotMatch(reviewItemSummary(herReport[1], "report"), /## 建议|无$/);
  assert.equal(itemSuggestion(herReport[0], "report"), "改为 10–12 h。");
});

test("条目里的文件路径与多行号拆成可点跳转，裸文件名补试报告同目录", () => {
  const items = parseReviewItems(`## 严重问题

R001 位置：\`manuscript/draft.md:166, 212, 240\`（\`@tbl-her\`）。问题：与 \`draft.md:131, 195\` 及 \`notes/extraction.md:29\` 口径不一致，参考 \`references.bib:590-591\`。
`, "report");
  const tokens = tokenizeDecisionSummary(reviewItemSummary(items[0], "report"));
  const files = tokens.filter((t) => t.kind === "file");
  assert.equal(files.length, 4);
  assert.equal(files[0].path, "manuscript/draft.md");
  assert.deepEqual(files[0].jumps, [
    { label: "manuscript/draft.md:166", line: 166 },
    { sep: ", ", label: "212", line: 212 },
    { sep: ", ", label: "240", line: 240 },
  ]);
  assert.deepEqual(files[3].jumps, [{ label: "references.bib:590-591", line: 590 }]);
  const { orderedRaws, candidatesByRaw } = decisionCandidatePaths(items, "report", "manuscript/review-report.md");
  assert.deepEqual(orderedRaws, [
    "manuscript/draft.md",
    "draft.md",
    "notes/extraction.md",
    "references.bib",
    "manuscript/review-report.md",
  ]);
  assert.deepEqual(candidatesByRaw.get("draft.md"), ["draft.md", "manuscript/draft.md"]);
});

test("审查报告保留小节严重度与类别，撤销清空决定并支持筛选检索", () => {
  const doc = `## 严重问题

R001 位置：manuscript/draft.md:12。问题：摘要数字偏大。类别：数据。建议改法：改回 12%。

## 一般问题

R002 位置：manuscript/draft.md:40。问题：转场生硬。类别：写作。

## 建议

R003 位置：manuscript/draft.md:90。问题：可补一句展望。类别：写作。建议：末尾加一句。
`;
  const parsed = parseReviewItems(doc, "report");
  assert.deepEqual(
    parsed.map((i) => ({ id: i.id, section: i.section, category: i.category })),
    [
      { id: "R001", section: "severe", category: "数据" },
      { id: "R002", section: "general", category: "写作" },
      { id: "R003", section: "suggestion", category: "写作" },
    ],
  );
  // 展示正文剥离末尾已单独渲染的建议段，避免同一条里重复两遍
  assert.doesNotMatch(reviewItemDisplayBody(parsed[0], "report"), /建议改法/);
  assert.match(reviewItemDisplayBody(parsed[0], "report"), /摘要数字偏大/);

  const applied = applyReportVerdict(doc, "R001", "修改", "改回 12%");
  assert.equal(parseReviewItems(applied, "report")[0]?.verdict, "修改");
  const undone = clearReportVerdict(applied, "R001");
  assert.equal(parseReviewItems(undone, "report")[0]?.verdict, null);
  assert.doesNotMatch(undone, /决定：修改/);

  const verifyLine =
    "- V001 | 位置：manuscript/review-final.md:145 | 原文摘要：过电位 | 来源：[@Liu2025] | 裁决：待裁决 | 依据：\n";
  const vMod = applyVerifyVerdict(verifyLine, "V001", "修改", "按原文改写");
  assert.equal(parseReviewItems(vMod, "verify")[0]?.verdict, "修改");
  const vUndone = clearVerifyVerdict(vMod, "V001");
  assert.equal(parseReviewItems(vUndone, "verify")[0]?.verdict, null);
  assert.match(vUndone, /裁决：待裁决 \| 依据：/);
  assert.equal(reviewItemSourceTag(parseReviewItems(verifyLine, "verify")[0]!, "verify"), "review-final.md");

  assert.equal(reviewItemMatchesQuery(parsed[0], "report", "严重 数据"), true);
  assert.equal(reviewItemMatchesQuery(parsed[2], "report", "严重"), false);
  const counts = countReviewVerdicts(parseReviewItems(applied, "report"));
  assert.deepEqual(counts, { total: 3, open: 2, decided: 1, accepted: 0, modified: 1, rejected: 0 });

  const sigA = reviewVerdictsSignature(parseReviewItems(applied, "report"));
  assert.equal(resolveDecisionHandoffState(sigA, null), "pending");
  assert.equal(resolveDecisionHandoffState(sigA, sigA), "handed");
  const changed = applyReportVerdict(applied, "R001", "拒绝");
  const sigB = reviewVerdictsSignature(parseReviewItems(changed, "report"));
  assert.equal(resolveDecisionHandoffState(sigB, sigA), "changed");
});
