import { useMemo, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import { secondaryActionClass, NoticeBar } from "./PageFrame";
import { watchAdoptText, watchLedgerFailed } from "../acceptance-log";
import { journalMetricTone } from "../lit-watch";
import type { RunDto } from "../types";

interface WatchReviewEntry {
  id: string;
  title: string;
  authors: string;
  journal: string;
  pubDate: string | null;
  url: string;
  relevance: string;
  zhSummary: string;
  impactFactor: string | null;
  casQuartile: number | null;
  top: boolean;
  decision: string;
}

interface SnapshotFile {
  path: string;
  before: string | null;
  initial: string | null;
  after: string | null;
}
interface Snapshot { runId: string; files: SnapshotFile[] }

/** 定时历史只能展示冻结证据；当前工作目录是另外一个明确标注的入口。 */
export default function WatchRunReview({ run, onClose, locked = false, currentDirectory: _currentDirectory }: {
  run: RunDto;
  onClose: () => void;
  currentDirectory: ReactNode;
  /** 这次已经采纳进课题：只查看，不能再改纳入或排除 */
  locked?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 已采纳的运行重开也要呈现定稿状态：locked 来自历史记录的 adopted，本地态只负责本次会话内点击后的即时变化
  const [adopted, setAdopted] = useState(locked);
  const [adoptedNote, setAdoptedNote] = useState<string | null>(null);
  const [ledgerPending, setLedgerPending] = useState(false);
  const [entries, setEntries] = useState<WatchReviewEntry[] | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(true);
  useEffect(() => {
    let cancelled = false;
    invoke<WatchReviewEntry[]>("watch_run_entries", { runId: run.id })
      .then((rows) => { if (!cancelled) setEntries(rows); })
      .catch((reason) => {
        if (cancelled) return;
        const message = String(reason);
        // 没跑成、或旧记录没有冻结收件箱：不是故障，列表留空
        if (message.includes("没有冻结产物")) setEntries([]);
        else setEntryError(message);
      });
    return () => { cancelled = true; };
  }, [run.id]);
  const counts = useMemo(() => {
    const rows = entries ?? [];
    return {
      all: rows.length,
      included: rows.filter((row) => row.decision === "included").length,
      excluded: rows.filter((row) => row.decision === "excluded").length,
    };
  }, [entries]);
  const shown = (entries ?? []).filter((row) => !onlyOpen || row.decision === "");
  async function decide(entry: WatchReviewEntry, decision: string) {
    if (deciding) return;
    setDeciding(entry.id);
    setEntryError(null);
    try {
      await invoke("watch_run_decide", { runId: run.id, entryId: entry.id, decision });
      setEntries((cur) =>
        cur?.map((row) => (row.id === entry.id ? { ...row, decision } : row)) ?? cur,
      );
    } catch (reason) {
      setEntryError(String(reason));
    } finally {
      setDeciding(null);
    }
  }
  useEffect(() => {
    let cancelled = false;
    invoke<Snapshot>("watch_run_snapshot", { runId: run.id })
      .then((value) => { if (!cancelled) setSnapshot(value); })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [run.id]);
  const changed = snapshot?.files.filter((file) => file.initial !== file.after) ?? [];
  async function adopt(retry = false) {
    if (busy || !snapshot || (adopted && !ledgerPending)) return;
    if (
      !retry &&
      !(await confirmDialog(
        counts.excluded > 0
          ? `将这次运行的产物采纳进项目？你排除的 ${counts.excluded} 篇不会写入（它的待获取题录和免费全文也不进），其余新命中接在项目雷达收件箱后面（日常积累，不进科研流程的精读清单）。项目里已有的内容不动，已收过的同一篇不重复加；保存前检查保护路径并备份原文件。`
          : "将这次运行的产物采纳进项目？新命中接在项目雷达收件箱后面（日常积累，不进科研流程的精读清单）。项目里已有的内容不动，已收过的同一篇不重复加；保存前检查保护路径并备份原文件。",
        { confirmText: "采纳进项目" },
      ))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await invoke<string[]>("adopt_watch_run", { runId: run.id });
      setAdopted(true);
      setLedgerPending(false);
      setAdoptedNote(
        `已采纳：新命中进入项目页「文献雷达」的清单，这次新下的 PDF 进 papers/。被排除的条目没有写入。项目里若有进行中的科研流程，PDF 的资源登记会在流程收尾后自动补记，不会卡它的合并。`,
      );
    } catch (reason) {
      const message = String(reason);
      if (watchLedgerFailed(message)) {
        setAdopted(true);
        setLedgerPending(true);
        setError(watchAdoptText(false));
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3 text-sm">
        <button type="button" onClick={onClose} disabled={busy} className="rounded-sm px-2 py-1 text-l2 hover:bg-hover">返回</button>
        <span className="min-w-0 flex-1 text-l1">本次定时任务 · 命中评审</span>
        {ledgerPending && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void adopt(true)}
            className={secondaryActionClass}
          >
            {busy ? "记录中…" : "再记录验收"}
          </button>
        )}
        {!ledgerPending && locked && (
          <span
            className="rounded-sm border border-hairline px-3 py-1 text-xs text-l3"
            title="这次运行的产物已经采纳进项目；这里只回看当时的命中与你的决定"
          >
            已采纳 · 只读回看
          </span>
        )}
        {!ledgerPending && !locked && (
          <button type="button" disabled={busy || adopted || !snapshot || run.status !== "completed" || changed.length === 0}
            onClick={() => void adopt()} className="rounded-sm border border-cta-bd bg-cta px-3 py-1 text-cta-text disabled:opacity-50">
            {busy ? "正在采纳…" : adopted ? "已采纳" : "采纳进项目"}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-l3">
          <span>本次新命中 {counts.all} 篇 · 留下 {counts.included} · 排除 {counts.excluded} · 未定 {counts.all - counts.included - counts.excluded}</span>
          <button type="button" className="hover:text-l1" onClick={() => setOnlyOpen((v) => !v)}>
            {onlyOpen ? "显示已定的" : "只看未定"}
          </button>
          <span className="text-l4">排除的不会写进项目；留下是你的标记，未定与留下的一起进项目的雷达收件箱。雷达只是日常积累，不进科研流程的精读清单。</span>
        </div>
        {adoptedNote && <NoticeBar className="mb-3">{adoptedNote}</NoticeBar>}
        {entryError && <NoticeBar tone="err" className="mb-3">{entryError}</NoticeBar>}
        {error && <NoticeBar tone="err" className="mb-3" onDismiss={() => setError(null)}>{error}</NoticeBar>}
        {entries == null && !entryError && <p className="text-sm text-l3">正在读取这次巡检的命中…</p>}
        {entries != null && shown.length === 0 && !error && (
          <p className="text-sm text-l3">
            {run.status !== "completed"
              ? `这次运行没有跑完（${run.status === "stopped" ? "已停止" : run.status === "failed" ? "失败" : run.status}），没有可评审的命中。`
              : counts.all === 0
                ? "这次巡检没有新命中。"
                : "未定的已经看完。"}
          </p>
        )}
        <ul className="space-y-2">
          {shown.map((entry) => (
            <li key={entry.id} className="rounded-md border border-hairline px-3 py-2">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-5 text-l1">{entry.title}</p>
                  <p className="mt-0.5 text-micro text-l3">
                    {[entry.authors, entry.journal, entry.pubDate?.trim() || null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {entry.zhSummary && <p className="mt-1 text-xs leading-5 text-l3">{entry.zhSummary}</p>}
                </div>
                <span className="flex shrink-0 flex-wrap items-center gap-1">
                  {entry.relevance === "推荐" && (
                    <span className="rounded-full bg-cta-pill px-1.5 py-px text-micro text-cta-pill-text">推荐</span>
                  )}
                  {entry.impactFactor && (
                    <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("if")}`}>IF {entry.impactFactor}</span>
                  )}
                  {entry.casQuartile != null && (
                    <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("quartile", entry.casQuartile)}`}>{entry.casQuartile}区</span>
                  )}
                  {entry.top && (
                    <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("top")}`}>TOP</span>
                  )}
                  {!entry.impactFactor && entry.casQuartile == null && (
                    <span className="text-micro text-l4">指标未收录</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {entry.decision === "included" && <span className="text-micro text-ok-text">已留下</span>}
                  {entry.decision === "excluded" && <span className="text-micro text-l4">已排除</span>}
                  {!locked && (
                    <>
                      <button
                        type="button"
                        disabled={deciding === entry.id}
                        onClick={() => void decide(entry, entry.decision === "included" ? "" : "included")}
                        className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text disabled:opacity-50"
                      >
                        {entry.decision === "included" ? "撤销留下" : "留下"}
                      </button>
                      <button
                        type="button"
                        disabled={deciding === entry.id}
                        onClick={() => void decide(entry, entry.decision === "excluded" ? "" : "excluded")}
                        className="rounded-sm border border-field px-2 py-1 text-xs text-l2 hover:bg-hover disabled:opacity-50"
                      >
                        {entry.decision === "excluded" ? "撤销排除" : "排除"}
                      </button>
                    </>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
