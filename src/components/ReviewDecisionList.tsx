import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readResearchFile } from "../research-report-load";
import { researchAbsolutePath } from "../research-report";
import {
  applyReportVerdict,
  applyVerifyVerdict,
  inlineDecisionLine,
  parseReviewItems,
  reviewItemSummary,
  type ReviewItem,
  type ReviewItemKind,
  type ReviewVerdict,
} from "../review-decisions";
import { InlineNotice } from "./PageFrame";

async function readFirst(roots: string[], rel: string) {
  for (const root of roots) {
    try {
      const file = await readResearchFile(root, rel);
      if (!file.truncated) return { root, file };
    } catch {
      /* 试下一处 */
    }
  }
  return null;
}

const VERDICTS: ReviewVerdict[] = ["接受", "拒绝", "修改"];

export default function ReviewDecisionList({
  worktreePath,
  projectRoot,
  target,
  kind,
  onAllDecided,
  onOpenCount,
}: {
  worktreePath?: string | null;
  projectRoot: string;
  target: string;
  kind: ReviewItemKind;
  /** 每条都已决定后，人再点「让 Agent 按决定继续」。 */
  onAllDecided?: () => void;
  /** 还没决定的条数。0 表示可以勾上这一行。 */
  onOpenCount?: (count: number) => void;
}) {
  const roots = [...new Set([worktreePath, projectRoot].filter((p): p is string => Boolean(p)))];
  const rel = target.trim();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [fileRoot, setFileRoot] = useState(projectRoot);
  const [text, setText] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [acceptingAll, setAcceptingAll] = useState(false);

  async function load() {
    setError(null);
    if (!rel) {
      setItems([]);
      onOpenCount?.(1);
      setError("这一条没有落点文件。");
      return;
    }
    const found = await readFirst(roots, rel);
    if (!found) {
      setItems([]);
      onOpenCount?.(kind === "verify" ? 0 : 1);
      setError(inlineDecisionLine(kind, "empty"));
      return;
    }
    setFileRoot(found.root);
    setText(found.file.text);
    setRevision(found.file.revision);
    const parsed = parseReviewItems(found.file.text, kind);
    setItems(parsed);
    onOpenCount?.(parsed.filter((item) => item.verdict == null).length);
  }

  useEffect(() => {
    void load();
  }, [worktreePath, projectRoot, rel, kind]);

  async function choose(item: ReviewItem, verdict: ReviewVerdict) {
    if (!revision) return;
    const note = verdict === "修改" ? (drafts[item.id] ?? item.note).trim() : "";
    if (verdict === "修改" && !note) {
      setError(`${item.id} 选了修改，先写一句要改成什么样。`);
      return;
    }
    setBusyId(item.id);
    setError(null);
    try {
      const next =
        kind === "verify"
          ? applyVerifyVerdict(text, item.id, verdict, note)
          : applyReportVerdict(text, item.id, verdict, note);
      const nextRevision = await invoke<string>("save_file_preview", {
        path: researchAbsolutePath(fileRoot, rel),
        root: fileRoot,
        text: next,
        expectedRevision: revision,
      });
      setText(next);
      setRevision(nextRevision);
      const parsed = parseReviewItems(next, kind);
      setItems(parsed);
      onOpenCount?.(parsed.filter((item) => item.verdict == null).length);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function acceptAll() {
    if (!revision || !items) return;
    const pending = items.filter((item) => item.verdict == null);
    if (pending.length === 0) return;
    setAcceptingAll(true);
    setError(null);
    try {
      let next = text;
      for (const item of pending) {
        next =
          kind === "verify"
            ? applyVerifyVerdict(next, item.id, "接受")
            : applyReportVerdict(next, item.id, "接受");
      }
      const nextRevision = await invoke<string>("save_file_preview", {
        path: researchAbsolutePath(fileRoot, rel),
        root: fileRoot,
        text: next,
        expectedRevision: revision,
      });
      setText(next);
      setRevision(nextRevision);
      const parsed = parseReviewItems(next, kind);
      setItems(parsed);
      onOpenCount?.(parsed.filter((item) => item.verdict == null).length);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setAcceptingAll(false);
    }
  }

  if (items == null) return <p className="text-micro text-l4">加载条目…</p>;
  if (items.length === 0) return <p className="text-micro text-l4">{error}</p>;
  const open = items.filter((item) => item.verdict == null);
  const busy = acceptingAll || busyId != null;

  return (
    <div>
      {error && <InlineNotice tone="err" size="micro" className="mb-1">{error}</InlineNotice>}
      {open.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-micro text-l4">{inlineDecisionLine(kind, "done")}</p>
          <button
            type="button"
            onClick={() => onAllDecided?.()}
            className="rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text"
          >
            让 Agent 按决定继续
          </button>
        </div>
      ) : (
        <>
          <p className="mb-1 text-micro leading-5 text-l4">{inlineDecisionLine(kind, "open")}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void acceptAll()}
            className="mb-1 rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text disabled:opacity-50"
          >
            {acceptingAll ? "接受中…" : "全部接受"}
          </button>
        <ul className="max-h-72 space-y-2 overflow-auto">
          {open.map((item) => {
            const draft = drafts[item.id] ?? "";
            return (
              <li key={item.id} className="border-t border-hairline pt-2">
                <p className="text-xs leading-5 text-l1">
                  <span className="mr-1 text-l4">{item.id}</span>
                  {reviewItemSummary(item, kind)}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {VERDICTS.map((verdict) => (
                    <button
                      key={verdict}
                      type="button"
                      disabled={busy}
                      onClick={() => void choose(item, verdict)}
                      className={
                        verdict === "接受"
                          ? "rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text disabled:opacity-50"
                          : "rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover disabled:opacity-50"
                      }
                    >
                      {verdict}
                    </button>
                  ))}
                  <input
                    value={draft}
                    onChange={(event) =>
                      setDrafts((prev) => ({ ...prev, [item.id]: event.target.value }))
                    }
                    placeholder="修改时写一句"
                    className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-1.5 py-0.5 text-micro text-l2 outline-none placeholder:text-l4"
                  />
                </div>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </div>
  );
}
