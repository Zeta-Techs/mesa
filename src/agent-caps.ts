/**
 * 能力表前端消费：只读 / 无头写盘的置灰与人话。
 * 数据来自 agent_capabilities，不在前端另抄名单。
 */

export interface HeadlessWriteFlag {
  supported: boolean;
  reason?: string;
}

/** 定时任务禁选：不支持写盘（如 qwen 未验证）。 */
export function headlessWriteBlocked(
  cap: HeadlessWriteFlag | undefined,
): string | null {
  if (!cap || cap.supported) return null;
  return cap.reason?.trim() || "不能用于定时任务";
}

/** 支持但要标出来的附注（如 grok 无沙箱）。 */
export function headlessWriteNote(
  cap: HeadlessWriteFlag | undefined,
): string | null {
  if (!cap?.supported) return null;
  return cap.reason?.trim() || null;
}

/** 可选但仍须明示风险（权限未实测 / 无沙箱）。 */
export function headlessWriteCaution(
  cap: HeadlessWriteFlag | undefined,
): string | null {
  return headlessWriteNote(cap);
}

/**
 * 聊天「停止钮」按 Esc 是否安全：Grok Build 在非 prompt 态收到 ESC 会走整进程
 * 退出确认链（调研录 matrix §9），「停下这一轮、会话保留」对它不成立——
 * 停止钮对该家隐藏，要停请切终端自行确认。
 */
export const ESC_INTERRUPT_AGENTS: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "gemini",
  "qwen",
  "kimi",
  "opencode",
  "codebuddy",
  "cursor",
  "agy",
]);

export function escInterruptSafe(agentId: string | null | undefined): boolean {
  return !!agentId && ESC_INTERRUPT_AGENTS.has(agentId);
}
