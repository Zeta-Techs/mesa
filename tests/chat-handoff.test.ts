import assert from "node:assert/strict";
import test from "node:test";
import {
  HOOKS_AGENTS,
  agentHasHooks,
  approvalExtraHint,
  chatMessageKey,
  claudeModeTier,
  chatHeaderStatus,
  CHAT_NO_SESSION_TEXT,
  composerShowsInterrupt,
  confirmHandoffEvent,
  placePendingUsers,
  handoffFor,
  hasAssistantText,
  kimiModelArg,
  localCommandRecord,
  mergeLocalRecords,
  mergeConversationPages,
  slidOutOfWindow,
  modelSwitchCommand,
  pendingAfterTurn,
  slashCommandRecorded,
  slashSettledLocally,
  shouldAutoPeek,
  slashHandoff,
  userTextRecorded,
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
  assert.equal(HOOKS_AGENTS.size, 8);
  assert.equal(agentHasHooks("claude-code"), true);
  assert.equal(agentHasHooks("claude"), false, "键是 agent id");
  assert.equal(agentHasHooks("codex"), true);
  assert.equal(agentHasHooks("cursor"), false);
  assert.equal(agentHasHooks("opencode"), true);
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
  assert.equal(confirmHandoffEvent("claude-code", true), "hooks_confirm");
  assert.equal(confirmHandoffEvent("claude-code", false), "no_hooks_confirm");
  assert.equal(confirmHandoffEvent("cursor", true), "no_hooks_confirm");
});

test("审批附加说明：没有精确状态的家引导去终端", () => {
  assert.equal(approvalExtraHint("codex", true), null, "Codex 改走 app-server，不再提 /hooks");
  assert.match(approvalExtraHint("cursor", false) ?? "", /精确注意力/);
  assert.equal(approvalExtraHint("claude-code", true), null);
});

