import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import { fieldClass, ghostActionClass, secondaryActionClass } from "./PageFrame";
import ChatMarkdown from "./ChatMarkdown";
import { absTime, relTime } from "../rel-time";
import { toast } from "../toast";
import { parseAssistantAnswer, QUICK_QUESTIONS, type AssistantAction } from "../project-assistant";
import {
  askProjectAssistant,
  assistantConnection,
  type AssistantFocus,
  type AssistantTurn,
} from "../project-assistant-run";
import type { ProjectDto } from "../types";

/** 外面要它带着问题打开（卡点、「问问为什么」）：nonce 变了才再问一次 */
export interface AssistantAsk {
  question: string;
  focus: AssistantFocus | null;
  nonce: number;
}

/**
 * 项目助手（2026-11-04，docs/design-project-assistant.md）：工作台右侧抽屉，与任务面板同一位置、同一套样式。
 * 上面是这个项目的问答记录，下面一个输入框；回答里的动作标记渲染成按钮，点了交给页面跳到原有入口。
 * 不开终端、不派活：每问一次，取一次项目快照、无头调用一次。
 */
export default function ProjectAssistantPanel({
  open,
  onClose,
  projectPath,
  projectName,
  project,
  stepCount,
  ask,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  projectPath: string | null;
  projectName: string;
  project: ProjectDto | null;
  stepCount: number;
  ask: AssistantAsk | null;
  onAction: (action: AssistantAction, turn: AssistantTurn) => void;
}) {
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<AssistantFocus | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const askedNonce = useRef<number | null>(null);
  const conn = assistantConnection(project);

  useEffect(() => {
    if (!open || !projectPath) return;
    let stale = false;
    setError(null);
    invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: projectPath })
      .then((list) => {
        if (!stale) setTurns(list);
      })
      .catch(() => {
        if (!stale) setTurns([]);
      });
    return () => {
      stale = true;
    };
  }, [open, projectPath]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, busy]);

  async function send(question: string, withFocus: AssistantFocus | null) {
    const q = question.trim();
    if (!q || busy || !projectPath) return;
    setBusy(true);
    setError(null);
    try {
      const turn = await askProjectAssistant({
        projectPath,
        project,
        question: q,
        history: turns,
        focus: withFocus,
      });
      setTurns((list) => [...list, turn]);
      setDraft("");
      setFocus(null);
    } catch (reason) {
      setError(String(reason));
      setDraft(q);
    } finally {
      setBusy(false);
    }
  }

  // 带着问题打开：只问一次（同一个 nonce 不重问）
  useEffect(() => {
    if (!open || !ask || askedNonce.current === ask.nonce) return;
    askedNonce.current = ask.nonce;
    setFocus(ask.focus);
    void send(ask.question, ask.focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ask]);

  async function clear() {
    if (!projectPath) return;
    try {
      await invoke("assistant_log_clear", { projectRoot: projectPath });
      setTurns([]);
    } catch (reason) {
      toast(`清空失败：${String(reason)}`, "error");
    }
  }

  return (
    <SettingsDrawerShell
      className="ccode-workbench-detail"
      backdropClassName="ccode-workbench-detail-backdrop"
      open={open && !!projectPath}
      onClose={onClose}
      title="项目助手"
      subtitle={projectName}
      headerActions={
        <div className="flex min-w-0 items-center gap-2 text-xs text-l3">
          <span className="min-w-0 flex-1 truncate" title={conn.bound ? "Agent 分工里给项目助手绑的连接" : "项目助手没单独绑连接，跟随项目默认；可在 Agent 分工里指定"}>
            用 {conn.line}
            {conn.bound ? "" : "（跟随项目默认）"}
          </span>
          {turns.length > 0 && (
            <button type="button" className={`${ghostActionClass} h-6 shrink-0 px-1.5`} disabled={busy} onClick={() => void clear()}>
              清空记录
            </button>
          )}
        </div>
      }
    >
      <div className="flex min-h-0 flex-col gap-4">
        {turns.length === 0 && !busy && (
          <p className="text-sm leading-6 text-l2">
            看不懂进度、不知道哪里出错、不知道下一步做什么，都可以问。它看得到这个项目每一步的状态、最近的运行和出错原因、
            核验与退回意见、等你回答的问题，以及 Mesa 自己在这个项目上出过的错；它只解释和指路，要动手时给你按钮，你点了才发生。
          </p>
        )}
        {turns.map((turn, i) => {
          const parsed = parseAssistantAnswer(turn.answer, stepCount);
          return (
            <article key={`${turn.at}-${i}`} className="space-y-2">
              <div className="flex items-baseline gap-2">
                <p className="min-w-0 flex-1 rounded-lg bg-inset px-2.5 py-1.5 text-sm text-l1">{turn.question}</p>
                <span className="shrink-0 text-micro text-l4" title={`${absTime(turn.at)}${turn.connection ? ` · ${turn.connection}` : ""}`}>
                  {relTime(turn.at)}
                </span>
              </div>
              <div className="text-sm text-l1">
                <ChatMarkdown text={parsed.text} cwd={projectPath} />
              </div>
              {parsed.actions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {parsed.actions.map((action) => (
                    <button
                      key={`${action.kind}-${action.step ?? ""}`}
                      type="button"
                      className={secondaryActionClass}
                      title={action.text || undefined}
                      onClick={() => onAction(action, turn)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </article>
          );
        })}
        {busy && <p className="text-sm text-l3">正在看这个项目的记录…（一般半分钟到一分钟）</p>}
        {error && <p className="break-words text-sm text-err-text">没问成：{error}</p>}
        <div ref={endRef} />
      </div>
      <div className="sticky bottom-0 mt-4 space-y-2 bg-[inherit] pb-1 pt-2">
        {focus && (
          <p className="text-xs text-l3">
            这次重点：{focus.title}
            <button type="button" className="ml-2 text-l3 underline hover:text-l1" onClick={() => setFocus(null)}>
              不带
            </button>
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {QUICK_QUESTIONS.map((q) => (
            <button key={q} type="button" className={`${ghostActionClass} h-6 px-2 text-xs`} disabled={busy} onClick={() => void send(q, focus)}>
              {q}
            </button>
          ))}
        </div>
        <form
          className="flex items-end gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft, focus);
          }}
        >
          <textarea
            className={`${fieldClass} min-h-[2.25rem] flex-1 resize-y py-1.5`}
            rows={2}
            value={draft}
            maxLength={2000}
            placeholder="问点什么，比如：第 3 步为什么一直保存不进项目？"
            aria-label="问项目助手"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send(draft, focus);
              }
            }}
          />
          <button type="submit" className={secondaryActionClass} disabled={busy || !draft.trim()}>
            {busy ? "在看…" : "问"}
          </button>
        </form>
      </div>
    </SettingsDrawerShell>
  );
}
