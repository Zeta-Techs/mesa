/**
 * 聊天层「这一轮现在在做什么」（ChatSurface 底部 M▁ 那一行；纯逻辑）。
 * 2026-10-21 用户：「正在生成回复」「正在用 Bash」太机械——对照 Claude / Codex 客户端，状态说在做的事，
 * 不说程序处在哪个阶段；过程里已经有一行在动的事不在这里再说一遍（那一行自己带光带）。
 *
 * 取数先后：旁路（正在跑的工具、思考摘要，chat_channel.rs）> 会话文件（还没回结果的调用、计划里进行中的一项、
 * 刚落盘的一段思考）> CLI 自己报的一句现状（程序状态旁路，如 Grok「Connection failed | Retrying (1/15)」）> 「思考中」。
 * 旁路没接上的家只走会话文件这一档，慢几秒但说法一样。
 *
 * 2026-10-26（设计稿 docs/design-chat-status-motion-mockup.html）：「思考中」与 M▁ 同一帧出现（原先刚发出 1.5 秒只亮光标——
 * 出字时整行本来就让位给预览，早出字不会多闪一下）；真会晃眼的是状态字连跳，由 settleStatus 让每条至少停 STATUS_MIN_DWELL_MS。
 * M▁ 的光标按这一轮所处的阶段换动作（statusCaretMotion）。
 */
import type { ChatMessageDto } from "./types.ts";
import { groupConversationSegments, sessionPlan, turnPlan, type ProcessItem } from "./conversation-tools.ts";
import { toolActivities, type ActivityKind } from "./tool-activity.ts";

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
  cwd: string | null;
  /** 显式传入（纯逻辑不读平台）：工具路径相对化走 Windows 方言 */
  isWindows: boolean;
}

export type ChatStatusKind = "tool" | "plan" | "thinking" | "cli" | "waiting";

export interface ChatStatus {
  kind: ChatStatusKind;
  /** 状态行写的字；null = 只留 M▁（过程里正在跑的那一行已经在动，kind 为 tool） */
  text: string | null;
}

/** 每条状态字至少停这么久再换（一秒里连读三个文件时不让字跟着连跳；期间来的只留最新一条） */
export const STATUS_MIN_DWELL_MS = 800;

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

function lastTool(items: readonly ProcessItem[]): { result: string | null; kind: ActivityKind } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool") return { result: it.tool.result, kind: it.tool.activity.kind };
    if (it.kind === "explore") {
      const last = it.tools[it.tools.length - 1];
      return last ? { result: last.result, kind: last.activity.kind } : null;
    }
  }
  return null;
}

/** 会话文件里这一轮（最后一轮、还在进行）的样子 */
function liveTurn(
  messages: readonly ChatMessageDto[],
  cwd: string | null,
  isWindows: boolean,
): { pendingVisible: boolean; pendingKind: ActivityKind | null; planStep: string | null; lastThought: string | null } {
  const empty = { pendingVisible: false, pendingKind: null, planStep: null, lastThought: null };
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
  const pendingVisible = Boolean(tool && tool.result === null);
  return {
    pendingVisible,
    pendingKind: pendingVisible && tool ? tool.kind : null,
    planStep: doing ? clip(doing.active ?? doing.text, 72) : null,
    lastThought: last?.kind === "thinking" ? last.text : null,
  };
}

export function chatStatus(input: ChatStatusInput): ChatStatus {
  const turn = liveTurn(input.messages, input.cwd, input.isWindows);
  // 正在跑的工具：过程里已经有那一行（带光带）就不重复，状态行改说计划里在做的那一项（没有就只留光标）
  if (turn.pendingVisible) return turn.planStep ? { kind: "plan", text: turn.planStep } : { kind: "tool", text: null };
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
  return { kind: "waiting", text: "思考中" };
}

/** 屏上正显示的那条状态与它出现的时刻 */
export interface ShownStatus {
  status: ChatStatus;
  parts?: ChatStatusParts;
  at: number;
}

const sameStatus = (a: ChatStatus, b: ChatStatus) => a.kind === b.kind && a.text === b.text;

/**
 * 状态字最短停留：上一条停够 STATUS_MIN_DWELL_MS 才换成最新的；没停够时照旧显示上一条，
 * retryInMs 告诉调用方多久后再来一次（那时取的仍是那一刻最新的一条，中间的直接跳过）
 */
export function settleStatus(
  shown: ShownStatus | null,
  next: ChatStatus,
  now: number,
  nextParts?: ChatStatusParts,
): { shown: ShownStatus; retryInMs: number | null } {
  const pack = (): ShownStatus => (nextParts ? { status: next, parts: nextParts, at: now } : { status: next, at: now });
  if (!shown) return { shown: pack(), retryInMs: null };
  if (sameStatus(shown.status, next)) return { shown, retryInMs: null };
  const wait = shown.at + STATUS_MIN_DWELL_MS - now;
  if (wait <= 0) return { shown: pack(), retryInMs: null };
  return { shown, retryInMs: wait };
}

