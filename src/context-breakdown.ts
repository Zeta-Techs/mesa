/**
 * 上下文浮层（点聊天输入框里的上下文圆环，2026-10-20）：总量来自会话文件里上一轮的实际用量；
 * 分类来自 CLI 自己的 `/context`（后端 context_breakdown.rs，只有 Claude Code、Qwen Code 能在后台跑）。
 *
 * 配色（2026-10-20 用户看过三段灰的版本后要「每类一个颜色」，是「颜色只表达风险」的有意例外）：
 * 对话、MCP 工具、内置工具、系统提示四大类各一个颜色，其余小类（技能、记忆文件…）同一种灰，剩余是底色。
 * 颜色跟着分类走、顺序固定，不按大小排。用量快满只让标题数字变橙，不改横条颜色。
 */

export interface ContextCategory {
  key: string;
  tokens: number;
}

export interface SubagentContext {
  id: string;
  title: string;
  model?: string | null;
  used: number;
  window?: number | null;
  totalTokens: number;
  cacheHitPct?: number | null;
}

/** 后端 ContextBreakdownDto */
export interface ContextBreakdown {
  /** CLI 自己认的上下文窗口（0 表示该模型窗口未知，按已用总量拆比） */
  window: number;
  used: number;
  untilCompact: number | null;
  categories: ContextCategory[];
  compactions?: number | null;
  cacheRead?: number | null;
  freshInput?: number | null;
  subagents?: SubagentContext[];
}

export interface ContextBreakdownRequest {
  agentId: string;
  profileId: string;
  cwd: string;
  model: string | null;
  sessionId: string;
}

/** 支持后端读取分类明细的家：Claude Code / Qwen Code 走无头 `/context`，Antigravity 走纯本地只读日志与子智能体库 */
export function breakdownSupported(agentId: string | null | undefined): boolean {
  return agentId === "claude-code" || agentId === "qwen" || agentId === "agy";
}

/** 后端可纯本地秒读明细、悬停即可自动调用的家（不起子进程） */
export function localBackendBreakdown(agentId: string | null | undefined): boolean {
  return agentId === "agy";
}

/** 需在后台拉起无头 CLI 跑 `/context` 的家：仅在用户继续/运行会话后于后台静默校准一次，历史预览不拉起进程 */
export function headlessBreakdownSupported(agentId: string | null | undefined): boolean {
  return agentId === "claude-code" || agentId === "qwen";
}

/** 会话日志记录了逐轮 token 用量的 7 家：已知模型窗口时可常显 0% 上下文饼盘并逐轮更新；
 *  Grok / CodeBuddy / Cursor 会话不落逐轮 usage，不常显 0% 以免聊完几十轮仍卡在 0% */
export function contextUsageSupported(agentId: string | null | undefined): boolean {
  return (
    agentId === "agy" ||
    agentId === "claude-code" ||
    agentId === "codex" ||
    agentId === "gemini" ||
    agentId === "kimi" ||
    agentId === "qwen" ||
    agentId === "opencode"
  );
}

/** 中英文混合文本的轻量 token 估算（与 agy.rs 同口径：CJK 约 0.55 tok/字，ASCII 约 0.25 tok/字） */
function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else nonAscii++;
  }
  return Math.max(1, Math.round(ascii * 0.25 + nonAscii * 0.55));
}

export interface LocalBreakdownMessage {
  role: string;
  blocks: readonly { kind: string; text: string; toolName?: string | null }[];
  usage: { input: number; cacheRead: number; cacheWrite: number } | null;
}

/**
 * 纯前端秒算本地上下文明细（全 7 家有逐轮用量的 CLI 通用，不起子进程、零等待）：
 * - 按末次上下文骤降（≥20K 后跌破 65%）截出最近一次压缩后的可见消息段；
 * - 估算「对话 / 工具调用与输出 / 思考过程」权重并严格锚定到末轮真实 used tokens；
 * - 真实 used 超出可见消息估算的部分归入「系统提示与工具」（系统提示、技能、工具定义等）。
 */
