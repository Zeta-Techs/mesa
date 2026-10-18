import { useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Archive,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { confirmDialog } from "./ConfirmDialog";
import ContextMenu from "./ContextMenu";
import {
  compactPrimaryActionClass,
  FoldMark,
  ghostActionClass,
  inlineActionClass,
  projectWellClass,
  searchFieldClass,
} from "./PageFrame";
import { useAppStore } from "../store";
import { IS_WINDOWS } from "../hotkeys";
import { absTime, relTime } from "../rel-time";
import { imeBlocksEnter } from "../ime-guard";
import { filterProjectSessions } from "../project-status";
import { metadataMatchesQuery, tokenizeSearchQuery } from "../session-search";
import {
  projectSessionLabel,
  splitRecentItems,
  tidySessionTitle,
} from "../session-title";
import { resumeSessionInTerminal } from "../quick-chat-launch";
import { projectBoundProfileId } from "../project-agents";
import type { SessionMetaDto } from "../types";

function sessionKey(s: SessionMetaDto) {
  return `${s.agent}:${s.sessionId}`;
}

function deleteSessionPrompt(s: SessionMetaDto): string {
  if (s.agent === "opencode") {
    return "删除该 OpenCode 对话？将从共享数据库抹掉记录，不能进回收站。";
  }
  return "删除该对话的本地文件？源文件将移入系统回收站（可找回）。";
}

/** @deprecated 宽度改由 `.ccode-project-work-well` 容器查询承担，勿再加 lg: 宽度类。 */
export const sessionsAsideOpenClass = "";

function sessionMatchesQuery(s: SessionMetaDto, query: string): boolean {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return true;
  if (metadataMatchesQuery(s, tokens)) return true;
  const hay = tidySessionTitle(s).title.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

export default function ProjectSessionsSection({
  projectPath,
  extraRoots = [],
  defaultOpen = false,
  hideIfEmpty = false,
  variant = "section",
  collapsed = false,
  fold = true,
  title = "这个项目的对话",
  empty,
  extra,
  onNewChat,
  onToggle,
  onError,
  defaultProfiles,
}: {
  projectPath: string;
  extraRoots?: string[];
  defaultOpen?: boolean;
  hideIfEmpty?: boolean;
  variant?: "section" | "sidebar";
  collapsed?: boolean;
  /** false = 不折叠，给办公侧栏卡片用 */
  fold?: boolean;
  title?: string;
  empty?: ReactNode;
  extra?: ReactNode;
  /** 侧栏「＋ 新对话」：有会话时在标题行，没有时在空态 */
  onNewChat?: (e: { metaKey: boolean; ctrlKey: boolean }) => void;
  onToggle?: () => void;
  onError?: (msg: string) => void;
  /** 项目 Agents 页为各家绑定的配置；继续会话时优先用 */
  defaultProfiles?: Record<string, string> | null;
}) {
  const sessions = useAppStore((s) => s.sessions);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const setPage = useAppStore((s) => s.setPage);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const [open, setOpen] = useState(defaultOpen || !fold);
  const [query, setQuery] = useState("");
  const [olderOpen, setOlderOpen] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    session: SessionMetaDto;
  } | null>(null);
  const [editing, setEditing] = useState<{
    agent: string;
    sessionId: string;
    title: string;
  } | null>(null);
  const composingLockRef = useRef(false);
  const composingFrameRef = useRef<number | null>(null);

  const rows = useMemo(
    () =>
      filterProjectSessions(sessions, projectPath, extraRoots, {
        isWindows: IS_WINDOWS,
      }),
    [sessions, projectPath, extraRoots],
  );
  const visible = useMemo(
    () => rows.filter((s) => sessionMatchesQuery(s, query)),
    [rows, query],
  );
  const searching = !!query.trim();
  const { recent, older } = useMemo(
    () => (searching ? { recent: visible, older: [] } : splitRecentItems(visible, 8)),
    [searching, visible],
  );

  if (hideIfEmpty && rows.length === 0) return null;

  const sidebar = variant === "sidebar";
  const bodyOpen = sidebar ? !collapsed : fold ? open : true;

  const newChatHeader = onNewChat ? (
    <button
      type="button"
      className={inlineActionClass}
      title="⌘ / Ctrl + 点可重选 Agent 和配置"
      onClick={(e) =>
        onNewChat({ metaKey: e.metaKey, ctrlKey: e.ctrlKey })
      }
    >
      ＋ 新对话
    </button>
  ) : null;
  const headerExtra = extra ?? newChatHeader;
  const emptyBody =
    empty ??
    (onNewChat ? (
      <button
        type="button"
        className={`${compactPrimaryActionClass} w-full`}
        title="⌘ / Ctrl + 点可重选 Agent 和配置"
        onClick={(e) =>
          onNewChat({ metaKey: e.metaKey, ctrlKey: e.ctrlKey })
        }
      >
        ＋ 发起新对话
      </button>
    ) : (
      <p className="px-1 py-2 text-xs text-l4">这个项目还没有对话</p>
    ));

  function openSession(s: SessionMetaDto) {
    setOpenSessionReq({ agent: s.agent, sessionId: s.sessionId });
    setPage("sessions");
  }

  function lockIme() {
    if (composingFrameRef.current != null) {
      cancelAnimationFrame(composingFrameRef.current);
      composingFrameRef.current = null;
    }
    composingLockRef.current = true;
  }

  function unlockImeAfterFrame() {
    composingLockRef.current = true;
    composingFrameRef.current = requestAnimationFrame(() => {
      composingLockRef.current = false;
      composingFrameRef.current = null;
    });
  }

  async function togglePin(s: SessionMetaDto) {
    try {
      if (s.pinned) {
        if (!(await confirmDialog("取消保留并删除本地快照？", { danger: true })))
          return;
        await invoke("unpin_session", {
          agent: s.agent,
          sessionId: s.sessionId,
          deleteSnapshot: true,
        });
      } else {
        await invoke("pin_session", {
          agent: s.agent,
          sessionId: s.sessionId,
          filePath: s.filePath,
        });
      }
      await loadSessions(true);
    } catch (e) {
      onError?.(String(e));
    }
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
      await loadSessions(true);
    } catch (e) {
      onError?.(String(e));
    }
  }

  async function toggleArchive(s: SessionMetaDto) {
    try {
      await invoke("set_session_meta", {
        agent: s.agent,
        sessionId: s.sessionId,
        customTitle: s.customTitle,
        tags: s.tags,
        archived: !s.archived,
      });
      await loadSessions(true);
    } catch (e) {
      onError?.(String(e));
    }
  }

  async function removeSession(s: SessionMetaDto) {
    if (!(await confirmDialog(deleteSessionPrompt(s), { danger: true }))) return;
    try {
      await invoke("delete_session", {
        agent: s.agent,
        sessionId: s.sessionId,
        filePath: s.filePath,
      });
      await loadSessions(true);
    } catch (e) {
      onError?.(String(e));
    }
  }

  if (sidebar && collapsed) {
    return (
      <button
        type="button"
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
        onClick={onToggle}
        aria-expanded={false}
        title="展开这个项目的对话"
      >
        <PanelRightOpen size={14} strokeWidth={1.8} />
        <MessageSquare size={14} strokeWidth={1.8} />
        {rows.length > 0 ? rows.length : null}
      </button>
    );
  }

  const heading = (
    <div className="mb-2.5 min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        {sidebar ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={onToggle}
            aria-expanded={true}
            aria-label={`收起${title}`}
          >
            <MessageSquare size={14} strokeWidth={1.8} className="shrink-0 text-l4" />
            <h2 className="min-w-0 truncate text-xs font-medium text-l2">
              {title}
              {rows.length > 0 ? `（${rows.length}）` : ""}
            </h2>
          </button>
        ) : fold ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <FoldMark open={open} boxed />
            <MessageSquare size={14} strokeWidth={1.8} className="shrink-0 text-l4" />
            <h2 className="min-w-0 truncate text-xs font-medium text-l2">
              {title}
              {rows.length > 0 ? `（${rows.length}）` : ""}
            </h2>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <MessageSquare size={14} strokeWidth={1.8} className="shrink-0 text-l4" />
            <h2 className="min-w-0 truncate text-xs font-medium text-l2">
              {title}
              {rows.length > 0 ? `（${rows.length}）` : ""}
            </h2>
          </div>
        )}
        {headerExtra && rows.length > 0 ? headerExtra : null}
        {bodyOpen && rows.length > 0 && !sidebar && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索"
            aria-label="搜索本项目会话"
            className={`${searchFieldClass} ml-auto w-44`}
          />
        )}
        {sidebar && onToggle && (
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
            onClick={onToggle}
            aria-label="收起会话"
            title="收起"
          >
            <PanelRightClose size={14} strokeWidth={1.8} />
          </button>
        )}
      </div>
      {bodyOpen && rows.length > 0 && sidebar && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索"
          aria-label="搜索本项目会话"
          className={`${searchFieldClass} mt-2 w-full`}
        />
      )}
    </div>
  );

  return (
    <section className={sidebar ? "min-h-0" : undefined}>
      {heading}
      {bodyOpen &&
        (rows.length === 0 ? (
          emptyBody
        ) : visible.length === 0 ? (
          <p className="px-1 py-2 text-xs text-l4">没有匹配</p>
        ) : (
          <div className={sidebar ? undefined : projectWellClass}>
          <ul className={sidebar ? "max-h-[min(70vh,28rem)] space-y-0.5 overflow-auto" : "space-y-0.5"}>
            {(olderOpen ? visible : recent).map((s) => {
              const shown = tidySessionTitle(s);
              const label = projectSessionLabel(shown);
              const isEditing =
                editing?.agent === s.agent && editing.sessionId === s.sessionId;
              return (
                <li key={sessionKey(s)} className="group min-w-0">
                  {isEditing ? (
                    <input
                      autoFocus
                      className={`${searchFieldClass} w-full`}
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
                  ) : (
                    <div className="flex min-h-9 min-w-0 items-center gap-1 rounded-md px-2 hover:bg-hover">
                      {s.pinned && (
                        <button
                          type="button"
                          className="shrink-0 px-0.5 text-xs text-l2 hover:text-cta"
                          title="已保留（点击取消）"
                          aria-label="取消保留"
                          onClick={() => void togglePin(s)}
                        >
                          ⚑
                        </button>
                      )}
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
                        onClick={() => openSession(s)}
                      >
                        <span
                          className="min-w-0 flex-1 truncate text-sm text-l2"
                          title={shown.unnamed ? undefined : shown.title}
                        >
                          {label}
                        </span>
                        {shown.interrupted && (
                          <span className="shrink-0 rounded-full bg-warn px-1.5 py-px text-micro text-warn-text">
                            已中断
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
                          className={`${ghostActionClass} whitespace-nowrap`}
                          disabled={!s.alive && !s.pinned}
                          title={
                            s.alive || s.pinned
                              ? "在终端接着聊"
                              : "源文件已失效，无法继续"
                          }
                          aria-label="继续"
                          onClick={() =>
                            resumeSessionInTerminal(s, {
                              preferredProfileId: projectBoundProfileId(
                                defaultProfiles,
                                s.agent,
                              ),
                            })
                          }
                        >
                          ▶
                        </button>
                        <button
                          type="button"
                          className={`${ghostActionClass} whitespace-nowrap`}
                          title="归档"
                          aria-label="归档"
                          onClick={() => void toggleArchive(s)}
                        >
                          <Archive size={14} strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          className={`${ghostActionClass} whitespace-nowrap`}
                          title="更多"
                          aria-label="更多"
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setMenu({
                              x: r.right,
                              y: r.bottom + 4,
                              session: s,
                            });
                          }}
                        >
                          ⋯
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            {older.length > 0 && !olderOpen && !searching && (
              <li>
                <button
                  type="button"
                  className="flex h-8 w-full items-center px-2 text-xs text-l4 hover:text-l2"
                  onClick={() => setOlderOpen(true)}
                >
                  更早 {older.length}
                </button>
              </li>
            )}
          </ul>
          </div>
        ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            {
              icon: menu.session.pinned ? PinOff : Pin,
              label: menu.session.pinned ? "取消保留" : "保留",
              onSelect: () => void togglePin(menu.session),
            },
            {
              icon: Pencil,
              label: "重命名",
              onSelect: () =>
                setEditing({
                  agent: menu.session.agent,
                  sessionId: menu.session.sessionId,
                  title:
                    menu.session.customTitle ??
                    tidySessionTitle(menu.session).title,
                }),
            },
            { separator: true },
            {
              icon: Trash2,
              label: "删除",
              danger: true,
              onSelect: () => void removeSession(menu.session),
            },
          ]}
        />
      )}
    </section>
  );
}