/**
 * M▁ 光标的五种物理编舞阶段（2026-11-15，设计稿 docs/design-chat-brand-status-mockup.html 方向 A）：
 * - thinking：思考中 / 推理摘要，柔光正弦深呼吸
 * - read：查阅文件 / 搜索 / 网页，微暗导轨浮现、琥珀游标左右往返扫描
 * - write：编辑 / 写入 / 删除文件，三拍打字步进推进
 * - cmd：运行终端命令 / 调子任务 / MCP，短促有力的双节拍脉冲
 * - steady：等你确认 / 提问，满格琥珀常亮锁定 + 余辉
 * 保留 breathe / stretch 别名兼容其他面板（如项目助手）
 */
export type StatusCaretMotion =
  | "thinking"
  | "read"
  | "write"
  | "cmd"
  | "steady"
  | "breathe"
  | "stretch";

/** 按工具类别映射物理光标动作（ConversationView 进行中工具行与 MesaStatusLead 共用） */
export function activityCaretMotion(kind: ActivityKind): "read" | "write" | "cmd" | "steady" {
  switch (kind) {
    case "read":
    case "search":
    case "list":
    case "web":
      return "read";
    case "edit":
    case "write":
    case "delete":
      return "write";
    case "ask":
      return "steady";
    default:
      return "cmd";
  }
}

export function statusCaretMotion(
  kind: ChatStatusKind,
  awaitingYou: boolean,
  activityKind?: ActivityKind | null,
): StatusCaretMotion {
  if (awaitingYou) return "steady";
  if (activityKind) return activityCaretMotion(activityKind);
  return kind === "tool" || kind === "plan" ? "cmd" : "thinking";
}

/** 状态行结构化语义片段：让 M▁ 后面的动词、等宽文件名虚下划线、命令胶囊、思考摘要与增删行数分层排版 */
export interface ChatStatusParts {
  motion: StatusCaretMotion;
  verb: string | null;
  awaiting?: boolean;
  target: string | null;
  targetKind: "plain" | "file" | "cmd" | "thought";
  note?: string | null;
  added?: number | null;
  removed?: number | null;
}

export function chatStatusParts(
  input: ChatStatusInput,
  status: ChatStatus = chatStatus(input),
  awaitingPromptText?: string | null,
): ChatStatusParts {
  if (awaitingPromptText) {
    const rest = awaitingPromptText.startsWith("等你确认")
      ? awaitingPromptText.slice("等你确认".length).trim()
      : awaitingPromptText;
    return {
      motion: "steady",
      verb: "等你确认",
      awaiting: true,
      target: rest || null,
      targetKind: "plain",
    };
  }
  const turn = liveTurn(input.messages, input.cwd, input.isWindows);
  if (status.text === null) {
    return {
      motion: statusCaretMotion(status.kind, false, turn.pendingKind),
      verb: null,
      target: null,
      targetKind: "plain",
    };
  }
  if (status.kind === "tool" && input.activity) {
    const acts = toolActivities(input.activity.name, input.activity.input, input.cwd, input.isWindows);
    const a = acts[0];
    if (a) {
      const motion = activityCaretMotion(a.kind);
      if (a.kind === "mcp" && a.note) {
        return {
          motion,
          verb: a.verb,
          target: clip(`${a.note} · ${a.target}`, 64),
          targetKind: "cmd",
        };
      }
      const isFile = a.kind === "edit" || a.kind === "write" || a.kind === "delete" || a.kind === "read";
      const targetKind = isFile ? "file" : a.kind === "run" ? "cmd" : "plain";
      return {
        motion,
        verb: a.verb,
        target: a.target ? clip(a.target, 64) : null,
        targetKind,
        note: acts.length > 1 ? `等 ${acts.length} 个文件` : null,
        added: a.added,
        removed: a.removed,
      };
    }
  }
  if (status.kind === "thinking") {
    return {
      motion: "thinking",
      verb: "思考中",
      target: status.text,
      targetKind: "thought",
    };
  }
  if (status.kind === "plan") {
    return {
      motion: statusCaretMotion("plan", false, turn.pendingKind),
      verb: null,
      target: status.text,
      targetKind: "plain",
    };
  }
  if (status.kind === "cli") {
    return {
      motion: "thinking",
      verb: null,
      target: status.text,
      targetKind: "plain",
    };
  }
  return {
    motion: "thinking",
    verb: status.text,
    target: null,
    targetKind: "plain",
  };
}
