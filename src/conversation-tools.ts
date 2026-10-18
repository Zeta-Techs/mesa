/**
 * 对话回放按「轮」整理：用户一句话之后，助手这一轮的过程（思考、工具调用、中途说明）收成一组，
 * 过程之后的正文是这一轮的回答，露在外面（ConversationView 画成「已工作 X 分 Y 秒」+ 一行一行的动作）。
 * 2026-10-18 用户：过程显示太粗糙（原先是「过程 · 思考与 N 次工具调用」折叠条里原样摆 JSON）。
 */
import type { BlockDto, ChatMessageDto } from "./types.ts";
import {
  orphanResultActivity,
  resultStatus,
  toolActivities,
  type ResultStatus,
  type ToolActivity,
} from "./tool-activity.ts";

export function isToolBlock(block: BlockDto): boolean {
  return block.kind === "tool_use" || block.kind === "tool_result";
}

export function isProcessBlock(block: BlockDto): boolean {
  return block.kind === "thinking" || isToolBlock(block);
}

export interface ProcessTool {
  activity: ToolActivity;
  result: string | null;
  status: ResultStatus;
}

export type ProcessItem =
  | { kind: "thinking"; text: string; seconds: number | null; index: number }
  | { kind: "text"; text: string; index: number }
  | { kind: "tool"; tool: ProcessTool; index: number }
  /** 连着的读文件 / 搜索 / 看目录并成一行「查阅」 */
  | { kind: "explore"; tools: ProcessTool[]; index: number };

export type ConversationSegment =
  | { kind: "message"; message: ChatMessageDto; index: number }
  | {
      kind: "turn";
      /** 这一轮助手侧第一条 / 最后一条消息的下标 */
      start: number;
      end: number;
      items: ProcessItem[];
      /** 过程之后的回答；还在生成的那一轮为 null（正文都算过程，免得说到一半被当成回答） */
      answer: ChatMessageDto | null;
      /** 这一轮从用户发问到最后一条消息用了多久；时间戳不全为 null */
      seconds: number | null;
      live: boolean;
    };

/** 助手这一轮的消息：非用户消息，或只装着工具结果的「用户」消息（结果没处挂时后端照原样给 user） */
function isTurnBody(m: ChatMessageDto): boolean {
  if (m.role !== "user") return true;
  return m.blocks.length > 0 && m.blocks.every((b) => b.kind === "tool_result");
}

