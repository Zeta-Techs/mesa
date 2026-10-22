import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Archive, Pencil } from "lucide-react";
import { agentBrandBadgeStyle } from "../agent-colors";
import { beginProjectChat } from "./AskAiModal";
import ConversationView from "./ConversationView";
import { firstCompleteTurnIndex } from "../conversation-tools";
import { useAutoLoadOlder } from "../auto-load-older";
import { resumeSessionInTerminal } from "../quick-chat-launch";
import { projectBoundProfileId, slotPrefs, CHAT_BINDING_SLOT } from "../project-agents";
import {
  compactFieldClass,
  compactPrimaryActionClass,
  EmptyState,
  ghostActionClass,
  LoadingRows,
  projectWellClass,
  rowActionClass,
} from "./PageFrame";
import { loadCodingOverview } from "./CodingProjectView";
import { sessionRuntimeKey, useAppStore } from "../store";
import { IS_WINDOWS } from "../hotkeys";
import { absTime, relTime } from "../rel-time";
import { imeBlocksEnter } from "../ime-guard";
import { filterProjectSessions } from "../project-status";
import { neighborFile } from "../project-files";
import { projectSessionLabel, tidySessionTitle } from "../session-title";
import { normalizeWorkMode } from "../work-mode";
import { AGENTS } from "../types";
import type {
  ChatMessageDto,
  ConversationPageDto,
  ProjectDto,
  SessionMetaDto,
} from "../types";

function sessionKey(s: SessionMetaDto) {
  return `${s.agent}:${s.sessionId}`;
}

function agentLabel(id: string): string {
  return AGENTS.find((item) => item.id === id)?.label ?? id;
}

