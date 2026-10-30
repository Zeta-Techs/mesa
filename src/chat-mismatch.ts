/**
 * 「聊天和终端对不上」一键对照反馈的纯逻辑（2026-10-30 用户：聊天层是读终端拼出来的、不是 CLI 原生数据，
 * 要向用户说明，并请用户出问题时对照着反馈）。入口三处：模型菜单底部的聊天层说明、确认卡右上角、最新一条回答下面；
 * 点了由 TerminalPage 收齐两边当时的内容，后端 feedback_chat_snapshot 脱敏截断，再打开反馈表单（App 听
 * MISMATCH_EVENT）。表单里有单独的勾选和预览，用户看到的就是发出去的。tests/chat-mismatch.test.ts
 */
import type { ChatMessageDto } from "./types";

export type MismatchFrom = "notes" | "decision" | "turn";

const FROM_LABEL: Record<MismatchFrom, string> = {
  notes: "聊天层说明",
  decision: "确认卡",
  turn: "回答下面",
};

/** App 收这个事件打开反馈表单（detail = MismatchReport） */
export const MISMATCH_EVENT = "mesa:report-chat-mismatch";

export interface MismatchReport {
  title: string;
  detail: string;
  /** 已脱敏的对照材料；整理失败时为 null（表单照开，只是不附） */
  snapshot: string | null;
}

/** 详情脚手架：两行没填的发送时剔除（feedback.ts stripUnfilledTemplate） */
export const MISMATCH_TEMPLATE = "哪里对不上：\n你当时在做什么：";

export function mismatchTitle(agentLabel: string, from: MismatchFrom): string {
  return from === "decision"
    ? `${agentLabel}：确认卡和终端里的菜单对不上`
    : `${agentLabel}：聊天里显示的和终端对不上`;
}

/** 聊天这一侧：最近几条消息按聊天里显示的顺序写成纯文本（工具调用只写一行名字，结果不抄，免得把终端输出抄两遍） */
export function chatSideText(
  messages: ChatMessageDto[],
  liveReply: string[] | null,
  maxMessages = 6,
  maxBlockChars = 1200,
): string {
  const cap = (t: string) => (t.length > maxBlockChars ? `${t.slice(0, maxBlockChars)}…（截断）` : t);
  const lines: string[] = [];
  for (const m of messages.slice(-maxMessages)) {
    const who = m.role === "user" ? "你" : m.role === "assistant" ? "AI" : m.role;
    const parts: string[] = [];
    for (const b of m.blocks) {
      if (b.kind === "text" && b.text.trim()) parts.push(cap(b.text.trim()));
      else if (b.kind === "thinking" && b.text.trim()) parts.push(`（思考）${cap(b.text.trim())}`);
      else if (b.kind === "tool_use") parts.push(`（工具 ${b.toolName ?? "?"}）${cap(b.text.trim().split("\n")[0] ?? "")}`);
      else if (b.kind === "command") parts.push(`（命令）${cap(b.text.trim())}`);
    }
    if (!parts.length) continue;
    lines.push(`[${who}${m.queued ? "·排队" : ""}] ${parts.join("\n")}`);
  }
  const live = (liveReply ?? []).join("\n").trim();
  if (live) lines.push(`[AI·正在写] ${cap(live)}`);
  return lines.join("\n\n") || "（聊天里还没有内容）";
}

/** 终端这一侧：去掉尾部空行，最多留最后 maxLines 行 */
export function terminalSideText(text: string, maxLines = 120): string {
  const lines = text.split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const kept = lines.slice(-maxLines);
  return kept.join("\n") || "（终端画面是空的）";
}

export interface MismatchInput {
  from: MismatchFrom;
  agentLabel: string;
  installed: string | null;
  verified: string | null;
  newer: boolean;
  platform: string;
  /** 这家聊天能力分档的说法（chat-fidelity.ts tierLabel，测试版另注）；没有分档记录为 null */
  capability: string | null;
  /** chat-channel.ts channelSourceNote：这次实际从哪取数 */
  sourceNote: string;
  /** 结构化旁路的种类与连接状态；没有旁路为 null */
  channel: { kind: string; connection: string | null } | null;
  messages: ChatMessageDto[];
  liveReply: string[] | null;
  /** 正在显示的确认卡：标题 + 按钮原文；没有为 null */
  card: { title: string; options: string[] } | null;
  terminal: string;
}

/** 对照材料全文（未脱敏；出站前经后端 feedback_chat_snapshot） */
export function mismatchSnapshot(input: MismatchInput): string {
  const version = input.installed
    ? `${input.installed}${input.verified ? `（Mesa 核对过 ${input.verified}${input.newer ? "，装的更新" : ""}）` : "（Mesa 没有核对记录）"}`
    : "读不到版本";
  const head = [
    "【聊天与终端对照】",
    `入口：${FROM_LABEL[input.from]}`,
    `Agent：${input.agentLabel} ${version}`,
    `平台：${input.platform}`,
    `聊天能力：${input.capability ?? "没有分档记录"}`,
    `取数来源：${input.sourceNote}${input.channel ? `（旁路 ${input.channel.kind}，${input.channel.connection ?? "状态未知"}）` : ""}`,
  ];
  if (input.card) {
    head.push(`确认卡：${input.card.title}${input.card.options.length ? ` ｜ 按钮：${input.card.options.join(" / ")}` : ""}`);
  }
  return [
    ...head,
    "",
    "—— 聊天里显示的（最近几条）——",
    chatSideText(input.messages, input.liveReply),
    "",
    "—— 终端里的（最后一屏）——",
    terminalSideText(input.terminal),
  ].join("\n");
}
