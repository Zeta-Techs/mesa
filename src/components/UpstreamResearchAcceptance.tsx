import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { upstreamAcceptanceNote, type UpstreamAcceptance } from "../research-acceptance";
import { formatDecisionAnswer, setDecisionAnswer } from "../step-decisions";
import type { StepDecisionDto } from "../types";
import { InlineNotice } from "./PageFrame";

export default function UpstreamResearchAcceptance({ projectRoot, stepName, decisions, text, evidenceRevision, onChange }: {
  projectRoot: string; stepName: string; decisions: StepDecisionDto[]; text: string;
  evidenceRevision: string | null; onChange: (text: string) => void;
}) {
  const [rows, setRows] = useState<UpstreamAcceptance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState(decisions[0]?.q ?? "");
  useEffect(() => {
    let cancelled = false; setRows([]); setError(null);
    invoke<UpstreamAcceptance[]>("research_upstream_acceptances", { projectRoot, stepName })
      .then((value) => { if (!cancelled) setRows(value); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [projectRoot, stepName]);
  if (!rows.length && !error) return null;
  return <section aria-label="引用上游验收" className="my-2 rounded ccode-well p-3 text-xs">
    <h3 className="font-medium text-l2">上游已确认的结论范围</h3>
    <p className="text-l3">引用既有依据，不自动批准本步。</p>
    {error && <InlineNotice tone="warn">{error}</InlineNotice>}
    {decisions.length > 1 && <select value={question} onChange={(e) => setQuestion(e.target.value)} className="mt-1 max-w-full rounded border border-field bg-canvas p-1">{decisions.map((d) => <option key={d.q} value={d.q}>{d.q}</option>)}</select>}
    {rows.map((row) => <div key={`${row.stepName}:${row.createdAt}`} className="mt-2">
      <p className={row.valid ? "text-l2" : "text-warn-text"}>{upstreamAcceptanceNote(row)}{!row.valid ? `；需重验：${row.changedFiles.join("、") || "缺少完整证据"}` : ""}</p>
      {row.valid && row.verdict !== "return" && question && <button type="button" className="mt-1 text-l3" onClick={() => onChange(setDecisionAnswer(text, question, formatDecisionAnswer("prepare", `引用上游：${upstreamAcceptanceNote(row)}。本步当前仅允许准备；正式批准须按本步证据重新选择。`, evidenceRevision)))}>引用依据，当前仅允许准备</button>}
    </div>)}
  </section>;
}
