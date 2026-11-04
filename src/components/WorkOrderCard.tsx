import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { compactFieldClass, ghostActionClass, primaryActionClass } from "./PageFrame";
import { dispatchStatus, type DispatchRecord, type DispatchTone } from "../assistant-dispatch";
import { relTime } from "../rel-time";
import type { WorkOrder } from "../project-assistant";

const TONE_CLASS: Record<DispatchTone, string> = {
  wait: "text-warn-text",
  live: "text-ok-text",
  done: "text-cta",
  fail: "text-err-text",
  idle: "text-l3",
};

/**
 * 项目助手起草的派活单（2026-11-04 用户拍板「它起草、你点一下就派」）：看清交给谁、要做什么、怎样算做完，
 * 能就地改一改，点「派出去」才开工。派过的记在问答记录那一轮上（不再派第二次），卡片每 10 秒看一次进度：
 * 还没送到（对方停在等确认 / 对话关了）/ 在做 / 做完等评审 / 做完等验收 / 已保存进项目。项目助手自己不碰文件。
 */
export default function WorkOrderCard({
  order,
  record,
  projectPath,
  onDispatch,
}: {
  order: WorkOrder;
  /** 派过了的记录；没派为 null */
  record: DispatchRecord | null;
  projectPath: string | null;
  onDispatch: (order: WorkOrder) => Promise<void>;
}) {
  const [draft, setDraft] = useState<WorkOrder>(order);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: DispatchTone } | null>(null);
  const shown = record ? { ...draft, title: record.title } : draft;
  const to = shown.target === "step" ? `第 ${shown.step} 步的 AI` : "新目标（隔离副本里做，做完验收）";

  useEffect(() => {
    if (!record || !projectPath) return;
    let stale = false;
    const load = () =>
      void dispatchStatus(record, projectPath)
        .then((s) => {
          if (!stale) setStatus(s);
        })
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [record, projectPath]);

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
      {editing && !record ? (
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
          <p className="font-medium text-l1">{shown.title}</p>
          <p className="whitespace-pre-wrap break-words text-l2">{shown.task}</p>
          {shown.done && (
            <p className="whitespace-pre-wrap break-words text-l3">
              <span className="text-l3">怎样算做完：</span>
              {shown.done}
            </p>
          )}
        </div>
      )}
      {error && <p className="mt-2 break-words text-xs text-err-text">没派出去：{error}</p>}
      <div className="mt-3 flex min-w-0 items-center gap-2">
        {record ? (
          <div className="min-w-0 text-xs leading-5">
            <p className="text-l3">
              {relTime(record.at)}派出 · {record.mode === "mail" ? "留话给开着的 AI" : record.mode === "resume" ? "接回那一步的对话开跑" : "记成目标开工"}
            </p>
            <p className={status ? TONE_CLASS[status.tone] : "text-l3"}>现在：{status?.text ?? "正在看…"}</p>
          </div>
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
