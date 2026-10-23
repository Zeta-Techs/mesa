// 出图模型选择器（2026-10-24 用户：「筛选框太长了，常用的、最新的放在前面」）。
// 锚在按钮下沿的浮层：搜索框 → 最近用过 → 推荐（各家最新一个）→ 按家族折叠的全部。
// single = 选一个就关；multi = 勾选多个（对比用），点外面或 Esc 关。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { FoldMark, searchFieldClass } from "./PageFrame";
import { useDownMenu } from "./LaunchMenu";
import {
  groupImageModels,
  itemKey,
  recommendedImageModels,
  type ImageModelItem,
} from "../image-models";

export default function ImageModelPicker({
  anchorRef,
  open,
  onClose,
  items,
  recent,
  selected,
  multi = false,
  maxSelected,
  onPick,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  items: ImageModelItem[];
  /** 最近用过（itemKey 列表，新的在前） */
  recent: string[];
  /** 已选（itemKey） */
  selected: string[];
  multi?: boolean;
  /** multi 时最多选几个；到上限后未选的项置灰 */
  maxSelected?: number;
  onPick: (item: ImageModelItem) => void;
}) {
  const { box, exiting, closeNow } = useDownMenu(open, anchorRef, 380);
  const panelRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set());
  // 竖向位置自己算：这块常在页面最底下，下方放不下就翻到按钮上方（启动栏菜单只往下长、最高 320）
  const [vert, setVert] = useState<{ top?: number; bottom?: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!box) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    setVert(
      below >= 300 || below >= above
        ? { top: rect.bottom + 4, maxHeight: Math.min(420, below) }
        : { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.min(420, above) },
    );
  }, [box, anchorRef]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  const byKey = useMemo(() => new Map(items.map((i) => [itemKey(i), i])), [items]);
  const recentItems = recent.map((k) => byKey.get(k)).filter((i): i is ImageModelItem => Boolean(i));
  const recommended = useMemo(() => recommendedImageModels(items), [items]);
  const families = useMemo(() => groupImageModels(items, filter), [items, filter]);
  // 同一个模型出现在多个网关时才在行尾写网关名
  const multiGateway = new Set(items.map((i) => i.gatewayId)).size > 1;
  const full = multi && maxSelected !== undefined && selected.length >= maxSelected;

  if (!box || !vert || typeof document === "undefined") return null;

  const row = (it: ImageModelItem, keyPrefix: string) => {
    const k = itemKey(it);
    const on = selected.includes(k);
    return (
      <button
        key={`${keyPrefix}${k}`}
        type="button"
        role="option"
        aria-selected={on}
        disabled={full && !on}
        onClick={() => {
          onPick(it);
          if (!multi) {
            closeNow();
            onClose();
          }
        }}
        className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left disabled:opacity-40 ${
          on ? "bg-hover text-l1" : "text-l2 hover:bg-hover hover:text-l1"
        }`}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{it.model}</span>
        {multiGateway && <span className="shrink-0 truncate text-micro text-l3">{it.gatewayName}</span>}
        <Check size={14} strokeWidth={2} aria-hidden="true" className={on ? "shrink-0 text-l2" : "invisible shrink-0"} />
      </button>
    );
  };
  const heading = (text: string) => (
    <p className="px-2.5 pb-0.5 pt-2 text-micro font-medium text-l3">{text}</p>
  );

  return createPortal(
    <div
      ref={panelRef}
      role="listbox"
      aria-label="出图模型"
      aria-multiselectable={multi || undefined}
      style={{
        top: vert.top,
        bottom: vert.bottom,
        left: box.left,
        width: box.width,
        maxHeight: vert.maxHeight,
        // 翻到上方时从下沿长出来（锚定展开口径同 .ccode-anchor-topleft）
        transformOrigin: vert.bottom !== undefined ? "bottom left" : "top left",
      }}
      className={`ccode-float-surface fixed z-50 flex flex-col overflow-hidden rounded-md border border-field${exiting ? " ccode-exiting" : ""}`}
    >
      <div className="shrink-0 p-1.5">
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜模型、网关或厂商（如 万相、grok）"
          className={`${searchFieldClass} w-full`}
        />
        {multi && maxSelected !== undefined && (
          <p className="px-1 pt-1 text-micro text-l3">
            已选 {selected.length} / {maxSelected}，一起出图对比
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {items.length === 0 && <p className="px-2.5 py-2 text-xs text-l3">网关目录里没有出图模型</p>}
        {!filter.trim() && recentItems.length > 0 && (
          <>
            {heading("最近用过")}
            {recentItems.map((it) => row(it, "r:"))}
          </>
        )}
        {!filter.trim() && recommended.length > 0 && (
          <>
            {heading("推荐 · 各家最新")}
            {recommended.map((it) => row(it, "p:"))}
          </>
        )}
        {filter.trim() && families.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-l3">没有匹配的出图模型</p>
        )}
        {families.length > 0 && !filter.trim() && heading("全部")}
        {families.map((g) => {
          const expanded = filter.trim() !== "" || openFamilies.has(g.key);
          return (
            <div key={g.key}>
              <button
                type="button"
                onClick={() =>
                  setOpenFamilies((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    return next;
                  })
                }
                className="flex h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-l2 hover:bg-hover"
              >
                <FoldMark open={expanded} />
                <span className="min-w-0 flex-1 truncate text-xs">{g.label}</span>
                <span className="text-micro text-l3">{g.items.length}</span>
              </button>
              {expanded && <div className="pl-4">{g.items.map((it) => row(it, "a:"))}</div>}
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
