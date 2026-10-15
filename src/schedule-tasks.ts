/**
 * 定时雷达（scheduler.rs）前端纯逻辑：周期白话、按项目过滤、通知文案、简报预览。
 * 与 DOM/Tauri 解耦，供 node --test 直接测；组件 ScheduleSection 保持薄。
 */
import { samePath } from "./path-utils.ts";
import type { RunRecordDto, ScheduleDto } from "./types.ts";

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

/** 时分补零：9:5 → "09:05" */
export function hhmm(hour: number, minute: number): string {
  const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0;
  const m = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 周期白话：「每天 09:00」/「每周一 09:00」；weekday 越界回落「每周 09:00」 */
export function frequencyLabel(
  frequency: string,
  weekday: number | null,
  hour: number,
  minute: number,
): string {
  const time = hhmm(hour, minute);
  if (frequency !== "weekly") return `每天 ${time}`;
  if (weekday === null || weekday < 1 || weekday > 7) return `每周 ${time}`;
  return `每周${WEEKDAY_LABELS[weekday - 1]} ${time}`;
}

/** 取某个项目根下的定时任务（注册路径为 canonical 绝对路径）。
 *  比较必须走 path-utils 的 samePath 方言层（剥 \\?\ verbatim、Windows 折大小写，
 *  与后端 same_path 同口径）——本地 normPath 字符串全等会把 verbatim/大小写漂移的
 *  任务在前端列表里弄丢而后端照跑，叠加雷达空态门控就是整张卡无声消失。 */
export function schedulesForProject(
  schedules: ScheduleDto[],
  projectRoot: string,
  isWindows: boolean,
): ScheduleDto[] {
  return schedules.filter((s) => samePath(s.projectRoot, projectRoot, isWindows));
}

/** 运行完成通知标题：「文献雷达 · 项目名」，失败时带「失败」 */
export function runDoneNotifyTitle(
  projectName: string,
  status: string,
  scheduleName = "定时任务",
): string {
  if (status === "ok") return `${scheduleName} · ${projectName}`;
  if (status === "timeout") return `${scheduleName} · ${projectName}（超时）`;
  return `${scheduleName} · ${projectName}（失败）`;
}

/** 通知正文：summary 首行，空白折叠后截断 */
export function runDoneNotifyBody(summary: string): string {
  const first = summary.split("\n").find((l) => l.trim()) ?? "";
  return truncateText(first.trim(), 120);
}

/** 文本截断：折叠连续空白，超过 max 加省略号 */
export function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/** 历史条目简报预览：前两行折叠为一行、限长（行内展示用，全文留给 title） */
export function summaryPreview(record: RunRecordDto): string {
  return truncateText(record.summary, 120);
}

/**
 * 巡检页「运行中」集合与后端真实运行态（ScheduleDto.runningRunId）对账，挂载/刷新时调用：
 * 后端报在跑的一律并入（挂载同步真实状态）；本地有、后端上次报在跑而这次不再跑的清除
 * （scheduler-run-done 事件漏收时的兜底）；刚点「立即运行」还没登记 Run 的
 * （前后两次快照都不在跑）保留，防按钮闪烁。
 */
export function reconcileRunningSchedules(
  current: ReadonlySet<string>,
  prevBackendRunning: ReadonlySet<string>,
  nextBackendRunning: ReadonlySet<string>,
): Set<string> {
  const next = new Set(current);
  for (const id of nextBackendRunning) next.add(id);
  for (const id of next) {
    if (prevBackendRunning.has(id) && !nextBackendRunning.has(id)) next.delete(id);
  }
  return next;
}

export function scheduleStatusMark(status: string | null | undefined): {
  glyph: string;
  label: string;
  className: string;
} {
  if (status === "ok") return { glyph: "✓", label: "成功", className: "text-ok-text" };
  if (status === "cancelled") return { glyph: "■", label: "已取消", className: "text-l4" };
  if (status === "timeout") return { glyph: "⏱", label: "超时", className: "text-warn-text" };
  return { glyph: "✗", label: "失败", className: "text-err-text" };
}
