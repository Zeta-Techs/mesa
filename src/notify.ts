/**
 * 长任务 OS 通知的判定纯函数（P3）：与 DOM/Tauri 解耦，供 node --test 直接测。
 * 触发链路在 TerminalPage：watch 各标签 attention 跃迁 → 窗口未聚焦 → 去抖 → 发系统通知。
 * 只对「待确认」发通知——「已回复」（回合结束）每回合都发生，不阻塞任何决策，通知它是噪音。
 */

/** 会话尾部注意力状态（与 TabStatus.attention 同型） */
export type AttentionState = "done" | "working" | "confirm" | null;

/** 同一标签两次通知的最小间隔 */
export const NOTIFY_DEBOUNCE_MS = 30_000;

/**
 * 注意力跃迁判定：非待确认 → 待确认时返回 true。
 * prev 为 undefined 表示标签首次出现（基线），一律不通知，防标签创建误报。
 */
export function attentionTransition(
  prev: AttentionState | undefined,
  next: AttentionState,
): boolean {
  if (prev === undefined) return false;
  return next === "confirm" && prev !== "confirm";
}

/**
 * 按标签去抖：lastAt 为上次发送时间（undefined = 从未发过）。
 * 距上次不足 windowMs 则抑制；恰好满 windowMs 放行。
 */
export function debounceAllows(
  lastAt: number | undefined,
  now: number,
  windowMs: number = NOTIFY_DEBOUNCE_MS,
): boolean {
  return lastAt === undefined || now - lastAt >= windowMs;
}

/** 通知标题：标签名优先，缺省回落 Agent 名 */
export function notifyTitle(tabTitle: string, agentLabel: string): string {
  return tabTitle ? `${agentLabel} · ${tabTitle}` : agentLabel;
}

/** 通知正文（只有待确认一种） */
export const NOTIFY_BODY = "等待你的确认";
