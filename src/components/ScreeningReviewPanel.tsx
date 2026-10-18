import { useEffect, useMemo, useState, type ReactNode } from "react";
import { readResearchLedger } from "../research-report-load";
import {
  parseIncludedRecords,
  screeningCountLine,
  screeningCounts,
  screeningSearchLog,
  type IncludedRecord,
} from "../screening-review";
import { countToFetchEntries } from "../step-flow";
import PendingConfirmList from "./PendingConfirmList";
import { InlineNotice } from "./PageFrame";

export default function ScreeningReviewPanel({
  root,
  projectRoot,
  onOpenPdf,
  onChanged,
  onPendingCleared,
  pane = "list",
  children,
}: {
  root: string;
  stepName?: string;
  projectRoot?: string;
  onOpenPdf?: (path: string) => void;
  onChanged?: () => void;
  /** 待确认已经全部纳入或排除。步骤卡用来自动勾上「核对待确认篇目」。 */
  onPendingCleared?: () => void;
  onOpenFile?: (path: string) => void;
  pane?: "list" | "process";
  children?: ReactNode;
}) {
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<IncludedRecord[] | null>(null);
  const [toFetch, setToFetch] = useState(0);
  const [searchLog, setSearchLog] = useState("");
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRecords(null);
    void (async () => {
      try {
        const [json, fetchMd, screening] = await Promise.all([
          readResearchLedger(root, "papers/included.json").catch(() => null),
          readResearchLedger(root, "papers/to-fetch.md").catch(() => null),
          readResearchLedger(root, "papers/screening.md").catch(() => null),
        ]);
        if (cancelled) return;
        if (!json) {
          setRecords([]);
          setError("未找到 papers/included.json。");
        } else {
          setRecords(parseIncludedRecords(json.text));
          if (json.truncated) setTruncated(true);
        }
        setToFetch(fetchMd ? countToFetchEntries(fetchMd.text) : 0);
        setSearchLog(screening ? screeningSearchLog(screening.text) : "");
        if (screening?.truncated) setTruncated(true);
      } catch (reason) {
        if (!cancelled) {
          setRecords([]);
          setError(String(reason));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, reload]);

  const counts = useMemo(
    () => screeningCounts(records ?? [], toFetch),
    [records, toFetch],
  );

  return (
    <section aria-label="筛选结果" className="px-4 py-3 text-sm">
      {records == null ? (
        <p className="text-l3">正在读取纳入清单…</p>
      ) : pane === "process" ? (
        <>
          <h4 className="font-medium text-l1">检索过程</h4>
          <p className="mt-1 text-xs text-l4">查了哪些库、命中多少、留下多少。</p>
          {searchLog ? (
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-5 text-l3">
              {searchLog}
            </pre>
          ) : (
            <p className="mt-2 text-xs text-l4">筛选记录里没有检索日志。完整经过在「文件」里的 screening.md。</p>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-l2">{screeningCountLine(counts)}</p>
            <button type="button" className="shrink-0 text-xs text-l3 hover:text-l1" onClick={() => setReload((n) => n + 1)}>
              刷新
            </button>
          </div>
          {truncated && <InlineNotice tone="warn" className="mt-1">清单截断，摘要可能不完整。</InlineNotice>}
          {error && <InlineNotice tone="warn" className="mt-1">{error}</InlineNotice>}
          <p className="mt-3 text-xs text-l4">待确认可以纳入或排除。已纳入不想要就点移出。</p>
          {records.length > 0 && (
            <div className="mt-2">
              <PendingConfirmList
                fill
                worktreePath={root}
                projectRoot={projectRoot || root}
                onOpenPdf={onOpenPdf}
                onChanged={() => {
                  setReload((n) => n + 1);
                  onChanged?.();
                }}
                onCleared={onPendingCleared}
              />
            </div>
          )}
          {children}
        </>
      )}
    </section>
  );
}
