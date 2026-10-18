import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { IS_WINDOWS } from "../hotkeys";
import { confirmDialog } from "./ConfirmDialog";
import { readResearchFile, type ReportPreview } from "../research-report-load";
import {
  parseReproductionContract,
  reproductionCommandFromContract,
  reproductionEntrypoints,
  reproductionScripts,
  type ReproductionContract,
} from "../research-report";
import type { ProjectStepDto, ResearchRunDto, ResearchSourceDto, ResearchWorkspaceRef, RunScriptDto, WsSettingsDto } from "../types";
import { InlineNotice } from "./PageFrame";

interface Choice {
  key: string;
  label: string;
  command: string;
  entry?: string;
  revision?: string | null;
  contract?: ReproductionContract;
  configured?: RunScriptDto;
}

function statusLabel(run: ResearchRunDto): string {
  if (run.status === "succeeded") return "运行结束（退出码 0）";
  if (run.status === "blocked") return "运行结束（检查阻塞）";
  if (run.status === "running") return "正在运行";
  return `运行结束（失败${run.exitCode != null ? `，退出码 ${run.exitCode}` : ""}）`;
}

export default function ResearchReproductionPanel({ workspace, step, onLaunched, onRun, sourceRunId = null }: {
  workspace: ResearchWorkspaceRef; sourceRunId?: string | null; step: ProjectStepDto; artifactDir?: string; onLaunched: () => void; onRun?: (run: ResearchRunDto) => void;
}) {
  const scope = JSON.stringify([sourceRunId, workspace.status, workspace.id, workspace.worktreePath, step.workspaceName, step.expectedArtifacts, step.inputs, step.optionalInputs, step.run]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => { scopeRef.current = scope; return () => { scopeRef.current = ""; }; }, [scope]);
  const busyRef = useRef(false);
  const sessionKey = `research-reproduction:${sourceRunId ?? workspace.worktreePath}`;
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<{ scope: string; choices: Choice[]; warnings: string[]; source: ResearchSourceDto | null } | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<ResearchRunDto | null>(null);
  const [result, setResult] = useState<{ path: string; value?: ReportPreview; error?: string } | null>(null);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const running = useAppStore((s) => s.runningScripts[workspace.id]);
  useEffect(() => {
    let stale = false;
    setData(null); setSelected(""); setError(null); setResult(null); setRun(null);
    void (async () => {
      const warnings: string[] = [];
      const choices: Choice[] = [];
      let source: ResearchSourceDto | null = null;
      try {
        source = await invoke<ResearchSourceDto>("research_source", { projectRoot: workspace.repoPath, workspaceId: workspace.id, worktreePath: workspace.worktreePath, sourceRunId });
        warnings.push(...source.warnings);
      } catch (reason) { warnings.push(`来源无法核对：${String(reason)}`); }
      try {
        const settings = await invoke<WsSettingsDto>("workspace_settings", { repoPath: workspace.repoPath });
        choices.push(...reproductionScripts(settings.run).map((script) => ({ key: `configured:${script.name}`, label: `项目脚本：${script.name}`, command: script.command, configured: script })));
      } catch (reason) { warnings.push(`脚本配置读取失败：${String(reason)}`); }
      for (const entry of source ? reproductionEntrypoints(step) : []) {
        try {
          const preview = await readResearchFile(source!.root, entry);
          if (preview.truncated || !preview.revision) { warnings.push(`${entry}：无法校验完整版本，不提供运行建议`); continue; }
          const contract = parseReproductionContract(entry, preview.text);
          if (!contract) { warnings.push(`${entry}：没有明确的复现约定（需要 MESA_REPRODUCE 或 reproduce 子命令）`); continue; }
          choices.push({
            key: entry,
            label: `入口：${entry}`,
            entry,
            revision: preview.revision,
            contract,
            command: reproductionCommandFromContract(contract, workspace.worktreePath, "（独立输出目录，运行时分配）", IS_WINDOWS),
          });
        } catch (reason) { warnings.push(`${entry}：${String(reason)}`); }
      }
      if (!stale) {
        setData({ scope, choices, warnings, source });
        if (choices.length) setSelected(choices[0].key);
        try {
          const raw = sessionStorage.getItem(sessionKey);
          const previous = raw ? JSON.parse(raw) as { choiceKey?: string; runId?: string } : null;
          if (previous?.choiceKey && choices.some((c) => c.key === previous.choiceKey)) setSelected(previous.choiceKey);
          if (previous?.runId) {
            const saved = await invoke<ResearchRunDto>("research_get_run", { workspaceId: workspace.id, runId: previous.runId });
            if (!stale) setRun(saved);
          }
        } catch { /* Session storage is optional. */ }
      }
    })();
    return () => { stale = true; };
  }, [scope, reload]);
  const current = data?.scope === scope ? data : null;
  const choice = current?.choices.find((c) => c.key === selected);
  async function openOutput(path: string, resultRun: ResearchRunDto | null = run) {
    if (!resultRun) return;
    const requestScope = scope;
    setResult({ path });
    try {
      const value = await invoke<ReportPreview>("research_read_run_file", { workspaceId: workspace.id, runId: resultRun.id, path });
      if (scopeRef.current === requestScope) setResult({ path, value });
    } catch (reason) {
      if (scopeRef.current === requestScope) setResult({ path, error: String(reason) });
    }
  }
  async function execute() {
    if (!choice?.contract || !choice.entry || !current?.source || busyRef.current || running) return;
    busyRef.current = true; setBusy(true); setError(null);
    const context = scope;
    try {
      const planned = reproductionCommandFromContract(choice.contract, current.source.root, "独立输出目录", IS_WINDOWS);
      const approved = await confirmDialog(`将在工作区执行复现（不是打开终端让你改命令）：\n${current.source.root}\n来源版本：${current.source.resultVersion}\n\n${planned}\n\n约定输出写到 ~/ccode/reproductions/；脚本仍有工作目录访问权，不是只读沙箱。启动不代表验证通过。`, { confirmText: "确认运行", focusCancel: true });
      if (!approved || scopeRef.current !== context) return;
      const preview = await readResearchFile(current.source.root, choice.entry);
      if (preview.truncated || preview.revision !== choice.revision) throw new Error("复现入口已变化，请刷新后重新审阅");
      const next = await invoke<ResearchRunDto>("research_run_reproduce", {
        projectRoot: workspace.repoPath,
        sourceRunId,
        expectedSourceRevision: current.source.revision,
        workspaceId: workspace.id,
        worktreePath: workspace.worktreePath,
        entry: choice.entry,
        subcommand: choice.contract.subcommand,
        resultFile: choice.contract.resultFile,
      });
      if (scopeRef.current !== context) return;
      setRun(next);
      onRun?.(next);
      setResult(null);
      try { sessionStorage.setItem(sessionKey, JSON.stringify({ choiceKey: choice.key, runId: next.id })); } catch { /* optional */ }
      if (next.resultFile && next.outputs.includes(next.resultFile)) await openOutput(next.resultFile, next);
    } catch (reason) { if (scopeRef.current === context) setError(String(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function openLog() {
    if (!run) return;
    setPendingTerminal({
      cwd: workspace.worktreePath,
      extraEnv: {},
      title: `run: 复现 ${run.id}`,
      shellOnly: true,
      wsId: workspace.id,
    });
    onLaunched();
    setPage("terminal");
  }
  return <section aria-label="复现运行" className="my-3 rounded-md ccode-well p-3 text-xs">
    <div className="flex items-center justify-between"><h3 className="font-medium text-l1">复现运行</h3><button type="button" onClick={() => setReload((n) => n + 1)} disabled={busy} className="text-l3">刷新入口</button></div>
    {!current ? <p className="mt-2 text-l3">正在读取脚本…</p> : <>
      {!current.choices.length ? <p className="mt-2 text-l3">尚无可用复现入口。请按任务书交付带约定的脚本，或在项目 run 配置中声明。</p> : <>
        <label className="my-2 block text-l2">运行入口<select value={selected} disabled={busy} onChange={(e) => { setSelected(e.target.value); setResult(null); }} className="mt-1 w-full rounded border border-field bg-canvas p-1 text-xs">{current.choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
        {choice?.contract && <p className="my-2 break-all text-micro text-l4">入口 {choice.contract.entry} · 子命令 {choice.contract.subcommand ?? "（无）"} · 工作目录=输入项目 · 输出=独立目录 · 结果 {choice.contract.resultFile}。项目内配置的脚本仍只在终端执行，不走这条闭环。</p>}
        {choice?.configured && <p className="my-2 break-all font-mono text-micro text-l3">{choice.command}</p>}
        <button type="button" onClick={() => void execute()} disabled={busy || !!running || !choice?.contract || !current?.source} className="rounded border border-field px-2 py-1 text-l2 disabled:opacity-50">{busy ? "正在运行…" : running ? "已有脚本运行中" : "运行这次复现"}</button>
      </>}
      {current.warnings.length > 0 && <details className="mt-2 text-warn-text"><summary>入口提醒（{current.warnings.length}）</summary>{current.warnings.map((w, i) => <p key={i} className="break-all">{w}</p>)}</details>}
    </>}
    {run && <div className="mt-2 rounded border border-field p-2">
      <p className="text-l2">{statusLabel(run)}</p>
      <p className="break-all text-micro text-l4">来源版本：{run.resultVersion ?? "旧记录未绑定"} · 来源指纹：{run.sourceRevision?.slice(0, 12) ?? "未知"} · 结果指纹：{run.resultRevision?.slice(0, 12) ?? "未绑定"}</p>
      {run.sourceChanged && <InlineNotice tone="warn">运行期间来源已变化，这次不能作为原版本的验收证据。</InlineNotice>}
      <p className="break-all text-micro text-l4">运行 {run.id} · 代码 {run.entryRevision?.slice(0, 12) ?? "未知"} · 退出码 {run.exitCode ?? "无"}。这不是计算检查通过，也不是人工科研验收通过。</p>
      <p className="mt-1 break-all font-mono text-micro text-l3">{run.command.join(" ")}</p>
      {run.stderr && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-micro text-err-text">{run.stderr}</pre>}
      {run.outputs.length > 0 && <ul className="mt-1 space-y-1">{run.outputs.map((path) => <li key={path}><button type="button" className="break-all text-cta-pill-text hover:underline" onClick={() => void openOutput(path)}>本次输出：{path}</button></li>)}</ul>}
      <button type="button" className="mt-2 text-l3" onClick={openLog}>在终端查看工作区</button>
    </div>}
    {result && <div role="region" aria-label="复现文件预览" className="mt-2 rounded border border-field p-2">
      <div className="flex justify-between gap-2"><span className="break-all text-l2">{result.path}</span><button type="button" onClick={() => setResult(null)}>关闭预览</button></div>
      {result.error ? <p role="alert" className="text-err-text">{result.error}</p> : !result.value ? <p>正在读取…</p> : <>
        {result.value.truncated && <InlineNotice tone="warn">仅显示部分内容，不能据此判定完整。</InlineNotice>}
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-micro text-l2">{result.value.text}</pre>
      </>}
    </div>}
    {error && <InlineNotice tone="err" className="mt-2">{error}</InlineNotice>}
  </section>;
}
