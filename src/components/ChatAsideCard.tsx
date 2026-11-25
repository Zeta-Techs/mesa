// 聊天页「问它一句（不打断）」（Side Question，2026-11-25，纯逻辑在 chat-aside.ts，后端在 ask_aside.rs）：
// - 紧贴输入框正上方、与对话流同中轴的独立浮卡（不插进主消息流、不覆盖主输入框草稿）；
// - 支持主框 `/btw <问题>` 直接发问、斜杠面板 `/btw`、「+」菜单「问它一句」三种呼出方式；
// - 支持卡内连续追问（最多带最近 8 轮），复用 ChatMarkdown 渲染回答，可收起成单行、清空、复制、带入主输入框；
// - 关闭即丢、不落盘、不污染原会话。
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownLeft,
  MessageSquareQuote,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  asideMethodHint,
  asideModeBadge,
  buildFallbackTranscript,
  canAskAside,
  toAsideHistory,
  type AsideTurn,
} from "../chat-aside";
import type { MesaCommand } from "../composer-assist";
import { imeBlocksEnter } from "../ime-guard";
import type { ChatMessageDto } from "../types";
import ChatMarkdown from "./ChatMarkdown";
import { MesaStatusLead } from "./MesaMark";

interface AsideAnswerResponse {
  text: string;
  how: string;
  costUsd: number | null;
  responderAgent: string | null;
  responderProfile: string | null;
}

