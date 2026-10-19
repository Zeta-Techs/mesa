import assert from "node:assert/strict";
import test from "node:test";
import {
  HOOKS_AGENTS,
  agentHasHooks,
  approvalExtraHint,
  chatMessageKey,
  chatHeaderStatus,
  chatWaitKind,
  chatWaitText,
  composerShowsInterrupt,
  confirmHandoffEvent,
  placePendingUsers,
  handoffFor,
  hasAssistantText,
  kimiModelArg,
  latestToolName,
  mergeConversationPages,
  modelSwitchCommand,
  slashCommandRecorded,
  shouldAutoPeek,
  slashHandoff,
} from "../src/chat-handoff.ts";
import type { ChatMessageDto } from "../src/types.ts";

function msg(
  role: string,
  blocks: ChatMessageDto["blocks"],
  timestamp: string | null = "t1",
): ChatMessageDto {
  return { role, blocks, timestamp, usage: null };
}

test("发送钮变暂停：正在出字或等首个回复；停在提示符或审批时仍是发送", () => {
  assert.equal(
    composerShowsInterrupt({ running: true, attention: "working" }),
    true,
  );
  assert.equal(
    composerShowsInterrupt({ running: true, pendingReply: true }),
    true,
  );
  assert.equal(
    composerShowsInterrupt({ running: true, attention: "done" }),
    false,
    "进程活着但停在提示符",
  );
  assert.equal(
    composerShowsInterrupt({ running: true, attention: "confirm" }),
    false,
    "审批时 Esc 归审批卡",
  );
  assert.equal(composerShowsInterrupt({ running: false, attention: "working" }), false);
  assert.equal(composerShowsInterrupt({}), false);
});

test("七家有 hooks，cursor/opencode 没有", () => {
  assert.equal(HOOKS_AGENTS.size, 7);
  assert.equal(agentHasHooks("claude"), true);
  assert.equal(agentHasHooks("codex"), true);
  assert.equal(agentHasHooks("cursor"), false);
  assert.equal(agentHasHooks("opencode"), false);
  assert.equal(agentHasHooks(null), false);
});

test("交接表：能聊天完成 / 窥视 / 必须切走", () => {
  assert.equal(handoffFor("send_message"), "chat_ok");
  assert.equal(handoffFor("direct_slash"), "chat_ok");
  assert.equal(handoffFor("picker_model"), "peek");
  assert.equal(handoffFor("hooks_confirm"), "peek");
  assert.equal(handoffFor("no_hooks_confirm"), "peek");
  assert.equal(handoffFor("login_or_trust"), "peek");
  assert.equal(handoffFor("prompt_dropped"), "must_switch");
  assert.equal(handoffFor("self_update"), "must_switch");
  assert.equal(shouldAutoPeek("picker_model"), true);
  assert.equal(shouldAutoPeek("send_message"), false);
  assert.equal(shouldAutoPeek("prompt_dropped"), true);
});

test("confirm 事件按 hooks 开关分流", () => {
  assert.equal(confirmHandoffEvent("claude", true), "hooks_confirm");
  assert.equal(confirmHandoffEvent("claude", false), "no_hooks_confirm");
  assert.equal(confirmHandoffEvent("cursor", true), "no_hooks_confirm");
});

test("审批附加说明：codex 点名 /hooks，无 hooks 引导去终端", () => {
  assert.match(approvalExtraHint("codex", true) ?? "", /\/hooks/);
  assert.match(approvalExtraHint("cursor", false) ?? "", /精确注意力/);
  assert.equal(approvalExtraHint("claude", true), null);
});

test("等待态三句人话 + 工具名", () => {
  assert.equal(chatWaitText("sent"), "已送出");
  assert.equal(chatWaitText("writing"), "正在生成回复");
  assert.equal(chatWaitText("using_tool", "Bash"), "正在用 Bash");
  assert.equal(chatWaitText("using_tool"), "正在调用工具");
  assert.match(chatWaitText("no_session"), /会话文件还没出现/);
  assert.equal(chatWaitText("idle"), "");

  assert.equal(
    chatWaitKind({
      pendingReply: true,
      running: true,
      syncState: "waiting",
      messageCount: 1,
      stuckWaiting: false,
      toolName: null,
    }),
    "sent",
  );
  assert.equal(
    chatWaitKind({
      pendingReply: true,
      running: true,
      syncState: "watching",
      messageCount: 2,
      stuckWaiting: false,
      toolName: null,
    }),
    "writing",
  );
  assert.equal(
    chatWaitKind({
      pendingReply: true,
      running: true,
      syncState: "watching",
      messageCount: 2,
      stuckWaiting: false,
      toolName: "Bash",
    }),
    "using_tool",
  );
  assert.equal(
    chatWaitKind({
      pendingReply: false,
      running: true,
      syncState: "waiting",
      messageCount: 0,
      stuckWaiting: true,
      toolName: null,
    }),
    "no_session",
  );
});

