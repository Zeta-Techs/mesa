import assert from "node:assert/strict";
import test from "node:test";
import {
  helpAnsweredUnsent,
  helpCategoryTag,
  helpConsultSeed,
  helpInboxLine,
  helpItemsSignature,
  helpNotDismissed,
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

test("选项回答与类别标", () => {
  assert.equal(optionAnswer("B", "期刊 + 顶会"), "B（期刊 + 顶会）");
  assert.equal(helpCategoryTag("一般"), null);
  assert.equal(helpCategoryTag("范围"), "范围");
});

test("流程线上的「回答问题（N）」按来源数还要人管的条目，全送出的来源不列", () => {
  const a = request([item({ id: "1" }), item({ id: "2", answer: "A" }), item({ id: "3", answer: "B", sent: "t" })]);
  const b = { ...request([item({ id: "4", answer: "A", sent: "t" })]), root: "/w2" };
  assert.deepEqual(helpPendingByRoot([a, b]), { "/w": 2 });
});

test("忽略此来源：签名没变的那份各处都不算，问题或回答变了重新算", () => {
  const a = request([item({ id: "1", question: "第⑤问：章节草图？" })]);
  const dismissed = { "/w": helpItemsSignature(a.items) };
  assert.deepEqual(helpPendingByRoot(helpNotDismissed([a], dismissed)), {});
  const changed = request([item({ id: "1", question: "第⑤问：章节草图？", answer: "A" })]);
  assert.deepEqual(helpPendingByRoot(helpNotDismissed([changed], dismissed)), { "/w": 1 });
  const other = { ...request([item({ id: "2" })]), root: "/w2" };
  assert.deepEqual(helpNotDismissed([a, other], dismissed), [other]);
});

test("请几家研讨这一问：问题、选项后果、建议、兜底、依据原样带上；依据里的文件进材料", () => {
  const seed = helpConsultSeed({
    id: "a",
    question: "纳入标准要不要放宽到 2015 年以后？",
    detail: ["现在只有 9 篇"],
    recommend: "B",
    options: [
      { key: "A", label: "维持 2018", effect: "篇数不够做亚组" },
      { key: "B", label: "放宽到 2015", effect: null },
    ],
    fallback: "按 A 继续",
    category: "范围",
    refs: "papers/screening.md 第 12 行；notes/张三2016.md、https://example.com/x.html",
    answer: null,
    sent: null,
  });
  assert.match(seed.question, /纳入标准要不要放宽/);
  assert.match(seed.question, /A\. 维持 2018——篇数不够做亚组/);
  assert.match(seed.question, /B\. 放宽到 2015（它建议）/);
  assert.match(seed.question, /我不回时它会：按 A 继续/);
  assert.match(seed.question, /我自己在卡片上作答/);
  assert.deepEqual(seed.paths.slice(0, 2), ["papers/screening.md", "notes/张三2016.md"]);
  const bare = helpConsultSeed({ id: "b", question: "继续吗？", detail: [], recommend: null, options: [], fallback: null, category: "一般", refs: null, answer: null, sent: null });
  assert.deepEqual(bare.paths, []);
});
