import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Folder, MessageSquare, Search } from "lucide-react";
import { createPortal } from "react-dom";
import { Modal } from "./Modal";
import RunCaret from "./RunCaret";
import { useAnimatedDismiss } from "../exit-animation";
import { imeBlocksEnter } from "../ime-guard";
import { absTime, relTime } from "../rel-time";
import {
  railSearch,
  type RailSearchChat,
  type RailSearchHit,
  type RailSearchFilter,
  type RailSearchProject,
} from "../rail-search";

/** 侧栏固定搜索入口打开的搜索弹层（2026-10-24 照 Claude 客户端）：
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
  const [filter, setFilter] = useState<RailSearchFilter>("all");
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const composingRef = useRef(false);
  const { dismiss, exiting } = useAnimatedDismiss(onClose);
  const hits = useMemo(() => railSearch(chats, projects, query, filter), [chats, projects, query, filter]);
  const searching = query.trim() !== "";

  const activeIndex = Math.min(index, hits.length - 1);
  // 键盘移到可视区外时跟着滚
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, hits]);

  const openAt = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    onClose();
    if (hit.kind === "chat") onOpenChat(hit.item);
    else onOpenProject(hit.item);
  };

  const groupOf = (hit: RailSearchHit<C, P>) =>
    !searching ? "最近对话" : hit.kind === "project" ? "项目" : "对话";

  return createPortal(
    <Modal
      open
      title="搜索对话和项目"
      onClose={dismiss}
      initialFocusRef={inputRef}
      size="lg"
      layer="overlay"
      overflow="hidden"
      panelClassName={`self-start mt-[8vh] max-h-[80vh]! ${exiting ? "ccode-exiting" : ""}`}
      contentClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center gap-2.5 border-b border-hairline">
        <Search size={16} strokeWidth={1.8} className="shrink-0 text-l3" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
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
              if (n) setIndex((activeIndex + 1) % n);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (n) setIndex((activeIndex - 1 + n) % n);
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
              if (!exiting) openAt(activeIndex);
            }
          }}
          placeholder="搜索对话和项目"
          aria-label="搜索对话和项目"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          className="ccode-picker-search h-12 min-w-0 flex-1 bg-transparent text-sm text-l1 outline-none placeholder:text-l4"
        />
      </div>
      <div role="group" aria-label="对话状态筛选" className="-ml-2.5 flex shrink-0 flex-wrap gap-1 py-2">
        {([
          ["all", "全部"], ["working", "运行中"], ["confirm", "等确认"], ["unread", "未读"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => { setFilter(value); setIndex(0); inputRef.current?.focus(); }}
            className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs ${filter === value ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover"}`}
          >
            {value !== "all" && <RunCaret state={value} decorative />}
            <span className="text-xs">{label}</span>
          </button>
        ))}
      </div>
      <span role="status" className="sr-only">{hits.length} 条结果</span>
      <ul ref={listRef} id={listId} role="listbox" aria-label="搜索结果" className="-mx-2.5 min-h-0 max-h-[min(480px,50vh)] overflow-auto py-1.5">
        {hits.map((hit, i) => {
          const selected = i === activeIndex;
          const group = groupOf(hit);
          const showGroup = searching && (i === 0 || groupOf(hits[i - 1]) !== group);
          const Icon = hit.kind === "project" ? Folder : MessageSquare;
          const title = hit.kind === "project" ? hit.item.name : hit.item.title;
          const sub = hit.kind === "project" ? hit.item.path : hit.item.folder;
          const when = hit.kind === "chat" ? relTime(hit.item.updatedAt) : "";
          return (
            <li key={`${hit.kind}:${hit.item.key}`} role="presentation">
              {showGroup && <div aria-hidden="true" className="px-2.5 pb-1 pt-2 text-micro text-l3">{group}</div>}
              <div
                role="option"
                id={`${listId}-${i}`}
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                data-idx={i}
                onClick={() => { if (!exiting) openAt(i); }}
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
              </div>
            </li>
          );
        })}
      </ul>
      {hits.length === 0 && (
        <p className="px-3.5 py-8 text-center text-xs text-l3">
          {filter !== "all" ? "没有符合当前筛选的对话，试试「全部」或更换关键词" : searching ? `没有匹配「${query.trim()}」的对话或项目` : "还没有对话"}
        </p>
      )}
    </Modal>,
    document.body,
  );
}
