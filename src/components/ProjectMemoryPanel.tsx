import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import type { KnowledgeForAiDto } from "../types";
import {
  FoldMark,
  ghostActionClass,
  secondaryActionClass,
  surfaceFieldClass,
  InlineNotice,
} from "./PageFrame";

type Entry = {
  meta: { id: string; createdAt: string; goalName: string; sourceVersion: string | null; state: string; replaces: string | null; reason: string };
  text: string;
  stalePaths: string[];
};
type Document = { revision: string; legacyText: string; entries: Entry[] };

/** 与后端 research_profile::CATEGORIES 同序（提升时选分类用） */
const RESEARCH_PROFILE_CATEGORIES = ["研究方向", "常用方法", "数据处理习惯", "写作偏好", "导师意见", "放弃的方向", "其他"];

/** 危险向 ghost：平时与普通行内钮同灰，悬停才转红（作废一类带确认的低频动作）。 */
const dangerGhostActionClass =
  "inline-flex h-7 items-center rounded-md px-2 text-xs text-l3 transition-colors hover:bg-hover hover:text-err-text disabled:opacity-50";

/** 项目长期知识：与抽屉内其他分区同一折叠 idiom，默认收起、摘要给有效条数。 */
export default function ProjectMemoryPanel({ projectPath }: { projectPath: string }) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 提升到研究档案（2026-11-02）：适用于所有项目的条目复制进用户层档案，分类由人选
  const [promoting, setPromoting] = useState<string | null>(null);
  const [promoteCategory, setPromoteCategory] = useState("常用方法");
  const [promoted, setPromoted] = useState<string | null>(null);
  // 交给 AI 的那一份（2026-11-08，后端 project_memory_for_ai，任务书 / 开对话 / 项目助手同一份）：带了几条、几条太长没带上、看原文
  const [forAi, setForAi] = useState<KnowledgeForAiDto | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  useEffect(() => {
    if (!doc) return;
    let stale = false;
    invoke<KnowledgeForAiDto>("project_memory_for_ai", { path: projectPath })
      .then((value) => { if (!stale) setForAi(value); })
      .catch(() => { if (!stale) setForAi(null); });
    return () => { stale = true; };
  }, [projectPath, doc]);
  useEffect(() => {
    let stale = false;
    setDoc(null); setError(null); setEditing(null); setText(""); setReason("");
    invoke<Document>("project_memory_read", { path: projectPath })
      .then((value) => { if (!stale) setDoc(value); })
      .catch((e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [projectPath, reload]);
  async function save(action: "add" | "replace" | "revoke" | "archive_legacy", id: string | null) {
    if (!doc || busy) return;
    if (!reason.trim()) { setError("请写明确认或作废的依据"); return; }
    if ((action === "revoke" || action === "archive_legacy") && !await confirmDialog("作废这条项目知识？历史仍保留，之后开工不再把它当作有效结论。", { focusCancel: true })) return;
    setBusy(true); setError(null);
    try {
      setDoc(await invoke<Document>("project_memory_update", { path: projectPath, expectedRevision: doc.revision, id, action, text, reason }));
      setText(""); setReason(""); setEditing(null);
    } catch (e) {
      setError(String(e));
    }
    finally { setBusy(false); }
  }
  async function promote(entry: Entry) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const profile = await invoke<{ doc: { revision: string } }>("research_profile_read");
      const project = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
      await invoke("research_profile_update", {
        expectedRevision: profile.doc.revision,
        id: null,
        action: "add",
        category: promoteCategory,
        text: entry.text,
        reason: `从项目「${project}」的长期知识提升（原依据：${entry.meta.reason}）`,
      });
      setPromoting(null);
      setPromoted(entry.meta.id);
    } catch (e) {
      setError(String(e));
    } finally { setBusy(false); }
  }
  const activeEntries = doc?.entries.filter((e) => e.meta.state === "active") ?? [];
  const hasHistory = !!doc?.entries.some((e) => e.meta.state !== "active");
  const summary = error
    ? "读取失败"
    : doc == null
      ? "读取中…"
      : activeEntries.length
        ? `${activeEntries.length} 条`
        : "还没有";
  return (
    <section aria-label="项目长期知识">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <FoldMark open={open} />
        <span className="text-xs font-medium text-l3">项目长期知识</span>
        <span className="min-w-0 flex-1 truncate text-micro text-l4">{summary}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg ccode-well p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-xs leading-5 text-l3">
              只保存你确认的结论；修订和作废保留原记录。
            </p>
            <button type="button" className={`${ghostActionClass} shrink-0`} disabled={busy} onClick={() => setReload((n) => n + 1)}>重新读取</button>
          </div>
          {forAi && (activeEntries.length > 0 || !!doc?.legacyText) && (
            <div className="text-xs leading-5">
              <p className="text-l3">
                交给 AI：{forAi.included} 条（流程每一步、开对话、项目助手拿到的是同一份；「已定 / 不做」排前）
                {forAi.omitted > 0 && <span className="text-warn-text">；{forAi.omitted} 条超出字数上限没带上——作废过时的、或把几条合成一条</span>}
                {forAi.stale > 0 && <span className="text-warn-text">；{forAi.stale} 条来源变了，重新确认前不带</span>}
                <button type="button" className="ml-2 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1" onClick={() => setRawOpen((v) => !v)}>
                  <span className="text-xs">{rawOpen ? "收起" : "看 AI 拿到的原文"}</span>
                </button>
              </p>
              {rawOpen && (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md ccode-well p-2 text-xs leading-5 text-l2">
                  {forAi.lines.length ? forAi.lines.map((l) => `- ${l}`).join("\n") : "（现在没有要交给 AI 的条目）"}
                </pre>
              )}
            </div>
          )}
          {activeEntries.map((entry) => <article key={entry.meta.id} className="rounded-lg ccode-well p-2">
            <p className="whitespace-pre-wrap text-xs leading-5 text-l2">{entry.text}</p>
            <p className="mt-1 break-all text-micro text-l4">{entry.meta.goalName} · {entry.meta.createdAt} · {entry.meta.sourceVersion ?? "人工确认"}</p>
            {forAi?.omittedIds.includes(entry.meta.id) && <p className="mt-0.5 text-xs leading-5 text-warn-text">超出字数上限，这条现在没交给 AI</p>}
            {!!entry.stalePaths.length && <p className="mt-0.5 text-xs leading-5 text-warn-text">来源已变化或无法在预算内确认，当前不作为有效结论：{entry.stalePaths.join("、")}</p>}
            <div className="mt-1.5 flex gap-1">
              <button type="button" className={ghostActionClass} disabled={busy} onClick={() => { setEditing(entry.meta.id); setText(entry.text); setReason(""); }}>修订 / 重新确认</button>
              <button type="button" className={dangerGhostActionClass} disabled={busy} onClick={() => void save("revoke", entry.meta.id)}>作废</button>
              {promoted === entry.meta.id
                ? <span className="inline-flex h-7 items-center px-2 text-xs text-l4">已提升到研究档案</span>
                : <button type="button" className={ghostActionClass} disabled={busy} title="这条适用于你所有项目时，复制进设置里的「研究档案」，以后开新项目 Agent 也会带上" onClick={() => setPromoting(promoting === entry.meta.id ? null : entry.meta.id)}>提升到研究档案</button>}
            </div>
            {promoting === entry.meta.id && <div className="mt-1 flex items-center gap-1.5 text-xs">
              <span className="text-l3">放进</span>
              <select aria-label="研究档案分类" value={promoteCategory} onChange={(e) => setPromoteCategory(e.target.value)} className="rounded-sm border border-field bg-canvas px-1.5 py-0.5 text-xs text-l2">
                {RESEARCH_PROFILE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
              <button type="button" className={secondaryActionClass} disabled={busy} onClick={() => void promote(entry)}>确认提升</button>
            </div>}
          </article>)}
          {!!doc?.legacyText && (
            <div className="pt-1">
              <button
                type="button"
                className="flex min-h-8 w-full items-center gap-1.5 text-left"
                onClick={() => setLegacyOpen((current) => !current)}
                aria-expanded={legacyOpen}
              >
                <FoldMark open={legacyOpen} />
                <span className="flex-1 text-xs font-medium text-l2">旧知识原文（未绑定版本）</span>
              </button>
              {legacyOpen && (
                <div className="mt-1 space-y-2">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md ccode-well p-2 text-xs leading-5 text-l2">{doc.legacyText}</pre>
                  <button type="button" className={dangerGhostActionClass} disabled={busy} onClick={() => void save("archive_legacy", null)}>停止带入旧知识（保留历史）</button>
                </div>
              )}
            </div>
          )}
          {hasHistory && (
            <div className="pt-1">
              <button
                type="button"
                className="flex min-h-8 w-full items-center gap-1.5 text-left"
                onClick={() => setHistoryOpen((current) => !current)}
                aria-expanded={historyOpen}
              >
                <FoldMark open={historyOpen} />
                <span className="flex-1 text-xs font-medium text-l2">历史与作废条目</span>
              </button>
              {historyOpen && (
                <div className="mt-1 space-y-1">
                  {doc?.entries.filter((e) => e.meta.state !== "active").map((entry) => <p key={entry.meta.id} className="text-xs leading-5 text-l3">{entry.meta.state === "revoked" ? "已作废" : "已替代"}：{entry.text}；依据：{entry.meta.reason}</p>)}
                </div>
              )}
            </div>
          )}
          <div className="space-y-2 pt-1">
            <label className="block text-xs text-l3">{editing ? "修订后的结论" : "新增人工确认的结论"}<textarea className={`${surfaceFieldClass} mt-1 resize-none leading-6`} rows={3} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} /></label>
            <label className="block text-xs text-l3">确认 / 作废依据<input className={`${surfaceFieldClass} mt-1`} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label>
            <div className="flex items-center gap-2">
              <button type="button" className={secondaryActionClass} disabled={busy || !doc || !text.trim() || !reason.trim()} onClick={() => void save(editing ? "replace" : "add", editing)}>{busy ? "保存中…" : editing ? "确认替代旧结论" : "确认新增"}</button>
              {editing && <button type="button" className={ghostActionClass} disabled={busy} onClick={() => { setEditing(null); setText(""); }}>取消修订</button>}
            </div>
            {error && <InlineNotice tone="err">{error}</InlineNotice>}
          </div>
        </div>
      )}
    </section>
  );
}
