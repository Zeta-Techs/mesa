/**
 * 对话回放按「轮」整理：用户一句话之后，助手这一轮的过程（思考、工具调用、中途说明）收成一组，
 * 过程之后的正文是这一轮的回答，露在外面（ConversationView 画成「已工作 X 分 Y 秒」+ 一行一行的动作）。
 * 2026-10-18 用户：过程显示太粗糙（原先是「过程 · 思考与 N 次工具调用」折叠条里原样摆 JSON）。
 */
import type { BlockDto, ChatMessageDto } from "./types.ts";
import {
  kindOf,
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
  index: number;
  resultIndex: number | null;
}

export type ProcessItem =
  | { kind: "thinking"; text: string; seconds: number | null; index: number; endIndex?: number }
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

/**
 * 回放只显示完整的轮：还有更早一页没加载时，开头那段多半是被分页切断的半轮（它的提问在更早一页里），
 * 收起行「已工作 X 分 · 运行 N 条命令」会在加载更早一页后变长、变多（2026-10-21 用户截图）。
 * 返回该从哪条开始显示：第一条真正的提问；没有更早一页、找不到提问（一轮比一整页还长）、
 * 或要定位的那条（搜索命中）落在半轮里时从 0 开始，宁可显示半轮也不藏东西。
 */
