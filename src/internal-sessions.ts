/** 设置页「Mesa 内部对话」卡片的纯逻辑（2026-10-17；后端 internal_sessions.rs）。 */

export interface InternalSessionsStats {
  total: number;
  totalBytes: number;
  oldest: string | null;
  eligible: number;
  eligibleBytes: number;
  retentionDays: number;
  autoClean: boolean;
  lastCleanAt: string | null;
}

/** 保留天数可选档（后端只收 7–365，默认 30） */
export const INTERNAL_RETENTION_CHOICES = [7, 14, 30, 90, 180] as const;

export function formatStorageBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** 立即清理的确认文案（确认框按「标题 / 空行 / 项：后果」自动排版） */
export function internalCleanupConfirmText(s: InternalSessionsStats): string {
  return [
    `清理 ${s.eligible} 条内部对话？`,
    "",
    `删除：${s.retentionDays} 天前 Mesa 后台调用留下的对话（${formatStorageBytes(s.eligibleBytes)}）`,
    "保留：你项目里的对话、你保留过的对话、用量页的花费记录",
    "",
    "注意：直接删除，不进回收站。",
  ].join("\n");
}
