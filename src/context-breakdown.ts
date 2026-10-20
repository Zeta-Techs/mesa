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

/**
 * 四大类的颜色：dataviz 参考调色板前四槽（蓝 / 橙 / 青绿 / 琥珀），深浅主题各一套。按横条里的相邻顺序用
 * validate_palette.js 在 Mesa 浮层底色上验过（深：#262a35 等六套深色 raised；浅：#ffffff）——相邻色盲区分 ΔE ≥ 8.4、
 * 正常视觉 ≥ 19.8；几套底色上对比度不到 3:1 的，靠下面列表里的文字标签补（每类都有名字和数字）。
 * 别的颜色顺序（如第四槽换品红）在深色下与青绿相邻色盲 ΔE 只有 1.6，验不过，别随手改。
 */
const SERIES: Record<string, { dark: string; light: string }> = {
  Messages: { dark: "#3987e5", light: "#2a78d6" },
  "MCP tools": { dark: "#d95926", light: "#eb6834" },
  "System tools": { dark: "#199e70", light: "#1baf7a" },
  "Built-in tools": { dark: "#199e70", light: "#1baf7a" },
  "System prompt": { dark: "#c98500", light: "#eda100" },
};

/** 列表与横条里的固定顺序（Claude 客户端同序）：先四大类，再小类；没见过的分类排在最后、按 CLI 给的顺序 */
const ORDER = [
  "Messages",
  "MCP tools",
  "System tools",
  "Built-in tools",
  "System prompt",
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
  total: { used: number; window: number },
  light = false,
): ContextView {
  if (!b || b.window <= 0) {
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
  const w = b.window;
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
      ratio: c.tokens / w,
      tone: series ? "series" : "minor",
      color: series ? (light ? series.light : series.dark) : null,
    };
  });
  // 不到 0.2% 的段画出来只剩段间缝，横条上略去（列表里照列）
  const segments = rows
    .filter((r) => r.ratio >= 0.002)
    .map((r) => ({ ratio: clamp(r.ratio), tone: r.tone, color: r.color }));
  const free = b.untilCompact ?? Math.max(0, w - b.used);
  const reserve = b.untilCompact !== null ? Math.max(0, w - b.used - b.untilCompact) : 0;
  if (reserve > 0) rows.push({ label: "自动压缩预留", tokens: reserve, ratio: reserve / w, tone: "reserve", color: null });
  rows.push({ label: "剩余", tokens: free, ratio: free / w, tone: "free", color: null });
  return {
    rows,
    bar: {
      segments,
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