test("卡住时的一句话", () => {
  assert.match(CHAT_NO_SESSION_TEXT, /会话文件还没出现/);
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

test("最新一页往后挪时，滑出窗口的那几条并进更早的，中间不丢", () => {
  const m = (t: string) => msg("user", [{ kind: "text", text: t, toolName: null }], t);
  const prev = [m("5"), m("6"), m("7"), m("8")];
  const next = [m("7"), m("8"), m("9")];
  assert.deepEqual(slidOutOfWindow(prev, next).map((x) => x.timestamp), ["5", "6"]);
  // 没挪：什么都不并
  assert.deepEqual(slidOutOfWindow(prev, prev), []);
  // 对不上：整页算滑出
  assert.deepEqual(slidOutOfWindow(prev, [m("20")]).map((x) => x.timestamp), ["5", "6", "7", "8"]);
  assert.deepEqual(slidOutOfWindow([], next), []);
  // 并进「更早」再拼最新一页：5–9 连着
  const older = [m("1"), m("2"), m("3"), m("4")];
  const kept = mergeConversationPages(older, slidOutOfWindow(prev, next));
  assert.deepEqual(mergeConversationPages(kept, next).map((x) => x.timestamp), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
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

test("发出的话落没落盘：残留草稿包含即算；Windows 上 Codex 吞掉的 emoji 与空白不挡认", () => {
  const sent = '第一行\n  缩进的第二行\n<b>不该加粗</b> & "引号" \u{1F600}\n第四行：aaaa';
  // 2026-10-21 Codex 实录：emoji 没了、原位留个空格
  const codex = '第一行\n  缩进的第二行\n<b>不该加粗</b> & "引号" \n第四行：aaaa';
  assert.equal(userTextRecorded(sent, codex), true);
  assert.equal(userTextRecorded("你是什么模型", "yyyyyy你是什么模型"), true);
  assert.equal(userTextRecorded("👍🏻 好的\r\n收到", "好的\n收到"), true);
  // 不同的话照样不算
  assert.equal(userTextRecorded("第二问", "第一问"), false);
  // 整句只有 emoji：去完什么都不剩，只认原文
  assert.equal(userTextRecorded("\u{1F600}", "随便一句"), false);
  assert.equal(userTextRecorded("\u{1F600}", "\u{1F600}"), true);
});

test("旁路回合结束：开始前发出的话算已收下；排队的必须早于这一轮开始", () => {
  const at = (ms: number, queued = false): ChatMessageDto => ({
    role: "user",
    blocks: [{ kind: "text", text: String(ms), toolName: null }],
    timestamp: new Date(ms).toISOString(),
    usage: null,
    ...(queued ? { queued: true } : {}),
  });
  const start = Date.parse("2026-10-21T07:05:23.261Z");
  const left = pendingAfterTurn(
    [
      at(start - 500), // 普通发送，回合随后开始 → 收下
      at(start + 1500), // 发送回执晚于回合开始事件 → 收下
      at(start + 5000), // 回合开始好久之后才发 → 还在等
      at(start - 100, true), // 上一轮时排队，这一轮开始前就在 → 收下
      at(start + 500, true), // 这一轮跑着时排队 → 等下一轮
    ],
    start,
  );
  assert.deepEqual(
    left.map((m) => m.blocks[0].text),
    [String(start + 5000), String(start + 500)],
  );
  const noTime = { ...at(start), timestamp: null };
  assert.equal(pendingAfterTurn([noTime], start).length, 1);
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

test("Claude 会话里的权限模式对上聊天徽标三档；对不上的不动徽标", () => {
  assert.equal(claudeModeTier("default"), "ask");
  assert.equal(claudeModeTier("auto"), "auto");
  assert.equal(claudeModeTier("bypassPermissions"), "full");
  assert.equal(claudeModeTier("acceptEdits"), null);
  assert.equal(claudeModeTier("plan"), null);
  assert.equal(claudeModeTier(null), null);
});

test("Codex 的 /status 只画在终端里：发出 1.5 秒后终端静了 1 秒就算本机处理完；Claude 与开着面板时不算", () => {
  const sent = cmdMsg("user", "text", "/status", "2026-10-19T12:00:00.000Z");
  const at = Date.parse("2026-10-19T12:00:00.000Z");
  const base = { agentId: "codex", sent, panelOpen: false };
  assert.equal(slashSettledLocally({ ...base, now: at + 2500, lastOutputAt: at + 1200 }), true);
  assert.equal(slashSettledLocally({ ...base, now: at + 1000, lastOutputAt: at + 100 }), false, "太早");
  assert.equal(slashSettledLocally({ ...base, now: at + 2500, lastOutputAt: at + 2000 }), false, "终端还在出字");
  assert.equal(slashSettledLocally({ ...base, agentId: "claude-code", now: at + 9000, lastOutputAt: at }), false);
  assert.equal(slashSettledLocally({ ...base, panelOpen: true, now: at + 9000, lastOutputAt: at }), false);
  const plain = cmdMsg("user", "text", "你好", "2026-10-19T12:00:00.000Z");
  assert.equal(slashSettledLocally({ ...base, sent: plain, now: at + 9000, lastOutputAt: at }), false);
});

test("本机命令记录：结果取终端里命令回显之后的几行，按时间插回对话", () => {
  const sent = cmdMsg("user", "text", "/status", "2026-10-19T12:00:05.000Z");
  const rec = localCommandRecord(sent, ["ok", "", "/status", "", ">_ OpenAI Codex (v0.163.0)", "", "Model:  glm-5.3-flash", ""]);
  assert.deepEqual(
    rec.blocks.map((b) => [b.kind, b.text]),
    [["command", "/status"], ["command_output", ">_ OpenAI Codex (v0.163.0)\n\nModel:  glm-5.3-flash"]],
  );
  assert.equal(localCommandRecord(sent, null).blocks.length, 1, "读不到屏就只留命令");
  const parsed = [
    cmdMsg("user", "text", "你好", "2026-10-19T12:00:00.000Z"),
    cmdMsg("assistant", "text", "你好！", "2026-10-19T12:00:02.000Z"),
    cmdMsg("user", "text", "下一句", "2026-10-19T12:00:09.000Z"),
  ];
  const merged = mergeLocalRecords(parsed as never, [rec]);
  assert.deepEqual(merged.map((m) => m.blocks[0].text), ["你好", "你好！", "/status", "下一句"]);
});
