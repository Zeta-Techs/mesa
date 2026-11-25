// 聊天页「侧边提问（Side Question / `/btw`）」右侧全高分栏（2026-11-25，纯逻辑在 chat-aside.ts，后端在 ask_aside.rs）：
// - 与左侧「主对话 + 主状态栏」平级并排（经 asideSlot portal 挂进 pane-body 右列，贯穿至底栏，不让主状态栏横穿右侧）；
// - 布局与左侧聊天层严格同构：单行页签顶栏（+ 新建 / × 关单条 / 清空 / 收起）+ 中间对话流 + 同高单行圆角输入框 + 同高 32px 底栏（只读徽标 + 独立模型选择器）；
// - 支持为侧边提问独立挑选任意已安装 Agent / 连接 / 模型（也可切回「自动跟随」），按本机记住偏好；
// - 多条线程彼此隔离、并发不串台；收起保留记录并在顶栏图标点微点，关单条或切主会话即丢弃不落盘。
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  CornerDownLeft,
  MessageSquareQuote,
  PanelRightClose,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  ASIDE_MODEL_PREF_KEY,
  ASIDE_PANE_DEFAULT_WIDTH,
  ASIDE_PANE_WIDTH_KEY,
  asideMethodHint,
  asideModeBadge,
  asideThreadTitleFromQuestion,
  buildAsideModelGroups,
  buildFallbackTranscript,
  canAskAside,
  clampAsidePaneWidth,
  createAsideThread,
  displayAsideAgent,
  removeAsideThread,
  resolveAsideModelOverride,
  summarizeAsidePane,
  toAsideHistory,
  type AsideModelGroup,
  type AsideModelOverride,
  type AsidePaneSummary,
  type AsideThread,
  type AsideTurn,
} from "../chat-aside";
import type { MesaCommand } from "../composer-assist";
import { imeBlocksEnter } from "../ime-guard";
import { useAppStore } from "../store";
import type { ChatMessageDto } from "../types";
import AgentIcon from "./AgentIcon";
import ChatMarkdown from "./ChatMarkdown";
import { MesaStatusLead } from "./MesaMark";

interface AsideAnswerResponse {
  text: string;
  how: string;
  costUsd: number | null;
  responderAgent: string | null;
  responderProfile: string | null;
  responderModel?: string | null;
}

/** 容器总宽低于此阈值时（双标签分屏 / 阅读区右栏），右侧分栏改为叠加覆盖右侧，避免把主对话压扁 */
const OVERLAY_BREAKPOINT_PX = 720;

function readSavedWidth(): number {
  try {
    const raw = localStorage.getItem(ASIDE_PANE_WIDTH_KEY);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? clampAsidePaneWidth(parsed) : ASIDE_PANE_DEFAULT_WIDTH;
  } catch {
    return ASIDE_PANE_DEFAULT_WIDTH;
  }
}

