import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAnimatedDismiss } from "../exit-animation";

export interface ContextMenuItem {
  label?: string;
  onSelect?: () => void;
  /** 禁用项：渲染为不可点，title 说明原因（如互斥脚本运行中） */
  disabled?: boolean;
  /** 危险项：红色警示文字（删除类不可逆操作） */
  danger?: boolean;
  title?: string;
  separator?: boolean;
}

/** 面板最大宽度（px，对应 max-w-80）：超长 label 截断，防止菜单被顶出屏幕 */
const MENU_MAX_WIDTH = 320;

/**
 * 轻量右键菜单：全屏 overlay + 浮动面板，
 * 点击空白 / Escape / 滚动任一发生即关闭。
 * alignRight 时 x 视为锚点右缘，按实际面板宽度右对齐。
 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  alignRight = false,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  alignRight?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{
    left: number;
    top: number;
  } | null>(null);
  // Esc/点外播退场；滚动关闭和选中项（commit）保持即时卸载
  const { dismiss, exiting } = useAnimatedDismiss(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    // capture 阶段的滚动监听能捕获任意容器的滚动；滚动时面板位置会脱锚，不播退场
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
    // dismiss 是稳定引用（useCallback 仅依赖时长），不随 onClose 内联换引用而重挂
  }, [onClose, dismiss]);

  // 实测面板宽高后钳制在视口内；useLayoutEffect 保证绘制前完成修正，不闪动
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setMeasured({
      left: Math.max(
        4,
        Math.min(alignRight ? x - w : x, window.innerWidth - w - 4),
      ),
      top: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
    });
  }, [alignRight, x, y, items.length]);

  // 首帧按估算摆放（useLayoutEffect 绘制前即被实测值取代，用户看不到）
  const style = measured ?? {
    left: Math.max(
      4,
      Math.min(alignRight ? x - 160 : x, window.innerWidth - MENU_MAX_WIDTH - 8),
    ),
    top: Math.max(4, Math.min(y, window.innerHeight - items.length * 32 - 16)),
  };

  return (
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
        className={`ccode-anchor-topleft absolute min-w-40 max-w-80 rounded-sm border border-field ccode-float-surface py-1${exiting ? " ccode-exiting" : ""}`}
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it, i) =>
          it.separator ? (
            <div
              key={`sep-${i}`}
              className="my-1 border-t border-hairline"
              role="separator"
            />
          ) : (
            <button
              key={it.label ?? `item-${i}`}
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                if (it.disabled) return;
                onClose();
                it.onSelect?.();
              }}
              className={`block w-full truncate px-3 py-1.5 text-left text-sm ${
                it.disabled
                  ? "cursor-not-allowed text-l4"
                  : it.danger
                    ? "text-err-text hover:bg-hover"
                    : "text-l2 hover:bg-hover"
              }`}
            >
              {it.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
