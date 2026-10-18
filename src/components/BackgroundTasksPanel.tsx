import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS, type RunDto } from "../types";
import { InlineNotice, ghostActionClass } from "./PageFrame";

/** 低频诊断区提供无头任务停止入口，避免只能等待超时。
 *  外形对齐设置页统一内容卡（卡头标题 + 一句说明），不画分隔横线（设置页不画线口径，2026-10-17） */
export default function BackgroundTasksPanel() {
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const reload = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const rows = await invoke<RunDto[]>("active_background_runs");
        if (!disposed) { setRuns(rows); setError(null); }
      } catch (reason) { if (!disposed) setError(String(reason)); }
      finally { inFlight = false; }
    };
    void reload();
    const timer = window.setInterval(() => void reload(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;
  return <div className="mt-3 rounded-lg ccode-well p-3">
    <div className="mb-2">
      <div className="text-sm text-l2">后台任务</div>
      <p className="mt-0.5 text-micro leading-4 text-l4">Mesa 在后台替你跑的 Agent（定时任务、起名摘要等），卡住时在这里停止</p>
    </div>
    {error && <InlineNotice tone="err">{error}</InlineNotice>}
    {!runs.length && !error && <p className="px-1 text-xs text-l4">现在没有在后台跑的任务</p>}
    {runs.map((run) => <div key={run.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-hover">
      <span className="min-w-0 flex-1 truncate text-l3">{agentLabel(run.agent)} · {run.taskRef || run.projectRoot || "AI 辅助任务"}</span>
      <button type="button" disabled={stopping === run.id} className={`${ghostActionClass} shrink-0`} onClick={() => {
        setStopping(run.id);
        void invoke("run_cancel", { id: run.id }).catch((reason) => setError(String(reason))).finally(() => setStopping(null));
      }}>{stopping === run.id ? "请求停止…" : "停止"}</button>
    </div>)}
  </div>;
}
