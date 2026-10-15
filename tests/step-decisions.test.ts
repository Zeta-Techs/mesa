import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTINUE_STEP_PROMPT,
  continueWithBriefPrompt,
  DECISIONS_HEADING,
  KEEP_WORKING_CLAUSE,
  decisionAsk,
  decisionPolicyBlock,
  decisionPolicyText,
  formatDecisionAnswer,
  stepWaitItems,
  isDecisionsOnly,
  isTaskMdStub,
  orderedAnswers,
  parseDecisions,
  recommendedAnswers,
  resolveTaskMdSource,
  reviewDistillSections,
  stripDecisions,
  unansweredDecisions,
  upsertDecisions,
  withReviewDistill,
} from "../src/step-decisions.ts";
import type { StepDecisionDto } from "../src/types.ts";

const DECISIONS: StepDecisionDto[] = [
  { q: "综述角度怎么收", options: ["领域全景铺开", "聚焦某个子问题"] },
  { q: "纳入标准定多严", options: ["只要高质量期刊/顶会", "含预印本"] },
];

test("决策暂停策略：按步骤列出必须停的事项，批次提交不是停工", () => {
  assert.match(decisionPolicyText("auto_continue"), /auto_continue/);
  assert.ok(CONTINUE_STEP_PROMPT.includes(KEEP_WORKING_CLAUSE));
  const carried = continueWithBriefPrompt(".ccode/handoff-1.md");
  assert.match(carried, /读 \.ccode\/handoff-1\.md 接力简报/);
  assert.ok(carried.includes(CONTINUE_STEP_PROMPT));
  const notes = decisionPolicyBlock({
    name: "文献精读与笔记",
    workspaceName: "lit-notes",
    brief: "把建议核心精读 K 篇写进 .ccode/help-wanted.md 问用户一句",
    humanTasks: [{ title: "继续精读笔记", timing: "after", optional: true }],
  });
  assert.match(notes, /先报依据再问/);
  assert.match(notes, /未答不得锁死/);
  assert.ok(notes.includes(KEEP_WORKING_CLAUSE));
  assert.doesNotMatch(notes, /继续精读笔记/);
  const draft = decisionPolicyBlock({
    name: "综述初稿",
    decisionMode: "hard_pause",
    decisions: [{ q: "写作依据的已评阅证据与结论范围" }],
  });
  assert.match(draft, /拍板后再锁范围：写作依据的已评阅证据与结论范围/);
  const format = decisionPolicyBlock({
    name: "期刊格式适配",
    workspaceName: "journal-format",
    humanTasks: [
      { title: "放入成稿与 references.bib", timing: "before" },
      { title: "拍板目标期刊、字数裁剪方案并补齐「待填」信息", timing: "after" },
    ],
  });
  assert.match(format, /开工前等你做完：放入成稿/);
  assert.match(format, /完成后交给你：拍板目标期刊/);
  assert.match(format, /渲染出样张后停下来让你看版式/);
  const search = stepWaitItems({
    name: "文献检索与筛选",
    brief: "写进 .ccode/help-wanted.md 问用户一句",
  });
  assert.equal(search.during.some((x) => x.includes("先报依据再问")), true);
});

