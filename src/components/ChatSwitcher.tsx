import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, MessageSquare, SquarePen, SquareTerminal } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { paletteOpenChats, recentChats, sidebarChatTitle, type PaletteOpenChat } from "../sidebar-chats";
import { tidySessionTitle } from "../session-title";
import { openConversation } from "../quick-chat-launch";
import { relTime } from "../rel-time";
import { projectOfCwd } from "../start-page";
import { isScratchCwd } from "../quick-chat";
import { IS_WINDOWS } from "../hotkeys";
import { RUN_CARET_LABEL } from "../run-caret";
import { useAnimatedDismiss } from "../exit-animation";
import type { ProjectDto, SessionMetaDto } from "../types";
import RunCaret from "./RunCaret";

/**
 * 灵动岛上的对话切换器（2026-10-24 用户定 A+D+E 的 D）：侧栏完全隐藏时，岛上「你在哪」那一格在运行页写正看着的对话名，
 * 展开面里同一格可点，往下弹「打开的对话」（同 ⌘K 那一组：sidebar-chats.paletteOpenChats）+「最近对话」（没开着的，
 * sidebar-chats.recentChats；2026-10-30 用户：这里要的是最近对话，不是「对话管理」入口）。
 * 活动胶囊照旧只管「谁在跑 / 谁等你」，这里管「切到哪一段」。
 */

/** 正看着的那段叫什么（运行页、有正看着的标签时）；没有返回 null，岛上照旧写页名 */
export function useCurrentChatLabel(): string | null {
  const page = useAppStore((s) => s.page);
  const runs = useAppStore((s) => s.terminalRunInputs);
  const active = useAppStore((s) => s.terminalActiveTabId);
  if (page !== "terminal" || !active) return null;
  return paletteOpenChats(runs, active).find((c) => c.current)?.label ?? null;
}

export function ChatSwitcherButton({ tabIndex }: { tabIndex?: number }) {
  const page = useAppStore((s) => s.page);
  const runs = useAppStore((s) => s.terminalRunInputs);
  const active = useAppStore((s) => s.terminalActiveTabId);
  const unreadChats = useAppStore((s) => s.unreadChats);
  const sessions = useAppStore((s) => s.sessions);
  const chats = paletteOpenChats(runs, page === "terminal" ? active : null, new Set(unreadChats));
  const recent = useMemo(() => recentChats(sessions, runs), [sessions, runs]);
  const current = chats.find((c) => c.current) ?? null;
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  if (chats.length === 0 && recent.length === 0) return null;
  return (
    <>
      <button
        type="button"
        tabIndex={tabIndex}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        title={current ? `正看着：${current.fullTitle}\n点开切到别的对话` : "开着的和最近的对话，点开切过去"}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ left: r.left, top: r.bottom + 6 });
        }}
        className={`ccode-top-nav-item shrink-0 ${current ? "ccode-top-nav-item-active" : ""}`}
      >
        <MessageSquare size={15} strokeWidth={1.8} aria-hidden="true" />
        <span className="max-w-[12em] truncate">
          {current ? current.label : chats.length ? `打开的对话 ${chats.length}` : "最近对话"}
        </span>
        <ChevronDown size={12} strokeWidth={2} aria-hidden="true" className="-ml-0.5 opacity-70" />
      </button>
      {anchor && (
        <ChatSwitcherPanel left={anchor.left} top={anchor.top} chats={chats} recent={recent} onClose={() => setAnchor(null)} />
      )}
    </>
  );
}

