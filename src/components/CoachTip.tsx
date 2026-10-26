import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { X } from "lucide-react";

/** 一次性的悬浮气泡提示（2026-10-27 侧栏多选起用，设计稿 docs/design-rail-multiselect-tip-mockup.html）。
 *  外观见 App.css .ccode-coach；只管画——什么时候出、出过要不要记由调用方定（规矩与计数在 coach-tips.ts）。
 *  贴在条 / 行里的直接摆（定位类经 className 传）；浮在别处的走 showFloatingCoach */
export default function CoachTip({
  arrow,
  arrowAt,
  title,
  children,
  actions,
  onClose,
  className = "",
  style,
}: {
  /** 小三角朝哪边：left = 气泡在锚点右边，down = 气泡在锚点上面，up = 气泡在锚点下面 */
  arrow: "left" | "down" | "up";
  /** 小三角离气泡上缘（left）/ 左缘（down、up）多远，px */
  arrowAt?: number;
  title?: string;
  children: ReactNode;
  /** 右下角的按钮，最后一个是主按钮 */
  actions?: { label: string; onClick: () => void }[];
  /** 给了才画右上角 × */
  onClose?: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      role={actions?.length ? "dialog" : "note"}
      aria-label={title}
      data-coach-tip
      data-arrow={arrow}
      className={`ccode-coach z-50 px-3 py-2.5 ${className}`}
      style={{ ...style, ...(arrowAt != null ? { "--coach-arrow": `${arrowAt}px` } : {}) } as CSSProperties}
    >
      {onClose && (
        <button
          type="button"
          aria-label="关掉这条提示"
          onClick={onClose}
          className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded opacity-50 hover:opacity-90"
        >
          <X size={12} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {title && <div className="ccode-coach-title mb-0.5 pr-4">{title}</div>}
      <div className={title ? "opacity-80" : undefined}>{children}</div>
      {actions && actions.length > 0 && (
        <div className="mt-2 flex justify-end gap-1">
          {actions.map((a, i) => {
            const primary = i === actions.length - 1;
            return (
              <button
                key={a.label}
                type="button"
                onClick={a.onClick}
                className={`rounded-md px-2.5 py-0.5 ${
                  primary ? "bg-cta font-medium text-cta-text hover:opacity-90" : "opacity-80 hover:bg-hover hover:opacity-100"
                }`}
              >
                {/* 字号写在内层：按钮上的会被全站 button { font: inherit } 吞掉 */}
                <span className="text-xs">{a.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

type Anchor = { left: number; top: number; right: number; bottom: number };
type FloatingOpts = {
  /** 锚点在窗口里的位置（getBoundingClientRect） */
  anchor: Anchor;
  /** right = 贴在锚点右边（侧栏的行，伸到画布上）；below = 挂在锚点下面（顶栏的按钮） */
  place: "right" | "below";
  title?: string;
  body: ReactNode;
  /** 点了先执行、再收起；最后一个是主按钮 */
  actions?: { label: string; onClick: () => void }[];
  /** 这个元素滚动时收起（侧栏的滚动区）；别处的滚动不管——对话一打开会自己滚到底 */
  scrollRoot?: Element | null;
};

let closeCurrent: (() => void) | null = null;

/** 浮在锚点旁边的气泡：挂到 body、fixed 定位，同一时间只有一个。点气泡外面、Esc、锚点所在区域滚动、
 *  窗口变大小都收起；点按钮执行后收起，右上角 × 也收起。返回收起函数 */
export function showFloatingCoach(opts: FloatingOpts): () => void {
  closeCurrent?.();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let closed = false;
  const onDown = (e: PointerEvent) => {
    if (!(e.target instanceof Node && host.contains(e.target))) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  function close() {
    if (closed) return;
    closed = true;
    if (closeCurrent === close) closeCurrent = null;
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    opts.scrollRoot?.removeEventListener("scroll", close);
    host.remove();
    // 可能正处在 React 的事件或渲染里：卸载挪到下一拍
    setTimeout(() => root.unmount(), 0);
  }
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", close);
  opts.scrollRoot?.addEventListener("scroll", close);
  closeCurrent = close;
  root.render(<FloatingCoach {...opts} onClose={close} />);
  return close;
}

function FloatingCoach({ anchor, place, title, body, actions, onClose }: FloatingOpts & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // 先量自己多大再摆：贴窗口边时往里挪，小三角仍对着锚点
  const [pos, setPos] = useState<{ left: number; top: number; arrowAt: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
    if (place === "right") {
      const cy = (anchor.top + anchor.bottom) / 2;
      const top = clamp(cy - 21, 8, window.innerHeight - h - 8);
      setPos({ left: anchor.right + 10, top, arrowAt: cy - top - 5 });
    } else {
      const cx = (anchor.left + anchor.right) / 2;
      const left = clamp(cx - 26, 8, window.innerWidth - w - 8);
      setPos({ left, top: anchor.bottom + 10, arrowAt: cx - left - 5 });
    }
  }, [anchor, place]);
  return (
    <div ref={ref} className="fixed z-50" style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}>
      <CoachTip
        arrow={place === "right" ? "left" : "up"}
        arrowAt={pos?.arrowAt}
        className="relative w-[248px]"
        title={title}
        onClose={onClose}
        actions={actions?.map((a) => ({
          label: a.label,
          onClick: () => {
            onClose();
            a.onClick();
          },
        }))}
      >
        {body}
      </CoachTip>
    </div>
  );
}