export function estimateLocalBreakdown(
  messages: readonly LocalBreakdownMessage[],
  used: number,
  window: number | null,
): ContextBreakdown | null {
  if (used <= 0 || messages.length === 0) return null;
  let prevUsed: number | null = null;
  let compactions = 0;
  let lastCompactIdx = 0;
  let cacheRead = 0;
  let freshInput = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const u = m.usage;
    if (m.role === "user" || !u) continue;
    const fresh = u.input + u.cacheWrite;
    const cur = u.cacheRead + fresh;
    if (cur <= 0) continue;
    if (prevUsed !== null && prevUsed >= 20_000 && cur < prevUsed * 0.65) {
      compactions += 1;
      lastCompactIdx = i;
    }
    prevUsed = cur;
    cacheRead = u.cacheRead;
    freshInput = fresh;
  }

  let msgTok = 0;
  let toolTok = 0;
  let thinkingTok = 0;
  for (let i = lastCompactIdx; i < messages.length; i++) {
    for (const b of messages[i].blocks) {
      const t = estimateTextTokens(b.text);
      if (b.kind === "thinking") {
        thinkingTok += t;
      } else if (b.kind === "tool_use" || b.kind === "tool_result") {
        toolTok += t + (b.toolName ? 12 : 4);
      } else {
        msgTok += t;
      }
    }
  }

  const estSum = msgTok + toolTok + thinkingTok;
  const categories: ContextCategory[] = [];
  if (estSum <= 0) {
    categories.push({ key: "Messages", tokens: used });
  } else if (estSum <= used) {
    if (msgTok > 0) categories.push({ key: "Messages", tokens: msgTok });
    if (toolTok > 0) categories.push({ key: "Tool outputs", tokens: toolTok });
    if (thinkingTok > 0) categories.push({ key: "Thinking", tokens: thinkingTok });
    const sysTok = used - estSum;
    if (sysTok > 0) categories.push({ key: "System & tools", tokens: sysTok });
  } else {
    const scale = used / estSum;
    const buckets: { key: string; tokens: number }[] = [
      { key: "Messages", tokens: Math.round(msgTok * scale) },
      { key: "Tool outputs", tokens: Math.round(toolTok * scale) },
      { key: "Thinking", tokens: Math.round(thinkingTok * scale) },
    ].filter((b) => b.tokens > 0);
    const roundedSum = buckets.reduce((acc, b) => acc + b.tokens, 0);
    if (buckets.length === 0) {
      categories.push({ key: "Messages", tokens: used });
    } else {
      const diff = used - roundedSum;
      if (diff !== 0) {
        let maxIdx = 0;
        for (let i = 1; i < buckets.length; i++) {
          if (buckets[i].tokens > buckets[maxIdx].tokens) maxIdx = i;
        }
        buckets[maxIdx].tokens = Math.max(1, buckets[maxIdx].tokens + diff);
      }
      categories.push(...buckets);
    }
  }

  return {
    window: window && window > 0 ? window : 0,
    used,
    untilCompact: null,
    categories,
    compactions: compactions > 0 ? compactions : null,
    cacheRead: cacheRead > 0 ? cacheRead : undefined,
    freshInput: freshInput > 0 ? freshInput : undefined,
  };
}

const VARIABLE_CATEGORY_KEYS = new Set(["Messages", "Tool outputs", "Thinking", "Unattributed"]);

/**
 * 将运行中会话做过一次 `/context` 校准得到的固定开销（系统提示、内置工具、MCP 工具、技能、记忆文件与自动压缩预留）
 * 投射到当前轮的真实 `currentUsed`：后续每轮无需再次拉起无头 CLI 子进程，即可实时更新「对话」与「离自动压缩剩余」。
 */
export function projectCalibratedBreakdown(
  calibrated: ContextBreakdown,
  currentUsed: number,
  currentWindow: number | null,
  local?: ContextBreakdown | null,
): ContextBreakdown {
  const effWin = currentWindow && currentWindow > 0 ? currentWindow : calibrated.window;
  const calWin = calibrated.window > 0 ? calibrated.window : effWin;
  const reserve =
    calibrated.untilCompact !== null && calWin > 0
      ? Math.max(0, calWin - calibrated.used - calibrated.untilCompact)
      : null;

  const compactions = calibrated.compactions ?? local?.compactions ?? null;
  const cacheRead = local?.cacheRead ?? calibrated.cacheRead;
  const freshInput = local?.freshInput ?? calibrated.freshInput;

  if (currentUsed <= 0) {
    return {
      ...calibrated,
      window: effWin,
      compactions,
      cacheRead,
      freshInput,
    };
  }

  const fixed = calibrated.categories.filter(
    (c) => c.tokens > 0 && !VARIABLE_CATEGORY_KEYS.has(c.key),
  );
  const fixedSum = fixed.reduce((acc, c) => acc + c.tokens, 0);
  const categories: ContextCategory[] = [];

  if (fixed.length === 0) {
    categories.push({ key: "Messages", tokens: currentUsed });
  } else if (fixedSum <= currentUsed) {
    categories.push(...fixed);
    const msgTokens = currentUsed - fixedSum;
    if (msgTokens > 0) categories.push({ key: "Messages", tokens: msgTokens });
  } else {
    const scale = currentUsed / fixedSum;
    const scaled = fixed
      .map((c) => ({ key: c.key, tokens: Math.round(c.tokens * scale) }))
      .filter((c) => c.tokens > 0);
    if (scaled.length === 0) {
      categories.push({ key: "Messages", tokens: currentUsed });
    } else {
      const sum = scaled.reduce((acc, c) => acc + c.tokens, 0);
      const diff = currentUsed - sum;
      if (diff !== 0) {
        let maxIdx = 0;
        for (let i = 1; i < scaled.length; i++) {
          if (scaled[i].tokens > scaled[maxIdx].tokens) maxIdx = i;
        }
        scaled[maxIdx].tokens = Math.max(1, scaled[maxIdx].tokens + diff);
      }
      categories.push(...scaled);
    }
  }

  const untilCompact =
    reserve !== null && effWin > 0
      ? Math.max(0, effWin - Math.min(effWin, reserve) - currentUsed)
      : null;

  return {
    window: effWin,
    used: currentUsed,
    untilCompact,
    categories,
    compactions,
    cacheRead,
    freshInput,
    subagents: calibrated.subagents,
  };
}

