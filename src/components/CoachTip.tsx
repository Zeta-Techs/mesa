import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";

/** 一次性的悬浮气泡提示（2026-10-27 侧栏多选起用，设计稿 docs/design-rail-multiselect-tip-mockup.html）。
 *  外观见 App.css .ccode-coach；只管画——什么时候出、出过要不要记、贴在哪由调用方定（定位类经 className 传）。 */
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
  /** 小三角朝哪边：left = 气泡在锚点右边，down = 气泡在锚点上面 */
  arrow: "left" | "down";
  /** 小三角离气泡上缘（left）/ 左缘（down）多远，px */
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
                className={`rounded-md px-2.5 py-0.5 text-xs ${
                  primary ? "bg-cta font-medium text-cta-text hover:opacity-90" : "opacity-80 hover:bg-hover hover:opacity-100"
                }`}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
