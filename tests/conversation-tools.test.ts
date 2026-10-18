import assert from "node:assert/strict";
import test from "node:test";
import {
  exploreLabel,
  formatSeconds,
  groupConversationSegments,
  isProcessBlock,
  segmentContainsIndex,
  turnSummary,
  type ConversationSegment,
} from "../src/conversation-tools.ts";
import type { BlockDto, ChatMessageDto } from "../src/types.ts";

function msg(role: string, blocks: BlockDto[], timestamp: string | null = null): ChatMessageDto {
  return { role, blocks, timestamp, usage: null };
}
const at = (s: number) => new Date(Date.UTC(2026, 9, 18, 1, 0, s)).toISOString();
const text = (body: string): BlockDto => ({ kind: "text", text: body, toolName: null });
const think = (body: string): BlockDto => ({ kind: "thinking", text: body, toolName: null });
const use = (name: string, input: unknown): BlockDto => ({ kind: "tool_use", text: JSON.stringify(input), toolName: name });
const result = (body: string): BlockDto => ({ kind: "tool_result", text: body, toolName: null });

function turnOf(segs: ConversationSegment[], k = 0) {
  const turns = segs.filter((s) => s.kind === "turn");
  const t = turns[k];
  assert.ok(t && t.kind === "turn", JSON.stringify(segs.map((s) => s.kind)));
  return t;
}

test("一轮：过程收成一组（思考、工具、中途说明），最后的正文是回答，时长从发问算到最后一条", () => {
  const messages = [
    msg("user", [text("在桌面创建一个 txt")], at(0)),
    msg("assistant", [think("先确认路径")], at(4)),
    msg("assistant", [text("我先看一眼桌面。")], at(5)),
    msg("assistant", [use("Write", { file_path: "/Users/me/Desktop/测试.txt", content: "测试\n" }), result("File created")], at(9)),
    msg("assistant", [text("已在桌面创建 测试.txt。")], at(12)),
  ];
  const segs = groupConversationSegments(messages, { cwd: "/Users/me" });
  assert.deepEqual(segs.map((s) => s.kind), ["message", "turn"]);
  const t = turnOf(segs);
  assert.equal(t.seconds, 12);
  assert.equal(t.live, false);
  assert.deepEqual(t.items.map((i) => i.kind), ["thinking", "text", "tool"]);
  if (t.items[0].kind === "thinking") assert.equal(t.items[0].seconds, 4, "思考时长 = 与上一条消息的间隔");
  if (t.items[2].kind === "tool") {
    assert.equal(t.items[2].tool.activity.target, "测试.txt");
    assert.equal(t.items[2].tool.result, "File created");
  }
  assert.deepEqual(t.answer?.blocks.map((b) => b.text), ["已在桌面创建 测试.txt。"]);
  assert.equal(segmentContainsIndex(t, 1), true);
  assert.equal(segmentContainsIndex(t, 4), true);
  assert.equal(segmentContainsIndex(t, 0), false);
  assert.deepEqual(turnSummary(t.items), { text: "改了 1 个文件", problems: 0 });
});

test("没有过程的回答照原样一条一条，不加「已工作」", () => {
  const segs = groupConversationSegments([msg("user", [text("你好")]), msg("assistant", [text("你好！")])]);
  assert.deepEqual(segs.map((s) => s.kind), ["message", "message"]);
});

test("还在生成的最后一轮：正文都算过程、不切回答；有没回结果的调用也算还在进行", () => {
  const base = [
    msg("user", [text("改一下")]),
    msg("assistant", [use("Read", { file_path: "/p/a.ts" }), result("…")]),
    msg("assistant", [text("看完了，接着改")]),
  ];
  let t = turnOf(groupConversationSegments(base, { live: true }));
  assert.equal(t.live, true);
  assert.equal(t.answer, null);
  assert.equal(t.items[t.items.length - 1].kind, "text");
  t = turnOf(groupConversationSegments(base));
  assert.equal(t.live, false);
  assert.ok(t.answer);
  // 工具还在跑：最后一个调用没有结果
  t = turnOf(groupConversationSegments([...base, msg("assistant", [use("Bash", { command: "npm test" })])]));
  assert.equal(t.live, true);
  // 不是最后一轮就不算
  const older = groupConversationSegments([...base, msg("user", [text("下一句")])], { live: true });
  assert.equal(turnOf(older).live, false);
});

test("连着的读文件 / 搜索并成一行「查阅」，夹着别的动作就断开；失败计数", () => {
  const messages = [
    msg("user", [text("查一下")]),
    msg("assistant", [use("Grep", { pattern: "a" }), result("x"), use("Read", { file_path: "/p/a.ts" }), result("y")]),
    msg("assistant", [use("Read", { file_path: "/p/b.ts" }), result("z")]),
    msg("assistant", [use("Bash", { command: "npm test" }), result("Exit code 1\nfail")]),
    msg("assistant", [use("Read", { file_path: "/p/c.ts" }), result("w")]),
    msg("assistant", [text("原因找到了")]),
  ];
  const t = turnOf(groupConversationSegments(messages));
  assert.deepEqual(t.items.map((i) => i.kind), ["explore", "tool", "tool"]);
  if (t.items[0].kind === "explore") assert.equal(exploreLabel(t.items[0].tools), "读了 2 个文件，搜索 1 次");
  assert.deepEqual(turnSummary(t.items), { text: "运行 1 条命令", problems: 1 });
});

test("结果没处挂、后端给成「用户」的工具结果仍算这一轮；分页截断处的孤立结果也有一行", () => {
  const messages = [
    msg("user", [result("前一页的结果")]),
    msg("assistant", [use("Bash", { command: "ls" })]),
    msg("user", [result("a\nb")]),
    msg("assistant", [text("好了")]),
  ];
  const segs = groupConversationSegments(messages);
  assert.deepEqual(segs.map((s) => s.kind), ["turn"]);
  const t = turnOf(segs);
  assert.deepEqual(
    t.items.map((i) => (i.kind === "tool" ? [i.tool.activity.verb, i.tool.result] : i.kind)),
    [
      ["工具结果", "前一页的结果"],
      ["运行", "a\nb"],
    ],
  );
  assert.equal(isProcessBlock(think("x")), true);
  assert.equal(isProcessBlock(text("x")), false);
});

test("时长写法", () => {
  assert.equal(formatSeconds(0), "不到 1 秒");
  assert.equal(formatSeconds(42), "42 秒");
  assert.equal(formatSeconds(253), "4 分 13 秒");
  assert.equal(formatSeconds(120), "2 分");
  assert.equal(formatSeconds(3900), "1 小时 5 分");
});