test("聊天头：没开始时不写等待会话文件", () => {
  assert.equal(
    chatHeaderStatus({
      state: "idle",
      syncState: "waiting",
      running: false,
      canResume: false,
      messageCount: 0,
    }),
    "",
  );
  assert.equal(
    chatHeaderStatus({
      state: "timeout",
      syncState: "waiting",
      running: false,
      canResume: true,
      messageCount: 0,
    }),
    "可恢复",
  );
  assert.equal(
    chatHeaderStatus({
      state: "idle",
      syncState: "waiting",
      running: true,
      canResume: false,
      messageCount: 0,
    }),
    "等待会话文件",
  );
  assert.equal(
    chatHeaderStatus({
      state: "linked",
      syncState: "watching",
      running: true,
      canResume: false,
      messageCount: 3,
    }),
    "实时同步",
  );
});

test("latestToolName 从最新 assistant 取，碰到 user 即停", () => {
  assert.equal(latestToolName([]), null);
  assert.equal(
    latestToolName([
      msg("user", [{ kind: "text", text: "hi", toolName: null }]),
    ]),
    null,
  );
  assert.equal(
    latestToolName([
      msg("user", [{ kind: "text", text: "hi", toolName: null }]),
      msg("assistant", [
        { kind: "tool_use", text: "ls", toolName: "Bash" },
        { kind: "text", text: "", toolName: null },
      ]),
    ]),
    "Bash",
  );
  assert.equal(
    latestToolName([
      msg("assistant", [{ kind: "tool_use", text: "x", toolName: "Read" }]),
      msg("user", [{ kind: "text", text: "next", toolName: null }]),
    ]),
    null,
  );
});

test("hasAssistantText 忽略纯工具块", () => {
  assert.equal(
    hasAssistantText([
      msg("assistant", [{ kind: "tool_use", text: "ls", toolName: "Bash" }]),
    ]),
    false,
  );
  assert.equal(
    hasAssistantText([
      msg("assistant", [
        { kind: "tool_use", text: "ls", toolName: "Bash" },
        { kind: "text", text: "好了", toolName: null },
      ]),
    ]),
    true,
  );
});

test("斜杠交接：无参 /model、/models、/login 要窥视", () => {
  assert.equal(slashHandoff("/help", "direct"), "direct_slash");
  assert.equal(slashHandoff("/effort high", "direct"), "direct_slash");
  assert.equal(slashHandoff("/model opus", "direct"), "direct_slash");
  assert.equal(slashHandoff("/model", "direct"), "picker_model");
  assert.equal(slashHandoff("/model opus", "picker"), "picker_model");
  assert.equal(slashHandoff("/models", null), "picker_model");
  assert.equal(slashHandoff("/login", null), "picker_model");
});

test("会话分页去重拼接，最新窗优先", () => {
  const older = [
    msg("user", [{ kind: "text", text: "a", toolName: null }], "t0"),
    msg("assistant", [{ kind: "text", text: "b", toolName: null }], "t1"),
  ];
  const latest = [
    msg("assistant", [{ kind: "text", text: "b", toolName: null }], "t1"),
    msg("user", [{ kind: "text", text: "c", toolName: null }], "t2"),
  ];
  const merged = mergeConversationPages(older, latest);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].timestamp, "t0");
  assert.equal(merged[2].timestamp, "t2");
  assert.equal(
    chatMessageKey(older[1]),
    chatMessageKey(latest[0]),
  );
});

test("kimi 模型别名与 /model 命令模板", () => {
  assert.equal(kimiModelArg("gpt-4.1"), "gpt-4_1");
  assert.equal(
    modelSwitchCommand("/model {model}", "gpt-4.1", "kimi"),
    "/model gpt-4_1",
  );
  assert.equal(
    modelSwitchCommand("/model {model}", "gpt-4.1", "claude"),
    "/model gpt-4.1",
  );
});