function savePaneWidth(width: number) {
  try {
    localStorage.setItem(ASIDE_PANE_WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* 存不了只影响下次默认宽度 */
  }
}

function readSavedModelOverride(): AsideModelOverride | null {
  try {
    const raw = localStorage.getItem(ASIDE_MODEL_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as { profileId?: unknown; model?: unknown };
    if (typeof p.profileId !== "string" || !p.profileId.trim()) return null;
    return {
      profileId: p.profileId,
      model: typeof p.model === "string" && p.model.trim() ? p.model : null,
    };
  } catch {
    return null;
  }
}

function saveModelOverride(next: AsideModelOverride | null) {
  try {
    if (!next) localStorage.removeItem(ASIDE_MODEL_PREF_KEY);
    else localStorage.setItem(ASIDE_MODEL_PREF_KEY, JSON.stringify(next));
  } catch {
    /* 存不了只影响下次重启后的记忆 */
  }
}

export function useChatAside({
  sessionId,
  sessionFile,
  agentId,
  profileId,
  model,
  cwd,
  messages,
  containerWidth = null,
  asideSlot = null,
  toggleRequest = 0,
  onSummaryChange,
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
  /** 整个 pane-body 的可用宽度（含左右两列，开关/拖宽右栏时不变，避免误触发 overlay 震荡） */
  containerWidth?: number | null;
  /** pane-body 右侧全高列插槽：宽屏时经 createPortal 挂进去，使左侧主状态栏不再横穿右栏底下 */
  asideSlot?: HTMLElement | null;
  /** 来自顶栏侧边提问按钮的开关请求序号（每次 +1 翻转开合） */
  toggleRequest?: number;
  /** 把开合、活跃线程数、是否思考中上报给顶栏按钮点亮状态 */
  onSummaryChange?: (summary: AsidePaneSummary) => void;
  /** 把某条侧边回答带入主输入框（不自动发送） */
  onInsertToMain: (text: string) => void;
  /** 收起右侧分栏后把焦点还给主输入框 */
  onReturnFocus: () => void;
}) {
  const threadCounterRef = useRef(1);
  const nextThreadId = useCallback(() => `sq-${threadCounterRef.current++}`, []);

  const profiles = useAppStore((s) => s.profiles);
  const agents = useAppStore((s) => s.agents);
  const hiddenProfiles = useAppStore((s) => s.settings?.hiddenProfiles);

  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<AsideThread[]>(() => [createAsideThread("sq-0")]);
  const [activeId, setActiveId] = useState<string>("sq-0");
  const [focusSeq, setFocusSeq] = useState(0);
  const [paneWidth, setPaneWidth] = useState<number>(readSavedWidth);
  const [savedOverride, setSavedOverride] = useState<AsideModelOverride | null>(readSavedModelOverride);

  // 校验本地记忆的独立模型是否仍在连接列表里；连接被删自动回退「自动跟随」
  const modelOverride = useMemo(
    () => resolveAsideModelOverride(savedOverride, profiles),
    [savedOverride, profiles],
  );
  const installedAgentIds = useMemo(
    () => (agents.length > 0 ? agents.filter((a) => Boolean(a.binaryPath)).map((a) => a.id) : null),
    [agents],
  );
  const modelGroups = useMemo(
    () => buildAsideModelGroups(profiles, hiddenProfiles ?? [], installedAgentIds),
    [profiles, hiddenProfiles, installedAgentIds],
  );
  const pickModelOverride = useCallback((next: AsideModelOverride | null) => {
    setSavedOverride(next);
    saveModelOverride(next);
  }, []);

  // 每条线程独立维护请求令牌，并发多开不串台；主会话切换时递增 sessionEpochRef 丢弃所有旧会话在途响应
  const sessionEpochRef = useRef(0);
  const threadReqRef = useRef<Map<string, number>>(new Map());
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const contextRef = useRef({ sessionId, sessionFile, agentId, profileId, model, cwd, modelOverride });
  contextRef.current = { sessionId, sessionFile, agentId, profileId, model, cwd, modelOverride };

  // 切到另一段完全不同的主会话时重置所有侧边线程（新对话首句后补上 sessionId 不算换会话）
  const boundSessionRef = useRef<string | null>(sessionId || sessionFile || null);
  useEffect(() => {
    const curKey = sessionId || sessionFile || null;
    const prevKey = boundSessionRef.current;
    if (curKey && prevKey && curKey !== prevKey) {
      sessionEpochRef.current += 1;
      threadReqRef.current.clear();
      const fresh = createAsideThread(nextThreadId());
      setOpen(false);
      setThreads([fresh]);
      setActiveId(fresh.id);
    }
    if (curKey) boundSessionRef.current = curKey;
  }, [sessionId, sessionFile, nextThreadId]);

  // 顶栏按钮翻转开合
  const lastToggleRef = useRef(toggleRequest);
  useEffect(() => {
    if (toggleRequest === lastToggleRef.current) return;
    lastToggleRef.current = toggleRequest;
    setOpen((cur) => {
      const next = !cur;
      if (next) setFocusSeq((n) => n + 1);
      else onReturnFocus();
      return next;
    });
  }, [toggleRequest, onReturnFocus]);

  // 上报状态给顶栏图标（仅摘要变化时触发）
  const summary = useMemo(() => summarizeAsidePane(open, threads), [open, threads]);
  const onSummaryRef = useRef(onSummaryChange);
  onSummaryRef.current = onSummaryChange;
  useEffect(() => {
    onSummaryRef.current?.(summary);
  }, [summary]);

  const askInThread = useCallback(async (threadId: string, rawQuestion: string) => {
    const q = rawQuestion.trim();
    if (!q) return;
    const ctx = contextRef.current;
    const gate = canAskAside({
      sessionId: ctx.sessionId,
      filePath: ctx.sessionFile,
      messageCount: messagesRef.current.length,
    });
    setOpen(true);
    setActiveId(threadId);
    if (!gate.ok) {
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, error: { message: gate.reason, retryQuestion: q } } : t,
        ),
      );
      return;
    }

    const epoch = sessionEpochRef.current;
    const reqId = (threadReqRef.current.get(threadId) ?? 0) + 1;
    threadReqRef.current.set(threadId, reqId);
    const snapshot = threadsRef.current.find((t) => t.id === threadId);
    const history = snapshot ? toAsideHistory(snapshot.turns) : [];

    setThreads((prev) =>
      prev.map((t) =>
        t.id === threadId
          ? {
              ...t,
              title: t.turns.length === 0 ? asideThreadTitleFromQuestion(q) : t.title,
              pendingQuestion: q,
              error: null,
            }
          : t,
      ),
    );

    try {
      const res = await invoke<AsideAnswerResponse>("chat_ask_aside", {
        req: {
          agent: ctx.agentId ?? "",
          sessionId: ctx.sessionId,
          filePath: ctx.sessionFile,
          profileId: ctx.profileId,
          model: ctx.model,
          overrideProfileId: ctx.modelOverride?.profileId ?? null,
          overrideModel: ctx.modelOverride?.model ?? null,
          cwd: ctx.cwd,
          question: q,
          history,
          fallbackTranscript: buildFallbackTranscript(messagesRef.current),
        },
      });
      if (sessionEpochRef.current !== epoch || threadReqRef.current.get(threadId) !== reqId) return;
      const nextTurn: AsideTurn = {
        id: `${threadId}-${reqId}-${Date.now()}`,
        question: q,
        answer: res.text,
        how: res.how,
        costUsd: res.costUsd ?? null,
        responderAgent: res.responderAgent ?? null,
        responderProfile: res.responderProfile ?? null,
        responderModel: res.responderModel ?? null,
      };
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId
            ? {
                ...t,
                title: t.turns.length === 0 ? asideThreadTitleFromQuestion(q) : t.title,
                turns: [...t.turns, nextTurn],
                pendingQuestion: null,
                error: null,
              }
            : t,
        ),
      );
      setFocusSeq((n) => n + 1);
    } catch (reason) {
      if (sessionEpochRef.current !== epoch || threadReqRef.current.get(threadId) !== reqId) return;
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId
            ? {
                ...t,
                pendingQuestion: null,
                error: { message: String(reason), retryQuestion: q },
              }
            : t,
        ),
      );
    }
  }, []);

  const openCard = useCallback(
    (initialQuestion?: string) => {
      const q = initialQuestion?.trim() ?? "";
      setOpen(true);
      if (q) {
        const cur = threadsRef.current.find((t) => t.id === activeIdRef.current) ?? threadsRef.current[0];
        if (cur && cur.pendingQuestion === null) {
          void askInThread(cur.id, q);
        } else {
          const fresh = createAsideThread(nextThreadId());
          setThreads((prev) => [...prev, fresh]);
          setActiveId(fresh.id);
          void askInThread(fresh.id, q);
        }
      } else {
        setFocusSeq((n) => n + 1);
      }
    },
    [askInThread, nextThreadId],
  );

  const createThread = useCallback(() => {
    const fresh = createAsideThread(nextThreadId());
    setThreads((prev) => [...prev, fresh]);
    setActiveId(fresh.id);
    setFocusSeq((n) => n + 1);
  }, [nextThreadId]);

  const selectThread = useCallback((id: string) => {
    setActiveId(id);
    setFocusSeq((n) => n + 1);
  }, []);

  const clearThread = useCallback((id: string) => {
    threadReqRef.current.set(id, (threadReqRef.current.get(id) ?? 0) + 1);
    setThreads((prev) => prev.map((t) => (t.id === id ? createAsideThread(id) : t)));
    setFocusSeq((n) => n + 1);
  }, []);

  const closeThread = useCallback(
    (id: string) => {
      threadReqRef.current.set(id, (threadReqRef.current.get(id) ?? 0) + 1);
      const res = removeAsideThread(threadsRef.current, activeIdRef.current, id);
      if (res.threads.length === 0) {
        const fresh = createAsideThread(nextThreadId());
        setThreads([fresh]);
        setActiveId(fresh.id);
        setOpen(false);
        onReturnFocus();
        return;
      }
      setThreads(res.threads);
      if (res.activeId) setActiveId(res.activeId);
    },
    [nextThreadId, onReturnFocus],
  );

  const collapsePane = useCallback(() => {
    setOpen(false);
    onReturnFocus();
  }, [onReturnFocus]);

  const resizeWidth = useCallback(
    (next: number, commit = false) => {
      const clamped = clampAsidePaneWidth(next, containerWidth);
      setPaneWidth(clamped);
      if (commit) savePaneWidth(clamped);
    },
    [containerWidth],
  );

  const command: MesaCommand = useMemo(
    () => ({
      cmd: "/btw",
      label: "问它一句",
      hint: "在右侧打开独立侧边提问栏，不打断当前对话",
      allowArgs: true,
      run: () => openCard(),
    }),
    [openCard],
  );

  const activeThread = threads.find((t) => t.id === activeId) ?? threads[0]!;
  const overlay = Boolean(containerWidth && containerWidth > 0 && containerWidth < OVERLAY_BREAKPOINT_PX);
  const clampedWidth = clampAsidePaneWidth(paneWidth, containerWidth);

  const paneElement = open ? (
    <ChatAsidePane
      agentId={agentId}
      cwd={cwd}
      threads={threads}
      activeThread={activeThread}
      focusSeq={focusSeq}
      width={clampedWidth}
      overlay={overlay}
      modelGroups={modelGroups}
      modelOverride={modelOverride}
      onPickModel={pickModelOverride}
      onResize={resizeWidth}
      onSelectThread={selectThread}
      onCreateThread={createThread}
      onCloseThread={closeThread}
      onClearThread={() => clearThread(activeThread.id)}
      onCollapse={collapsePane}
      onAsk={(q) => void askInThread(activeThread.id, q)}
      onInsertToMain={onInsertToMain}
    />
  ) : null;

  // 宽屏且父级给了 pane-body 右列插槽时，portal 进全高右列（与左侧「主对话 + 主状态栏」平级并排）；
  // 窄屏或阅读区无插槽时留在 ChatSurface 内部叠加显示
  const pane: ReactNode =
    paneElement && !overlay && asideSlot ? createPortal(paneElement, asideSlot) : paneElement;

  return { open, summary, openCard, createThread, collapsePane, command, pane, panel: pane };
}