export function firstCompleteTurnIndex(
  messages: readonly ChatMessageDto[],
  hasOlder: boolean,
  keepIndex: number | null = null,
): number {
  if (!hasOlder) return 0;
  const at = messages.findIndex((m) => !isTurnBody(m));
  if (at <= 0) return 0;
  if (keepIndex != null && keepIndex >= 0 && keepIndex < at) return 0;
  return at;
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
  isWindows: boolean,
): ProcessItem[] {
  const items: ProcessItem[] = [];
  // 调用与结果配对：两头都带调用 id 的按 id（并行调用的结果可能乱序回来）；没有 id 的按先后
  const open: ProcessTool[][] = [];
  const byCall = new Map<string, ProcessTool[]>();
  for (const { block, index } of entries) {
    if (block.kind === "thinking") {
      if (!block.text.trim()) continue;
      const last = items[items.length - 1];
      if (last?.kind === "thinking") {
        last.text = `${last.text}\n\n${block.text}`;
        last.endIndex = index;
        continue;
      }
      const prev = index > 0 ? messages[index - 1].timestamp : null;
      items.push({ kind: "thinking", text: block.text, seconds: secondsBetween(prev, messages[index].timestamp), index });
    } else if (block.kind === "tool_use") {
      const tools = toolActivities(block.toolName, block.text, cwd, isWindows).map(
        (activity): ProcessTool => ({ activity, result: null, status: "ok", index, resultIndex: null }),
      );
      open.push(tools);
      if (block.callId) byCall.set(block.callId, tools);
      for (const tool of tools) items.push({ kind: "tool", tool, index });
    } else if (block.kind === "tool_result") {
      const status = resultStatus(block.text, block.isError);
      const matched = block.callId ? byCall.get(block.callId) : undefined;
      // 带 id 的孤立结果不能错挂到另一个具名调用；旧格式无 id 的调用仍按顺序配对。
      const tools = matched ?? (block.callId ? open.find((group) => ![...byCall.values()].includes(group)) : open[0]);
      if (tools) {
        const at = open.indexOf(tools);
        if (at >= 0) open.splice(at, 1);
        for (const [id, group] of byCall) if (group === tools) byCall.delete(id);
        for (const t of tools) {
          t.result = block.text;
          t.status = status;
          t.resultIndex = index;
        }
      } else {
        items.push({ kind: "tool", tool: { activity: orphanResultActivity(), result: block.text, status, index, resultIndex: index }, index });
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
  // isWindows 显式传入（纯逻辑不读平台）：工具路径相对化走 Windows 方言（反斜杠、不分大小写）
  opts: { live?: boolean; cwd?: string | null; isWindows?: boolean } = {},
): ConversationSegment[] {
  const out: ConversationSegment[] = [];
  // 末尾还没被收下的话（聊天层乐观显示的排队气泡）不算这一轮结束：它上面那一轮仍在跑，照常铺开（2026-10-22：
  // 原先生成中一发话，正在跑的那一轮立刻收成「已工作」，后面的步骤也只进收起的那一行）
  let tail = messages.length - 1;
  while (tail >= 0 && messages[tail].role === "user" && messages[tail].queued) tail -= 1;
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
    const isLast = end === tail;
    // 最后一轮还有没回结果的调用 = 工具正在跑（或等批准）：也算进行中，不收起、不切回答
    const pending =
      entries.filter((e) => e.block.kind === "tool_use").length >
      entries.filter((e) => e.block.kind === "tool_result").length;
    const live = isLast && (Boolean(opts.live) || pending);
    const cut = live ? entries.length - 1 : lastProcess;
    const answerBlocks = entries.slice(cut + 1).map((e) => e.block);
    const answerCwd = answerBlocks.length ? messages[entries[entries.length - 1].index].cwd : undefined;
    const asked = start > 0 ? messages[start - 1] : null;
    out.push({
      kind: "turn",
      start,
      end,
      items: buildItems(messages, entries.slice(0, cut + 1), opts.cwd ?? null, opts.isWindows ?? false),
      answer: answerBlocks.length
        ? { role: "assistant", blocks: answerBlocks, timestamp: messages[end].timestamp, usage: null, ...(answerCwd ? { cwd: answerCwd } : {}) }
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

/** 保留过程行位置，异常入口直接展开同一份记录，不另建状态。 */
/** 定位目标是不是这一行本身或它里面的子行：行键 `…:3` 不能认 `…:31`（前缀相同但是另一行） */
export function detailTargets(target: string, rowKey: string): boolean {
  return target === rowKey || target.startsWith(`${rowKey}:`);
}

export function turnToolEntries(items: readonly ProcessItem[]) {
  return items.flatMap((item, index) =>
    item.kind === "tool"
      ? [{ tool: item.tool, row: String(index), parent: null as string | null }]
      : item.kind === "explore"
        ? item.tools.map((tool, i) => ({ tool, row: `${index}:${i}`, parent: String(index) }))
        : [],
  );
}

/**
 * 没顺利完成的几步怎么说：被你拒绝的单说「被拒绝」，不混进「没成功」——拒绝是你的决定，不是出错
 * （2026-10-19 用户实测：拒绝一条命令后收起行写「1 步没成功」）
 */
export function problemText(statuses: readonly ResultStatus[], unit = "步"): string | null {
  const denied = statuses.filter((s) => s === "denied").length;
  const failed = statuses.filter((s) => s === "failed").length;
  const interrupted = statuses.filter((s) => s === "interrupted").length;
  const parts: string[] = [];
  if (failed) parts.push(`${failed} ${unit}失败`);
  if (interrupted) parts.push(`${interrupted} ${unit}已中断`);
  if (denied) parts.push(`${denied} ${unit}被拒绝`);
  return parts.length ? parts.join(" · ") : null;
}

/** 收起时跟在「已工作」后面的一句：改了几个文件、跑了几条命令；都没有才说查阅了几次 */
export function turnSummary(items: readonly ProcessItem[]): {
  text: string;
  problems: number;
  problem: string | null;
} {
  const tools = allTools(items);
  const files = new Set(
    tools
      .filter((t) => ["edit", "write", "delete"].includes(t.activity.kind))
      .map((t) => t.activity.path ?? t.activity.target),
  );
  const runs = tools.filter((t) => t.activity.kind === "run").length;
  const parts: string[] = [];
  if (files.size) parts.push(`${files.size} 个文件操作`);
  if (runs) parts.push(`运行 ${runs} 条命令`);
  if (!parts.length) {
    const looked = tools.filter((t) => EXPLORE.has(t.activity.kind) || t.activity.kind === "web").length;
    if (looked) parts.push(`查阅 ${looked} 次`);
  }
  return {
    text: parts.join(" · "),
    problems: tools.filter((t) => t.status !== "ok").length,
    problem: problemText(tools.map((t) => t.status)),
  };
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

export interface PlanEntry {
  text: string;
  status: "pending" | "in_progress" | "completed";
  /** 这一项正在做时的说法（Claude 的 activeForm，如「正在跑测试」）；聊天层状态行用，没有就不带这个键 */
  active?: string;
}

function activeForm(v: unknown): Pick<PlanEntry, "active"> {
  return typeof v === "string" && v.trim() ? { active: v.trim() } : {};
}

function planStatus(raw: unknown): PlanEntry["status"] {
  const s = String(raw ?? "").toLowerCase().replace(/[-\s]/g, "_");
  if (["completed", "complete", "done", "finished", "success"].includes(s)) return "completed";
  if (["in_progress", "inprogress", "active", "running", "doing"].includes(s)) return "in_progress";
  return "pending";
}

/** 一次「更新待办 / 计划」调用里的清单（Claude TodoWrite、Codex update_plan、Qwen todo_write、
 *  OpenCode todowrite、Gemini write_todos、Kimi SetTodoList 的参数形状都收） */
export function planEntries(input: string): PlanEntry[] | null {
  let args: unknown;
  try {
    args = JSON.parse(input);
  } catch {
    return null;
  }
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const list = obj.todos ?? obj.plan ?? obj.items ?? obj.steps;
  if (!Array.isArray(list)) return null;
  const out: PlanEntry[] = [];
  for (const it of list) {
    if (typeof it === "string") {
      out.push({ text: it, status: "pending" });
      continue;
    }
    if (!it || typeof it !== "object") continue;
    const e = it as Record<string, unknown>;
    const text = [e.content, e.step, e.description, e.title, e.text, e.task].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    if (text) out.push({ text: text.trim(), status: planStatus(e.status ?? e.state), ...activeForm(e.activeForm) });
  }
  return out.length ? out : null;
}

/** 拼计划只用到的工具字段 */
type PlanTool = { activity: { toolName: string; input: string }; result: string | null };

function latestPlan(tools: readonly PlanTool[]): PlanEntry[] | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    const entries = planEntries(tools[i].activity.input);
    if (entries) return entries;
  }
  return taskPlan(tools);
}

/** 这一轮最后一次更新的计划（同一轮里计划整表替换，只画最新那份；ACP plan 语义） */
export function turnPlan(items: readonly ProcessItem[]): PlanEntry[] | null {
  return latestPlan(allTools(items).filter((t) => t.activity.kind === "todo"));
}

/** 整段对话的计划（不分轮）。Claude Code 的 Task 清单整个会话共用、终端转圈行一直显示进行中那一项；
 *  上一轮建、这一轮没动时按这一轮拼不出（2026-10-22 实证：发了「继续」后聊天层状态行丢了「检索候选」）。
 *  只扫待办类工具块、按 callId 配结果，不做整段分组 */
export function sessionPlan(messages: readonly ChatMessageDto[]): PlanEntry[] | null {
  const results = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.blocks) if (b.kind === "tool_result" && b.callId) results.set(b.callId, b.text);
  }
  const tools: PlanTool[] = [];
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind !== "tool_use" || !b.toolName || kindOf(b.toolName) !== "todo") continue;
      tools.push({
        activity: { toolName: b.toolName, input: b.text },
        result: b.callId ? (results.get(b.callId) ?? null) : null,
      });
    }
  }
  return tools.length ? latestPlan(tools) : null;
}