test("本地消息放回：普通发送插在新回复前，长对话不跳到页顶；排队中的接在末尾", () => {
  const msg = (role: string, text: string, queued = false) => ({
    role,
    blocks: [{ kind: "text" as const, text, toolName: null }],
    timestamp: null,
    usage: null,
    ...(queued ? { queued: true } : {}),
  });
  const old = [msg("user", "第一问"), msg("assistant", "第一答"), msg("user", "第二问"), msg("assistant", "第二答")];
  const known = new Set(old.filter((m) => m.role !== "user").map((m) => JSON.stringify(m.blocks)));
  const sent = msg("user", "第三问");
  // 长对话：刚发的那句还没落盘、回复也还没出 → 接在末尾（原先会插到「第一答」前面）
  assert.deepEqual(
    placePendingUsers(old, [sent], known).map((m) => m.blocks[0].text),
    ["第一问", "第一答", "第二问", "第二答", "第三问"],
  );
  // 回复先落盘、用户那句还没有 → 插在新回复前
  const reply = msg("assistant", "第三答");
  assert.deepEqual(
    placePendingUsers([...old, reply], [sent], known).map((m) => m.blocks[0].text),
    ["第一问", "第一答", "第二问", "第二答", "第三问", "第三答"],
  );
  // 排队中的：即便后面又长出新回复，也在末尾
  const queued = msg("user", "补一句", true);
  assert.deepEqual(
    placePendingUsers([...old, reply], [queued], known).map((m) => m.blocks[0].text),
    ["第一问", "第一答", "第二问", "第二答", "第三答", "补一句"],
  );
  assert.equal(placePendingUsers(old, [], known), old);
});

const cmdMsg = (role: string, kind: string, text: string, timestamp: string | null) => ({
  role,
  blocks: [{ kind, text, toolName: null }],
  timestamp,
});

test("斜杠命令发送后只要出现命令块就算已落盘（Claude 把 /cost 记成 /usage）", () => {
  const sent = cmdMsg("user", "text", "/cost", "2026-10-19T07:11:00.000Z");
  const parsed = [
    cmdMsg("user", "text", "你好", "2026-10-19T07:00:00.000Z"),
    cmdMsg("user", "command", "/usage", "2026-10-19T07:11:03.000Z"),
  ];
  assert.equal(slashCommandRecorded(sent, parsed), true);
});

test("发送之前就有的命令块不算（上一次的 /usage 不能冒充这一次）", () => {
  const sent = cmdMsg("user", "text", "/cost", "2026-10-19T07:11:00.000Z");
  const parsed = [cmdMsg("user", "command", "/usage", "2026-10-19T07:05:00.000Z")];
  assert.equal(slashCommandRecorded(sent, parsed), false);
});

test("几秒时钟偏差内的命令块照认", () => {
  const sent = cmdMsg("user", "text", "/model x", "2026-10-19T07:11:00.000Z");
  const parsed = [cmdMsg("user", "command", "/model x", "2026-10-19T07:10:57.000Z")];
  assert.equal(slashCommandRecorded(sent, parsed), true);
});

test("普通提问、没有时间戳、助手的命令块都不走这条路", () => {
  const later = [cmdMsg("user", "command", "/usage", "2026-10-19T07:12:00.000Z")];
  assert.equal(slashCommandRecorded(cmdMsg("user", "text", "解释 /usage 是什么", "2026-10-19T07:11:00.000Z"), later), false);
  assert.equal(slashCommandRecorded(cmdMsg("user", "text", "/cost", null), later), false);
  assert.equal(
    slashCommandRecorded(cmdMsg("user", "text", "/cost", "2026-10-19T07:11:00.000Z"), [
      cmdMsg("assistant", "command", "/usage", "2026-10-19T07:12:00.000Z"),
    ]),
    false,
  );
  // ! 命令同样处理
  assert.equal(
    slashCommandRecorded(cmdMsg("user", "text", "!ls", "2026-10-19T07:11:00.000Z"), [
      cmdMsg("user", "command", "! ls", "2026-10-19T07:11:01.000Z"),
    ]),
    true,
  );
});
