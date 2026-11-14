import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { compactFieldClass, rowActionClass } from "./PageFrame";
import { changeLine, CHANGES_SHOWN } from "../peek";
import { mailStatusText } from "../project-mail";
import type { ChangedFileDto, ProjectMailDto } from "../types";

/**
 * 工作台任务面板里一段开着的工作（2026-11-03 用户拍板：协调对话并进工作台）：
 * - 改了哪些文件：与 Agent 用的 `peek changes` 同一口径（.ccode/ 不算、对开工基线比），打开面板时读一次；
 * - 给它留话：Mesa 记下，它空闲、你没在它输入框里打字时送进对话（与同项目 Agent 之间的留话同一条送达 / 撤回链路）。
 * - 问它一句（不打断，2026-11-11）：Claude Code 原生分叉、Codex 记忆副本，只读回答、答完就丢，不进它的对话（ask_aside.rs）。
 */
export default function TaskPanelPeek({
  runId,
  projectPath,
  draft = null,
  agentId = null,
}: {
  runId: string;
  projectPath: string;
  /** 项目助手「给第 N 步留话」带来的草稿：只填进框里，发不发人点 */
  draft?: string | null;
  /** 这段工作是哪家 Agent：「问它一句」一期只给 Claude Code、Codex */
  agentId?: string | null;
}) {
  const [files, setFiles] = useState<ChangedFileDto[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [mails, setMails] = useState<ProjectMailDto[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<{ q: string; text: string; how: string; costUsd: number | null } | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const canAsk = agentId === "claude-code" || agentId === "codex";

  async function askAside() {
    const q = ask.trim();
    if (!q || asking) return;
    setAsking(true);
    setAskError(null);
    try {
      const got = await invoke<{ text: string; how: string; costUsd: number | null }>("run_ask_aside", { runId, question: q });
      setAnswer({ q, ...got });
      setAsk("");
    } catch (reason) {
      setAskError(String(reason));
    } finally {
      setAsking(false);
    }
  }

  async function loadMails() {
    const all = await invoke<ProjectMailDto[]>("mail_list", { projectRoot: projectPath }).catch(() => [] as ProjectMailDto[]);
    setMails(all.filter((m) => m.toRun === runId && m.fromRun === "you"));
  }

  useEffect(() => {
    let stale = false;
    setFiles(null);
    setFilesError(null);
    setShowAll(false);
    setText("");
    setError(null);
    setAsk("");
    setAnswer(null);
    setAskError(null);
    invoke<ChangedFileDto[]>("peek_changes", { runId })
      .then((got) => !stale && setFiles(got))
      .catch((reason) => !stale && setFilesError(String(reason)));
    void loadMails();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, projectPath]);
  useEffect(() => {
    if (draft) setText(draft);
  }, [draft, runId]);

  async function send() {
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await invoke("mail_send", { toRun: runId, text });
      setText("");
      await loadMails();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSending(false);
    }
  }

  const shown = files ? (showAll ? files : files.slice(0, CHANGES_SHOWN)) : [];
  return (
    <>
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-l3">改了哪些文件</h3>
          {files && files.length > 0 && <span className="tabular-nums text-micro text-l4">{files.length} 个</span>}
        </div>
        <div className="rounded-lg ccode-well px-3.5 py-2.5">
          {filesError ? (
            <p className="text-xs text-l3">{filesError}</p>
          ) : files === null ? (
            <p className="text-xs text-l3">读取中…</p>
          ) : files.length === 0 ? (
            <p className="text-xs text-l3">还没改动</p>
          ) : (
            <>
              <ul className="divide-y divide-hairline/55">
                {shown.map((f) => (
                  <li key={f.path} className="flex items-baseline justify-between gap-2 py-1 text-xs first:pt-0 last:pb-0">
                    <span className="min-w-0 flex-1 break-all font-mono text-micro text-l2">{f.path}</span>
                    <span className="shrink-0 font-mono text-micro tabular-nums text-l3">{changeLine(f)}</span>
                  </li>
                ))}
              </ul>
              {files.length > CHANGES_SHOWN && (
                <button type="button" className="mt-1.5 text-xs text-l3 hover:text-l1" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "收起" : `还有 ${files.length - CHANGES_SHOWN} 个`}
                </button>
              )}
            </>
          )}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium text-l3">给它留话</h3>
        <div className="rounded-lg ccode-well p-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              className={`${compactFieldClass} min-w-0 flex-1`}
              placeholder="比如：样本 3 号剔掉，后面别再用"
              value={text}
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" className={rowActionClass} disabled={sending || !text.trim()}>
              {sending ? "记下中…" : "留话"}
            </button>
          </form>
          <p className="mt-1.5 text-micro leading-relaxed text-l4">
            它空闲、你也没在它输入框里打字时送进对话；没送到前在项目分组「留话」里能撤回。
          </p>
          {error && <p className="mt-1.5 text-xs text-err-text">{error}</p>}
          {mails.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-hairline/70 pt-2">
              {mails.slice(0, 5).map((m) => (
                <li key={m.id} className="text-xs text-l2">
                  <span className="text-l3">{mailStatusText(m)}：</span>
                  {m.text.length > 60 ? `${m.text.slice(0, 60)}…` : m.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {canAsk && (
        <section>
          <h3 className="mb-2 text-xs font-medium text-l3">问它一句（不打断）</h3>
          <div className="rounded-lg ccode-well p-3">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void askAside();
              }}
            >
              <input
                className={`${compactFieldClass} min-w-0 flex-1`}
                placeholder="比如：做到哪了？为什么把列名改了？"
                value={ask}
                disabled={asking}
                onChange={(e) => setAsk(e.target.value)}
              />
              <button type="submit" className={rowActionClass} disabled={asking || !ask.trim()}>
                {asking ? "在想…" : "问"}
              </button>
            </form>
            <p className="mt-1.5 text-micro leading-relaxed text-l4">
              {agentId === "claude-code"
                ? "接上它的记忆另起一份只读分身来答，答完就丢，它手上的活和对话都不受影响。"
                : "把它到现在的对话记录交给同一条连接只读回答，答完就丢，它手上的活和对话都不受影响。"}
              要它照做，用上面的留话。
            </p>
            {askError && <p className="mt-1.5 text-xs text-err-text">{askError}</p>}
            {answer && (
              <div className="mt-2 rounded-md bg-inset px-2.5 py-2 text-xs leading-5 text-l2">
                <div className="mb-0.5 text-micro text-l4">
                  你问：{answer.q}
                  {answer.costUsd != null && answer.costUsd > 0 ? ` · 约 $${answer.costUsd.toFixed(3)}` : ""}
                </div>
                <div className="whitespace-pre-wrap">{answer.text}</div>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