function ChatSwitcherPanel({
  left,
  top,
  chats,
  recent,
  onClose,
}: {
  left: number;
  top: number;
  chats: readonly PaletteOpenChat[];
  recent: readonly SessionMetaDto[];
  onClose: () => void;
}) {
  const { dismiss, exiting } = useAnimatedDismiss(onClose);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left, top });
  const [projects, setProjects] = useState<ProjectDto[]>([]);

  useEffect(() => {
    let alive = true;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => alive && setProjects(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPos({
      left: Math.max(8, Math.min(left, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - el.offsetHeight - 8)),
    });
  }, [left, top]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("[data-switch-row]")?.focus({ preventScroll: true });
  }, []);

  const placeOf = (cwd: string) => {
    const p = projectOfCwd(cwd, projects.map((x) => x.path), IS_WINDOWS);
    if (p) return projects.find((x) => x.path === p)?.name ?? "";
    return isScratchCwd(cwd, IS_WINDOWS) ? "随手聊" : "";
  };
  const where = (c: PaletteOpenChat) => (c.kind === "terminal" ? "终端" : placeOf(c.cwd));

  /** 最近对话：同侧栏点一段（openConversation：接回终端 / 源文件不在时进对话页） */
  function resume(s: SessionMetaDto) {
    onClose();
    openConversation(s);
  }

  function go(tabId: string) {
    const s = useAppStore.getState();
    s.setPage("terminal");
    s.focusTab(tabId);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-switch-row]"));
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const d = e.key === "ArrowDown" ? 1 : -1;
    list[(i + d + list.length) % list.length].focus();
  }

  // 挂到 body：岛带 transform + backdrop-filter，会把 fixed 子元素的定位基准改成岛自己（同活动面板）
  return createPortal(
    <div
      className={`fixed inset-0 z-50${exiting ? " ccode-exiting" : ""}`}
      onClick={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label="切换对话"
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={pos}
        className={`ccode-anchor-topleft ccode-float-surface absolute w-80 rounded-lg border border-field${exiting ? " ccode-exiting" : ""}`}
      >
        <div className="max-h-[min(30rem,70vh)] overflow-y-auto">
          {chats.length > 0 && (
            <>
              <div className="flex h-9 items-center px-3 text-xs font-medium text-l1">打开的对话</div>
              <div className="border-t border-hairline p-1.5">
                {chats.map((c) => {
                  const Icon = c.kind === "terminal" ? SquareTerminal : c.kind === "new" ? SquarePen : null;
                  const state = c.current
                    ? "正看着"
                    : c.caret === "confirm" || c.caret === "unread" || c.caret === "working"
                      ? RUN_CARET_LABEL[c.caret]
                      : "";
                  const place = where(c);
                  return (
                    <button
                      key={c.tabId}
                      type="button"
                      data-switch-row
                      aria-current={c.current ? "true" : undefined}
                      title={c.fullTitle}
                      onClick={() => go(c.tabId)}
                      className={`ccode-menu-item flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover ${
                        c.current ? "bg-rail-sel" : ""
                      }`}
                    >
                      {Icon && <Icon size={13} strokeWidth={1.8} className="shrink-0 text-l3" aria-hidden="true" />}
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-xs ${c.current ? "text-l1" : "text-l2"}`}>{c.label}</span>
                        {(place || state) && (
                          <span className={`block truncate text-micro ${c.caret === "confirm" && !c.current ? "text-warn-text" : "text-l3"}`}>
                            {[state, place].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </span>
                      {c.caret && <RunCaret state={c.caret} decorative className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {recent.length > 0 && (
            <>
              <div
                className={`flex h-9 items-center px-3 text-xs font-medium text-l1${chats.length ? " border-t border-hairline" : ""}`}
              >
                最近对话
              </div>
              <div className="border-t border-hairline p-1.5">
                {recent.map((s) => {
                  const full = tidySessionTitle(s).title;
                  const place = placeOf(s.projectPath);
                  const when = relTime(s.updatedAt);
                  return (
                    <button
                      key={`${s.agent}\n${s.sessionId}`}
                      type="button"
                      data-switch-row
                      title={full}
                      onClick={() => resume(s)}
                      className="ccode-menu-item flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-l2">{sidebarChatTitle(full, place)}</span>
                        {place && <span className="block truncate text-micro text-l3">{place}</span>}
                      </span>
                      {when && <span className="shrink-0 text-micro text-l3">{when}</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
