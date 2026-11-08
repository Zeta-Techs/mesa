import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS, type RunDto } from "../types";
import { InlineNotice, paneOutlineButtonClass } from "./PageFrame";
import { usePolling } from "../polling";

/** 低频诊断区提供无头任务停止入口，避免只能等待超时。
 *  外形同设置页 Card：粗体节标题 + 一句说明，下面一条细线收边，不套卡 */
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
  return <div className="mt-7">
    <div className="mb-2">
      <div className="text-base font-semibold text-l1">后台任务</div>
      <p className="mt-0.5 text-xs leading-5 text-l3">Mesa 在后台替你跑的 Agent（定时任务、起名摘要等），卡住时在这里停止</p>
    </div>
    <div className="border-t border-hairline pt-1">
    {error && <InlineNotice tone="err">{error}</InlineNotice>}
    {!runs.length && !error && <p className="px-1 py-2 text-xs text-l4">现在没有在后台跑的任务</p>}
    {runs.map((run) => <div key={run.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-hover">
      <span className="min-w-0 flex-1 truncate text-l3">{agentLabel(run.agent)} · {run.taskRef || run.projectRoot || "AI 辅助任务"}</span>
      <button type="button" disabled={stopping === run.id} className={`${paneOutlineButtonClass} shrink-0`} onClick={() => {
        setStopping(run.id);
        void invoke("run_cancel", { id: run.id }).catch((reason) => setError(String(reason))).finally(() => setStopping(null));
      }}>{stopping === run.id ? "请求停止…" : "停止"}</button>
    </div>)}
    </div>
  </div>;
}