export function parseTimestamp(ts: string | null): number | null {
  if (!ts) return null;
  if (/^\d{10}$/.test(ts)) return Number(ts) * 1000;
  if (/^\d{13}$/.test(ts)) return Number(ts);
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function secondsBetween(from: string | null, to: string | null): number | null {
  const a = parseTimestamp(from);
  const b = parseTimestamp(to);
  if (a === null || b === null) return null;
  const s = Math.round((b - a) / 1000);
  return s >= 0 && s < 86_400 ? s : null;
}

const EXPLORE = new Set(["read", "search", "list"]);

function buildItems(
  messages: readonly ChatMessageDto[],
  entries: Array<{ block: BlockDto; index: number }>,
  cwd: string | null,
): ProcessItem[] {
  const items: ProcessItem[] = [];
  // 调用与结果按先后配对：并行调用的结果也按调用顺序回来
  const open: ProcessTool[][] = [];
  for (const { block, index } of entries) {
    if (block.kind === "thinking") {
      if (!block.text.trim()) continue;
      const last = items[items.length - 1];
      if (last?.kind === "thinking") {
        last.text = `${last.text}\n\n${block.text}`;
        continue;
      }
      const prev = index > 0 ? messages[index - 1].timestamp : null;
      items.push({ kind: "thinking", text: block.text, seconds: secondsBetween(prev, messages[index].timestamp), index });
    } else if (block.kind === "tool_use") {
      const tools = toolActivities(block.toolName, block.text, cwd).map(
        (activity): ProcessTool => ({ activity, result: null, status: "ok" }),
      );
      open.push(tools);
      for (const tool of tools) items.push({ kind: "tool", tool, index });
    } else if (block.kind === "tool_result") {
      const status = resultStatus(block.text);
      const tools = open.shift();
      if (tools) {
        for (const t of tools) {
          t.result = block.text;
          t.status = status;
        }
      } else {
        items.push({ kind: "tool", tool: { activity: orphanResultActivity(), result: block.text, status }, index });
      }
    } else if (block.kind === "text") {
      if (block.text.trim()) items.push({ kind: "text", text: block.text, index });
    }
  }
  const out: ProcessItem[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (item.kind === "tool" && EXPLORE.has(item.tool.activity.kind)) {
      if (prev?.kind === "explore") {
        prev.tools.push(item.tool);
        continue;
      }
      if (prev?.kind === "tool" && EXPLORE.has(prev.tool.activity.kind)) {
        out[out.length - 1] = { kind: "explore", tools: [prev.tool, item.tool], index: prev.index };
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * 整理成「消息 / 轮」两种段。没有任何过程的回答照原样一条一条（不加「已工作」那一行）。
 * live = 最后一轮还在生成：它的正文全算过程、不收起。
 */
export function groupConversationSegments(
  messages: readonly ChatMessageDto[],
  opts: { live?: boolean; cwd?: string | null } = {},
): ConversationSegment[] {
  const out: ConversationSegment[] = [];
  let i = 0;
  while (i < messages.length) {
    if (!isTurnBody(messages[i])) {
      out.push({ kind: "message", message: messages[i], index: i });
      i += 1;
      continue;
    }
    const start = i;
    while (i < messages.length && isTurnBody(messages[i])) i += 1;
    const end = i - 1;
    const entries: Array<{ block: BlockDto; index: number }> = [];
    for (let k = start; k <= end; k++) for (const block of messages[k].blocks) entries.push({ block, index: k });
    let lastProcess = -1;
    entries.forEach((e, k) => {
      if (isProcessBlock(e.block)) lastProcess = k;
    });
    if (lastProcess < 0) {
      for (let k = start; k <= end; k++) out.push({ kind: "message", message: messages[k], index: k });
      continue;
    }
    const isLast = end === messages.length - 1;
    // 最后一轮还有没回结果的调用 = 工具正在跑（或等批准）：也算进行中，不收起、不切回答
    const pending =
      entries.filter((e) => e.block.kind === "tool_use").length >
      entries.filter((e) => e.block.kind === "tool_result").length;
    const live = isLast && (Boolean(opts.live) || pending);
    const cut = live ? entries.length - 1 : lastProcess;
    const answerBlocks = entries.slice(cut + 1).map((e) => e.block);
    const asked = start > 0 ? messages[start - 1] : null;
    out.push({
      kind: "turn",
      start,
      end,
      items: buildItems(messages, entries.slice(0, cut + 1), opts.cwd ?? null),
      answer: answerBlocks.length
        ? { role: "assistant", blocks: answerBlocks, timestamp: messages[end].timestamp, usage: null }
        : null,
      seconds: secondsBetween(asked?.timestamp ?? messages[start].timestamp, messages[end].timestamp),
      live,
    });
  }
  return out;
}

export function segmentContainsIndex(segment: ConversationSegment, index: number): boolean {
  if (segment.kind === "message") return segment.index === index;
  return index >= segment.start && index <= segment.end;
}

/** 「12 秒」「4 分 13 秒」「1 小时 5 分」 */
export function formatSeconds(s: number): string {
  if (s < 1) return "不到 1 秒";
  if (s < 60) return `${s} 秒`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function allTools(items: readonly ProcessItem[]): ProcessTool[] {
  return items.flatMap((it) => (it.kind === "tool" ? [it.tool] : it.kind === "explore" ? it.tools : []));
}

/** 收起时跟在「已工作」后面的一句：改了几个文件、跑了几条命令；都没有才说查阅了几次 */
export function turnSummary(items: readonly ProcessItem[]): { text: string; problems: number } {
  const tools = allTools(items);
  const files = new Set(
    tools
      .filter((t) => ["edit", "write", "delete"].includes(t.activity.kind))
      .map((t) => t.activity.path ?? t.activity.target),
  );
  const runs = tools.filter((t) => t.activity.kind === "run").length;
  const parts: string[] = [];
  if (files.size) parts.push(`改了 ${files.size} 个文件`);
  if (runs) parts.push(`运行 ${runs} 条命令`);
  if (!parts.length) {
    const looked = tools.filter((t) => EXPLORE.has(t.activity.kind) || t.activity.kind === "web").length;
    if (looked) parts.push(`查阅 ${looked} 次`);
  }
  return { text: parts.join(" · "), problems: tools.filter((t) => t.status !== "ok").length };
}

/** 一组「查阅」的说明：「读了 3 个文件，搜索 2 次」 */
export function exploreLabel(tools: readonly ProcessTool[]): string {
  const reads = new Set(tools.filter((t) => t.activity.kind === "read").map((t) => t.activity.path ?? t.activity.target)).size;
  const searches = tools.filter((t) => t.activity.kind === "search").length;
  const lists = tools.filter((t) => t.activity.kind === "list").length;
  const parts: string[] = [];
  if (reads) parts.push(`读了 ${reads} 个文件`);
  if (searches) parts.push(`搜索 ${searches} 次`);
  if (lists) parts.push(`看了 ${lists} 个目录`);
  return parts.join("，");
}