export default function ProjectChatsView({
  project,
  extraRoots = [],
  onError,
}: {
  project: ProjectDto;
  extraRoots?: string[];
  onError?: (msg: string) => void;
}) {
  const sessions = useAppStore((s) => s.sessions);
  const liveSessions = useAppStore((s) => s.liveSessions);
  // 终端里正停在「等你确认」的标签：绿点换成黄点（同对话页）
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const waitingTabs = useMemo(
    () => new Set(terminalRunInputs.filter((r) => r.attention === "confirm").map((r) => r.tabId)),
    [terminalRunInputs],
  );
  const profiles = useAppStore((s) => s.profiles);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const setPage = useAppStore((s) => s.setPage);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const [codingRoots, setCodingRoots] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{
    agent: string;
    sessionId: string;
    title: string;
  } | null>(null);
  const composingLockRef = useRef(false);
  const convScrollRef = useRef<HTMLDivElement>(null);
  const composingFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (normalizeWorkMode(project.workMode) !== "coding") {
      setCodingRoots([]);
      return;
    }
    let stale = false;
    loadCodingOverview(project.path)
      .then((ov) => {
        if (!stale) setCodingRoots(ov.worktrees.map((w) => w.path));
      })
      .catch(() => {
        if (!stale) setCodingRoots([]);
      });
    return () => {
      stale = true;
    };
  }, [project.path, project.workMode]);

  const roots = useMemo(
    () => [...extraRoots, ...codingRoots],
    [extraRoots, codingRoots],
  );
  const rows = useMemo(
    () =>
      filterProjectSessions(sessions, project.path, roots, {
        isWindows: IS_WINDOWS,
      }),
    [sessions, project.path, roots],
  );
  const selected =
    selectedKey == null
      ? null
      : (rows.find((s) => sessionKey(s) === selectedKey) ?? null);

  useEffect(() => {
    if (!selected) {
      setMessages([]);
      setCursor(null);
      setLoadingConv(false);
      return;
    }
    if (!selected.alive && !selected.pinned) {
      setMessages([]);
      setCursor(null);
      setLoadingConv(false);
      return;
    }
    let cancelled = false;
    setLoadingConv(true);
    invoke<ConversationPageDto>("get_session_conversation_page", {
      agent: selected.agent,
      filePath: selected.filePath,
      before: null,
      around: null,
    })
      .then((page) => {
        if (cancelled) return;
        setMessages(page.messages);
        setCursor(page.cursor);
      })
      .catch((reason) => {
        if (!cancelled) onError?.(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoadingConv(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, onError]);

  function startChat(e: { metaKey: boolean; ctrlKey: boolean }) {
    const kind = normalizeWorkMode(project.workMode);
    beginProjectChat(
      {
        cwd: project.path,
        name: project.name,
        kind: kind === "coding" || kind === "office" ? kind : "research",
        ...slotPrefs(profiles, project, CHAT_BINDING_SLOT),
      },
      { forcePick: e.metaKey || e.ctrlKey },
    );
  }

  async function archive(s: SessionMetaDto) {
    setBusy(true);
    try {
      await invoke("set_session_meta", {
        agent: s.agent,
        sessionId: s.sessionId,
        customTitle: s.customTitle,
        tags: s.tags,
        archived: true,
      });
      const key = sessionKey(s);
      if (key === selectedKeyRef.current) {
        const keys = rowsRef.current.map((row) => ({ path: sessionKey(row) }));
        const next =
          neighborFile(keys, key, 1) ?? neighborFile(keys, key, -1);
        setSelectedKey(next?.path ?? null);
      }
      const current = useAppStore.getState().sessions;
      useAppStore.setState({
        sessions: current.map((item) =>
          item.agent === s.agent && item.sessionId === s.sessionId
            ? { ...item, archived: true }
            : item,
        ),
      });
      void loadSessions();
    } catch (reason) {
      onError?.(String(reason));
    } finally {
      setBusy(false);
    }
  }

  function lockIme() {
    composingLockRef.current = true;
  }

  function unlockImeAfterFrame() {
    composingLockRef.current = true;
    if (composingFrameRef.current != null) {
      cancelAnimationFrame(composingFrameRef.current);
    }
    composingFrameRef.current = requestAnimationFrame(() => {
      composingLockRef.current = false;
      composingFrameRef.current = null;
    });
  }

  async function saveTitle(s: SessionMetaDto, title: string) {
    try {
      await invoke("set_session_meta", {
        agent: s.agent,
        sessionId: s.sessionId,
        customTitle: title.trim() || null,
        tags: s.tags,
        archived: s.archived,
      });
      setEditing(null);
      const current = useAppStore.getState().sessions;
      useAppStore.setState({
        sessions: current.map((item) =>
          item.agent === s.agent && item.sessionId === s.sessionId
            ? { ...item, customTitle: title.trim() || null }
            : item,
        ),
      });
      void loadSessions();
    } catch (reason) {
      onError?.(String(reason));
    }
  }

  async function loadOlder(settle?: () => Promise<void>) {
    if (!selected || cursor == null || loadingOlder) return;
    const key = selectedKey;
    setLoadingOlder(true);
    try {
      const page = await invoke<ConversationPageDto>(
        "get_session_conversation_page",
        {
          agent: selected.agent,
          filePath: selected.filePath,
          before: cursor,
          around: null,
        },
      );
      await settle?.();
      if (selectedKeyRef.current !== key) return;
      const scroller = convScrollRef.current;
      if (scroller)
        prependRestoreRef.current = {
          height: scroller.scrollHeight,
          top: scroller.scrollTop,
        };
      setMessages((current) => [...page.messages, ...current]);
      setCursor(page.cursor);
    } catch (reason) {
      onError?.(String(reason));
    } finally {
      setLoadingOlder(false);
    }
  }

  function resumeInProject(s: SessionMetaDto) {
    const chat = slotPrefs(profiles, project, CHAT_BINDING_SLOT);
    const fromChat =
      chat.preferredAgent === s.agent ? chat.preferredProfile : undefined;
    resumeSessionInTerminal(s, {
      preferredProfileId:
        fromChat ||
        projectBoundProfileId(project.defaultProfiles, s.agent),
    });
  }

  const canContinue = !!(selected && (selected.alive || selected.pinned));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  // 前插后在绘制前保住阅读位置，不然自动加载会把视线顶到新拉来那页的开头（放 rAF 会先闪一帧）
  const prependRestoreRef = useRef<{ height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const restore = prependRestoreRef.current;
    const el = convScrollRef.current;
    prependRestoreRef.current = null;
    if (restore && el) el.scrollTop = restore.top + el.scrollHeight - restore.height;
  }, [messages]);

  useAutoLoadOlder(convScrollRef, {
    enabled: !loadingConv && cursor !== null,
    busy: loadingOlder,
    onLoad: loadOlder,
    fillKey: messages.length,
  });
  const prevRow = neighborFile(
    rows.map((s) => ({ path: sessionKey(s) })),
    selectedKey,
    -1,
  );
  const nextRow = neighborFile(
    rows.map((s) => ({ path: sessionKey(s) })),
    selectedKey,
    1,
  );

  function selectNeighbor(delta: -1 | 1) {
    const next = neighborFile(
      rowsRef.current.map((s) => ({ path: sessionKey(s) })),
      selectedKeyRef.current,
      delta,
    );
    if (next) setSelectedKey(next.path);
  }

  useEffect(() => {
    if (!selectedKey) return;
    const node = document.querySelector(
      `[data-session-key="${CSS.escape(selectedKey)}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    if (!selectedKey) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      selectNeighbor(event.key === "ArrowUp" ? -1 : 1);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedKey]);

  function openInSessions(s: SessionMetaDto) {
    setOpenSessionReq({ agent: s.agent, sessionId: s.sessionId });
    setPage("sessions");
  }

  function chatRow(s: SessionMetaDto, active: boolean, hideAgent: boolean) {
    const shown = tidySessionTitle(s);
    const isEditing =
      editing?.agent === s.agent && editing.sessionId === s.sessionId;
    if (isEditing && editing) {
      return (
        <input
          autoFocus
          className={`${compactFieldClass} w-full`}
          value={editing.title}
          onChange={(e) =>
            setEditing({ ...editing, title: e.target.value })
          }
          onCompositionStart={lockIme}
          onCompositionUpdate={lockIme}
          onCompositionEnd={unlockImeAfterFrame}
          onBlur={() => void saveTitle(s, editing.title)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(null);
              return;
            }
            if (e.key !== "Enter") return;
            if (
              imeBlocksEnter({
                isComposing: e.nativeEvent.isComposing,
                keyCode: e.nativeEvent.keyCode,
                composingLock: composingLockRef.current,
              })
            ) {
              return;
            }
            e.preventDefault();
            void saveTitle(s, editing.title);
          }}
        />
      );
    }
    const canResume = !!(s.alive || s.pinned);
    const isLive = s.live || !!liveSessions[sessionRuntimeKey(s.agent, s.sessionId)];
    // 步骤工作区里的对话标出是哪一步（检索/精读…），编程工作树标树名；主仓对话不标
    const where = s.stepName ?? s.workspace;
    return (
      <div
        data-session-key={sessionKey(s)}
        className={`flex min-h-9 min-w-0 items-center gap-1 rounded-md px-2 ${
          active ? "bg-hover" : "hover:bg-hover"
        }`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={() => setSelectedKey(sessionKey(s))}
        >
          {isLive &&
            (waitingTabs.has(liveSessions[sessionRuntimeKey(s.agent, s.sessionId)] ?? "") ? (
              <span
                className="size-2 shrink-0 rounded-full bg-warn-text"
                title="在等你确认（批准一个操作或选一项）"
                aria-label="等你确认"
              />
            ) : (
              <span
                className="size-2 shrink-0 rounded-full bg-ok-text"
                title="这条对话的 CLI 还在运行"
                aria-label="进行中"
              />
            ))}
          <span className="min-w-0 flex-1 truncate text-sm text-l2">
            {projectSessionLabel(shown)}
          </span>
          {!hideAgent && where && (
            <span
              className="max-w-[12rem] shrink-0 truncate text-micro text-l4"
              title={s.stepName ? `研究步骤：${s.stepName}` : `工作区：${where}`}
            >
              {where}
            </span>
          )}
          {!hideAgent && (
            <span
              className="shrink-0 rounded-full px-1.5 py-px text-micro font-medium"
              style={agentBrandBadgeStyle(s.agent)}
            >
              {agentLabel(s.agent)}
            </span>
          )}
        </button>
        <span
          className="shrink-0 text-micro text-l4 group-hover:hidden group-focus-within:hidden"
          title={absTime(s.updatedAt)}
        >
          {relTime(s.updatedAt)}
        </span>
        <div className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
          <button
            type="button"
            className={ghostActionClass}
            disabled={!canResume}
            title={canResume ? "在终端接着聊" : "源文件已失效，无法继续"}
            aria-label="继续"
            onClick={(event) => {
              event.stopPropagation();
              resumeInProject(s);
            }}
          >
            ▶
          </button>
          <button
            type="button"
            className={ghostActionClass}
            title="重命名"
            aria-label="重命名"
            onClick={(event) => {
              event.stopPropagation();
              setEditing({
                agent: s.agent,
                sessionId: s.sessionId,
                title: s.customTitle ?? shown.title,
              });
            }}
          >
            <Pencil size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={ghostActionClass}
            title="归档"
            aria-label="归档"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void archive(s);
            }}
          >
            <Archive size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>
    );
  }

  const heading = (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-l2">
        这个项目的对话
        {rows.length > 0 ? `（${rows.length}）` : ""}
      </h2>
      <button
        type="button"
        className={ghostActionClass}
        title="⌘ / Ctrl + 点可重选 Agent 和配置"
        onClick={(e) => startChat(e)}
      >
        ＋ 新对话
      </button>
    </div>
  );

  if (!selected) {
    return (
      <div className="min-h-[20rem]">
        {heading}
        {rows.length === 0 ? (
          <EmptyState
            compact
            title="还没有对话"
            action={
              <button
                type="button"
                className={compactPrimaryActionClass}
                onClick={(e) => startChat(e)}
              >
                ＋ 发起新对话
              </button>
            }
          />
        ) : (
          <ul className="space-y-0.5">
            {rows.map((s) => (
              <li key={sessionKey(s)} className="group min-w-0">
                {chatRow(s, false, false)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <section className="flex h-full min-h-0 w-full shrink-0 flex-col lg:w-[22rem] lg:pr-6">
        {heading}
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {rows.map((s) => (
            <li key={sessionKey(s)} className="group min-w-0">
              {chatRow(s, sessionKey(s) === sessionKey(selected), true)}
            </li>
          ))}
        </ul>
      </section>
      <section
        className={`ml-0 hidden h-full min-h-0 min-w-0 flex-1 flex-col lg:flex ${projectWellClass}`}
      >
        <header className="mb-2 flex shrink-0 items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate text-sm text-l1"
            title={projectSessionLabel(tidySessionTitle(selected))}
          >
            {projectSessionLabel(tidySessionTitle(selected))}
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 text-micro text-l4 xl:flex">
            <span
              className="rounded-full px-1.5 py-px font-medium"
              style={agentBrandBadgeStyle(selected.agent)}
            >
              {agentLabel(selected.agent)}
            </span>
            {selected.updatedAt ? (
              <span title={absTime(selected.updatedAt)}>
                {relTime(selected.updatedAt)}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className={rowActionClass}
            onClick={() => selectNeighbor(-1)}
            disabled={!prevRow}
            title="上一条（↑）"
          >
            ↑
          </button>
          <button
            type="button"
            className={rowActionClass}
            onClick={() => selectNeighbor(1)}
            disabled={!nextRow}
            title="下一条（↓）"
          >
            ↓
          </button>
          <button
            type="button"
            className={rowActionClass}
            disabled={!canContinue}
            title={canContinue ? "在终端接着聊" : "源文件已失效，无法继续"}
            onClick={() => resumeInProject(selected)}
          >
            继续
          </button>
          <button
            type="button"
            className={rowActionClass}
            title="到对话页看完整操作"
            onClick={() => openInSessions(selected)}
          >
            对话页
          </button>
          <button
            type="button"
            className={ghostActionClass}
            onClick={() => setSelectedKey(null)}
            aria-label="关闭预览"
          >
            ×
          </button>
        </header>
        <div ref={convScrollRef} className="min-h-0 flex-1 overflow-auto">
          {!selected.alive && !selected.pinned ? (
            <p className="px-1 py-6 text-sm text-l3">
              源文件已失效，没有可回放的内容。
            </p>
          ) : loadingConv ? (
            <LoadingRows compact />
          ) : (
            <>
              {messages.length === 0 ? (
                <p className="px-1 py-6 text-sm text-l3">
                  这条会话没有可回放的内容。
                </p>
              ) : (
                // 与对话页同一套排版（聊天字号字体、过程行、中途说明降级），只是气泡底色按井的底色重算
                <div className="ccode-chat-in-well">
                  <ConversationView
                    key={sessionKey(selected)}
                    messages={messages.slice(firstCompleteTurnIndex(messages, cursor !== null))}
                    cwd={selected.projectPath ?? project.path}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
