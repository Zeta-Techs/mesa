import assert from "node:assert/strict";
import test from "node:test";
import { chatSearchHits, locateChatQuote, makeChatQuote, quotePayload } from "../src/chat-navigation.ts";
import type { ChatMessageDto } from "../src/types.ts";

const message = (text: string, id?: string): ChatMessageDto => ({ id, role: "assistant", timestamp: null, usage: null, blocks: [{ kind: "text", text, toolName: null }] });

test("引用按来源与原文核对，前插分页不移位，变更或歧义时保留文字但不乱跳", () => {
  const source = message("第一段\n第二段", "a");
  const quote = makeChatQuote([source], "第一段\n第二段", "第二段");
  assert.deepEqual(quote.range, { start: 4, end: 7 });
  assert.equal(locateChatQuote([message("更早"), source], quote), 1);
  assert.equal(locateChatQuote([message("已修改", "a")], quote), -1);
  const anonymous = message("相同");
  assert.equal(locateChatQuote([anonymous, { ...anonymous }], makeChatQuote([anonymous], "相同")), -1);
  assert.equal(quotePayload(quote, "请解释"), "引用之前的回复：\n> 第二段\n\n请解释");
});

test("Markdown 选区无法映射时保留所选文字；整轮回答可以跨多条原始消息", () => {
  const sources = [message("**重点**", "a"), message("结论", "b")];
  const quote = makeChatQuote(sources, "**重点**\n\n结论", "重点\n结论");
  assert.equal(quote.range, null);
  assert.equal(quote.text, "重点\n结论");
  assert.equal(locateChatQuote(sources, quote), 1);
});

test("聊天检索覆盖原始工具输出和单字，重复消息向前分页仍保持命中键", () => {
  const body = message("查测试");
  const output: ChatMessageDto = { ...message(""), blocks: [{kind: "tool_result", text: "Exit code 1: TEST failed", toolName: null}] };
  const hits = chatSearchHits([body, output], "test");
  assert.deepEqual(hits.map(hit => hit.index), [1]);
  const before = chatSearchHits([body, { ...body }], "查");
  const after = chatSearchHits([{ ...body }, body, { ...body }], "查");
  assert.deepEqual(after.slice(1).map(hit => hit.key), before.map(hit => hit.key));
  assert.deepEqual(chatSearchHits([body], "  "), []);
});
