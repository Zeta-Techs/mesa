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

/** 周期下拉（与 scheduler.rs validate_fields 同一闭集） */
export const SCHEDULE_FREQUENCIES: readonly { id: string; label: string }[] = [
  { id: "daily", label: "每天" },
  { id: "weekdays", label: "工作日（周一到周五）" },
  { id: "weekly", label: "每周" },
  { id: "hourly", label: "每隔几小时" },
  { id: "manual", label: "仅手动（不定时）" },
];

/** 「每 N 小时」只收 24 的因数（scheduler.rs INTERVAL_HOURS_ALLOWED） */
export const INTERVAL_HOURS: readonly number[] = [1, 2, 3, 4, 6, 8, 12];

/** 单次上限选项（分钟；后端收 5–180） */
export const TIMEOUT_CHOICES: readonly number[] = [10, 20, 30, 45, 60, 90, 120, 180];

/** 周期白话：「每天 09:00」/「工作日 09:00」/「每周一 09:00」/「每 6 小时，在 :15」/「仅手动」；
 *  weekday 越界回落「每周 09:00」，未知周期按每天（不静默丢失） */
export function frequencyLabel(
  frequency: string,
  weekday: number | null,
  hour: number,
  minute: number,
  intervalHours?: number | null,
): string {
  const time = hhmm(hour, minute);
  if (frequency === "manual") return "仅手动";
  if (frequency === "weekdays") return `工作日 ${time}`;
  if (frequency === "hourly") {
    const n = intervalHours && INTERVAL_HOURS.includes(intervalHours) ? intervalHours : 1;
    const mm = time.slice(3);
    return n === 1 ? `每小时，在 :${mm}` : `每 ${n} 小时，在 :${mm}`;
  }
  if (frequency !== "weekly") return `每天 ${time}`;
  if (weekday === null || weekday < 1 || weekday > 7) return `每周 ${time}`;
  return `每周${WEEKDAY_LABELS[weekday - 1]} ${time}`;
}

