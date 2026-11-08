import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverHelpPrompt,
  helpAnsweredUnsent,
  helpCategoryTag,
  helpInboxLine,
  helpItemsSignature,
  helpPendingByRoot,
  helpUnanswered,
  optionAnswer,
} from "../src/help-requests.ts";
import type { HelpItemDto, HelpRequestDto } from "../src/types.ts";

function item(over: Partial<HelpItemDto>): HelpItemDto {
  return {
    id: "x",
    question: "问题",
    detail: [],
    recommend: null,
    options: [],
    fallback: null,
    category: "一般",
    refs: null,
    answer: null,
    sent: null,
    ...over,
  };
}

function request(items: HelpItemDto[]): HelpRequestDto {
  return { root: "/w", workspaceId: "w", workspaceName: "检索", repoName: "p", repoPath: "/p", items };
}

test("收件箱一行：先说没答的问题；全答了只差送出说这个；全送出就没有", () => {
  const open = item({ id: "a", question: "纳入标准是否包含会议论文？" });
  const answered = item({ id: "b", answer: "B（期刊）" });
  const sent = item({ id: "c", answer: "A", sent: "2026-11-02 10:00" });
  assert.equal(helpInboxLine(request([open, answered, item({ id: "d" })])), "有人工请求：纳入标准是否包含会议论文？（共 2 条）");
  assert.equal(helpInboxLine(request([answered, sent])), "1 条回答还没交给 Agent");
  assert.equal(helpInboxLine(request([sent])), null);
  assert.deepEqual(helpUnanswered([open, answered, sent]).map((i) => i.id), ["a"]);
  assert.deepEqual(helpAnsweredUnsent([open, answered, sent]).map((i) => i.id), ["b"]);
});

test("忽略签名只看还要人管的条目与回答：答了或换题就复现", () => {
  const a = item({ id: "a" });
  const sent = item({ id: "s", answer: "A", sent: "t" });
  const base = helpItemsSignature([a, sent]);
  assert.equal(base, helpItemsSignature([a]));
  assert.notEqual(base, helpItemsSignature([item({ id: "a", answer: "B" })]));
  assert.notEqual(base, helpItemsSignature([item({ id: "b" })]));
});

test("选项回答、类别标与交给 Agent 的话", () => {
  assert.equal(optionAnswer("B", "期刊 + 顶会"), "B（期刊 + 顶会）");
  assert.equal(helpCategoryTag("一般"), null);
  assert.equal(helpCategoryTag("范围"), "范围");
  const two = [
    item({ id: "a", question: "会议论文要不要纳入？", answer: "A（只要期刊）" }),
    item({ id: "b", question: "SI 要不要下？", answer: "先不下" }),
  ];
  const plain = deliverHelpPrompt(two, 0);
  assert.match(plain, /答了 \.ccode\/help-wanted\.md 的 2 条问题：\n1\. 会议论文要不要纳入？ → A（只要期刊）\n2\. SI 要不要下？ → 先不下/);
  assert.match(plain, /先把这些答案写进 TASK\.md「已定口径」.*确认写进去了，再把答过的这几条从 help-wanted\.md 删掉/);
  assert.doesNotMatch(plain, /项目知识/);
  assert.match(deliverHelpPrompt(two, 1), /其中 1 条人要求以后同类照此办，已记进项目知识/);
});

test("流程线上的「回答问题（N）」按来源数还要人管的条目，全送出的来源不列", () => {
  const a = request([item({ id: "1" }), item({ id: "2", answer: "A" }), item({ id: "3", answer: "B", sent: "t" })]);
  const b = { ...request([item({ id: "4", answer: "A", sent: "t" })]), root: "/w2" };
  assert.deepEqual(helpPendingByRoot([a, b]), { "/w": 2 });
});