function AsideModelPicker({
  agentId,
  groups,
  override,
  lastResponder,
  onPick,
}: {
  agentId: string | null;
  groups: readonly AsideModelGroup[];
  override: AsideModelOverride | null;
  lastResponder: { agent: string | null; profile: string | null; model: string | null } | null;
  onPick: (next: AsideModelOverride | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const pickedGroup = override ? groups.find((g) => g.profileId === override.profileId) ?? null : null;
  const chipAgent = pickedGroup?.agentId ?? lastResponder?.agent ?? agentId ?? null;
  const autoName = lastResponder?.model?.trim() || lastResponder?.profile?.trim() || null;
  const chipLabel = pickedGroup
    ? override?.model || pickedGroup.profileName
    : autoName
      ? `自动 · ${autoName}`
      : "自动跟随";
  const chipTitle = pickedGroup
    ? `侧边提问已指定：${pickedGroup.agentLabel} · ${pickedGroup.profileName}${override?.model ? ` · ${override.model}` : ""}\n${
        pickedGroup.canInspectFiles ? "支持只读查看工作区文件" : "按当前对话记录纯文本回答"
      }（点击更换或切回自动跟随）`
    : `侧边提问模型：自动跟随${
        lastResponder?.profile || lastResponder?.model
          ? `（实际使用 ${[displayAsideAgent(lastResponder.agent), lastResponder.profile, lastResponder.model].filter(Boolean).join(" · ")}）`
          : `（${asideMethodHint(agentId)}）`
      }\n点击可为侧边提问单独选一个模型`;

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-1 items-center justify-end">
      <button
        type="button"
        data-testid="aside-model-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={chipTitle}
        className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-l3 transition-colors hover:bg-hover hover:text-l1"
      >
        {chipAgent ? (
          <AgentIcon agent={chipAgent} label={displayAsideAgent(chipAgent)} size={13} className="shrink-0" />
        ) : (
          <Sparkles size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l4" />
        )}
        <span className="min-w-0 truncate leading-[18px]">{chipLabel}</span>
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l4" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="选择侧边提问模型"
          className="ccode-float-surface ccode-menu-surface absolute bottom-full right-0 z-50 mb-1.5 flex max-h-80 w-72 flex-col overflow-hidden rounded-xl border border-field p-1.5 text-xs"
        >
          <div className="ccode-chat-scroll overflow-auto">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={override === null}
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
            >
              <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" className="mt-0.5 shrink-0 text-l3" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-l1">自动跟随</span>
                <span className="block text-micro leading-4 text-l4">
                  优先原生分身 / 同家只读，其余借只读连接代答
                </span>
              </span>
              <Check
                size={13}
                strokeWidth={2}
                aria-hidden="true"
                className={`mt-0.5 shrink-0 ${override === null ? "text-l2" : "invisible"}`}
              />
            </button>

            {groups.length > 0 && <div className="mx-1 my-1.5 h-px bg-hairline" />}

            {groups.length === 0 ? (
              <p className="px-2 py-2 text-micro text-l4">还没有可用的其他连接，当前将按自动策略回答。</p>
            ) : (
              groups.map((g) => (
                <div key={g.profileId} className="mb-1 last:mb-0">
                  <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-micro text-l4">
                    <AgentIcon agent={g.agentId} label={g.agentLabel} size={12} className="shrink-0" />
                    <span className="min-w-0 truncate font-medium text-l3">{g.profileName}</span>
                    <span className="ml-auto shrink-0 text-l4">
                      {g.canInspectFiles ? "可读文件" : "按记录答"}
                    </span>
                  </div>
                  {g.options.map((opt) => {
                    const selected =
                      override !== null &&
                      override.profileId === opt.profileId &&
                      (override.model ?? null) === opt.model;
                    return (
                      <button
                        key={`${opt.profileId}:${opt.model ?? ""}`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        onClick={() => {
                          onPick({ profileId: opt.profileId, model: opt.model });
                          setOpen(false);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg py-1 pl-6 pr-2 text-left text-l2 transition-colors hover:bg-hover hover:text-l1"
                      >
                        <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                        <Check
                          size={13}
                          strokeWidth={2}
                          aria-hidden="true"
                          className={`shrink-0 ${selected ? "text-l2" : "invisible"}`}
                        />
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ChatAsidePane({
  agentId,
  cwd,
  threads,
  activeThread,
  focusSeq,
  width,
  overlay,
  modelGroups,
  modelOverride,
  onPickModel,
  onResize,
  onSelectThread,
  onCreateThread,
  onCloseThread,
  onClearThread,
  onCollapse,
  onAsk,
  onInsertToMain,
}: {
  agentId: string | null;
  cwd: string | null;
  threads: readonly AsideThread[];
  activeThread: AsideThread;
  focusSeq: number;
  width: number;
  overlay: boolean;
  modelGroups: readonly AsideModelGroup[];
  modelOverride: AsideModelOverride | null;
  onPickModel: (next: AsideModelOverride | null) => void;
  onResize: (width: number, commit?: boolean) => void;
  onSelectThread: (id: string) => void;
  onCreateThread: () => void;
  onCloseThread: (id: string) => void;
  onClearThread: () => void;
  onCollapse: () => void;
  onAsk: (question: string) => void;
  onInsertToMain: (text: string) => void;
}) {
  // 每条线程各自保留未发送草稿，切页签不丢刚打一半的字
  const [draftByThread, setDraftByThread] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composingLockRef = useRef(false);

  const draft = draftByThread[activeThread.id] ?? "";
  const busy = activeThread.pendingQuestion !== null;
  const setDraft = (next: string) =>
    setDraftByThread((prev) => ({ ...prev, [activeThread.id]: next }));

  // 每次打开、新建、切页签或回答回来，把光标送进右侧栏底部输入框
  useEffect(() => {
    const t = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(t);
  }, [focusSeq, activeThread.id]);

  // 有新回答或开始等待时，自动把右侧对话流滚到底部
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeThread.id, activeThread.turns.length, activeThread.pendingQuestion, activeThread.error?.message]);

  // 思考计时（满 3 秒显示）
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
  }, [busy, activeThread.id]);

  // 底部输入框单行起自动增高（封顶约 5 行）
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!draft) {
      el.style.height = "";
      return;
    }
    el.style.height = "0";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft, activeThread.id]);

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let latest = startWidth;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      latest = startWidth + (startX - ev.clientX);
      onResize(latest, false);
    };
    const onUp = () => {
      setDragging(false);
      onResize(latest, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

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

  const latestTurn = activeThread.turns[activeThread.turns.length - 1] ?? null;
  const badge = latestTurn
    ? asideModeBadge(latestTurn.how, latestTurn.responderAgent, latestTurn.responderProfile)
    : null;
  const pickedGroup = modelOverride
    ? modelGroups.find((g) => g.profileId === modelOverride.profileId) ?? null
    : null;
  const emptyHint = pickedGroup
    ? `将由 ${pickedGroup.profileName}${modelOverride?.model ? `（${modelOverride.model}）` : ""}${
        pickedGroup.canInspectFiles ? "只读回答" : "按对话记录回答"
      } · 原对话一字不动`
    : asideMethodHint(agentId);
  const leftStatusLabel = badge
    ? badge.label
    : pickedGroup
      ? pickedGroup.canInspectFiles
        ? "只读 · 可查文件"
        : "只读 · 按记录答"
      : "只读 · 不进主对话";
  const leftStatusTitle = badge ? badge.title : emptyHint;
  const hasContent = activeThread.turns.length > 0 || busy || Boolean(activeThread.error);

  return (
    <aside
      data-testid="chat-aside-pane"
      aria-label="侧边提问（不打断主对话）"
      style={{ width: overlay ? `min(${width}px, 88%)` : `${width}px` }}
      className={
        overlay
          ? "ccode-float-surface absolute inset-y-0 right-0 z-30 flex min-h-0 flex-col border-l border-field"
          : "relative -mt-px flex h-[calc(100%+1px)] min-h-0 shrink-0 flex-col border-l border-hairline bg-canvas"
      }
    >
      {/* 左侧隐形拖拽宽手柄 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整侧边提问栏宽度"
        onPointerDown={startResize}
        className={`absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize transition-colors ${
          dragging ? "bg-mesa-amber/40" : "hover:bg-field/60"
        }`}
      />

      {/* 单行清爽页签顶栏：多页签 + 「+」新建 + 清空 + 收起（去掉多余的重复副标题行） */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <div
          role="tablist"
          aria-label="侧边提问列表"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        >
          {threads.map((t) => {
            const active = t.id === activeThread.id;
            const thinking = t.pendingQuestion !== null;
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={active}
                data-testid={`aside-tab-${t.id}`}
                className={`group/tab flex h-7 max-w-[11rem] shrink-0 items-center gap-1 rounded-md pl-2 pr-1 text-xs transition-colors ${
                  active ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover hover:text-l2"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectThread(t.id)}
                  title={t.title}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <MessageSquareQuote
                    size={12}
                    strokeWidth={1.8}
                    aria-hidden="true"
                    className={`shrink-0 ${active ? "text-mesa-amber" : "text-l4"}`}
                  />
                  <span className="min-w-0 truncate">{t.title}</span>
                  {thinking && (
                    <span
                      aria-label="思考中"
                      className="size-1.5 shrink-0 animate-pulse rounded-full bg-mesa-amber"
                    />
                  )}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseThread(t.id);
                  }}
                  title="关闭这条侧边提问"
                  aria-label={`关闭「${t.title}」`}
                  className={`flex size-4 shrink-0 items-center justify-center rounded-sm text-l4 transition-opacity hover:bg-hover hover:text-l1 ${
                    active ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100"
                  }`}
                >
                  <X size={11} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onCreateThread}
            title="新建一条独立的侧边提问"
            aria-label="新建侧边提问"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        {hasContent && !busy && (
          <button
            type="button"
            onClick={onClearThread}
            title="清空当前侧边提问内容"
            aria-label="清空当前侧边提问"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-l4 transition-colors hover:bg-hover hover:text-l1"
          >
            <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onCollapse}
          title="收起侧边提问栏（保留记录，Esc）"
          aria-label="收起侧边提问栏"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
        >
          <PanelRightClose size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {/* 中间独立滚动对话流 / 极简空态 */}
      <div ref={bodyRef} className="ccode-chat-scroll flex min-h-0 flex-1 flex-col overflow-auto px-3.5 py-4">
        {!hasContent ? (
          <div className="m-auto flex max-w-[18rem] flex-col items-center gap-2 py-8 text-center">
            <MessageSquareQuote size={22} strokeWidth={1.6} aria-hidden="true" className="text-l4" />
            <p className="text-xs leading-5 text-l3">不打断主对话，在旁边随口问一句</p>
            <p className="text-micro leading-relaxed text-l4">{emptyHint}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {activeThread.turns.map((turn) => {
              const copied = copiedId === turn.id;
              return (
                <div key={turn.id} className="space-y-2.5">
                  <div className="ml-auto w-fit max-w-[88%] ccode-well rounded-2xl px-3.5 py-2 text-sm leading-6 text-l1">
                    <p className="whitespace-pre-wrap break-words">{turn.question}</p>
                  </div>
                  <div className="min-w-0 text-sm leading-relaxed text-l2">
                    <ChatMarkdown text={turn.answer} cwd={cwd} suppressMentionedMedia />
                    <div className="mt-1.5 flex items-center gap-1 text-micro text-l4">
                      <button
                        type="button"
                        onClick={() => copyAnswer(turn.id, turn.answer)}
                        title={copied ? "已复制" : "复制回答"}
                        aria-label={copied ? "已复制" : "复制回答"}
                        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-hover hover:text-l1"
                      >
                        {copied ? (
                          <Check size={12} strokeWidth={2} aria-hidden="true" />
                        ) : (
                          <Copy size={12} strokeWidth={1.8} aria-hidden="true" />
                        )}
                        <span>{copied ? "已复制" : "复制"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onInsertToMain(turn.answer)}
                        title="把这段回答填进左侧主输入框，修改后再决定发不发"
                        aria-label="带入主输入框"
                        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-hover hover:text-l1"
                      >
                        <CornerDownLeft size={12} strokeWidth={1.8} aria-hidden="true" />
                        <span>带入主输入框</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {busy && (
              <div className="space-y-2.5">
                <div className="ml-auto w-fit max-w-[88%] ccode-well rounded-2xl px-3.5 py-2 text-sm leading-6 text-l1">
                  <p className="whitespace-pre-wrap break-words">{activeThread.pendingQuestion}</p>
                </div>
                <div className="flex items-center gap-2 py-0.5 text-xs text-l3">
                  <MesaStatusLead text="正在看这段对话…" motion="thinking" sweep />
                  {elapsed >= 3 && (
                    <span className="shrink-0 tabular-nums text-micro text-l4">{elapsed} 秒</span>
                  )}
                </div>
              </div>
            )}

            {activeThread.error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-err-bd/50 px-3 py-2 text-xs text-err-text"
              >
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {activeThread.error.message}
                </span>
                {activeThread.error.retryQuestion && (
                  <button
                    type="button"
                    onClick={() => onAsk(activeThread.error!.retryQuestion!)}
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
      </div>

      {/* 底部输入盒：与左侧 ChatComposer 同款单行圆角结构（48px 单行高度、pb-2 pt-2.5 边距） */}
      <div className="shrink-0 bg-canvas px-3 pb-2 pt-2.5">
        <div className="ccode-composer-box rounded-xl border border-composer-edge bg-composer transition-colors focus-within:border-l4">
          <div className="flex items-end gap-1.5 px-2 py-1.5">
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
                  onCollapse();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitDraft();
                }
              }}
              placeholder={
                activeThread.turns.length === 0
                  ? "随口问一句，不打断主对话"
                  : "接着追问，仍不进主对话"
              }
              className="ccode-composer-text block max-h-[8.25rem] min-w-0 flex-1 resize-none bg-transparent px-1.5 pb-[6.5px] pt-[3.5px] text-sm leading-6 text-l1 caret-mesa-amber outline-none placeholder:text-l3 disabled:opacity-50"
            />
            <div className="flex h-[34px] shrink-0 items-center">
              <button
                type="button"
                disabled={busy || !draft.trim()}
                onClick={submitDraft}
                data-state={!busy && draft.trim() ? "ready" : busy ? "sending" : "empty"}
                title="发送侧边提问（Enter 发送 · Shift+Enter 换行 · Esc 收起）"
                aria-label="发送侧边提问"
                className="ccode-send-block"
              >
                <ArrowUp size={13} strokeWidth={2.4} aria-hidden="true" className="ccode-send-arrow" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 底部 32px 状态栏：与左侧 TerminalStatusBar（h-8）像素级齐平——左只读方式，右侧边栏独立模型选择器 */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 bg-canvas px-3 text-micro select-none">
        <span className="shrink-0 text-l4" title={leftStatusTitle}>
          {leftStatusLabel}
        </span>
        <AsideModelPicker
          agentId={agentId}
          groups={modelGroups}
          override={modelOverride}
          lastResponder={
            latestTurn
              ? {
                  agent: latestTurn.responderAgent,
                  profile: latestTurn.responderProfile,
                  model: latestTurn.responderModel ?? null,
                }
              : null
          }
          onPick={onPickModel}
        />
      </div>
    </aside>
  );
}
