import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverHelpPrompt,
  helpAnsweredUnsent,
  helpCategoryTag,
  helpInboxLine,
  helpItemsSignature,
  helpUnanswered,
  ledgerLines,
  optionAnswer,
} from "../src/help-requests.ts";
import type { HelpItemDto, HelpRequestDto, ProjectMemoryDocumentDto } from "../src/types.ts";

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
  const plain = deliverHelpPrompt(2, 0);
  assert.match(plain, /有 2 条问题人已经在 Mesa 里答了/);
  assert.match(plain, /再把答过的这几条从 help-wanted\.md 删掉/);
  assert.doesNotMatch(plain, /项目知识/);
  assert.match(deliverHelpPrompt(2, 1), /其中 1 条人要求以后同类照此办，已记进项目知识/);
});

test("任务书账本只取有效、来源没变的已定 / 不做，新的在前", () => {
  const entry = (goalName: string, text: string, state = "active", stalePaths: string[] = []) => ({
    meta: { id: text, createdAt: "", goalName, state, reason: "" },
    text,
    stalePaths,
  });
  const doc: ProjectMemoryDocumentDto = {
    revision: "r",
    legacyText: "",
    entries: [
      entry("已定", "旧的 → A"),
      entry("目标 1", "验收知识"),
      entry("不做", "撤回的", "revoked"),
      entry("已定", "来源变了", "active", ["a.md"]),
      entry("不做", "预印本\n → 不加"),
    ],
  };
  assert.deepEqual(ledgerLines(doc), ["不做：预印本 → 不加", "已定：旧的 → A"]);
});