/** 后端的本地时刻串（无时区 ISO，如 2026-10-23T09:00:00）→ Date；JS 把无时区的日期时间按本地解析 */
export function parseLocalSlot(text: string | null | undefined): Date | null {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayKey(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 应跑时刻白话：今天 / 明天 / 昨天 HH:MM，其余「10月26日 09:00」 */
export function slotLabel(text: string | null | undefined, now: Date = new Date()): string {
  const d = parseLocalSlot(text);
  if (!d) return "";
  const time = hhmm(d.getHours(), d.getMinutes());
  const diff = Math.round((dayKey(d) - dayKey(now)) / 86400000);
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  if (diff === -1) return `昨天 ${time}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

/** 列表行「下次 明天 09:00」；停用 / 仅手动 / 后端没算出来时不显示 */
export function nextRunLabel(
  s: Pick<ScheduleDto, "enabled" | "nextRunAt">,
  now: Date = new Date(),
): string | null {
  if (!s.enabled || !s.nextRunAt) return null;
  const label = slotLabel(s.nextRunAt, now);
  return label ? `下次 ${label}` : null;
}

/** 跳过原因白话（与 scheduler.rs skip_reason_text 同口径） */
export function skipReasonText(code: string | null | undefined): string {
  switch (code) {
    case "missed_closed":
      return "应用没开";
    case "missed_asleep":
      return "电脑在睡眠";
    case "unreviewed":
      return "上一轮还没评审";
    case "no_keywords":
      return "还没有关键词";
    default:
      return "没赶上";
  }
}

/** 跳过行的一句话：「已跳过 3 次：上一轮还没评审」 */
export function skipLine(record: Pick<RunRecordDto, "skipReason" | "skipCount">): string {
  const n = record.skipCount ?? 1;
  return `已跳过${n > 1 ? ` ${n} 次` : ""}：${skipReasonText(record.skipReason)}`;
}

/** 跳过行悬停说明：每种原因下一步怎么办 */
export function skipHint(code: string | null | undefined): string {
  switch (code) {
    case "unreviewed":
      return "上一轮的产物还没评审，这一轮先不跑，免得越攒越多。去评审采纳，或在历史里删掉上一轮；也可以在「编辑任务」里关掉这条规则。";
    case "no_keywords":
      return "文献雷达还没有关键词，订上关键词后下一分钟就会跑。";
    case "missed_closed":
      return "到点时 Mesa 没开。打开后只补跑最近那一次，更早的记在这里。";
    case "missed_asleep":
      return "到点时电脑在睡眠。醒来后只补跑最近那一次，更早的记在这里。";
    default:
      return "到点时没能跑上。之后只补跑最近那一次，更早的记在这里。";
  }
}

/** 运行行上的来由小标：补跑写原定时刻，手动写「手动」，准点不标 */
export function triggerTag(
  record: Pick<RunRecordDto, "trigger" | "scheduledFor">,
  now: Date = new Date(),
): string | null {
  if (record.trigger === "catchup") {
    const when = slotLabel(record.scheduledFor, now);
    return when ? `补跑 · 原定 ${when}` : "补跑";
  }
  if (record.trigger === "manual") return "手动";
  return null;
}

/** 其他项目的定时任务（项目「定时任务」页底部总览用） */
export function otherProjectSchedules(
  schedules: ScheduleDto[],
  projectRoot: string,
  isWindows: boolean,
): ScheduleDto[] {
  return schedules.filter((s) => !samePath(s.projectRoot, projectRoot, isWindows));
}

/** 「待处理」里的定时任务条目：其他巡检有新产物待评审 / 任务被自动暂停（文献雷达的新命中另走 lit:） */
export interface ScheduleInboxCandidate {
  kind: "review" | "paused";
  scheduleId: string;
  scheduleName: string;
  projectRoot: string;
  runId?: string | null;
  isolationPath?: string | null;
  reason?: string | null;
  at?: string;
}

export function scheduleInboxCandidates(
  schedules: readonly ScheduleDto[],
): ScheduleInboxCandidate[] {
  const out: ScheduleInboxCandidate[] = [];
  for (const s of schedules) {
    if (!s.enabled && s.pausedReason) {
      out.push({
        kind: "paused",
        scheduleId: s.id,
        scheduleName: s.name,
        projectRoot: s.projectRoot,
        reason: s.pausedReason,
      });
    }
    if (s.skill === "lit-watch") continue;
    const last = s.history.find((r) => r.status === "ok");
    // 只认明确算过「无新内容」的新记录（noop === false）：升级前的旧记录不翻出来
    if (
      last &&
      last.noop === false &&
      !last.adopted &&
      last.isolationPath &&
      last.runId
    ) {
      out.push({
        kind: "review",
        scheduleId: s.id,
        scheduleName: s.name,
        projectRoot: s.projectRoot,
        runId: last.runId,
        isolationPath: last.isolationPath,
        at: last.at,
      });
    }
  }
  return out;
}

/** 补跑开始的通知：标题「补跑：任务 · 项目」，正文写原定时刻与之前错过几次 */
export function catchupNotify(
  scheduleName: string,
  projectName: string,
  scheduledFor: string | null | undefined,
  missed: number,
  now: Date = new Date(),
): { title: string; body: string } {
  const when = slotLabel(scheduledFor, now);
  const parts = [when ? `原定 ${when}` : "到点时没跑上"];
  if (missed > 0) parts.push(`之前还错过 ${missed} 次`);
  return {
    title: `补跑：${scheduleName} · ${projectName}`,
    body: `${parts.join("，")}。到点时 Mesa 没开或电脑在睡眠，打开后只补跑最近这一次。`,
  };
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

/** 运行完成通知标题：「文献雷达 · 项目名」，失败时带「失败」，被自动暂停时带「已自动暂停」 */
export function runDoneNotifyTitle(
  projectName: string,
  status: string,
  scheduleName = "定时任务",
  autoPaused = false,
): string {
  if (autoPaused) return `${scheduleName} · ${projectName}（已自动暂停）`;
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

/** 历史条目简报预览：前两行折叠为一行、限长（行内展示用，全文留给 title）；跳过行写原因 */
export function summaryPreview(record: RunRecordDto): string {
  if (record.status === "skipped") return skipLine(record);
  const text = truncateText(record.summary, 120);
  return record.noop ? `无新内容 · ${text}` : text;
}

/** 跑完要不要弹通知：成功但无新内容不弹；被自动暂停一定弹 */
export function shouldNotifyRunDone(payload: {
  status: string;
  noop?: boolean;
  autoPaused?: string | null;
}): boolean {
  if (payload.autoPaused) return true;
  return !(payload.status === "ok" && payload.noop);
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
  if (status === "skipped") return { glyph: "↷", label: "已跳过", className: "text-l4" };
  if (status === "cancelled") return { glyph: "■", label: "已取消", className: "text-l4" };
  if (status === "timeout") return { glyph: "⏱", label: "超时", className: "text-warn-text" };
  return { glyph: "✗", label: "失败", className: "text-err-text" };
}

/** 任务行第二行「上次 …」的一句话（2026-10-23 使用优化：不用展开历史就能看到上次结果） */
export function lastRunBrief(
  r: RunRecordDto,
  isLit: boolean,
): { text: string; tone: "ok" | "warn" | "err" | "muted" } {
  if (r.status === "skipped") return { text: skipLine(r), tone: "muted" };
  if (r.status === "timeout") return { text: "超时", tone: "warn" };
  if (r.status === "cancelled") return { text: "已取消", tone: "muted" };
  if (r.status !== "ok") {
    const first = r.summary.split("\n").find((l) => l.trim()) ?? "";
    return { text: `失败：${truncateText(first, 40) || "没有错误信息"}`, tone: "err" };
  }
  if (r.noop) return { text: "无新内容", tone: "muted" };
  if (isLit && r.newEntries != null) {
    return { text: `${r.newEntries} 篇新命中${r.adopted ? " · 已采纳" : ""}`, tone: "ok" };
  }
  if (r.adopted) return { text: "已采纳", tone: "ok" };
  if (r.noop === false && r.isolationPath && r.runId) return { text: "有新产物待评审", tone: "ok" };
  const first = r.summary.split("\n").find((l) => l.trim()) ?? "";
  return { text: truncateText(first, 40) || "跑完了", tone: "ok" };
}

/** 「上次」那一行给哪个按钮：还没评审的去评审，否则有后台对话就看过程 */
export function lastRunAction(r: RunRecordDto): "review" | "process" | null {
  // 旧记录没算过 noop：雷达 0 条新命中也当没东西可评审
  if (r.status === "ok" && r.isolationPath && !r.adopted && !r.noop && r.newEntries !== 0) {
    return "review";
  }
  if (r.agent && r.sessionId) return "process";
  return null;
}

