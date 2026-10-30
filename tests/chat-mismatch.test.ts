import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MISMATCH_TEMPLATE,
  chatSideText,
  mismatchSnapshot,
  mismatchTitle,
  terminalSideText,
} from "../src/chat-mismatch.ts";
import { feedbackBody, stripUnfilledTemplate } from "../src/feedback.ts";
import type { ChatMessageDto } from "../src/types.ts";

const msg = (role: string, blocks: ChatMessageDto["blocks"], queued = false): ChatMessageDto => ({
  role,
  blocks,
  timestamp: null,
  usage: null,
  ...(queued ? { queued } : {}),
});
const text = (t: string) => ({ kind: "text" as const, text: t, toolName: null });

test("聊天侧：最近几条按角色写，工具只写名字和首行，正在写的另起一条", () => {
  const out = chatSideText(
    [
      msg("user", [text("跑一下测试")]),
      msg("assistant", [
        { kind: "tool_use", text: "npm test\n--watch", toolName: "Bash" },
        { kind: "tool_result", text: "很长的输出", toolName: null },
        text("测试全过了"),
      ]),
      msg("user", [text("再提交")], true),
    ],
    ["正在提", "交…"],
  );
  assert.equal(
    out,
    "[你] 跑一下测试\n\n[AI] （工具 Bash）npm test\n测试全过了\n\n[你·排队] 再提交\n\n[AI·正在写] 正在提\n交…",
  );
  assert.ok(!out.includes("很长的输出"));
});

test("聊天侧：只取最后几条、单块过长截断、空时写明", () => {
  const many = Array.from({ length: 10 }, (_, i) => msg("user", [text(`第${i}句`)]));
  const out = chatSideText(many, null, 3);
  assert.ok(!out.includes("第6句"));
  assert.ok(out.includes("第7句") && out.includes("第9句"));
  assert.ok(chatSideText([msg("assistant", [text("长".repeat(50))])], null, 6, 10).endsWith("…（截断）"));
  assert.equal(chatSideText([], null), "（聊天里还没有内容）");
});

test("终端侧：去尾部空行、只留最后几行", () => {
  assert.equal(terminalSideText("a\nb\nc\n\n  \n", 2), "b\nc");
  assert.equal(terminalSideText("\n\n"), "（终端画面是空的）");
});

test("对照全文：版本、分档、取数来源、确认卡都在，两边各一段", () => {
  const out = mismatchSnapshot({
    from: "decision",
    agentLabel: "Claude Code",
    installed: "2.1.310",
    verified: "2.1.300",
    newer: true,
    platform: "macOS",
    capability: "常用的事都能做（测试版）",
    sourceNote: "本次未接入实时通道，当前按会话文件和终端画面更新。",
    channel: null,
    messages: [msg("assistant", [text("要运行 rm 吗")])],
    liveReply: null,
    card: { title: "要运行这条命令吗", options: ["Yes", "No"] },
    terminal: "Do you want to proceed?\n❯ 1. Yes\n  2. No",
  });
  assert.ok(out.startsWith("【聊天与终端对照】\n入口：确认卡\nAgent：Claude Code 2.1.310（Mesa 核对过 2.1.300，装的更新）"));
  assert.ok(out.includes("聊天能力：常用的事都能做"));
  assert.ok(out.includes("确认卡：要运行这条命令吗 ｜ 按钮：Yes / No"));
  assert.ok(out.includes("—— 聊天里显示的（最近几条）——\n[AI] 要运行 rm 吗"));
  assert.ok(out.endsWith("—— 终端里的（最后一屏）——\nDo you want to proceed?\n❯ 1. Yes\n  2. No"));
});

test("标题按入口写；脚手架没填的两行发送时剔除；对照进正文自动附带段", () => {
  assert.equal(mismatchTitle("Codex", "decision"), "Codex：确认卡和终端里的菜单对不上");
  assert.equal(mismatchTitle("Codex", "turn"), "Codex：聊天里显示的和终端对不上");
  assert.equal(stripUnfilledTemplate(MISMATCH_TEMPLATE), "");
  const body = feedbackBody({
    kind: "bug",
    title: "t",
    detail: "哪里对不上：按钮少了一个\n你当时在做什么：",
    chatSnapshot: "【聊天与终端对照】",
  });
  assert.equal(body, "哪里对不上：按钮少了一个\n\n——以下由 Mesa 自动附带——\n【聊天与终端对照】");
});