/** 标签状态 → 去读分类明细要的参数；这家不支持、还没有会话就 null */
export function breakdownRequest(
  status: {
    agentId: string;
    profileId: string;
    cwd: string;
    sessionId: string | null;
    launchModel: string | null;
    model: string;
  } | null,
): ContextBreakdownRequest | null {
  if (!status || !breakdownSupported(status.agentId) || !status.sessionId || !status.profileId) return null;
  return {
    agentId: status.agentId,
    profileId: status.profileId,
    cwd: status.cwd,
    model: status.launchModel || status.model || null,
    sessionId: status.sessionId,
  };
}

const LABELS: Record<string, string> = {
  Messages: "对话",
  "Tool outputs": "工具调用与输出",
  Thinking: "思考过程",
  "System & tools": "系统提示与工具",
  "System prompt": "系统提示",
  "System tools": "内置工具",
  "Built-in tools": "内置工具",
  "MCP tools": "MCP 工具",
  "MCP server instructions": "MCP 说明",
  "Custom agents": "自定义子代理",
  "Memory files": "记忆文件",
  Skills: "技能",
  "Startup context": "启动上下文",
  Unattributed: "其他",
};

export function categoryLabel(key: string): string {
  return LABELS[key] ?? key;
}

/**
 * 四大类的颜色：dataviz 参考调色板前四槽（蓝 / 橙 / 青绿 / 琥珀），深浅主题各一套。按横条里的相邻顺序用
 * validate_palette.js 在 Mesa 浮层底色上验过（深：#262a35 等六套深色 raised；浅：#ffffff）——相邻色盲区分 ΔE ≥ 8.4、
 * 正常视觉 ≥ 19.8；几套底色上对比度不到 3:1 的，靠下面列表里的文字标签补（每类都有名字和数字）。
 * 别的颜色顺序（如第四槽换品红）在深色下与青绿相邻色盲 ΔE 只有 1.6，验不过，别随手改。
 */
const SERIES: Record<string, { dark: string; light: string }> = {
  Messages: { dark: "#3987e5", light: "#2a78d6" },
  "MCP tools": { dark: "#d95926", light: "#eb6834" },
  "Tool outputs": { dark: "#199e70", light: "#1baf7a" },
  "System tools": { dark: "#199e70", light: "#1baf7a" },
  "Built-in tools": { dark: "#199e70", light: "#1baf7a" },
  "System & tools": { dark: "#c98500", light: "#eda100" },
  "System prompt": { dark: "#c98500", light: "#eda100" },
};

/** 列表与横条里的固定顺序（Claude 客户端同序）：先四大类，再小类；没见过的分类排在最后、按 CLI 给的顺序 */
const ORDER = [
  "Messages",
  "MCP tools",
  "Tool outputs",
  "System tools",
  "Built-in tools",
  "System & tools",
  "System prompt",
  "Thinking",
  "Skills",
  "MCP server instructions",
  "Custom agents",
  "Memory files",
  "Startup context",
  "Unattributed",
];

export type ContextTone = "series" | "minor" | "used" | "reserve" | "free";

export interface ContextRow {
  label: string;
  tokens: number;
  ratio: number;
  tone: ContextTone;
  /** 四大类的颜色；其余按 tone 走主题灰 */
  color: string | null;
}

