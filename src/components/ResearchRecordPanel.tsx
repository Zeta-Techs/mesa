import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { RESEARCH_EXPORTS, runRecordLine, type ResearchExportKind, type RunRecordDto } from "../research-record";
import { absTime, relTime } from "../rel-time";
import { FoldMark } from "./PageFrame";

const RECENT = 30;

/** 项目设置「规则与验收」里的研究记录：每次 AI 运行一行，下面三颗导出按钮。没有记录时整块不出现 */
export default function ResearchRecordPanel({ projectPath }: { projectPath: string }) {
  const [runs, setRuns] = useState<RunRecordDto[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ResearchExportKind | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    invoke<{ runs: RunRecordDto[] }>("research_record_read", { path: projectPath })
      .then((dto) => {
        if (!stale) setRuns(dto.runs);
      })
      .catch(() => {
        if (!stale) setRuns([]);
      });
    return () => {
      stale = true;
    };
  }, [projectPath]);
  if (runs.length === 0) return null;
  const exportOne = async (kind: ResearchExportKind) => {
    setBusy(kind);
    setError(null);
    setDone(null);
    try {
      setDone(await invoke<string>("research_export", { path: projectPath, kind }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-3 text-xs">
      <button
        type="button"
        className="flex items-center gap-1.5 font-medium text-l3 hover:text-l1"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <FoldMark open={open} />
        研究记录
        <span className="font-normal text-l4">{runs.length}</span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1">
          {runs.slice(0, RECENT).map((run) => {
            const line = runRecordLine(run);
            return (
              <li key={run.runId} className="rounded-md px-1.5 py-1 hover:bg-hover">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-l2" title={line.meta}>
                    {line.title}
                    <span className="text-l4"> · {line.meta}</span>
                  </span>
                  {line.flag && <span className="shrink-0 text-micro text-warn-text">{line.flag}</span>}
                  <span className="shrink-0 text-micro text-l4" title={absTime(run.createdAt)}>
                    {relTime(run.createdAt)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-micro text-l4">导出</span>
        {RESEARCH_EXPORTS.map((item) => (
          <button
            key={item.kind}
            type="button"
            disabled={busy !== null}
            title={item.hint}
            onClick={() => void exportOne(item.kind)}
            className="rounded-md border border-hairline px-1.5 py-0.5 text-micro text-l2 hover:bg-hover disabled:opacity-50"
          >
            {busy === item.kind ? "导出中…" : item.label}
          </button>
        ))}
      </div>
      {done && (
        <p className="mt-1 text-micro text-l3">
          已导出到下载文件夹：
          <button type="button" className="underline hover:text-l1" onClick={() => void revealItemInDir(done)}>
            {done.split(/[\\/]/).pop()}
          </button>
        </p>
      )}
      {error && <p className="mt-1 text-micro text-err-text">{error}</p>}
    </div>
  );
}
