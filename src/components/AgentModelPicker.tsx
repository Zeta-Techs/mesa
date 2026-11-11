import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { AGENTS } from "../types";
import { useMenuKeyNav } from "../menu-key-nav";
import { pickPopoverSide, popoverRoom } from "../popover-side";
import { groupByAgent, type AgentModelOption } from "../agent-model-groups";
import { AgentMark } from "./RelayPicker";

const MENU_CAP = 460;
// 行的样子同聊天层的模型菜单 / 换 Agent（ChatModelMenu、RelayPicker）：选中只靠行尾的勾和字色，悬停 / 键盘焦点才铺底
const item = (selected: boolean) =>
  `flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-40 ${
    selected ? "text-l1" : "text-l2 hover:text-l1"
  }`;
const mark = (selected: boolean) => (
  <Check size={14} strokeWidth={2} aria-hidden="true" className={`shrink-0 ${selected ? "text-l2" : "invisible"}`} />
);
const section = "px-2 pb-1 pt-1.5 text-xs text-l3";
const note = "px-2 pb-1.5 pt-0.5 text-xs leading-[18px] text-l4";

/** 一家 Agent 的整体说明（维护级、只看材料一类），第一层写成行尾小字，第二层写在标题下 */
export interface AgentNote {
  short: string;
  long?: string;
  warn?: boolean;
}

/**
 * 选「哪家 Agent · 哪条连接 · 哪个模型」的两层小菜单（2026-11-11 用户：复核方、研讨成员的原生下拉一次摊开四五十行太夸张，
 * 照聊天层换 Agent 那组做）。先一家一行，点进去按连接分组列模型。弹层挂到 body 上、fixed 定位，
 * 评审页工具条、研讨弹层里都不会被裁；下面放得下往下开，否则往上（popover-side.ts）。
 */
export default function AgentModelPicker<O extends AgentModelOption>({
  options,
  selectedKey,
  onPick,
  title,
  hint,
  empty = "没有能用的连接，先到连接页加一条。",
  agentNote,
  ariaLabel,
  triggerTitle,
  triggerClassName,
  children,
}: {
  options: readonly O[];
  selectedKey?: string | null;
  onPick: (option: O) => void;
  /** 第一层顶上的小标题，如「换复核方」「再请一位」 */
  title: string;
  hint?: string;
  empty?: string;
  agentNote?: (agentId: string) => AgentNote | null;
  ariaLabel: string;
  triggerTitle?: string;
  triggerClassName: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; room: number } | null>(null);
  useMenuKeyNav(menuRef, open && pos !== null, agent ?? "agents");

  const groups = groupByAgent(options);
  const selected = selectedKey ? options.find((o) => o.key === selectedKey) : undefined;
  const group = agent ? groups.find((g) => g.agentId === agent) : undefined;

  const close = () => {
    setOpen(false);
    setAgent(null);
    setPos(null);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current;
      const menu = menuRef.current;
      if (!t) return;
      const anchor = t.getBoundingClientRect();
      const body = bodyRef.current;
      const natural = menu ? menu.offsetHeight + (body ? body.scrollHeight - body.clientHeight : 0) : MENU_CAP;
      const h = window.innerHeight;
      const side = pickPopoverSide(anchor, h, Math.min(natural, MENU_CAP));
      const room = popoverRoom(anchor, h, side, MENU_CAP);
      const width = menu?.offsetWidth ?? 304;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
      setPos(side === "below" ? { left, top: anchor.bottom + 8, room } : { left, bottom: h - anchor.top + 8, room });
    };
    place();
    const body = bodyRef.current;
    const sel = body?.querySelector<HTMLElement>('[data-selected="true"]');
    if (body && sel && sel.offsetTop + sel.offsetHeight > body.clientHeight) {
      body.scrollTop = sel.offsetTop - body.clientHeight / 2;
    }
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, agent]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    // 捕获阶段先拦下 Esc：只关这个小菜单，不连带关掉下面的弹层 / 评审页
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      if (agent) setAgent(null);
      else close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, agent]);

  const labelOf = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

  const menu = open && (
    <div
      ref={menuRef}
      role="dialog"
      aria-label={ariaLabel}
      // 字号挂在容器上：全站 button { font: inherit } 会吞掉按钮自己的 text-*
      className="fixed z-70 flex w-[19rem] flex-col rounded-xl border border-field ccode-float-surface p-1 text-sm shadow-lg whitespace-normal"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top,
        bottom: pos?.bottom,
        maxHeight: pos?.room ?? MENU_CAP,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {group ? (
        <>
          <button
            type="button"
            onClick={() => setAgent(null)}
            className="flex h-8 w-full shrink-0 items-center gap-1 rounded-lg px-2 text-left text-xs text-l3 outline-none hover:bg-hover hover:text-l1 focus-visible:bg-hover"
          >
            <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="text-xs">{title}</span>
          </button>
          <div className="flex shrink-0 items-center gap-1.5 px-2 pb-1 pt-0.5 font-medium text-l1">
            <AgentMark agentId={group.agentId} />
            {labelOf(group.agentId)}
          </div>
          {(() => {
            const n = agentNote?.(group.agentId);
            return n ? (
              <p className={`${note} shrink-0 ${n.warn ? "text-warn-text" : ""}`}>{n.long ?? n.short}</p>
            ) : null;
          })()}
          <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <ul>
              {group.profiles.map((p) => (
                <li key={p.profileId}>
                  <div className="px-2 pb-0.5 pt-1.5 text-micro text-l4">{p.profileName}</div>
                  <ul>
                    {p.options.map((o) => {
                      const isSel = o.key === selectedKey;
                      return (
                        <li key={o.key}>
                          <button
                            type="button"
                            disabled={o.disabled}
                            data-selected={isSel}
                            title={o.warn ? `${o.model || "默认模型"}：${o.warn}` : o.model || "按连接默认"}
                            className={item(isSel)}
                            onClick={() => {
                              onPick(o);
                              close();
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate">{o.model || "按连接默认"}</span>
                            {o.warn && <span className="max-w-[9rem] shrink-0 truncate text-micro text-warn-text">{o.warn}</span>}
                            {mark(isSel)}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : (
        <>
          <h4 className={`${section} shrink-0`}>{title}</h4>
          {hint && <p className={`${note} shrink-0`}>{hint}</p>}
          <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {groups.length === 0 && <p className={note}>{empty}</p>}
            <ul>
              {groups.map((g) => {
                const isSel = selected?.agentId === g.agentId;
                const n = agentNote?.(g.agentId);
                return (
                  <li key={g.agentId}>
                    <button
                      type="button"
                      data-selected={isSel}
                      title={n?.long ?? undefined}
                      className={item(isSel)}
                      onClick={() => setAgent(g.agentId)}
                    >
                      <AgentMark agentId={g.agentId} />
                      <span className="min-w-0 flex-1 truncate">{labelOf(g.agentId)}</span>
                      {n && <span className={`shrink-0 text-micro ${n.warn ? "text-warn-text" : "text-l4"}`}>{n.short}</span>}
                      {isSel && mark(true)}
                      <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerTitle}
        className={triggerClassName}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {children}
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
