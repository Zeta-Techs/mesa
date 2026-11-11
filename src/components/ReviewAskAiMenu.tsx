import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export interface ReviewAskAiItem {
  key: string;
  label: string;
  /** 一句话说清它做什么（第一次用的人分得清三样） */
  desc: string;
  onClick: () => void;
  disabled?: boolean;
  /** 字标黄（复核方与写稿同一模型族） */
  warn?: boolean;
  /** 行尾的小入口（复核那一行的「换一家」） */
  trailing?: ReactNode;
}

/**
 * 评审页「请 AI 看看 ▾」（2026-11-11 用户：项目助手 / 复核 / 研讨三个文字按钮摊在工具栏上又散又不知道做什么）。
 * 三样收进一个菜单，每样下面一句说明；都只读、不改稿件，结论由人定。
 * 复核那一行的「换一家」是 AgentModelPicker，弹层挂在 body 上——点它不算点到菜单外面。
 */
export default function ReviewAskAiMenu({ items }: { items: readonly ReviewAskAiItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (rootRef.current?.contains(target)) return;
      if (target?.closest?.(".ccode-float-surface")) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        title="让别的 AI 帮你看这一步交的东西；它们只看不改，结论由你定"
        className="flex items-center gap-0.5 rounded-sm px-1 text-l3 hover:bg-hover hover:text-l1"
      >
        请 AI 看看
        <ChevronDown aria-hidden="true" className="h-3 w-3" />
      </button>
      {open && (
        <div
          role="menu"
          className="ccode-float-surface absolute top-full left-0 z-40 mt-1 w-80 rounded-lg border border-field p-1 shadow-lg"
        >
          {items.map((item) => (
            <div key={item.key} className="flex items-start gap-1 rounded-md hover:bg-hover">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className="min-w-0 flex-1 px-2 py-1.5 text-left disabled:opacity-50"
              >
                <span className={`block text-xs ${item.warn ? "text-warn-text" : "text-l1"}`}>{item.label}</span>
                <span className="mt-0.5 block text-micro leading-snug text-l4">{item.desc}</span>
              </button>
              {item.trailing && <span className="shrink-0 pt-1.5 pr-1">{item.trailing}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
