import { AlarmClock } from "lucide-react";
import { rowActionClass } from "./PageFrame";
import { absTime } from "../rel-time";
import { hhmm } from "../schedule-tasks";
import {
  scheduleTimeline,
  type CardTone,
  type ScheduleAction,
  type ScheduleOverviewRow,
} from "../workbench-cards";

const TONE_DOT: Record<CardTone, string> = {
  live: "bg-ok-text",
  wait: "bg-warn-text",
  fail: "bg-err-text",
  done: "bg-ok-text/50",
  idle: "bg-l4/60",
};

const ACTION_LABEL: Record<ScheduleAction, string> = {
  cancel: "停止",
  rerun: "重跑",
  reopen: "重新打开",
  run: "现在跑",
};

const ACTION_TIP: Record<ScheduleAction, string> = {
  cancel: "停下这一轮（跑到一半的产物留在隔离目录，不进项目）",
  rerun: "上次没跑成，现在再跑一次",
  reopen: "它被自动暂停了；重新打开后按原来的时间继续跑",
  run: "不等到点，现在跑一次",
};

const ROW_GRID =
  "grid grid-cols-[6px_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1.4fr)_5.5rem] items-center gap-x-3";

/**
 * 工作台「定时任务」总览（2026-10-27）：跨项目一块看完，顶上一条今后 24 小时的时间轴，行内停止 / 重跑 / 重新打开 / 现在跑。
 * 项目分组里不再列定时任务（同一件事只说一次）；被自动暂停、有产物待评审的在「等你拍板」里，这里只写状态不给按钮
 */
export default function WorkbenchSchedules({
  rows,
  nowMs,
  openTaskId,
  selectedTaskId,
  onOpen,
  onAction,
}: {
  rows: readonly ScheduleOverviewRow[];
  nowMs: number;
  /** 右侧任务面板正开着的那一行 */
  openTaskId: string | null;
  /** 键盘选中的那一行 */
  selectedTaskId: string | null;
  onOpen: (row: ScheduleOverviewRow) => void;
  onAction: (row: ScheduleOverviewRow) => void;
}) {
  if (rows.length === 0) return null;
  const points = scheduleTimeline(rows, nowMs);
  const paused = rows.filter((r) => r.task.state.startsWith("已自动暂停")).length;
  const marks = [0, 6, 12, 18, 24].map((h) => {
    const d = new Date(nowMs + h * 3600_000);
    return { h, label: h === 0 ? "现在" : hhmm(d.getHours(), d.getMinutes()) };
  });
  return (
    <section className="mt-7 min-w-0" aria-label="定时任务" data-workbench-queue="">
      <div className="mb-2.5 flex items-center gap-2 px-1">
        <AlarmClock size={14} strokeWidth={1.8} className="shrink-0 text-l4" aria-hidden="true" />
        <h2 className="text-micro font-medium text-l2">定时任务</h2>
        <span className="text-micro text-l3">
          {rows.length - paused} 个在用{paused ? ` · ${paused} 个暂停` : ""}
        </span>
      </div>

      {/* 今后 24 小时：哪会儿要跑什么；正在跑的钉在「现在」 */}
      <div className="relative mx-1 mb-6 mt-1 h-5" aria-label="今后 24 小时要跑的定时任务">
        <div className="absolute inset-x-0 top-2 h-px bg-hairline" />
        {marks.map((m) => (
          <span
            key={m.h}
            className="absolute top-4 -translate-x-1/2 text-micro text-l4 first:translate-x-0 last:-translate-x-full"
            style={{ left: `${(m.h / 24) * 100}%` }}
          >
            {m.label}
          </span>
        ))}
        {points.map((p) => (
          <span
            key={p.id}
            className={`absolute top-[5px] size-[7px] -translate-x-1/2 rounded-full ring-2 ring-canvas ${
              p.running ? "bg-ok-text" : "bg-l3"
            }`}
            style={{ left: `${Math.min(Math.max(p.pos, 0.005), 0.995) * 100}%` }}
            title={`${p.name} · ${p.running ? "正在跑" : absTime(new Date(p.at).toISOString())}`}
          />
        ))}
        {points.length === 0 && (
          <span className="absolute right-0 -top-0.5 text-micro text-l4">今后 24 小时没有要跑的</span>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-hairline">
        {rows.map((row) => {
          const selected = selectedTaskId === row.task.id;
          return (
            <div
              key={row.task.id}
              id={`wbs-${row.task.id}`}
              className={`${ROW_GRID} min-h-10 border-t border-hairline px-4 py-1.5 first:border-t-0 ${
                openTaskId === row.task.id || selected ? "bg-hover" : "hover:bg-hover"
              } ${selected ? "shadow-[inset_2px_0_0_var(--color-nav-accent)]" : ""}`}
            >
              <span className={`size-1.5 rounded-full ${TONE_DOT[row.task.queued ? "wait" : row.task.tone]}`} />
              <button
                type="button"
                className="min-w-0 truncate text-left text-sm text-l1 hover:underline"
                aria-haspopup="dialog"
                title={`看「${row.task.name}」的详情`}
                onClick={() => onOpen(row)}
              >
                {row.task.name}
              </button>
              <span className="min-w-0 truncate text-micro text-l3" title={row.projectRoot}>
                {row.projectName}
              </span>
              <span className="min-w-0 truncate text-micro text-l3">{row.frequency}</span>
              <span
                className={`min-w-0 truncate text-micro ${row.task.tone === "fail" ? "text-err-text" : "text-l3"}`}
                title={row.task.state}
              >
                {row.task.state}
                {row.task.queued ? " · 在「等你拍板」里" : ""}
              </span>
              <span className="text-right">
                {row.action && (
                  <button
                    type="button"
                    className={rowActionClass}
                    title={ACTION_TIP[row.action]}
                    onClick={() => onAction(row)}
                  >
                    {ACTION_LABEL[row.action]}
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
