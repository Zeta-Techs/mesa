import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Folder, MessageSquare, Search, X } from "lucide-react";
import { useAnimatedDismiss } from "../exit-animation";
import { imeBlocksEnter } from "../ime-guard";
import { absTime, relTime } from "../rel-time";
import {
  railSearch,
  type RailSearchChat,
  type RailSearchHit,
  type RailSearchProject,
} from "../rail-search";

/** 侧栏「项目」标签行放大镜打开的搜索弹层（2026-10-24 照 Claude 客户端）：
 *  对话和项目一起搜，不输入时列最近的对话；↑↓ 选、回车打开、Esc 关。
 *  打开什么由宿主（ProjectTree）给回调，本组件只管列和选。 */
export default function RailSearchPalette<C, P>({
  chats,
  projects,
  onOpenChat,
  onOpenProject,
  onClose,
}: {
  chats: RailSearchChat<C>[];
  projects: RailSearchProject<P>[];
  onOpenChat: (chat: RailSearchChat<C>) => void;
  onOpenProject: (project: RailSearchProject<P>) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const composingRef = useRef(false);
  const { dismiss, exiting } = useAnimatedDismiss(onClose);
  const hits = useMemo(() => railSearch(chats, projects, query), [chats, projects, query]);
  const searching = query.trim() !== "";

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);
  // 键盘移到可视区外时跟着滚
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const openAt = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    onClose();
    if (hit.kind === "chat") onOpenChat(hit.item);
    else onOpenProject(hit.item);
  };

  const groupOf = (hit: RailSearchHit<C, P>) =>
    !searching ? "最近对话" : hit.kind === "project" ? "项目" : "对话";

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-black/40 ccode-fade${exiting ? " ccode-exiting" : ""}`}
      onClick={dismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="搜索对话和项目"
        className={`ccode-command-palette ccode-anchor-top mt-[10vh] h-fit w-[min(640px,calc(100vw-32px))] overflow-hidden rounded-xl border border-field ccode-float-surface${exiting ? " ccode-exiting" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-hairline px-4">
          <Search size={16} strokeWidth={1.8} className="shrink-0 text-l3" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              requestAnimationFrame(() => {
                composingRef.current = false;
              });
            }}
            onKeyDown={(e) => {
              const n = hits.length;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (n) setIndex((i) => (i + 1) % n);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (n) setIndex((i) => (i - 1 + n) % n);
              } else if (e.key === "Enter") {
                // 组词中 / 确认候选的那次 Enter 只上屏
                if (
                  imeBlocksEnter({
                    isComposing: e.nativeEvent.isComposing,
                    keyCode: e.keyCode,
                    composingLock: composingRef.current,
                  })
                ) {
                  return;
                }
                e.preventDefault();
                if (!exiting) openAt(index);
              } else if (e.key === "Escape") {
                e.preventDefault();
                dismiss();
              }
            }}
            placeholder="搜索对话和项目"
            aria-label="搜索对话和项目"
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-l1 outline-none placeholder:text-l4"
          />
          <button
            type="button"
            onClick={dismiss}
            aria-label="关闭"
            title="关闭（Esc）"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
          >
            <X size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <ul ref={listRef} className="max-h-[min(480px,64vh)] overflow-auto p-1.5">
          {hits.map((hit, i) => {
            const selected = i === index;
            const group = groupOf(hit);
            const showGroup = searching && (i === 0 || groupOf(hits[i - 1]) !== group);
            const Icon = hit.kind === "project" ? Folder : MessageSquare;
            const title = hit.kind === "project" ? hit.item.name : hit.item.title;
            const sub = hit.kind === "project" ? hit.item.path : hit.item.folder;
            const when = hit.kind === "chat" ? relTime(hit.item.updatedAt) : "";
            return (
              <li key={`${hit.kind}:${hit.item.key}`}>
                {showGroup && <div className="px-2.5 pb-1 pt-2 text-micro text-l3">{group}</div>}
                <button
                  type="button"
                  data-idx={i}
                  onClick={() => openAt(i)}
                  // 用 mousemove 而不是 mouseenter：键盘滚动列表时，停着的鼠标不该把选中抢走
                  onMouseMove={() => {
                    if (!selected) setIndex(i);
                  }}
                  title={
                    hit.kind === "chat"
                      ? `${hit.item.fullTitle}\n${hit.item.folder}${hit.item.updatedAt ? ` · ${absTime(hit.item.updatedAt)}` : ""}`
                      : hit.item.path
                  }
                  className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors ${
                    selected ? "bg-seg-sel text-l1" : "text-l2"
                  }`}
                >
                  <Icon
                    size={14}
                    strokeWidth={1.8}
                    aria-hidden="true"
                    className={`shrink-0 ${selected ? "text-l2" : "text-l3"}`}
                  />
                  <span className="min-w-0 shrink truncate text-sm">{title}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-l4">{sub}</span>
                  {selected ? (
                    <CornerDownLeft size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                  ) : (
                    when && <span className="shrink-0 text-xs text-l4">{when}</span>
                  )}
                </button>
              </li>
            );
          })}
          {hits.length === 0 && (
            <li className="px-3.5 py-8 text-center text-xs text-l4">
              {searching ? `没有匹配「${query.trim()}」的对话或项目` : "还没有对话"}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
