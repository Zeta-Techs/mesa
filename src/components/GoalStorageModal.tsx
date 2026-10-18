import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TaskStorageReviewDto } from "../types";
import { Modal } from "./Modal";
import { confirmDialog } from "./ConfirmDialog";
import { primaryActionClass, secondaryActionClass, InlineNotice } from "./PageFrame";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** 只有显式打开时扫描磁盘，列表轮询不递归统计副本。 */
export default function GoalStorageModal({ taskId, onClose, onChanged }: {
  taskId: string; onClose: () => void; onChanged: () => void;
}) {
  const [review, setReview] = useState<TaskStorageReviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setReview(await invoke<TaskStorageReviewDto>("task_storage_review", { taskId })); }
    catch (error) { setReview(null); setError(`无法核对副本，未清理：${String(error)}`); }
    finally { setLoading(false); }
  }, [taskId]);
  useEffect(() => { void load(); }, [load]);

  async function clean(scope: "workspace" | "review") {
    if (!review || busy || loading) return;
    const usage = scope === "workspace" ? review.workspace : review.review;
    const effect = scope === "workspace"
      ? "删除这个目标所有工作副本（含复制的输入和未采纳成果）。之后不能从旧副本或旧会话续跑，只能从当前项目重新开始。历史冻结版本暂时保留。"
      : "永久删除这个目标的历史冻结版本、上下文副本及写回前备份；旧版将无法预览、重新采纳或恢复。";
    const ok = await confirmDialog(`${review.pending ? "继续原来的清理操作。" : ""}将清理约 ${size(usage.bytes)}（${usage.files} 个文件）。\n\n${effect}\n\n不删除主项目文件、目标记录或接受账本；归档不等于清理。此操作不能撤销。`,
      { danger: true, focusCancel: true, confirmText: review.pending ? "继续清理" : "确认清理" });
    if (!ok) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      setReview(await invoke<TaskStorageReviewDto>("task_cleanup", {
        taskId, scope, revision: review.revision, operationId: review.pending?.id ?? null, confirmed: true,
      }));
      setNotice(scope === "workspace" ? "工作副本已清理；项目成果和接受记录保留。" : "历史版本与恢复备份已清理；项目成果和接受记录保留。");
      onChanged();
    } catch (error) {
      setError(`清理未完成：${String(error)}`);
      try { setReview(await invoke<TaskStorageReviewDto>("task_storage_review", { taskId })); }
      catch { setReview(null); }
      onChanged();
    } finally { setBusy(false); }
  }

  return <Modal open title="释放副本空间" onClose={() => { if (!busy) onClose(); }} size="md" dismissOnBackdrop={!busy}>
    <div className="space-y-4 text-xs">
      <p className="text-l3">仅清理这个目标的内部副本，主项目成果、目标和接受记录始终保留。占用按文件内容统计，实际释放空间可能不同。</p>
      {loading && <p role="status" className="text-l3">统计并核对副本…</p>}
      {error && <InlineNotice tone="err">{error}</InlineNotice>}
      {notice && <p role="status" className="text-l3">{notice}</p>}
      {!loading && review && <>
        {review.blockedReason && <InlineNotice tone="warn">{review.blockedReason}</InlineNotice>}
        {review.pending && <div className="space-y-2 rounded-md border border-field p-3">
          <p>有未完成的{review.pending.scope === "workspace" ? "工作副本" : "历史版本"}清理。请继续原操作；完成前不能启动或返修。</p>
          <button type="button" className={primaryActionClass} disabled={busy || !!review.blockedReason}
            onClick={() => void clean(review.pending!.scope)}>继续清理</button>
        </div>}
        {(["workspace", "review"] as const).map((scope) => {
          const usage = scope === "workspace" ? review.workspace : review.review;
          const reason = scope === "workspace" ? review.blockedReason : review.reviewBlockedReason;
          return <section key={scope} className="space-y-2 rounded-md border border-field p-3">
            <h3 className="font-medium text-l1">{scope === "workspace" ? "工作副本" : "历史版本与恢复备份"} · {size(usage.bytes)}</h3>
            <p className="text-l3">{usage.files} 个文件。{scope === "workspace"
              ? "清理后不再从旧副本续跑；可从当前项目重新开始。未采纳成果也会删除。"
              : "包括冻结产物、上下文和写回前备份。清理后不能查看或恢复旧版。"}</p>
            {reason && reason !== review.blockedReason && <p className="text-l3">{reason}</p>}
            <button type="button" className={secondaryActionClass}
              disabled={busy || !!review.pending || !!reason || usage.directories === 0}
              onClick={() => void clean(scope)}>{scope === "workspace" ? "清理工作副本" : "删除历史版本与备份"}</button>
          </section>;
        })}
      </>}
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryActionClass} disabled={busy || loading} onClick={() => void load()}>刷新占用</button>
        <button type="button" className={secondaryActionClass} disabled={busy} onClick={onClose}>{busy ? "清理中…" : "关闭"}</button>
      </div>
    </div>
  </Modal>;
}
