import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { useExitRender } from "../exit-animation";

type ModalSize = "sm" | "md" | "lg" | "xl";

const sizes: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

/** 全站对话框壳：统一 Esc、遮罩、滚动边界、移动端宽度和可访问名称。 */
export function Modal({
  open,
  title,
  children,
  onClose,
  size = "md",
  footer,
  description,
  dismissOnBackdrop = true,
  panelClassName = "",
  contentClassName = "",
  overflow = "auto",
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  size?: ModalSize;
  footer?: ReactNode;
  description?: ReactNode;
  dismissOnBackdrop?: boolean;
  panelClassName?: string;
  contentClassName?: string;
  /** hidden：预览类弹层自带滚动，外层再滚会撑破高度并在 WKWebView 里瓦片黑屏 */
  overflow?: "auto" | "hidden";
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  // 退场延续：open→false 后保持挂载 150ms 播退场（焦点/滚动锁仍由下方 effect 即刻恢复）
  const { render, exiting } = useExitRender(open);

  // 调用方常以内联函数传入 onClose。不要让它导致焦点陷阱 effect
  // 每次渲染重跑，否则 busy/error 状态更新时焦点会被恢复到背景元素。
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panelRef.current)?.focus();
    });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [open]);

  if (!render) return null;
  return (
    <div
      className={`ccode-modal-backdrop fixed inset-0 z-40 flex items-center justify-center overflow-hidden overscroll-none bg-black/40 p-3 sm:p-4 ccode-fade${exiting ? " ccode-exiting" : ""}`}
      onMouseDown={(event) => {
        if (dismissOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`ccode-modal-panel ccode-float-surface flex max-h-[calc(100vh-24px)] w-full ${sizes[size]} flex-col rounded-lg border border-field p-4 sm:p-5 ${
          overflow === "hidden" ? "overflow-hidden overscroll-none" : "overflow-y-auto"
        }${exiting ? " ccode-exiting" : ""} ${panelClassName}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="min-w-0 text-base font-semibold text-l1">{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-base leading-none text-l4 hover:bg-hover hover:text-l1"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {description && (
          <p id={descriptionId} className="mt-1 text-xs leading-5 text-l3">
            {description}
          </p>
        )}
        <div className={`mt-4 min-h-0 ${contentClassName}`}>{children}</div>
        {footer && <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-hairline pt-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Sheet({
  open,
  title,
  children,
  onClose,
  side = "right",
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  side?: "left" | "right";
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const { render, exiting } = useExitRender(open);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panelRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [open]);

  if (!render) return null;
  return (
    <div
      className={`fixed inset-0 z-40 flex bg-black/40 ccode-fade${exiting ? " ccode-exiting" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`ccode-float-surface ccode-sheet-${side} flex h-full w-[min(30rem,calc(100vw-24px))] flex-col overflow-y-auto border-field p-4 sm:p-5 ${side === "right" ? "ml-auto border-l" : "mr-auto border-r"}${exiting ? " ccode-exiting" : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-l1">{title}</h2>
          <button type="button" aria-label="关闭" className="text-l3 hover:text-l1" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
