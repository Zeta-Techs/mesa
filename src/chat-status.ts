/**
 * 聊天层「这一轮现在在做什么」（ChatSurface 底部 M▁ 那一行；纯逻辑）。
 * 2026-10-21 用户：「正在生成回复」「正在用 Bash」太机械——对照 Claude / Codex 客户端，状态说在做的事，
 * 不说程序处在哪个阶段；过程里已经有一行在动的事不在这里再说一遍（那一行自己带光带）。
 *
 * 取数先后：旁路（正在跑的工具、思考摘要，chat_channel.rs）> 会话文件（还没回结果的调用、计划里进行中的一项、
 * 刚落盘的一段思考）> CLI 自己报的一句现状（程序状态旁路，如 Grok「Connection failed | Retrying (1/15)」）> 「思考中」。
 * 旁路没接上的家只走会话文件这一档，慢几秒但说法一样。
 */
import type { ChatMessageDto } from "./types.ts";
import { groupConversationSegments, sessionPlan, turnPlan, type ProcessItem } from "./conversation-tools.ts";
import { toolActivities } from "./tool-activity.ts";

/** 旁路快照里正在跑的工具（ChatChannelSnapshot.activity 的子集） */
export interface StatusActivity {
  name: string;
  input: string;
}

export interface ChatStatusInput {
  messages: readonly ChatMessageDto[];
  activity: StatusActivity | null;
  /** 旁路的思考摘要（Codex 推理摘要 / Qwen、OpenCode 思考增量） */
  thinking: string | null;
  /** CLI 自己报的一句现状（程序状态旁路的 msg）；照原文显示，只在比「思考中」多说了点什么时用 */
  statusLine?: string | null;
  /** 这一轮开始了多久（毫秒） */
  sinceStartMs: number;
  cwd: string | null;
  /** 显式传入（纯逻辑不读平台）：工具路径相对化走 Windows 方言 */
  isWindows: boolean;
}

export type ChatStatusKind = "tool" | "plan" | "thinking" | "cli" | "waiting" | "none";

export interface ChatStatus {
  kind: ChatStatusKind;
  /** 状态行写的字；null = 只留 M▁（刚发出，或过程里那一行已经在动） */
  text: string | null;
}

/** 刚发出的这一会儿只亮光标，不急着写「思考中」（多数回复一两秒内就有动静） */
export const STATUS_QUIET_START_MS = 1500;

const HEADLINE_MAX = 48;

/** 只等于「在等 / 在想」的现状不比「思考中」多说什么，不换成英文原文 */
const GENERIC_STATUS_RE = /^(waiting for (the )?response|thinking|working|generating|processing)\b/i;

function clip(text: string, max = HEADLINE_MAX): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : text;
}

/**
 * 一段思考的「小标题」：Codex 推理摘要以 `**小标题**` 开头，取它；别家（或原始推理）取第一句。
 * 取不出东西返回 null
 */
export function thinkingHeadline(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  const bold = /^\*\*(.+?)\*\*/.exec(t);
  if (bold && bold[1].trim()) return clip(bold[1].trim());
  const line = (t.split("\n").find((l) => l.trim()) ?? "").replace(/^[#>*\-\s]+/, "").trim();
  if (!line) return null;
  const sentence = /^(.+?[。！？!?]|.+?\.(?=\s|$))/.exec(line);
  const head = (sentence ? sentence[1] : line).replace(/[。.]$/, "").trim();
  return head ? clip(head) : null;
}

/** 一次工具调用怎么说：「运行 npm test」「编辑 store.ts」「调用 blender · get_scene_info」；补丁改多个文件说「等 N 个文件」 */
export function describeActivity(
  activity: StatusActivity,
  cwd: string | null,
  isWindows: boolean,
): string | null {
  const acts = toolActivities(activity.name, activity.input, cwd, isWindows);
  const a = acts[0];
  if (!a) return null;
  if (a.kind === "mcp" && a.note) return `${a.verb} ${a.note} · ${a.target}`;
  let text = a.target ? `${a.verb} ${a.target}` : a.verb;
  if (acts.length > 1) text += ` 等 ${acts.length} 个文件`;
  return clip(text, 72);
}

function lastTool(items: readonly ProcessItem[]): { result: string | null } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool") return it.tool;
    if (it.kind === "explore") return it.tools[it.tools.length - 1] ?? null;
  }
  return null;
}

/** 会话文件里这一轮（最后一轮、还在进行）的样子 */
function liveTurn(
  messages: readonly ChatMessageDto[],
  cwd: string | null,
  isWindows: boolean,
): { pendingVisible: boolean; planStep: string | null; lastThought: string | null } {
  const empty = { pendingVisible: false, planStep: null, lastThought: null };
  // 只看最后一句提问之后（状态每秒重算，整段对话的差异计算不必跟着跑）
  let ask = messages.length - 1;
  while (ask >= 0 && !(messages[ask].role === "user" && messages[ask].blocks.some((b) => b.kind === "text"))) ask--;
  const segs = groupConversationSegments(messages.slice(Math.max(0, ask)), { live: true, cwd, isWindows });
  const seg = segs[segs.length - 1];
  if (!seg || seg.kind !== "turn" || !seg.live) return empty;
  const tool = lastTool(seg.items);
  // 这一轮没碰计划时用整段对话的（Claude Code 的 Task 清单跨轮共用，终端转圈行一直显示它）
  const plan = turnPlan(seg.items);
  const doing =
    plan?.find((p) => p.status === "in_progress") ??
    (plan ? null : sessionPlan(messages)?.find((p) => p.status === "in_progress")) ??
    null;
  const last = seg.items[seg.items.length - 1];
  return {
    pendingVisible: Boolean(tool && tool.result === null),
    planStep: doing ? clip(doing.active ?? doing.text, 72) : null,
    lastThought: last?.kind === "thinking" ? last.text : null,
  };
}

export function chatStatus(input: ChatStatusInput): ChatStatus {
  const turn = liveTurn(input.messages, input.cwd, input.isWindows);
  // 正在跑的工具：过程里已经有那一行（带光带）就不重复，状态行改说计划里在做的那一项（没有就只留光标）
  if (turn.pendingVisible) return turn.planStep ? { kind: "plan", text: turn.planStep } : { kind: "none", text: null };
  if (input.activity) {
    const text = describeActivity(input.activity, input.cwd, input.isWindows);
    if (text) return { kind: "tool", text };
  }
  const thought = thinkingHeadline(input.thinking);
  if (thought) return { kind: "thinking", text: thought };
  if (turn.planStep) return { kind: "plan", text: turn.planStep };
  const settled = thinkingHeadline(turn.lastThought);
  if (settled) return { kind: "thinking", text: settled };
  const line = input.statusLine?.trim();
  if (line && !GENERIC_STATUS_RE.test(line)) return { kind: "cli", text: clip(line, 72) };
  if (input.sinceStartMs < STATUS_QUIET_START_MS) return { kind: "none", text: null };
  return { kind: "waiting", text: "思考中" };
}