function taskArgs(input: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(input) as unknown;
    if (!v || typeof v !== "object") return null;
    const inner = (v as Record<string, unknown>).input;
    return (inner && typeof inner === "object" ? inner : v) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Claude Code 新版的任务工具不传整张清单：TaskCreate 一次建一条（编号在结果「Task #3 created successfully」里），
 *  TaskUpdate 按编号改状态 / 删除。照 Claude Code 自己的拼法把这一轮的调用拼回一张清单；
 *  上一轮建的任务这一轮只改状态时拼不出（不知道标题），不画 */
function taskPlan(tools: readonly PlanTool[]): PlanEntry[] | null {
  const tasks = new Map<string, PlanEntry>();
  tools.forEach((t, i) => {
    const name = t.activity.toolName.toLowerCase();
    const args = taskArgs(t.activity.input);
    if (!args) return;
    if (name === "taskcreate") {
      const subject = typeof args.subject === "string" ? args.subject.trim() : "";
      if (!subject) return;
      const id = t.result?.match(/Task #(\w+) created successfully/)?.[1] ?? `pending-${i}`;
      tasks.set(id, { text: subject, status: "pending", ...activeForm(args.activeForm) });
    } else if (name === "taskupdate") {
      const id = String(args.taskId ?? "");
      if (args.status === "deleted") {
        tasks.delete(id);
        return;
      }
      const prev = tasks.get(id);
      if (!prev) return;
      const subject = typeof args.subject === "string" && args.subject.trim() ? args.subject.trim() : prev.text;
      tasks.set(id, {
        ...prev,
        text: subject,
        status: args.status === undefined ? prev.status : planStatus(args.status),
        ...activeForm(args.activeForm),
      });
    }
  });
  return tasks.size ? [...tasks.values()] : null;
}
