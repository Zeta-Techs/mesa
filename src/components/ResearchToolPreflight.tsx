import { inlineActionClass } from "./PageFrame";
import { useAppStore } from "../store";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "../types";

export interface ToolCheck { name: string; status: string; detail: string; blocking: boolean }

/** 开工前只读检查技能与外部工具。全部就绪时只出一行小字（挂在开工弹层「技能」行下）；
 *  有缺口或步骤提示才展开成带「去技能页分发 / 重新检测」的块——就绪时还摆一整块，
 *  与下面的技能芯片把同一件事说两遍（2026-10-17 用户截图）。 */
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
  const agentLabel = AGENTS.find((a) => a.id === agent)?.label ?? agent;
  if (!error && !checks) {
    return <p className="mt-1 text-micro text-l4">正在检查技能是否已启用…</p>;
  }
  if (!error && checks && checks.every((c) => c.status === "available" && !c.blocking)) {
    if (checks.length === 0) return null;
    return (
      <p className="mt-1 text-micro text-l4" title={checks.map((c) => `${c.name}：${c.detail}`).join("\n")}>
        已启用到 {agentLabel}
      </p>
    );
  }
  return <section aria-label="开工工具检查" className="mt-1.5 rounded ccode-well p-2.5 text-xs">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium text-l2">技能与工具检查</h3><span className="flex gap-3 text-micro"><button type="button" className={inlineActionClass} onClick={() => setPage("skills")}>去技能页分发</button><button type="button" className={inlineActionClass} onClick={() => setReload((n) => n + 1)}>重新检测</button></span></div>
    {error ? <p className="mt-1 text-err-text">{error}</p> : <ul className="mt-1 space-y-1">{checks!.map((c) => <li key={c.name} className={c.blocking ? "text-warn-text" : "text-l3"}>{c.name}：{c.detail}{c.blocking ? "（开工前需处理）" : ""}</li>)}</ul>}
  </section>;
}
