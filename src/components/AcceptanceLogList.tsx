import { useState } from "react";
import { acceptanceEntryKey, acceptanceEntryRow } from "../acceptance-log";
import {
  acceptanceLogView,
  recentAcceptanceLog,
} from "../project-status";
import { absTime, relTime } from "../rel-time";
import type { AcceptanceLogEntryDto } from "../types";
import { FoldMark } from "./PageFrame";

/** 任务页只读账本：科研 / 编程 / 目标共用，不另开页签。
 *  一条一行：「对象 · 发生了什么 · N 个文件」+ 右侧时间；版本号与文件清单进悬浮，
 *  人写的备注才另起一行（系统自动备注不重复）。 */
export default function AcceptanceLogList({
  entries,
  className = "mt-3",
}: {
  entries: readonly AcceptanceLogEntryDto[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const recent = recentAcceptanceLog(entries);
  if (recent.length === 0) return null;
  return (
    // 字号在容器：全站 button { font: inherit } 吞掉按钮上的 text-*
    <div className={`text-xs ${className}`}>
      <button
        type="button"
        className="flex items-center gap-1.5 font-medium text-l3 hover:text-l1"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <FoldMark open={open} />
        验收记录
        <span className="font-normal text-l4">{entries.length}</span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1">
          {recent.map((entry) => {
            const view = acceptanceLogView(entry);
            const row = acceptanceEntryRow(entry);
            const paths = (entry.paths ?? []).filter((p) => p.trim() && p.trim() !== ".");
            return (
              <li key={acceptanceEntryKey(entry)} className="rounded-md px-1.5 py-1 hover:bg-hover">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span
                    className="min-w-0 flex-1 truncate text-l2"
                    title={[row.version ? `版本 ${row.version}` : "", ...paths].filter(Boolean).join("\n") || undefined}
                  >
                    {row.title}
                    <span className="text-l4"> · {view.filesLabel}</span>
                  </span>
                  <span
                    className="shrink-0 text-micro text-l4"
                    title={absTime(view.decidedAt)}
                  >
                    {relTime(view.decidedAt)}
                  </span>
                </div>
                {row.note && (
                  <p className="mt-0.5 text-micro leading-4 text-l3">{row.note}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
