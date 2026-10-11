import { inlineActionClass } from "./PageFrame";
import { useAppStore } from "../store";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ToolCheck { name: string; status: string; detail: string; blocking: boolean }
export default function ResearchToolPreflight({ projectRoot, stepName, agent, onBlocked }: {
  projectRoot: string; stepName: string; agent: string; onBlocked: (blocked: boolean) => void;
}) {
  const [checks, setChecks] = useState<ToolCheck[] | null>(null);
  const setPage = useAppStore((s) => s.setPage);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let stale = false;
    setChecks(null); setError(null); onBlocked(true);
    invoke<ToolCheck[]>("research_tool_preflight", { projectRoot, stepName, agent })
      .then((rows) => { if (!stale) { setChecks(rows); onBlocked(rows.some((r) => r.blocking)); } })
      .catch((reason) => { if (!stale) { setError(String(reason)); onBlocked(true); } });
    return () => { stale = true; };
  }, [projectRoot, stepName, agent, reload, onBlocked]);
  return <section aria-label="开工工具检查" className="my-2 rounded ccode-well p-3 text-xs">
    <div className="flex justify-between"><h3 className="font-medium text-l2">所选 Agent 的技能与工具</h3><span className="flex gap-3"><button type="button" className={inlineActionClass} onClick={() => setPage("skills")}>去技能页分发</button><button type="button" className={inlineActionClass} onClick={() => setReload((n) => n + 1)}>重新检测</button></span></div>
    {error ? <p className="text-err-text">{error}</p> : !checks ? <p className="text-l3">正在只读检查…</p> : <ul className="mt-1 space-y-1">{checks.map((c) => <li key={c.name} className={c.blocking ? "text-warn-text" : "text-l3"}>{c.name}：{c.detail}{c.blocking ? "（开工前需处理）" : ""}</li>)}</ul>}
  </section>;
}
