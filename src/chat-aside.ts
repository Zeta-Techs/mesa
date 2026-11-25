/**
 * 聊天页「问它一句（不打断）」（Side Question）的纯逻辑（tests/chat-aside.test.ts）。
 * - 解析主输入框里直接敲的 `/btw` 或 `/btw 问题`；
 * - 判定当前对话是否已具备提问上下文，并生成尚未落盘时的兜底对话纯文本；
 * - 汇总后端返回的不同执行路径（原生分叉 / 同家副本 / 只读代答 / 纯文本记录）的中文徽标与说明；
 * - 裁剪送给后端的卡内连续追问历史。
 */
import type { ChatMessageDto } from "./types.ts";
import { userSaid } from "./chat-relay.ts";

/** 支持进程级只读无头调用的 4 家 Agent（与 src-tauri/src/ask_aside.rs NATIVE_INSPECT_AGENTS 同口径） */
export const ASIDE_NATIVE_AGENTS = ["claude-code", "codex", "kimi", "grok"] as const;

/** 浮卡内单次送给后端的最大追问轮数（与后端 HISTORY_TURNS_CAP 对齐） */
export const ASIDE_HISTORY_LIMIT = 8;

/** 会话尚未落盘时，前端从当前消息流拼兜底文本的字符上限 */
export const ASIDE_FALLBACK_CHAR_CAP = 32_000;

export type BtwParseResult =
  | { kind: "open" }
  | { kind: "ask"; question: string };

export interface AsideTurn {
  id: string;
  question: string;
  answer: string;
  how: string;
  costUsd: number | null;
  responderAgent: string | null;
  responderProfile: string | null;
}

export interface AsideTurnPayload {
  question: string;
  answer: string;
}

export interface AsideBadge {
  label: string;
  title: string;
}

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  kimi: "Kimi Code",
  grok: "Grok Build",
  gemini: "Gemini CLI",
  qwen: "Qwen Code",
  opencode: "OpenCode",
  codebuddy: "CodeBuddy Code",
  cursor: "Cursor CLI",
  agy: "Antigravity CLI",
};

function displayAgentName(agentId: string | null | undefined): string {
  if (!agentId) return "只读连接";
  return AGENT_LABELS[agentId] ?? agentId;
}

/**
 * 识别主输入框里直接发的 `/btw` 或 `/btw 问题`：
 * - 仅 `/btw`（忽略首尾空白、大小写不敏感）→ 打开侧边浮卡并聚焦；
 * - `/btw 你的问题`（支持空格或换行分隔）→ 打开浮卡并立刻发问；
 * - 像 `/btwx` 这类非命令边界，或非 `/btw` 开头 → 返回 null，照常作为主对话发送。
 */
export function parseBtwInput(raw: string): BtwParseResult | null {
  const trimmed = raw.trim();
  const m = /^\/btw(?:(?:\s+)([\s\S]*))?$/i.exec(trimmed);
  if (!m) return null;
  const question = (m[1] ?? "").trim();
  return question ? { kind: "ask", question } : { kind: "open" };
}

/** 当前对话是否已具备侧边提问上下文（空对话还没发过一句时先拦下） */
export function canAskAside(input: {
  sessionId?: string | null;
  filePath?: string | null;
  messageCount: number;
}): { ok: true } | { ok: false; reason: string } {
  const hasSession = Boolean(input.sessionId?.trim() || input.filePath?.trim());
  if (hasSession || input.messageCount > 0) return { ok: true };
  return { ok: false, reason: "先和它聊一句再侧边提问，目前还没有对话记录" };
}

/** 浮卡打开前 / 刚打开时的默认提示语：说清本对话会怎么答（原生分身 / 副本 / 只读代答） */
export function asideMethodHint(agentId: string | null | undefined): string {
  if (agentId === "claude-code") {
    return "接上这段对话的记忆另起只读分身回答，不落盘，原对话一字不动";
  }
  if (agentId && (ASIDE_NATIVE_AGENTS as readonly string[]).includes(agentId)) {
    return "把这段对话的记录副本交给同一条连接只读回答，原对话一字不动";
  }
  return "这家 CLI 暂不支持原生只读分身，会借项目助手或默认只读连接读当前对话副本代答，原对话一字不动";
}

/** 根据后端返回的执行路径给出短徽标与悬停说明 */
export function asideModeBadge(
  how: string,
  responderAgent?: string | null,
  responderProfile?: string | null,
): AsideBadge {
  const who = responderProfile?.trim() || displayAgentName(responderAgent);
  switch (how) {
    case "fork":
      return {
        label: "只读分身",
        title: "Claude Code 原生无落盘分叉：接上当前对话完整记忆只读回答，原会话一字节不动",
      };
    case "copy":
      return {
        label: "只读副本",
        title: `由当前连接（${who}）读取本对话最近记录副本只读回答，不写入原会话`,
      };
    case "delegate":
      return {
        label: `${displayAgentName(responderAgent)} 代答`,
        title: `借只读连接「${who}」读取当前对话副本并只读核对工作区后代答，原对话一字不动`,
      };
    default:
      return {
        label: "按记录答",
        title: `由「${who}」仅依据当前对话记录纯文本回答（不读写工作区文件），原对话一字不动`,
      };
  }
}

/** 裁剪送给后端的卡内追问历史，只保留最近 ASIDE_HISTORY_LIMIT 轮有效问答 */
export function toAsideHistory(turns: readonly AsideTurn[]): AsideTurnPayload[] {
  return turns
    .filter((t) => t.question.trim() !== "" && t.answer.trim() !== "")
    .slice(-ASIDE_HISTORY_LIMIT)
    .map((t) => ({ question: t.question.trim(), answer: t.answer.trim() }));
}

/**
 * 当对话刚发完第一句、CLI 会话文件尚未落盘时，把聊天页当前可见的文本消息拼成兜底记录；
 * 后端收到后仍会在 Rust 层做完整敏感信息脱敏。
 */
export function buildFallbackTranscript(messages: readonly ChatMessageDto[]): string | null {
  const parts: string[] = [];
  for (const m of messages) {
    const texts = m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => (m.role === "user" ? userSaid(b.text) : b.text).trim())
      .filter(Boolean);
    if (texts.length === 0) continue;
    const roleLabel = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role;
    parts.push(`## ${roleLabel}\n${texts.join("\n")}`);
  }
  if (parts.length === 0) return null;
  const full = parts.join("\n\n");
  if (full.length <= ASIDE_FALLBACK_CHAR_CAP) return full;
  return `…（更早的略）\n${full.slice(-ASIDE_FALLBACK_CHAR_CAP)}`;
}
