import assert from "node:assert/strict";
import test from "node:test";
import { chatStatus, describeActivity, thinkingHeadline, STATUS_QUIET_START_MS } from "../src/chat-status.ts";
import type { BlockDto, ChatMessageDto } from "../src/types.ts";

const msg = (role: string, blocks: BlockDto[]): ChatMessageDto => ({ role, blocks, timestamp: null, usage: null });
const text = (t: string): BlockDto => ({ kind: "text", text: t, toolName: null });
const use = (name: string, input: unknown, callId?: string): BlockDto => ({
  kind: "tool_use",
  text: JSON.stringify(input),
  toolName: name,
  ...(callId ? { callId } : {}),
});
const result = (t: string, callId?: string): BlockDto => ({ kind: "tool_result", text: t, toolName: null, ...(callId ? { callId } : {}) });
const think = (t: string): BlockDto => ({ kind: "thinking", text: t, toolName: null });
const ask = msg("user", [text("帮我跑一下测试")]);

const base = { messages: [ask], activity: null, thinking: null, sinceStartMs: 5000, cwd: "/w", isWindows: false };

test("什么都还没有：刚发出只亮光标，过一会儿写「思考中」", () => {
  assert.deepEqual(chatStatus({ ...base, sinceStartMs: 200 }), { kind: "none", text: null });
  assert.deepEqual(chatStatus({ ...base, sinceStartMs: STATUS_QUIET_START_MS }), { kind: "waiting", text: "思考中" });
});

test("旁路报来正在跑的工具：说在做的事，不说工具原名", () => {
  const s = chatStatus({ ...base, activity: { name: "Bash", input: JSON.stringify({ command: "npm test" }) } });
  assert.deepEqual(s, { kind: "tool", text: "运行 npm test" });
  assert.equal(describeActivity({ name: "Read", input: JSON.stringify({ file_path: "/w/src/a.ts" }) }, "/w", false), "读取 a.ts");
  assert.equal(describeActivity({ name: "mcp__blender__get_scene_info", input: "{}" }, "/w", false), "调用 blender · get_scene_info");
  assert.equal(
    describeActivity({ name: "commandExecution", input: JSON.stringify({ command: "/bin/zsh -lc 'cargo test'" }) }, "/w", false),
    "运行 cargo test",
  );
  // 补丁一次改几个文件
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Add File: b.ts\n+z\n*** End Patch";
  assert.equal(describeActivity({ name: "apply_patch", input: JSON.stringify({ input: patch }) }, "/w", false), "编辑 a.ts 等 2 个文件");
  // Windows 路径按 Windows 方言相对化
  assert.equal(
    describeActivity({ name: "Edit", input: JSON.stringify({ file_path: "C:\\w\\src\\b.ts" }) }, "C:\\w", true),
    "编辑 b.ts",
  );
});

test("过程里已经有那一行在动：状态行不重复，只说计划里在做的一项", () => {
  const running = [ask, msg("assistant", [use("Bash", { command: "npm test" }, "c1")])];
  assert.deepEqual(chatStatus({ ...base, messages: running, activity: { name: "Bash", input: "{}" } }), { kind: "none", text: null });
  const plan = msg("assistant", [
    use("TodoWrite", { todos: [
      { content: "跑测试", activeForm: "正在跑测试", status: "in_progress" },
      { content: "修报错", activeForm: "正在修报错", status: "pending" },
    ] }, "p1"),
  ]);
  const withPlan = [ask, plan, msg("user", [result("ok", "p1")]), msg("assistant", [use("Bash", { command: "npm test" }, "c1")])];
  assert.deepEqual(chatStatus({ ...base, messages: withPlan }), { kind: "plan", text: "正在跑测试" });
  // 工具跑完、还没开始下一步：说计划里那一项
  const done = [...withPlan, msg("user", [result("pass", "c1")])];
  assert.deepEqual(chatStatus({ ...base, messages: done }), { kind: "plan", text: "正在跑测试" });
});

test("思考：旁路的摘要优先，取小标题或第一句；会话里刚落盘的一段思考兜底", () => {
  assert.deepEqual(chatStatus({ ...base, thinking: "**规划修复步骤**\n\n先看调用方" }), { kind: "thinking", text: "规划修复步骤" });
  assert.equal(thinkingHeadline("The user wants tests run. I'll start with npm."), "The user wants tests run");
  assert.equal(thinkingHeadline("先确认 latestToolName 的调用方。然后改"), "先确认 latestToolName 的调用方");
  assert.equal(thinkingHeadline("  \n## 看看目录\n细节"), "看看目录");
  assert.equal(thinkingHeadline(""), null);
  assert.equal([...(thinkingHeadline("长".repeat(80)) ?? "")].length, 49, "过长截断加省略号");
  const thought = [ask, msg("assistant", [think("想一想先读哪个文件。再说")])];
  assert.deepEqual(chatStatus({ ...base, messages: thought }), { kind: "thinking", text: "想一想先读哪个文件" });
  // 思考之后已经动手了：不再拿那段思考说事
  const acted = [ask, msg("assistant", [think("想一想"), use("Read", { file_path: "/w/a" }, "r1")]), msg("user", [result("x", "r1")])];
  assert.deepEqual(chatStatus({ ...base, messages: acted }), { kind: "waiting", text: "思考中" });
});

test("只看最后一句提问之后：上一轮没回结果的调用不算这一轮在跑", () => {
  const prev = msg("assistant", [use("Bash", { command: "sleep 9" }, "old")]);
  const s = chatStatus({ ...base, messages: [msg("user", [text("上一问")]), prev, ask] });
  assert.deepEqual(s, { kind: "waiting", text: "思考中" });
});

test("Claude Code 的 Task 清单跨轮共用：发了「继续」后这一轮没动计划，状态行仍说进行中那一项", () => {
  // 2026-10-22 实证：任务在上一轮建好、标成进行中，人发「继续」后终端转圈行写「检索候选…」，聊天层只剩光标
  const earlier = [
    msg("user", [text("读 TASK.md，按简报做到完成标准")]),
    msg("assistant", [
      use("TaskCreate", { subject: "检索候选文献并去重", activeForm: "检索候选" }, "t1"),
      use("TaskCreate", { subject: "逐条筛选与字段补全", activeForm: "筛选并补字段" }, "t2"),
    ]),
    msg("user", [result("Task #3 created successfully: 检索候选文献并去重", "t1"), result("Task #4 created successfully: 逐条筛选与字段补全", "t2")]),
    msg("assistant", [use("TaskUpdate", { taskId: "3", status: "in_progress" }, "u1")]),
    msg("user", [result("Updated task #3 status", "u1")]),
  ];
  const resumed = [
    ...earlier,
    msg("user", [text("继续")]),
    msg("assistant", [use("Bash", { command: "python fetch_oa.py" }, "c9")]),
  ];
  assert.deepEqual(chatStatus({ ...base, messages: resumed }), { kind: "plan", text: "检索候选" });
  // 这一轮自己更新过计划时以这一轮为准（全部做完就不再说）
  const finished = [
    ...resumed,
    msg("user", [result("ok", "c9")]),
    msg("assistant", [use("TodoWrite", { todos: [{ content: "检索候选文献并去重", status: "completed" }] }, "p9")]),
    msg("user", [result("ok", "p9")]),
    msg("assistant", [use("Bash", { command: "ls" }, "c10")]),
  ];
  assert.deepEqual(chatStatus({ ...base, messages: finished }), { kind: "none", text: null });
});
