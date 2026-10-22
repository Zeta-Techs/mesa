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

test("CLI 自己报的现状（程序状态）：比「思考中」多说了点什么才用原文", () => {
  assert.deepEqual(chatStatus({ ...base, statusLine: "Connection failed | Retrying (1/15)" }), {
    kind: "cli",
    text: "Connection failed | Retrying (1/15)",
  });
  assert.deepEqual(chatStatus({ ...base, statusLine: "Waiting for response…" }), { kind: "waiting", text: "思考中" });
  // 旁路的工具、思考摘要在它前面
  assert.equal(chatStatus({ ...base, statusLine: "x", thinking: "**读配置**" }).kind, "thinking");
});

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