test("空草稿：新建小节并写入答案", () => {
  const out = upsertDecisions("", [{ q: "综述角度怎么收", answer: "领域全景铺开" }]);
  assert.match(out, /^## 已定方向\n\n- 综述角度怎么收：领域全景铺开\n/);
  assert.deepEqual([...parseDecisions(out)], [["综述角度怎么收", "领域全景铺开"]]);
});

test("已有草稿：小节插在一级标题之后，正文不动", () => {
  const draft = "# 任务书草稿：检索筛选\n\n## 背景\n\n这里是正文。\n";
  const out = upsertDecisions(draft, [
    { q: "综述角度怎么收", answer: "聚焦某个子问题" },
  ]);
  const lines = out.split("\n");
  assert.equal(lines[0], "# 任务书草稿：检索筛选");
  assert.ok(
    lines.indexOf(DECISIONS_HEADING) < lines.indexOf("## 背景"),
    `已定方向应在正文小节之前:\n${out}`,
  );
  assert.ok(out.includes("这里是正文。"), "原正文必须保留");
});

test("重复拍板同一题 = 覆盖，不产生第二行", () => {
  let out = upsertDecisions("", [{ q: "综述角度怎么收", answer: "领域全景铺开" }]);
  out = upsertDecisions(out, [{ q: "综述角度怎么收", answer: "聚焦某个子问题" }]);
  assert.equal(parseDecisions(out).get("综述角度怎么收"), "聚焦某个子问题");
  assert.equal(out.match(/- 综述角度怎么收：/g)?.length, 1, out);
});

test("小节内已有答案 + 新答案：保序追加，原答案保留", () => {
  let out = upsertDecisions("", [{ q: "综述角度怎么收", answer: "领域全景铺开" }]);
  out = upsertDecisions(out, [{ q: "纳入标准定多严", answer: "含预印本" }]);
  assert.deepEqual(
    [...parseDecisions(out)],
    [
      ["综述角度怎么收", "领域全景铺开"],
      ["纳入标准定多严", "含预印本"],
    ],
  );
});

test("小节被后续二级标题终止：不吃下面的内容", () => {
  const draft = `${DECISIONS_HEADING}\n\n- 综述角度怎么收：领域全景铺开\n\n## 其他\n\n- 纳入标准定多严：不该被解析\n`;
  const got = parseDecisions(draft);
  assert.equal(got.get("综述角度怎么收"), "领域全景铺开");
  assert.equal(got.has("纳入标准定多严"), false, "小节外的同形行不该算数");
});

test("小节只由空行与答案行组成：遇到任何别的内容即终止（不吞正文）", () => {
  // 已定方向后面直接跟没有标题的正文——旧口径（吃到下一个 ## 或文件尾）会把正文
  // 一并算进小节，重写时删掉它。这里断言正文既不被解析、也不被吞掉
  const draft = `${DECISIONS_HEADING}\n\n- 综述角度怎么收：领域全景铺开\n\n这是人写的正文，不能丢。\n`;
  assert.equal(parseDecisions(draft).get("综述角度怎么收"), "领域全景铺开");
  assert.equal(stripDecisions(draft), "这是人写的正文，不能丢。");
  const out = upsertDecisions(draft, [
    { q: "纳入标准定多严", answer: "只要顶刊" },
  ]);
  assert.ok(out.includes("这是人写的正文，不能丢。"), `正文必须保留:\n${out}`);
  assert.equal(parseDecisions(out).size, 2);
});

test("没有小节 / 空答案：解析为空、写入为 no-op", () => {
  assert.equal(parseDecisions("# 只有标题\n\n正文").size, 0);
  const draft = "# 任务书草稿\n";
  assert.equal(upsertDecisions(draft, []), draft);
  assert.equal(upsertDecisions(draft, [{ q: " ", answer: "x" }]), draft);
  assert.equal(upsertDecisions(draft, [{ q: "x", answer: " " }]), draft);
});

test("未答项与推荐值：已答的不被一键覆盖", () => {
  const answered = new Map([["综述角度怎么收", "聚焦某个子问题"]]);
  assert.deepEqual(
    unansweredDecisions(DECISIONS, answered).map((d) => d.q),
    ["纳入标准定多严"],
  );
  assert.deepEqual(recommendedAnswers(DECISIONS, answered), [
    { q: "纳入标准定多严", answer: formatDecisionAnswer("approve", "只要高质量期刊/顶会") },
  ]);
  assert.deepEqual(recommendedAnswers(DECISIONS, new Map()), [
    { q: "综述角度怎么收", answer: formatDecisionAnswer("approve", "领域全景铺开") },
    { q: "纳入标准定多严", answer: formatDecisionAnswer("approve", "只要高质量期刊/顶会") },
  ]);
});

test("无选项的决策项不参与推荐值", () => {
  assert.deepEqual(recommendedAnswers([{ q: "空题", options: [] }], new Map()), []);
});

test("CRLF 草稿也能解析", () => {
  const draft = `${DECISIONS_HEADING}\r\n\r\n- 综述角度怎么收：领域全景铺开\r\n`;
  assert.equal(parseDecisions(draft).get("综述角度怎么收"), "领域全景铺开");
});

// ===== 开工口径：只点了选项的草稿不该顶掉模板拼装 =====

test("只有已定方向的草稿 = 决策项-only（开工走模板拼装）", () => {
  const draft = upsertDecisions("", [
    { q: "综述角度怎么收", answer: "领域全景铺开" },
  ]);
  assert.equal(isDecisionsOnly(draft), true);
  assert.equal(stripDecisions(draft), "");
});

test("只剩标题行也算没有正文", () => {
  const draft = upsertDecisions("# 任务书草稿：检索筛选\n", [
    { q: "综述角度怎么收", answer: "领域全景铺开" },
  ]);
  assert.equal(isDecisionsOnly(draft), true, draft);
});

test("有正文的草稿不是决策项-only（保持 v3.72 草稿优先）", () => {
  const draft = upsertDecisions("# 任务书草稿\n\n先做预调研，再定检索式。\n", [
    { q: "综述角度怎么收", answer: "领域全景铺开" },
  ]);
  assert.equal(isDecisionsOnly(draft), false, draft);
  assert.equal(stripDecisions(draft), "# 任务书草稿\n\n先做预调研，再定检索式。");
});

test("空草稿 / 无已定方向段：都不是决策项-only", () => {
  assert.equal(isDecisionsOnly(""), false);
  assert.equal(isDecisionsOnly("   "), false);
  assert.equal(isDecisionsOnly("# 任务书草稿\n\n正文"), false);
});

// ===== 可执行任务书闸门：评审沉淀 stub 不得顶掉模板拼装 =====

const LIT_NOTES_STUB = `# 任务书草稿：文献精读与笔记


## 上一步（lit-search）评审沉淀（2026-09-18T08:18:13Z）
「lit-search」已保存进项目。请读项目根已有产物与本步 TASK.md 接着做，不要编造未出现的文献。
`;

const ASSEMBLED_NOTES = `# 文献精读与笔记

项目根：\`/tmp/p\`

## 课题主题
主题

输入：上一步产物 papers/included.md。全程按 lit-notes 技能执行。

## 预期产物
- notes/*.md
`;

test("空文件 / 只剩标题 / 仅已定方向 / 仅评审沉淀 = 任务书 stub", () => {
  assert.equal(isTaskMdStub(""), true);
  assert.equal(isTaskMdStub("   "), true);
  assert.equal(isTaskMdStub("# 任务书草稿：文献精读与笔记\n"), true);
  assert.equal(
    isTaskMdStub(
      upsertDecisions("# 任务书草稿：检索筛选\n", [
        { q: "综述角度怎么收", answer: "领域全景铺开" },
      ]),
    ),
    true,
  );
  assert.equal(isTaskMdStub(LIT_NOTES_STUB), true);
  assert.equal(
    isTaskMdStub(
      upsertDecisions(LIT_NOTES_STUB, [
        { q: "综述角度怎么收", answer: "领域全景铺开" },
      ]),
    ),
    true,
  );
});

test("有简报正文的草稿不是 stub（含同时带评审沉淀）", () => {
  assert.equal(isTaskMdStub("# 任务书草稿\n\n先做预调研，再定检索式。\n"), false);
  assert.equal(isTaskMdStub(`${ASSEMBLED_NOTES}\n${LIT_NOTES_STUB}`), false);
});

test("评审沉淀小节能抽出，接到模板拼装后面且不重复", () => {
  const section = reviewDistillSections(LIT_NOTES_STUB);
  assert.match(section, /## 上一步（lit-search）评审沉淀（2026-09-18T08:18:13Z）/);
  assert.match(section, /不要编造未出现的文献/);
  const merged = withReviewDistill(ASSEMBLED_NOTES, LIT_NOTES_STUB);
  assert.match(merged, /全程按 lit-notes 技能执行/);
  assert.match(merged, /不要编造未出现的文献/);
  assert.equal(withReviewDistill(merged, LIT_NOTES_STUB), merged);
});

test("resolveTaskMdSource：stub 走拼装+沉淀，有正文用文件全文", () => {
  const fromStub = resolveTaskMdSource(LIT_NOTES_STUB, ASSEMBLED_NOTES);
  assert.match(fromStub, /全程按 lit-notes 技能执行/);
  assert.match(fromStub, /不要编造未出现的文献/);
  const full = `${ASSEMBLED_NOTES}\n人手改过的一句。\n`;
  assert.equal(resolveTaskMdSource(full, "不应使用"), full);
  assert.equal(resolveTaskMdSource("", ASSEMBLED_NOTES), ASSEMBLED_NOTES);
  assert.equal(resolveTaskMdSource(null, ASSEMBLED_NOTES), ASSEMBLED_NOTES);
});

test("orderedAnswers：按模板顺序排，人手写的条目排在后面不丢", () => {
  const decisions = [
    { q: "综述角度怎么收", options: ["领域全景铺开"] },
    { q: "纳入标准定多严", options: ["只要顶刊"] },
  ];
  const answered = new Map([
    ["纳入标准定多严", "只要顶刊"],
    ["手写的题", "手写的答案"],
    ["综述角度怎么收", "领域全景铺开"],
  ]);
  assert.deepEqual(orderedAnswers(decisions, answered), [
    { q: "综述角度怎么收", answer: "领域全景铺开" },
    { q: "纳入标准定多严", answer: "只要顶刊" },
    { q: "手写的题", answer: "手写的答案" },
  ]);
});

test("decisionAsk：合同口吻的初稿题改成人话，其它题原样", () => {
  assert.equal(
    decisionAsk("写作依据的已评阅证据与结论范围（仅探索/待补时明确草稿边界）"),
    "初稿可以依据哪些已经评过的笔记？结论能写到哪一步？",
  );
  assert.equal(decisionAsk("综述角度怎么收"), "综述角度怎么收");
});
