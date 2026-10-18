import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadResearchReports, readResearchFile } from "../research-report-load";
import { researchReportPatterns } from "../research-report";
import type { ProjectStepDto, ResearchAcceptanceDto, ResearchAcceptedFile, ResearchSourceDto, ResearchWorkspaceRef } from "../types";
import { InlineNotice } from "./PageFrame";

const VERDICTS = [
  { value: "accept", label: "接受" },
  { value: "accept_with_conditions", label: "有条件接受" },
  { value: "return", label: "退回" },
] as const;

const SCREENING_VERDICTS = [
  { value: "accept", label: "可以用，进精读" },
  { value: "accept_with_conditions", label: "可以用，但有保留" },
  { value: "return", label: "还不行，让 AI 再改" },
] as const;

export default function ResearchAcceptancePanel({ workspace, step, runId = null, sourceRunId = null, variant = "default" }: {
  workspace: ResearchWorkspaceRef; step: ProjectStepDto; runId?: string | null; sourceRunId?: string | null;
  variant?: "default" | "screening";
}) {
  const screening = variant === "screening";
  const [verdict, setVerdict] = useState<typeof VERDICTS[number]["value"] | "">(screening ? "" : "return");
  const [scope, setScope] = useState("");
  const [blockers, setBlockers] = useState("");
  const [files, setFiles] = useState<ResearchAcceptedFile[]>([]);
  const [saved, setSaved] = useState<ResearchAcceptanceDto | null>(null);
  const [stale, setStale] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<ResearchSourceDto | null>(null);
  const [reload, setReload] = useState(0);
  const identity = JSON.stringify([workspace.id, workspace.repoPath, workspace.worktreePath, step.name, sourceRunId]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [linkRun, setLinkRun] = useState(true);
  useEffect(() => { setLinkRun(true); }, [runId, identity]);
  useEffect(() => {
    let cancelled = false;
    setError(null); setBusy(false); setSource(null); setFiles([]); setSaved(null); setScope(""); setBlockers(""); setStale([]);
    void (async () => {
      try {
        const source = await invoke<ResearchSourceDto>("research_source", { projectRoot: workspace.repoPath, workspaceId: workspace.id, worktreePath: workspace.worktreePath, sourceRunId });
        const existing = await invoke<ResearchAcceptanceDto | null>("research_get_acceptance", {
          projectRoot: workspace.repoPath, workspaceId: workspace.id, stepName: step.name, resultVersion: source.resultVersion, sourceRevision: source.revision,
        });
        const reports = await loadResearchReports(source.root, researchReportPatterns(step, "acceptance"), "acceptance");
        const current: ResearchAcceptedFile[] = [];
        for (const report of reports.reports) {
          if (report.revision) current.push({ path: report.path, revision: report.revision });
        }
        if (cancelled) return;
        setSource(source);
        setFiles(current);
        if (existing) {
          setSaved(existing);
          setVerdict(existing.verdict === "accept" || existing.verdict === "accept_with_conditions" ? existing.verdict : "return");
          setScope(existing.conclusionScope);
          setBlockers(existing.openBlockers.join("\n"));
          const changed = existing.files.filter((file) => current.find((c) => c.path === file.path)?.revision !== file.revision).map((f) => f.path);
          setStale(changed);
        } else {
          setSaved(null); setStale([]);
        }
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [workspace.id, workspace.repoPath, workspace.worktreePath, workspace.status, step.name, sourceRunId, reload]);
  async function save() {
    if (busy || !source) return;
    setBusy(true); setError(null);
    const saveIdentity = identity;
    if (!verdict) return;
    try {
      const current: ResearchAcceptedFile[] = [];
      for (const file of files) {
        const preview = await readResearchFile(source.root, file.path);
        if (!preview.revision || preview.truncated || preview.revision !== file.revision) throw new Error(`${file.path}：无法绑定完整版本`);
        current.push({ path: file.path, revision: preview.revision });
      }
      const record = await invoke<ResearchAcceptanceDto>("research_save_acceptance", {
        projectRoot: workspace.repoPath,
        record: {
          verdict,
          sourceRoot: source.root,
          sourceRunId,
          resultVersion: source.resultVersion,
          sourceRevision: source.revision,
          stepName: step.name,
          workspaceId: workspace.id,
          files: current,
          conclusionScope: scope.trim(),
          openBlockers: blockers.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
          runId: linkRun ? runId : null,
          createdAt: "",
        },
      });
      if (identityRef.current === saveIdentity) { setSaved(record); setFiles(current); setStale([]); }
    } catch (reason) { if (identityRef.current === saveIdentity) setError(String(reason)); }
    finally { if (identityRef.current === saveIdentity) setBusy(false); }
  }
  const verdicts = screening ? SCREENING_VERDICTS : VERDICTS;
  if (screening) {
    return <section aria-label="筛选决定" className="mt-4 text-xs">
      <details className="text-l3">
        <summary className="cursor-pointer text-l2">给精读留一句（可选）</summary>
        <p className="mt-1 text-micro text-l4">不填也能保存进项目。</p>
        {saved && <p className="mt-1 text-l2">上次：{SCREENING_VERDICTS.find((v) => v.value === saved.verdict)?.label ?? saved.verdict}</p>}
        {stale.length > 0 && <p className="text-warn-text">清单文件已变，若要留备注请重写。</p>}
        <label className="mt-2 block text-l2">清单
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)} className="mt-1 w-full rounded border border-field bg-canvas p-1">
            <option value="">不留</option>
            {verdicts.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="mt-2 block text-l2">备注
          <textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={2} className="mt-1 w-full rounded border border-field bg-canvas p-1" placeholder="例如：纳入的可以精读；缺全文的先按摘要。" />
        </label>
        <button type="button" disabled={busy || !verdict || !source || !scope.trim() || (verdict !== "return" && files.length === 0)} onClick={() => void save()} className="mt-2 rounded border border-field px-2 py-1 text-l2 disabled:opacity-50">{busy ? "保存中…" : "记下"}</button>
        {error && <InlineNotice tone="err" className="mt-2">{error}</InlineNotice>}
      </details>
    </section>;
  }
  return <section aria-label="科研验收决定" className="my-3 rounded-md ccode-well p-3 text-xs">
    <div className="flex justify-between"><h3 className="font-medium text-l1">科研验收决定</h3><button type="button" disabled={busy} onClick={() => setReload((n) => n + 1)}>重新核对来源</button></div>
    {source && <details className="text-micro text-l4">
      <summary>来源核对</summary>
      <p className="break-all">当前来源版本：{source.resultVersion} · 指纹 {source.revision.slice(0, 12)}</p>
    </details>}
    {source?.warnings.map((warning) => <p className="text-warn-text" key={warning}>{warning}</p>)}
    <p className="my-1 text-micro text-l4">这是接受研究结论的记录，不是保存进项目，也不是报告里写了「通过」。保存工作仍用右上角保存进项目。</p>
    {saved && <p className="text-l2">上次：{VERDICTS.find((v) => v.value === saved.verdict)?.label ?? saved.verdict} · {saved.createdAt}{saved.runId ? ` · 运行 ${saved.runId}` : ""}</p>}
    {stale.length > 0 && <p className="text-warn-text">以下文件版本已变，需要重新确认：{stale.join("、")}</p>}
    <label className="mt-2 block text-l2">决定
      <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)} className="mt-1 w-full rounded border border-field bg-canvas p-1">
        {verdicts.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </label>
    <label className="mt-2 block text-l2">接受的结论范围
      <textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={2} className="mt-1 w-full rounded border border-field bg-canvas p-1" placeholder="例如：仅接受合成演示范围内的描述性差值，不外推真实任务。" />
    </label>
    <label className="mt-2 block text-l2">未关闭的阻塞项
      <textarea value={blockers} onChange={(e) => setBlockers(e.target.value)} rows={2} className="mt-1 w-full rounded border border-field bg-canvas p-1" placeholder="一行一项；没有则留空" />
    </label>
    {runId && <label className="mt-2 block text-l3"><input type="checkbox" checked={linkRun} disabled={busy} onChange={(e) => setLinkRun(e.target.checked)} /> 关联本次复现记录（版本不一致时请重跑或取消关联，不会把运行结束当成科学通过）</label>}
    {files.length > 0 && <p className="mt-2 break-all text-micro text-l4">绑定文件：{files.map((f) => `${f.path}（${f.revision.slice(0, 8)}）`).join("、")}</p>}
    <button type="button" disabled={busy || !verdict || !source || !scope.trim() || (verdict !== "return" && files.length === 0)} onClick={() => void save()} className="mt-2 rounded border border-field px-2 py-1 text-l2 disabled:opacity-50">{busy ? "保存中…" : "记下验收决定"}</button>
    {error && <InlineNotice tone="err" className="mt-2">{error}</InlineNotice>}
  </section>;
}
