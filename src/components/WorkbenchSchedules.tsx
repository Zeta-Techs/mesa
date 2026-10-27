import { AlarmClock } from "lucide-react";
import { rowActionClass } from "./PageFrame";
import { absTime } from "../rel-time";
import { hhmm } from "../schedule-tasks";
import {
  scheduleTimelineGroups,
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

/**
 * 工作台「定时任务」总览（2026-10-27）：跨项目一块看完，顶上一条今后 24 小时的时间轴，行内停止 / 重跑 / 重新打开 / 现在跑。
 * 项目分组里不再列定时任务（同一件事只说一次）；被自动暂停、有产物待评审的在「等你拍板」里，这里只带回拍板队列
 */
export default function WorkbenchSchedules({
  rows,
  nowMs,
  openTaskId,
  selectedTaskId,
  onOpen,
  onAction,
  onQueue,
}: {
  rows: readonly ScheduleOverviewRow[];
  nowMs: number;
  /** 右侧任务面板正开着的那一行 */
  openTaskId: string | null;
  /** 键盘选中的那一行 */
  selectedTaskId: string | null;
  onOpen: (row: ScheduleOverviewRow) => void;
  onAction: (row: ScheduleOverviewRow) => void;
  onQueue: (row: ScheduleOverviewRow) => void;
}) {
  if (rows.length === 0) return null;
  const groups = scheduleTimelineGroups(rows, nowMs);
  const paused = rows.filter((r) => r.task.state.startsWith("已自动暂停")).length;
  const openPoint = (id: string) => {
    const row = rows.find((item) => item.task.id === id);
    if (row) row.task.queued ? onQueue(row) : onOpen(row);
  };
  return (
    <section className="mt-7 min-w-0" aria-label="定时任务" data-workbench-queue="">
      <div className="mb-2.5 flex items-center gap-2 px-1">
        <AlarmClock size={14} strokeWidth={1.8} className="shrink-0 text-l4" aria-hidden="true" />
        <h2 className="text-micro font-medium text-l2">定时任务</h2>
        <span className="text-micro text-l3">
          {rows.length - paused} 个在用{paused ? ` · ${paused} 个暂停` : ""}
        </span>
      </div>

      <div className="mb-3 px-1">
        <p className="mb-2 text-xs text-l3">今后 24 小时</p>
        <ul className="flex flex-wrap gap-2" aria-label="今后 24 小时要跑的定时任务">
          {groups.map((group) => {
            const date = new Date(group.at);
            const time = group.running ? "正在跑" : `${date.getDate() !== new Date(nowMs).getDate() ? "明天 " : ""}${hhmm(date.getHours(), date.getMinutes())}`;
            const label = `${time} · ${group.items.length} 项`;
            return (
              <li key={group.key} className="min-w-0 max-w-full">
                {group.items.length === 1 ? (
                  <button type="button" className="ccode-workbench-time-item" title={absTime(date.toISOString())} onClick={() => openPoint(group.items[0].id)}>
                    <span className="shrink-0 tabular-nums text-l3">{time}</span>
                    <span className="min-w-0 break-words text-l2">{group.items[0].name} · {rows.find((row) => row.task.id === group.items[0].id)?.projectName}</span>
                  </button>
                ) : (
                  <details className="rounded-lg border border-hairline text-xs">
                    <summary className="cursor-pointer rounded-lg px-2.5 py-1.5 text-l2 hover:bg-hover">{label}</summary>
                    <ul className="space-y-1 px-2 pb-2" aria-label={label}>
                      {group.items.map((point) => (
                        <li key={point.id}>
                          <button type="button" className="w-full break-words rounded-lg px-1.5 py-1 text-left text-l2 hover:bg-hover" onClick={() => openPoint(point.id)}>
                            {point.name} · {rows.find((row) => row.task.id === point.id)?.projectName}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        {groups.length === 0 && <p className="text-xs text-l3">今后 24 小时没有要跑的</p>}
      </div>

      <div className="overflow-hidden rounded-lg border border-hairline">
        {rows.map((row) => {
          const selected = selectedTaskId === row.task.id;
          return (
            <div
              key={row.task.id}
              id={`wbs-${row.task.id}`}
              tabIndex={-1}
              data-workbench-nav={`s:${row.task.id}`}
              className={`ccode-workbench-schedule min-h-10 border-t border-hairline px-4 py-1.5 first:border-t-0 ${
                openTaskId === row.task.id || selected ? "bg-hover" : "hover:bg-hover"
              } ${selected ? "shadow-[inset_2px_0_0_var(--color-nav-accent)]" : ""}`}
            >
              <span aria-hidden="true" className={`ccode-workbench-schedule-dot size-1.5 rounded-full ${TONE_DOT[row.task.queued ? "wait" : row.task.tone]}`} />
              <button
                type="button"
                className="ccode-workbench-schedule-name min-w-0 break-words text-left text-sm text-l1 hover:underline"
                aria-haspopup={row.task.queued ? undefined : "dialog"}
                title={row.task.queued ? `去拍板队列处理「${row.task.name}」` : `看「${row.task.name}」的详情`}
                onClick={() => row.task.queued ? onQueue(row) : onOpen(row)}
              >
                {row.task.name}
              </button>
              <span className="ccode-workbench-schedule-project min-w-0 break-words text-xs text-l3" title={row.projectRoot}>
                {row.projectName}
              </span>
              <span className="ccode-workbench-schedule-frequency min-w-0 break-words text-xs text-l3">{row.frequency}</span>
              <span
                className={`ccode-workbench-schedule-state min-w-0 break-words text-xs ${row.task.tone === "fail" ? "text-err-text" : "text-l3"}`}
                title={row.task.state}
              >
                {row.task.state}
                {row.task.queued ? " · 在「等你拍板」里" : ""}
              </span>
              <span className="ccode-workbench-schedule-action text-right">
                {row.task.queued ? (
                  <button type="button" className={rowActionClass} onClick={() => onQueue(row)}>去拍板</button>
                ) : row.action && (
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
