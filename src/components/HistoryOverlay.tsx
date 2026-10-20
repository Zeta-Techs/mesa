import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  formatTimeOfDay,
  groupHistoryByDay,
  translateHistoryEntry,
  type WsStepMap,
} from "../history-view";
import { EmptyState } from "./PageFrame";
import { GitInstallOffer } from "../dep-install";
import type { HistoryEntryDto } from "../types";

/**
 * 保存历史（全宽覆盖层，同 PipelineEditor 形态）：把 git log 翻译成白话时间线。
 * 只读视图；数据为当前分支 first-parent 主线（工作区分支的过程提交不单独列出，
 * 成果通过「✓ 保存进项目」条目体现）。
 */
export default function HistoryOverlay({
  projectName,
  repoPath,
  wsSteps,
  onClose,
}: {
  projectName: string;
  repoPath: string;
  /** 工作区名 → 步骤名（merge commit 的「保存进项目」优先显示步骤名） */
  wsSteps: WsStepMap;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 一键装好 Git 后重新读取
  const [reloadTick, setReloadTick] = useState(0);

  // Esc 关闭（与应用内其他浮层一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let stale = false;
    setError(null);
    invoke<HistoryEntryDto[]>("project_history", { repoPath, limit: 100 })
      .then((list) => {
        if (!stale) setEntries(list);
      })
      .catch((reason) => {
        if (!stale) setError(String(reason));
      });
    return () => {
      stale = true;
    };
  }, [repoPath, reloadTick]);

  const groups = useMemo(
    () => (entries ? groupHistoryByDay(entries) : []),
    [entries],
  );

  return (
    <div data-surface="canvas" className="fixed inset-0 z-30 flex flex-col bg-canvas">
      {/* 覆盖层头部统一（P3）：strip 底 + hairline 下缘；只读视图无主动作，仅「关闭」 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hairline bg-strip px-8 py-3">
        <h2 className="shrink-0 text-base font-semibold text-l1">
          {projectName} · 保存历史
        </h2>
        <span className="min-w-0 truncate text-xs text-l3">
          主仓库提交才进入项目时间线；工作区过程提交在任务分支历史中保留（只读，最近 100 条主线记录）
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-8 py-4">
          {error ? (
            <div className="rounded-sm ccode-well p-3 text-xs">
              <p>
                <span className="mr-1 text-err-text">✗</span>
                <span className="text-l2">{error}</span>
              </p>
              <GitInstallOffer error={error} onInstalled={() => setReloadTick((n) => n + 1)} />
            </div>
          ) : entries === null ? (
            <p className="text-xs text-l4">读取中…</p>
          ) : entries.length === 0 ? (
            <EmptyState
              title="还没有保存记录"
              detail="保存一次改动、或合并一个任务，这里就会有记录。"
            />
          ) : (
            groups.map((group) => (
              <section key={group.label} className="mb-4">
                <h3 className="mb-1 text-xs font-medium text-l4">
                  {group.label}
                </h3>
                <ul className="divide-y divide-hairline rounded-md ccode-well">
                  {group.entries.map((entry) => {
                    const item = translateHistoryEntry(entry, wsSteps);
                    return (
                      <li
                        key={entry.hash}
                        className="flex items-baseline gap-2 px-3 py-2"
                      >
                        <span className="w-10 shrink-0 font-mono text-xs text-l4">
                          {formatTimeOfDay(entry.time)}
                        </span>
                        <span
                          className={`w-4 shrink-0 text-xs ${
                            item.kind === "merge" ? "text-ok-text" : "text-l3"
                          }`}
                        >
                          {item.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-l2">
                            {item.title}
                          </span>
                          {item.stats && (
                            <span className="block text-xs text-l4">
                              {item.stats}
                            </span>
                          )}
                        </span>
                        <span
                          className="shrink-0 font-mono text-micro text-l4"
                          title={`提交 ${entry.hash} · ${entry.author}`}
                        >
                          {entry.hash}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
