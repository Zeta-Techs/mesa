import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS, type RunDto } from "../types";
import { InlineNotice, paneOutlineButtonClass } from "./PageFrame";
import { usePolling } from "../polling";

/** 低频诊断区提供无头任务停止入口，避免只能等待超时。
 *  外形统一对齐设置页分组卡（SubHeading + .ccode-well rounded-xl）。 */
export default function BackgroundTasksPanel() {
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const reload = async (alive: () => boolean) => {
    try {
      const rows = await invoke<RunDto[]>("active_background_runs");
      if (alive()) { setRuns(rows); setError(null); }
    } catch (reason) { if (alive()) setError(String(reason)); }
  };
  useEffect(() => {
    let disposed = false;
    void reload(() => !disposed);
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  usePolling(reload, 2000);
  const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;
  return (
    <div className="mt-6">
      <div className="mb-2 px-0.5">
        <h3 className="text-xs font-semibold tracking-wide text-l2">后台任务</h3>
      </div>
      <div className="ccode-well divide-y divide-hairline overflow-hidden rounded-xl border border-hairline px-4 py-1.5">
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        {!runs.length && !error && <p className="py-2 text-xs text-l4">现在没有在后台跑的任务</p>}
        {runs.map((run) => (
          <div key={run.id} className="flex items-center gap-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-sm text-l2">
              {agentLabel(run.agent)} · {run.taskRef || run.projectRoot || "AI 辅助任务"}
            </span>
            <button
              type="button"
              disabled={stopping === run.id}
              className={`${paneOutlineButtonClass} shrink-0`}
              onClick={() => {
                setStopping(run.id);
                void invoke("run_cancel", { id: run.id })
                  .catch((reason) => setError(String(reason)))
                  .finally(() => setStopping(null));
              }}
            >
              {stopping === run.id ? "请求停止…" : "停止"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