export function useChatAside({
  sessionId,
  sessionFile,
  agentId,
  profileId,
  model,
  cwd,
  messages,
  narrow,
  onInsertToMain,
  onReturnFocus,
}: {
  sessionId: string | null;
  sessionFile: string | null;
  agentId: string | null;
  profileId: string | null;
  model: string | null;
  cwd: string | null;
  messages: readonly ChatMessageDto[];
  narrow: boolean;
  /** 把某条侧边回答带入主输入框（不自动发送） */
  onInsertToMain: (text: string) => void;
  /** 关闭浮卡后把焦点还给主输入框 */
  onReturnFocus: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [turns, setTurns] = useState<AsideTurn[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; retryQuestion: string | null } | null>(null);
  const [focusSeq, setFocusSeq] = useState(0);

  // 防止切换会话或关掉浮卡后，在途请求晚到把内容塞回新会话
  const reqSeqRef = useRef(0);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const contextRef = useRef({ sessionId, sessionFile, agentId, profileId, model, cwd });
  contextRef.current = { sessionId, sessionFile, agentId, profileId, model, cwd };

  // 切到另一段完全不同的会话时清空浮卡（刚发第一句后从 null 补上 sessionId 不算换会话）
  const boundSessionRef = useRef<string | null>(sessionId || sessionFile || null);
  useEffect(() => {
    const curKey = sessionId || sessionFile || null;
    const prevKey = boundSessionRef.current;
    if (curKey && prevKey && curKey !== prevKey) {
      reqSeqRef.current += 1;
      setOpen(false);
      setCollapsed(false);
      setTurns([]);
      setPendingQuestion(null);
      setError(null);
    }
    if (curKey) boundSessionRef.current = curKey;
  }, [sessionId, sessionFile]);

  const ask = useCallback(async (rawQuestion: string) => {
    const q = rawQuestion.trim();
    if (!q) return;
    const ctx = contextRef.current;
    const gate = canAskAside({
      sessionId: ctx.sessionId,
      filePath: ctx.sessionFile,
      messageCount: messagesRef.current.length,
    });
    if (!gate.ok) {
      setOpen(true);
      setCollapsed(false);
      setError({ message: gate.reason, retryQuestion: q });
      return;
    }
    const reqId = ++reqSeqRef.current;
    setOpen(true);
    setCollapsed(false);
    setError(null);
    setPendingQuestion(q);
    try {
      const res = await invoke<AsideAnswerResponse>("chat_ask_aside", {
        req: {
          agent: ctx.agentId ?? "",
          sessionId: ctx.sessionId,
          filePath: ctx.sessionFile,
          profileId: ctx.profileId,
          model: ctx.model,
          cwd: ctx.cwd,
          question: q,
          history: toAsideHistory(turnsRef.current),
          fallbackTranscript: buildFallbackTranscript(messagesRef.current),
        },
      });
      if (reqSeqRef.current !== reqId) return;
      const nextTurn: AsideTurn = {
        id: `${reqId}-${Date.now()}`,
        question: q,
        answer: res.text,
        how: res.how,
        costUsd: res.costUsd ?? null,
        responderAgent: res.responderAgent ?? null,
        responderProfile: res.responderProfile ?? null,
      };
      setTurns((prev) => [...prev, nextTurn]);
      setPendingQuestion(null);
      setFocusSeq((n) => n + 1);
    } catch (reason) {
      if (reqSeqRef.current !== reqId) return;
      setPendingQuestion(null);
      setError({ message: String(reason), retryQuestion: q });
    }
  }, []);

  const openCard = useCallback(
    (initialQuestion?: string) => {
      const q = initialQuestion?.trim() ?? "";
      setOpen(true);
      setCollapsed(false);
      setError(null);
      if (q) {
        void ask(q);
      } else {
        setFocusSeq((n) => n + 1);
      }
    },
    [ask],
  );

  const clearCard = useCallback(() => {
    reqSeqRef.current += 1;
    setTurns([]);
    setPendingQuestion(null);
    setError(null);
    setFocusSeq((n) => n + 1);
  }, []);

  const closeCard = useCallback(() => {
    reqSeqRef.current += 1;
    setOpen(false);
    setCollapsed(false);
    setTurns([]);
    setPendingQuestion(null);
    setError(null);
    onReturnFocus();
  }, [onReturnFocus]);

  const command: MesaCommand = useMemo(
    () => ({
      cmd: "/btw",
      label: "问它一句",
      hint: "不打断当前对话，只读侧边提问（答完即丢）",
      allowArgs: true,
      run: () => openCard(),
    }),
    [openCard],
  );

  const panel: ReactNode = open ? (
    <ChatAsideCard
      agentId={agentId}
      cwd={cwd}
      narrow={narrow}
      collapsed={collapsed}
      turns={turns}
      pendingQuestion={pendingQuestion}
      error={error}
      focusSeq={focusSeq}
      onToggleCollapse={() => setCollapsed((v) => !v)}
      onClear={clearCard}
      onClose={closeCard}
      onAsk={(q) => void ask(q)}
      onInsertToMain={(text) => {
        onInsertToMain(text);
        setCollapsed(true);
      }}
    />
  ) : null;

  return { open, openCard, command, panel };
}

function ChatAsideCard({
  agentId,
  cwd,
  narrow,
  collapsed,
  turns,
  pendingQuestion,
  error,
  focusSeq,
  onToggleCollapse,
  onClear,
  onClose,
  onAsk,
  onInsertToMain,
}: {
  agentId: string | null;
  cwd: string | null;
  narrow: boolean;
  collapsed: boolean;
  turns: readonly AsideTurn[];
  pendingQuestion: string | null;
  error: { message: string; retryQuestion: string | null } | null;
  focusSeq: number;
  onToggleCollapse: () => void;
  onClear: () => void;
  onClose: () => void;
  onAsk: (question: string) => void;
  onInsertToMain: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composingLockRef = useRef(false);
  const busy = pendingQuestion !== null;

  // 每次打开、清空或回答回来，把光标送回浮卡输入框
  useEffect(() => {
    if (collapsed) return;
    const t = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(t);
  }, [focusSeq, collapsed]);

  // 有新回答或开始等待时，自动把浮卡内容区滚到最底
  useLayoutEffect(() => {
    if (collapsed) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, pendingQuestion, error?.message, collapsed]);

  // 等待计时（满 3 秒显示）
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  // 输入框单行起、随内容自动增高（封顶约 4 行）
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!draft) {
      el.style.height = "";
      return;
    }
    el.style.height = "0";
    el.style.height = `${Math.min(el.scrollHeight, 108)}px`;
  }, [draft, collapsed]);

  function submitDraft() {
    const q = draft.trim();
    if (!q || busy) return;
    setDraft("");
    onAsk(q);
  }

  function copyAnswer(id: string, text: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    });
  }

  const latestTurn = turns[turns.length - 1] ?? null;
  const badge = latestTurn
    ? asideModeBadge(latestTurn.how, latestTurn.responderAgent, latestTurn.responderProfile)
    : null;
  const methodHint = asideMethodHint(agentId);

  return (
    <div className="shrink-0 bg-canvas px-4 pt-2" data-testid="chat-aside-card">
      <section
        aria-label="问它一句（不打断）"
        className={`ccode-float-surface mx-auto w-full rounded-xl border border-field ${
          narrow ? "max-w-[45rem]" : "ccode-chat-column"
        }`}
      >
        {/* 顶栏：标题 + 只读方式徽标 + 清空/收起/关闭 */}
        <div className="flex items-center gap-2 px-3 py-2">
          <MessageSquareQuote size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-mesa-amber" />
          <span className="shrink-0 text-xs font-medium text-l1">问它一句</span>
          {badge ? (
            <span
              title={badge.title}
              className="shrink-0 rounded-md border border-hairline px-1.5 py-0.5 text-micro text-l3"
            >
              {badge.label}
            </span>
          ) : (
            <span className="min-w-0 truncate text-micro text-l4">不打断 · 不进主对话</span>
          )}
          {collapsed && (
            <button
              type="button"
              onClick={onToggleCollapse}
              className="min-w-0 flex-1 truncate text-left text-xs text-l3 hover:text-l1"
            >
              {busy
                ? `正在想：${pendingQuestion}`
                : latestTurn
                  ? `「${latestTurn.question}」· ${turns.length} 轮`
                  : "点此展开提问"}
            </button>
          )}
          <div className={`${collapsed ? "" : "ml-auto"} flex shrink-0 items-center gap-0.5`}>
            {!collapsed && (turns.length > 0 || error) && !busy && (
              <button
                type="button"
                onClick={onClear}
                title="清空侧边问答记录"
                aria-label="清空侧边问答"
                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1"
              >
                <Trash2 size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>清空</span>
              </button>
            )}
            <button
              type="button"
              onClick={onToggleCollapse}
              title={collapsed ? "展开侧边问答" : "收起侧边问答（保留记录）"}
              aria-label={collapsed ? "展开侧边问答" : "收起侧边问答"}
              className="inline-flex size-6 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
            >
              {collapsed ? (
                <ChevronUp size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭并丢弃（Esc）"
              aria-label="关闭侧边问答"
              className="inline-flex size-6 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
            >
              <X size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>

        {!collapsed && (
          <>
            {/* 问答区（有记录、生成中或报错时展开；支持卡内多轮滚屏） */}
            {(turns.length > 0 || busy || error) && (
              <div
                ref={bodyRef}
                className="ccode-chat-scroll max-h-[38vh] space-y-3 overflow-auto border-t border-hairline px-3 py-2.5"
              >
                {turns.map((turn) => {
                  const turnBadge = asideModeBadge(turn.how, turn.responderAgent, turn.responderProfile);
                  const copied = copiedId === turn.id;
                  return (
                    <div key={turn.id} className="space-y-1.5">
                      <div className="ccode-well rounded-lg px-2.5 py-1.5 text-xs leading-5 text-l1">
                        <div className="mb-0.5 flex items-center gap-2 text-micro text-l4">
                          <span>你问</span>
                          {turns.length > 1 && (
                            <span title={turnBadge.title} className="text-l4">
                              · {turnBadge.label}
                            </span>
                          )}
                          {turn.costUsd != null && turn.costUsd > 0 && (
                            <span className="ml-auto tabular-nums">约 ${turn.costUsd.toFixed(3)}</span>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap break-words">{turn.question}</p>
                      </div>
                      <div className="px-1 text-xs leading-relaxed text-l2">
                        <ChatMarkdown text={turn.answer} cwd={cwd} />
                        <div className="mt-1.5 flex items-center gap-2 text-micro text-l4">
                          <button
                            type="button"
                            onClick={() => copyAnswer(turn.id, turn.answer)}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-hover hover:text-l1"
                          >
                            {copied ? (
                              <Check size={11} strokeWidth={2} aria-hidden="true" />
                            ) : (
                              <Copy size={11} strokeWidth={1.8} aria-hidden="true" />
                            )}
                            <span>{copied ? "已复制" : "复制"}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onInsertToMain(turn.answer)}
                            title="把这段回答填进主输入框，修改后再决定发不发"
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-hover hover:text-l1"
                          >
                            <CornerDownLeft size={11} strokeWidth={1.8} aria-hidden="true" />
                            <span>带入主输入框</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {busy && (
                  <div className="space-y-1.5">
                    <div className="ccode-well rounded-lg px-2.5 py-1.5 text-xs leading-5 text-l1">
                      <div className="mb-0.5 text-micro text-l4">你问</div>
                      <p className="whitespace-pre-wrap break-words">{pendingQuestion}</p>
                    </div>
                    <div className="flex items-center gap-2 px-1 py-0.5 text-xs text-l3">
                      <MesaStatusLead text="正在看这段对话…" motion="thinking" sweep />
                      {elapsed >= 3 && (
                        <span className="shrink-0 tabular-nums text-micro text-l4">{elapsed} 秒</span>
                      )}
                    </div>
                  </div>
                )}

                {error && (
                  <div role="alert" className="flex items-start gap-2 rounded-lg border border-err-bd/50 px-2.5 py-2 text-xs text-err-text">
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error.message}</span>
                    {error.retryQuestion && (
                      <button
                        type="button"
                        onClick={() => onAsk(error.retryQuestion!)}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-field px-2 py-0.5 text-micro text-l1 hover:bg-hover"
                      >
                        <RotateCcw size={11} strokeWidth={1.8} aria-hidden="true" />
                        <span>重试</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 独立侧边输入框：不影响主框草稿，支持卡内连续追问 */}
            <div className="border-t border-hairline px-2.5 py-2">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={draft}
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.value)}
                  onCompositionStart={() => {
                    composingLockRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    window.requestAnimationFrame(() => {
                      composingLockRef.current = false;
                    });
                  }}
                  onKeyDown={(e) => {
                    if (
                      imeBlocksEnter({
                        isComposing: e.nativeEvent.isComposing,
                        keyCode: e.keyCode,
                        composingLock: composingLockRef.current,
                      })
                    ) {
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      onClose();
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submitDraft();
                    }
                  }}
                  placeholder={
                    turns.length === 0
                      ? "只读随口问一句（如：做到哪了？为什么这样改？）"
                      : "接着追问（仍不进主对话）"
                  }
                  className="block max-h-[6.75rem] min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-xs leading-5 text-l1 caret-mesa-amber outline-none placeholder:text-l3 disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={busy || !draft.trim()}
                  onClick={submitDraft}
                  title="发送侧边提问（Enter 发送 · Shift+Enter 换行 · Esc 关闭）"
                  aria-label="发送侧边提问"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-field text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowUp size={13} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </div>
              {turns.length === 0 && !busy && !error && (
                <p className="mt-1 px-1 text-micro text-l4">{methodHint}</p>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
