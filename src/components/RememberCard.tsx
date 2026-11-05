import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookmarkPlus } from "lucide-react";
import { compactFieldClass, ghostActionClass, primaryActionClass } from "./PageFrame";
import type { ProjectMemoryDocumentDto } from "../types";
import { addProjectKnowledge } from "../assistant-desk";

/**
 * 项目助手起草的「记进项目知识」（2026-11-05 用户「让它真正像个助手」：记录和记忆分开）：
 * 你说出以后都要照办的偏好时，它起草一句；你可以改，点「记进项目知识」才写进「已定 / 不做」（project_memory_update add，
 * 与项目设置里的项目知识同一份），以后干活的 AI 和项目助手都会照着办。已经记过同一句的直接显示「已记下」。
 */
export default function RememberCard({ text, projectPath }: { text: string; projectPath: string | null }) {
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) return;
    let stale = false;
    invoke<ProjectMemoryDocumentDto>("project_memory_read", { path: projectPath })
      .then((doc) => {
        if (!stale && doc.entries.some((e) => e.meta.state === "active" && e.text.trim() === text.trim())) setState("done");
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [projectPath, text]);

  async function remember() {
    const line = draft.trim();
    if (!line || !projectPath) return;
    setState("busy");
    setError(null);
    try {
      await addProjectKnowledge(projectPath, line);
      setState("done");
      setEditing(false);
    } catch (reason) {
      setError(String(reason));
      setState("idle");
    }
  }

  return (
    <section className="mt-3 rounded-xl border border-hairline p-3" aria-label="记进项目知识">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-l3">
        <BookmarkPlus size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="font-medium text-l2">以后照这样办</span>
      </div>
      {editing && state !== "done" ? (
        <textarea
          className={`${compactFieldClass} min-h-12 w-full resize-y py-1.5`}
          value={draft}
          maxLength={300}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-l1">{draft}</p>
      )}
      {error && <p className="mt-2 break-words text-xs text-err-text">没记上：{error}</p>}
      <div className="mt-2 flex min-w-0 items-center gap-2">
        {state === "done" ? (
          <span className="text-xs text-ok-text">已记进项目知识「已定 / 不做」</span>
        ) : (
          <>
            <button type="button" className={primaryActionClass} disabled={state === "busy" || !draft.trim()} onClick={() => void remember()}>
              {state === "busy" ? "记下中…" : "记进项目知识"}
            </button>
            <button type="button" className={ghostActionClass} disabled={state === "busy"} onClick={() => setEditing((v) => !v)}>
              {editing ? "改好了" : "改一改"}
            </button>
            <span className="min-w-0 truncate text-micro text-l4">点了才记；以后干活的 AI 都会照着办</span>
          </>
        )}
      </div>
    </section>
  );
}
