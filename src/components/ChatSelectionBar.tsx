import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Quote, Sigma, Table2, type LucideIcon } from "lucide-react";
import {
  rangeCopyHtml,
  rangePlainText,
  rangeSoleFormula,
  rangeTable,
  tableCopyHtml,
  tableToTsv,
  writeClipboard,
} from "../chat-copy";

/** 选区落在哪条消息里：AI 回复（data-chat-message）或用户气泡那一行 */
const MESSAGE_SELECTOR = "[data-chat-message], .ccode-chat-user-row";

function messageOf(node: Node): Element | null {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return el?.closest(MESSAGE_SELECTOR) ?? null;
}

interface BarState {
  range: Range;
  /** 选区所在的消息（跨消息时为 null：不给引用） */
  message: Element | null;
  formula: string | null;
  table: HTMLTableElement | null;
  x: number;
  y: number;
  below: boolean;
}

/**
 * 选中对话里的文字时浮在选区上方的小条（2026-10-30 用户：别都堆到消息下面的悬停操作里，选中时再弹）：
 * 复制（纯文本）、选区只是一条公式时「复制 LaTeX」、碰到表格时「复制表格」、AI 回复里「引用追问」。
 * ⌘C 同一套取法（公式还原成 $TeX$，不带按钮字）。挂在 ConversationView 的片段里，靠一个隐形锚找到所在的对话容器，
 * 只管这个容器里的选区（分屏两段对话各管各的）。
 */
export default function ChatSelectionBar({
  onQuote,
}: {
  /** 引用选中文字追问（聊天层传；回放页不传 = 不显示） */
  onQuote?: (message: Element, selected: string) => boolean;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<BarState | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const dragging = useRef(false);
  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;

  useEffect(() => {
    const scope = anchorRef.current?.parentElement;
    if (!scope) return;
    const scroller = scope.closest<HTMLElement>(".ccode-chat-scroll");
    let frame = 0;

    function place(range: Range): Pick<BarState, "x" | "y" | "below"> | null {
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
      const first = rects[0] ?? range.getBoundingClientRect();
      const box = range.getBoundingClientRect();
      const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      // 选区整段滚出了对话区：先收起，滚回来再出
      if (box.bottom < view.top || box.top > view.bottom) return null;
      const below = first.top - view.top < 44;
      return {
        x: first.left + Math.min(first.width, 240) / 2,
        y: below ? Math.min(box.bottom, view.bottom - 8) + 6 : first.top - 6,
        below,
      };
    }

    function update() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setBar(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const a = messageOf(range.startContainer);
      const b = messageOf(range.endContainer);
      if (!a || !b || !scope!.contains(a) || !scope!.contains(b)) {
        setBar(null);
        return;
      }
      if (!rangePlainText(range)) {
        setBar(null);
        return;
      }
      const at = place(range);
      if (!at) {
        setBar(null);
        return;
      }
      const message = a === b ? a : null;
      setBar({
        range: range.cloneRange(),
        message,
        formula: rangeSoleFormula(range),
        table: rangeTable(range, message ?? scope!),
        ...at,
      });
      setCopied(null);
    }
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    const onSelectionChange = () => {
      if (!dragging.current) schedule();
    };
    const onDown = (e: MouseEvent) => {
      if (barRef.current?.contains(e.target as Node)) return;
      if (scope.contains(e.target as Node)) {
        dragging.current = true;
        setBar(null);
      }
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      // 松手这一刻选区还没定下来（双击选词、点公式整条选中都在 click 之后）
      window.setTimeout(schedule, 0);
    };
    const onScroll = () => {
      setBar((prev) => {
        if (!prev) return prev;
        const at = place(prev.range);
        return at ? { ...prev, ...at } : null;
      });
    };
    // ⌘C：同一套取法。只接手这个对话容器里的选区，别处（输入框、终端）照旧
    const onCopy = (e: ClipboardEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !e.clipboardData) return;
      const range = sel.getRangeAt(0);
      const a = messageOf(range.startContainer);
      const b = messageOf(range.endContainer);
      if (!a || !b || !scope.contains(a) || !scope.contains(b)) return;
      const text = rangePlainText(range);
      if (!text) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
      e.clipboardData.setData("text/html", rangeCopyHtml(range));
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onUp, true);
    document.addEventListener("copy", onCopy);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mouseup", onUp, true);
      document.removeEventListener("copy", onCopy);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // 量出实际宽度后以选区开头为中心摆，贴窗口边挪回来（同 HoverTip）
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!bar || !el) return;
    const w = el.offsetWidth;
    el.style.left = `${Math.min(Math.max(bar.x - w / 2, 8), Math.max(window.innerWidth - 8 - w, 8))}px`;
  }, [bar]);

  function done(key: string) {
    setCopied(key);
    window.setTimeout(() => setCopied((k) => (k === key ? null : k)), 1200);
  }

  const actions: { key: string; label: string; icon: LucideIcon; title: string; run: (b: BarState) => void }[] = [];
  if (bar) {
    actions.push({
      key: "text",
      label: "复制",
      icon: Copy,
      title: "复制选中的文字（不带 Markdown 符号；公式写成 $LaTeX$）",
      run: (b) => void writeClipboard(rangePlainText(b.range)).then(() => done("text")),
    });
    if (bar.formula !== null) {
      const tex = bar.formula;
      actions.push({
        key: "latex",
        label: "复制 LaTeX",
        icon: Sigma,
        title: "复制这条公式的 LaTeX 源码（不带 $ 定界符，可贴进 Word 公式编辑器或 LaTeX 稿件）",
        run: () => void writeClipboard(tex).then(() => done("latex")),
      });
    }
    if (bar.table) {
      const table = bar.table;
      actions.push({
        key: "table",
        label: "复制表格",
        icon: Table2,
        title: "复制整张表：贴进 Excel / WPS 自动分好列，贴进 Word 是一张表",
        run: () => void writeClipboard(tableToTsv(table), tableCopyHtml(table)).then(() => done("table")),
      });
    }
    if (onQuote && bar.message?.matches("[data-chat-message]")) {
      actions.push({
        key: "quote",
        label: "引用追问",
        icon: Quote,
        title: "引用选中的文字，接着在输入框里问；不会自动发送",
        run: (b) => {
          if (b.message && onQuoteRef.current?.(b.message, rangePlainText(b.range))) {
            window.getSelection()?.removeAllRanges();
            setBar(null);
          }
        },
      });
    }
  }

  return (
    <>
      <span ref={anchorRef} hidden aria-hidden="true" />
      {bar &&
        createPortal(
          <div
            ref={barRef}
            role="toolbar"
            aria-label="选中文字的操作"
            className={`ccode-float-surface fixed z-50 flex items-center gap-0.5 rounded-lg border border-hairline p-0.5 ${
              bar.below ? "" : "-translate-y-full"
            }`}
            style={{ left: bar.x, top: bar.y }}
            // 点按钮不能把选区点没
            onMouseDown={(e) => e.preventDefault()}
          >
            {actions.map((a) => {
              const Icon = copied === a.key ? Check : a.icon;
              return (
                <button
                  key={a.key}
                  type="button"
                  title={a.title}
                  onClick={() => a.run(bar)}
                  className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1 focus-visible:outline-2 focus-visible:outline-cta"
                >
                  <Icon size={12} strokeWidth={1.8} aria-hidden="true" />
                  {copied === a.key ? "已复制" : a.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
