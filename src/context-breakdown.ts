/**
 * 上下文浮层（点聊天输入框里的上下文圆环，2026-10-20）：总量来自会话文件里上一轮的实际用量；
 * 分类来自 CLI 自己的 `/context`（后端 context_breakdown.rs，只有 Claude Code、Qwen Code 能在后台跑）。
 *
 * 设计规范「颜色只表达风险」：横条只分三段——对话、固定开销（系统提示 / 工具 / 技能 / 记忆…）、剩余，
 * 用深浅不同的灰，快满时变橙；细分只在下面的列表里看（六种灰在横条上分不清）。
 */

export interface ContextCategory {
  key: string;
  tokens: number;
}

/** 后端 ContextBreakdownDto */
export interface ContextBreakdown {
  window: number;
  used: number;
  untilCompact: number | null;
  categories: ContextCategory[];
}

export interface ContextBreakdownRequest {
  agentId: string;
  profileId: string;
  cwd: string;
  model: string | null;
  sessionId: string;
}

/** 能在后台跑 `/context` 的家（2026-10-20 实测；CodeBuddy 无头模式把它当普通提问发给模型） */
export function breakdownSupported(agentId: string | null | undefined): boolean {
  return agentId === "claude-code" || agentId === "qwen";
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

export type ContextTone = "conversation" | "overhead" | "used" | "reserve" | "free";

export interface ContextView {
  rows: { label: string; tokens: number; ratio: number; tone: ContextTone }[];
  /** 横条三段（占窗口的比例）与自动压缩线的位置；不知道压缩点为 null */
  bar: { conversation: number; overhead: number; compactAt: number | null };
  untilCompact: number | null;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

/**
 * 浮层的行与横条。有分类：对话一行、固定开销各类按大小排、自动压缩预留、剩余（到自动压缩为止）；
 * 没有分类（这家不提供 / 还在读 / 没读到）：已用、剩余两行，横条只有一段
 */
export function contextView(b: ContextBreakdown | null, total: { used: number; window: number }): ContextView {
  if (!b || b.window <= 0) {
    const free = Math.max(0, total.window - total.used);
    return {
      rows: [
        { label: "已用", tokens: total.used, ratio: total.used / total.window, tone: "used" },
        { label: "剩余", tokens: free, ratio: free / total.window, tone: "free" },
      ],
      bar: { conversation: clamp(total.used / total.window), overhead: 0, compactAt: null },
      untilCompact: null,
    };
  }
  const w = b.window;
  const conversation = b.categories.filter((c) => c.key === "Messages").reduce((s, c) => s + c.tokens, 0);
  const overhead = Math.max(0, b.used - conversation);
  const fixed = b.categories
    .filter((c) => c.key !== "Messages" && c.tokens > 0)
    .sort((x, y) => y.tokens - x.tokens);
  const rows: ContextView["rows"] = [
    { label: categoryLabel("Messages"), tokens: conversation, ratio: conversation / w, tone: "conversation" },
    ...fixed.map((c) => ({ label: categoryLabel(c.key), tokens: c.tokens, ratio: c.tokens / w, tone: "overhead" as const })),
  ];
  const free = b.untilCompact ?? Math.max(0, w - b.used);
  const reserve = b.untilCompact !== null ? Math.max(0, w - b.used - b.untilCompact) : 0;
  if (reserve > 0) rows.push({ label: "自动压缩预留", tokens: reserve, ratio: reserve / w, tone: "reserve" });
  rows.push({ label: "剩余", tokens: free, ratio: free / w, tone: "free" });
  return {
    rows,
    bar: {
      conversation: clamp(conversation / w),
      overhead: clamp(overhead / w),
      compactAt: b.untilCompact !== null ? clamp((b.used + b.untilCompact) / w) : null,
    },
    untilCompact: b.untilCompact,
  };
}

/** 百分比一位小数（与 CLI 自己的 /context 同口径），极小值写「<0.1%」 */
export function fmtRatio(ratio: number): string {
  const p = ratio * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p.toFixed(1)}%`;
}