export interface ContextView {
  rows: ContextRow[];
  /** 横条：已占用的各段（固定顺序），剩余是底色；自动压缩线的位置，不知道为 null */
  bar: { segments: { ratio: number; tone: ContextTone; color: string | null }[]; compactAt: number | null };
  untilCompact: number | null;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

/**
 * 浮层的行与横条。有分类：四大类各一色、小类同灰，再是自动压缩预留与剩余（到自动压缩为止）；
 * 没有分类（这家不提供 / 还在读 / 没读到）：已用、剩余两行，横条只有一段。light = 当前是浅色主题
 */
export function contextView(
  b: ContextBreakdown | null,
  total: { used: number; window: number | null },
  light = false,
): ContextView {
  if (!b || (b.window <= 0 && b.categories.length === 0)) {
    if (!total.window || total.window <= 0) {
      return {
        rows: [{ label: "已用", tokens: total.used, ratio: 1, tone: "used", color: null }],
        bar: { segments: [{ ratio: 1, tone: "used", color: null }], compactAt: null },
        untilCompact: null,
      };
    }
    const free = Math.max(0, total.window - total.used);
    const used = clamp(total.used / total.window);
    return {
      rows: [
        { label: "已用", tokens: total.used, ratio: total.used / total.window, tone: "used", color: null },
        { label: "剩余", tokens: free, ratio: free / total.window, tone: "free", color: null },
      ],
      bar: { segments: [{ ratio: used, tone: "used", color: null }], compactAt: null },
      untilCompact: null,
    };
  }
  const hasWindow = b.window > 0;
  const denom = hasWindow ? b.window : Math.max(1, b.used);
  const rank = (key: string) => {
    const i = ORDER.indexOf(key);
    return i < 0 ? ORDER.length : i;
  };
  const cats = b.categories
    .map((c, i) => ({ ...c, i }))
    .filter((c) => c.tokens > 0 || c.key === "Messages")
    .sort((x, y) => rank(x.key) - rank(y.key) || x.i - y.i);
  const rows: ContextRow[] = cats.map((c) => {
    const series = SERIES[c.key];
    return {
      label: categoryLabel(c.key),
      tokens: c.tokens,
      ratio: c.tokens / denom,
      tone: series ? "series" : "minor",
      color: series ? (light ? series.light : series.dark) : null,
    };
  });
  // 不到 0.2% 的段画出来只剩段间缝，横条上略去（列表里照列）
  const segments = rows
    .filter((r) => r.ratio >= 0.002)
    .map((r) => ({ ratio: clamp(r.ratio), tone: r.tone, color: r.color }));
  if (hasWindow) {
    const free = b.untilCompact ?? Math.max(0, b.window - b.used);
    const reserve = b.untilCompact !== null ? Math.max(0, b.window - b.used - b.untilCompact) : 0;
    if (reserve > 0) rows.push({ label: "自动压缩预留", tokens: reserve, ratio: reserve / b.window, tone: "reserve", color: null });
    rows.push({ label: "剩余", tokens: free, ratio: free / b.window, tone: "free", color: null });
  }
  return {
    rows,
    bar: {
      segments,
      compactAt: hasWindow && b.untilCompact !== null ? clamp((b.used + b.untilCompact) / b.window) : null,
    },
    untilCompact: hasWindow ? b.untilCompact : null,
  };
}

/** 百分比一位小数（与 CLI 自己的 /context 同口径），极小值写「<0.1%」 */
export function fmtRatio(ratio: number): string {
  const p = ratio * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p.toFixed(1)}%`;
}

/** 上下文很长时回复会明显变慢：2026-11-06 实测一个对话到 54 万 token 后首字 30–176 秒，同一线路的短对话 2 秒，
 *  用户还以为是代理的问题。过 30 万给一句，让人先想到「新开对话」而不是去改网络 */
export const LONG_CONTEXT_TOKENS = 300_000;

export function longContextHint(used: number): string | null {
  return used >= LONG_CONTEXT_TOKENS ? `对话已有 ${Math.round(used / 10_000)} 万 token，回复会变慢，新开对话会快` : null;
}

/** Codex 会话里存的图（2026-11-11，借 ClawChat 实测）：每轮整个重发，8MB 起变慢、13MB 以上随时可能慢到像卡住 */
export const IMAGE_SLOW_BYTES = 8 * 1024 * 1024;
export const IMAGE_STUCK_BYTES = 13 * 1024 * 1024;

export function imageWeightNote(bytes: number | null | undefined): { level: "slow" | "stuck"; text: string } | null {
  if (!bytes || bytes < IMAGE_SLOW_BYTES) return null;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  return bytes >= IMAGE_STUCK_BYTES
    ? {
        level: "stuck",
        text: `这段会话里存了 ${mb} MB 图片，Codex 每轮都要整个重发，随时可能慢到像卡住。建议现在另开一段新对话接着做（开头说一句做到哪了），或用「换 Agent」交给别家。`,
      }
    : {
        level: "slow",
        text: `这段会话里存了 ${mb} MB 图片，Codex 每轮都要整个重发，已经开始变慢。这批图做完后另开一段新对话接着做。`,
      };
}
