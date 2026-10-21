import assert from "node:assert/strict";
import test from "node:test";
import {
  exploreLabel,
  firstCompleteTurnIndex,
  formatSeconds,
  groupConversationSegments,
  isProcessBlock,
  planEntries,
  problemText,
  segmentContainsIndex,
  turnPlan,
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
  assert.deepEqual(turnSummary(t.items), { text: "改了 1 个文件", problems: 0, problem: null });
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
  assert.deepEqual(turnSummary(t.items), { text: "运行 1 条命令", problems: 1, problem: "1 步没成功" });
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
      ["查看目录", "a\nb"],
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

test("被拒绝单说，不混进「没成功」；CLI 标了 is_error 的结果算失败", () => {
  assert.equal(problemText(["ok", "denied"]), "1 步被拒绝");
  assert.equal(problemText(["failed", "interrupted", "denied"]), "2 步没成功 · 1 步被拒绝");
  assert.equal(problemText(["ok"]), null);
  assert.equal(problemText(["failed"], "处"), "1 处没成功");
  const msgs: ChatMessageDto[] = [
    { role: "user", blocks: [{ kind: "text", text: "查一下", toolName: null }], timestamp: "t0", usage: null },
    {
      role: "assistant",
      blocks: [
        { kind: "tool_use", text: '{"url":"https://crates.io","prompt":"x"}', toolName: "WebFetch" },
        { kind: "tool_result", text: "Unable to verify if domain crates.io is safe to fetch.", toolName: null, isError: true },
      ],
      timestamp: "t1",
      usage: null,
    },
    {
      role: "assistant",
      blocks: [
        { kind: "tool_use", text: '{"command":"echo approve-2"}', toolName: "Bash" },
        { kind: "tool_result", text: "The user doesn't want to proceed with this tool use.", toolName: null, isError: true },
      ],
      timestamp: "t2",
      usage: null,
    },
  ];
  const statuses = groupConversationSegments(msgs)
    .flatMap((s) => (s.kind === "turn" ? s.items : []))
    .flatMap((it) => (it.kind === "tool" ? [it.tool.status] : it.kind === "explore" ? it.tools.map((t) => t.status) : []));
  assert.deepEqual(statuses, ["failed", "denied"]);
});

test("调用与结果按调用 id 配对：并行调用的结果乱序回来也挂对（2026-10-20）", () => {
  const useId = (name: string, input: unknown, callId: string) => ({ ...use(name, input), callId });
  const resultId = (t: string, callId: string) => ({ ...result(t), callId });
  const messages = [
    msg("user", [text("看看")]),
    msg("assistant", [useId("Read", { file_path: "/w/a.ts" }, "c1"), useId("Read", { file_path: "/w/b.ts" }, "c2")]),
    msg("user", [resultId("B 的内容", "c2"), resultId("A 的内容", "c1")]),
    msg("assistant", [text("好了")]),
  ];
  const t = turnOf(groupConversationSegments(messages));
  const explore = t.items.find((i) => i.kind === "explore");
  assert.ok(explore && explore.kind === "explore");
  assert.deepEqual(
    explore.tools.map((x) => [x.activity.target, x.result]),
    [
      ["a.ts", "A 的内容"],
      ["b.ts", "B 的内容"],
    ],
  );
});

test("计划：各家待办参数收成同一份清单，一轮只取最后一次（2026-10-20）", () => {
  assert.deepEqual(
    planEntries(JSON.stringify({ todos: [{ content: "读代码", status: "completed" }, { content: "改", status: "in_progress" }] })),
    [
      { text: "读代码", status: "completed" },
      { text: "改", status: "in_progress" },
    ],
  );
  assert.deepEqual(planEntries(JSON.stringify({ plan: [{ step: "跑测试", status: "pending" }] })), [
    { text: "跑测试", status: "pending" },
  ]);
  assert.equal(planEntries("not json"), null);
  const messages = [
    msg("user", [text("做吧")]),
    msg("assistant", [use("TodoWrite", { todos: [{ content: "A", status: "pending" }] })]),
    msg("user", [result("ok")]),
    msg("assistant", [use("TodoWrite", { todos: [{ content: "A", status: "completed" }] })]),
    msg("user", [result("ok")]),
    msg("assistant", [text("好了")]),
  ];
  const t = turnOf(groupConversationSegments(messages));
  assert.deepEqual(turnPlan(t.items), [{ text: "A", status: "completed" }]);
});

test("还有更早一页时，开头被分页切断的半轮先不显示", () => {
  const half = [
    msg("assistant", [{ kind: "tool_use", text: "ls", toolName: "Bash" } as BlockDto]),
    msg("user", [{ kind: "tool_result", text: "ok" } as BlockDto]),
    msg("assistant", [{ kind: "text", text: "做完了" } as BlockDto]),
  ];
  const ask = msg("user", [{ kind: "text", text: "下一个问题" } as BlockDto]);
  const list = [...half, ask, msg("assistant", [{ kind: "text", text: "好" } as BlockDto])];
  assert.equal(firstCompleteTurnIndex(list, true), 3);
  // 已到对话开头：全显示
  assert.equal(firstCompleteTurnIndex(list, false), 0);
  // 开头就是提问
  assert.equal(firstCompleteTurnIndex([ask, ...half], true), 0);
  // 整页都在一轮里：不藏
  assert.equal(firstCompleteTurnIndex(half, true), 0);
  // 搜索命中落在半轮里：不藏
  assert.equal(firstCompleteTurnIndex(list, true, 1), 0);
  assert.equal(firstCompleteTurnIndex(list, true, 4), 3);
});

test("计划：Claude Code 新版任务工具一条一条建、按编号改，拼回一张清单（2026-10-21）", () => {
  const messages = [
    msg("user", [text("列 3 步计划再做")]),
    msg("assistant", [use("TaskCreate", { subject: "新建 plan_a.txt", activeForm: "新建中" })]),
    msg("user", [result("Task #1 created successfully: 新建 plan_a.txt")]),
    msg("assistant", [use("TaskCreate", { subject: "写一行 ok" })]),
    msg("user", [result("Task #2 created successfully: 写一行 ok")]),
    msg("assistant", [use("TaskCreate", { subject: "读出来" })]),
    msg("user", [result("Task #3 created successfully: 读出来")]),
    msg("assistant", [use("TaskUpdate", { taskId: "1", status: "completed" })]),
    msg("user", [result("Updated task #1 status")]),
    msg("assistant", [use("TaskUpdate", { taskId: "2", status: "in_progress" })]),
    msg("user", [result("Updated task #2 status")]),
    msg("assistant", [use("TaskUpdate", { taskId: "3", status: "deleted" })]),
    msg("user", [result("Updated task #3 deleted")]),
    msg("assistant", [use("TaskUpdate", { taskId: "9", status: "completed" })]),
    msg("user", [result("Task #9 not found")]),
    msg("assistant", [text("好了")]),
  ];
  const t = turnOf(groupConversationSegments(messages));
  assert.deepEqual(turnPlan(t.items), [
    // 建任务时带的 activeForm 留着，聊天层状态行说「正在做的那一项」用
    { text: "新建 plan_a.txt", status: "completed", active: "新建中" },
    { text: "写一行 ok", status: "in_progress" },
  ]);
});
