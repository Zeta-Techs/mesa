import { useState } from "react";
import { Check, Send } from "lucide-react";
import { compactFieldClass, ghostActionClass, primaryActionClass } from "./PageFrame";
import type { WorkOrder } from "../project-assistant";

/**
 * 项目助手起草的派活单（2026-11-04 用户拍板「它起草、你点一下就派」）：看清交给谁、要做什么、怎样算做完，
 * 能就地改一改，点「派出去」才开工；派过的记在本机（同一张不会派两次）。项目助手自己不碰文件。
 */
export default function WorkOrderCard({
  order,
  sentNote,
  onDispatch,
}: {
  order: WorkOrder;
  /** 已派出时的那句（「已留话给第 2 步的 AI」）；没派为 null */
  sentNote: string | null;
  onDispatch: (order: WorkOrder) => Promise<void>;
}) {
  const [draft, setDraft] = useState<WorkOrder>(order);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const to = draft.target === "step" ? `第 ${draft.step} 步的 AI` : "新目标（隔离副本里做，做完验收）";

  async function dispatch() {
    if (!draft.task.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onDispatch({ ...draft, title: draft.title.trim() || draft.task.trim().slice(0, 40) });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-3 rounded-xl border border-hairline p-3" aria-label="派活单">
      <div className="mb-2 flex items-center gap-2 text-xs text-l3">
        <span className="h-[3px] w-2.5 shrink-0 rounded-sm bg-mesa-amber" aria-hidden="true" />
        <span className="font-medium text-l2">派活单</span>
        <span>· 交给{to}</span>
      </div>
      {editing ? (
        <div className="space-y-2">
          <input
            className={`${compactFieldClass} w-full`}
            value={draft.title}
            maxLength={80}
            aria-label="标题"
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <label className="block">
            <span className="mb-1 block text-xs text-l3">要做</span>
            <textarea
              className={`${compactFieldClass} min-h-20 w-full resize-y py-1.5`}
              value={draft.task}
              maxLength={4000}
              onChange={(e) => setDraft({ ...draft, task: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-l3">怎样算做完</span>
            <textarea
              className={`${compactFieldClass} min-h-12 w-full resize-y py-1.5`}
              value={draft.done}
              maxLength={2000}
              onChange={(e) => setDraft({ ...draft, done: e.target.value })}
            />
          </label>
        </div>
      ) : (
        <div className="space-y-1.5 text-sm leading-6">
          <p className="font-medium text-l1">{draft.title}</p>
          <p className="whitespace-pre-wrap break-words text-l2">{draft.task}</p>
          {draft.done && (
            <p className="whitespace-pre-wrap break-words text-l3">
              <span className="text-l3">怎样算做完：</span>
              {draft.done}
            </p>
          )}
        </div>
      )}
      {error && <p className="mt-2 break-words text-xs text-err-text">没派出去：{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        {sentNote ? (
          <span className="flex items-center gap-1.5 text-xs text-ok-text">
            <Check size={13} strokeWidth={2} aria-hidden="true" />
            {sentNote}
          </span>
        ) : (
          <>
            <button type="button" className={`${primaryActionClass} gap-1.5`} disabled={busy || !draft.task.trim()} onClick={() => void dispatch()}>
              <Send size={13} strokeWidth={1.8} aria-hidden="true" />
              {busy ? "派出中…" : "派出去"}
            </button>
            <button type="button" className={ghostActionClass} disabled={busy} onClick={() => setEditing((v) => !v)}>
              {editing ? "改好了" : "改一改"}
            </button>
            <span className="min-w-0 truncate text-micro text-l4">点了才开工；做完照常评审 / 验收</span>
          </>
        )}
      </div>
    </section>
  );
}
