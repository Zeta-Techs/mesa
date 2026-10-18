import { useEffect, useRef, useState } from "react";
import { loadResearchReports, readResearchFile, type ResearchReportLoad, type ReportPreview } from "../research-report-load";
import { evidenceFingerprint } from "../step-decisions";
import type { ResearchReportKind } from "../research-report";
import { InlineNotice } from "./PageFrame";

/** Shared read-only report viewer inside kickoff and review; report prose is never a machine verdict. */
export default function ResearchEvidencePanel({ root, patterns, kind, refreshKey = 0, onFingerprint }: {
  root: string; patterns: string[]; kind: ResearchReportKind; refreshKey?: number; onFingerprint?: (value: string | null) => void;
}) {
  const key = JSON.stringify([root, patterns, kind, refreshKey]);
  const activeKey = useRef(key);
  activeKey.current = key;
  useEffect(() => { activeKey.current = key; return () => { activeKey.current = ""; }; }, [key]);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: ResearchReportLoad } | null>(null);
  const [preview, setPreview] = useState<{ key: string; path: string; value?: ReportPreview; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setPreview(null);
    loadResearchReports(root, patterns, kind).then((value) => {
      if (!cancelled) {
        setLoaded({ key, value });
        onFingerprint?.(evidenceFingerprint(value.reports));
      }
    })
      .catch((reason) => {
        if (!cancelled) {
          setLoaded({ key, value: { reports: [], warnings: [String(reason)], scanned: 0, files: [] } });
          onFingerprint?.(null);
        }
      });
    return () => { cancelled = true; };
  }, [key, reload]); // key includes the full path contract, not array identity.
  const value = loaded?.key === key ? loaded.value : null;
  async function open(path: string) {
    setPreview({ key, path });
    try {
      const value = await readResearchFile(root, path);
      if (activeKey.current === key) setPreview((current) => current?.key === key && current.path === path ? { key, path, value } : current);
    } catch (reason) {
      if (activeKey.current === key) setPreview((current) => current?.key === key && current.path === path ? { key, path, error: String(reason) } : current);
    }
  }
  return <section aria-label={kind === "decision" ? "决策摘要" : "验收摘要与未决项"} className="my-3 rounded-md ccode-well p-3 text-xs">
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="font-medium text-l1">{kind === "decision" ? "先看方案，再决定" : "验收摘要与未决项"}</h3>
      <button type="button" className="text-l3 hover:text-l1" onClick={() => setReload((n) => n + 1)}>刷新摘要</button>
    </div>
    <p className="mb-2 text-micro text-l4">文件当前内容；状态为报告自述，未经系统质量认证。</p>
    {!value ? <p className="text-l3">正在读取报告…</p> : <>
      {!value.reports.length && <p className="text-l3">{kind === "decision" ? "未找到决策摘要或验收摘要。请先查看上游报告或让 Agent 补方案、证据、代价及等待边界；不会自动填入批准。" : "未找到验收摘要。文件已生成不代表通过，请查看原始报告及未决问题。"}</p>}
      {value.reports.map((report) => <article key={report.path} className="mb-3 last:mb-0">
        <button type="button" onClick={() => void open(report.path)} className="mb-1 break-all text-left text-cta-pill-text hover:underline">查看原文：{report.path}</button>
        {report.sections.map((section) => <details key={`${section.line}-${section.heading}`} open className="mb-1">
          <summary className="cursor-pointer text-l2">{section.heading} · 第{section.line}行{report.truncated ? "（不完整）" : ""}</summary>
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words font-sans leading-5 text-l2">{section.text}</pre>
        </details>)}
      </article>)}
      {value.files.some((path) => !value.reports.some((r) => r.path === path)) && <details className="mt-2 text-l3">
        <summary>其他报告（未识别到摘要标题）</summary>
        {value.files.filter((path) => !value.reports.some((r) => r.path === path)).map((path) => <button key={path} type="button" onClick={() => void open(path)} className="block break-all text-left text-cta-pill-text">查看原文：{path}</button>)}
      </details>}
      {value.warnings.length > 0 && <details className="mt-2 text-warn-text"><summary>读取提醒（{value.warnings.length}）</summary><ul>{value.warnings.map((w, i) => <li key={i} className="break-all">{w}</li>)}</ul></details>}
    </>}
    {preview?.key === key && <div className="mt-2 rounded border border-field p-2" role="region" aria-label="报告原文">
      <div className="flex items-start justify-between gap-2"><span className="break-all text-l2">{preview.path}</span><button type="button" onClick={() => setPreview(null)} className="shrink-0 text-l3">关闭原文</button></div>
      {preview.error ? <p className="text-err-text">{preview.error}</p> : !preview.value ? <p>正在读取…</p> : <>
        {preview.value.truncated && <InlineNotice tone="warn">内容截断，不能据此认定检查完整。</InlineNotice>}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-micro text-l2">{preview.value.text}</pre>
      </>}
    </div>}
  </section>;
}
