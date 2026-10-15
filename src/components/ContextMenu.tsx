import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useAnimatedDismiss } from "../exit-animation";

export interface ContextMenuItem {
  label?: string;
  onSelect?: () => void;
  /** 禁用项：渲染为不可点，title 说明原因（如互斥脚本运行中） */
  disabled?: boolean;
  /** 危险项：红色警示文字（删除类不可逆操作） */
  danger?: boolean;
  /** 当前项：行底 bg-hover text-l1 + 行尾 Check，形态与 LaunchMenu 选中行一致 */
  checked?: boolean;
  /** 分组小标题（不可点）：段头与首行同现，替代裸分隔线；文字弱化同左栏组头 */
  header?: string;
  /** 行首状态点（无状态不渲染点、留占位保各行文字左对齐）：warn=待处理 / running=运行中，
   *  词表与项目栏 projectRailStatus 同款 */
  mark?: "warn" | "running";
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
    // capture 阶段的滚动监听能捕获任意容器的滚动；滚动时面板位置会脱锚，不播退场。
    // 面板自身的滚动（长清单 max-h 内部滚动）不脱锚，放行
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) {
        return;
      }
      onClose();
    };
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
        {/* 长清单（如收起态切换菜单）内部滚动：高度封顶、自身滚动不触发关闭（见 onScroll） */}
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
        {items.map((it, i) =>
          it.separator ? (
            <div
              key={`sep-${i}`}
              className="my-1 border-t border-hairline"
              role="separator"
            />
          ) : it.header ? (
            <div
              key={`head-${i}`}
              className="px-3 pb-0.5 pt-1.5 text-micro text-l4"
            >
              {it.header}
            </div>
          ) : (
            <button
              key={`item-${i}`}
              disabled={it.disabled}
              title={it.title}
              aria-current={it.checked ? "true" : undefined}
              onClick={() => {
                if (it.disabled) return;
                onClose();
                it.onSelect?.();
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                it.disabled
                  ? "cursor-not-allowed text-l4"
                  : it.danger
                    ? "text-err-text hover:bg-hover"
                    : it.checked
                      ? "bg-hover text-l1"
                      : "text-l2 hover:bg-hover"
              }`}
            >
              {it.mark ? (
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    it.mark === "warn" ? "bg-warn-text" : "bg-ok-text"
                  }`}
                  title={it.mark === "warn" ? "待处理" : "运行中"}
                />
              ) : (
                <span className="size-2 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.checked && (
                <Check
                  size={14}
                  strokeWidth={1.8}
                  className="shrink-0 text-l3"
                  aria-hidden="true"
                />
              )}
            </button>
          ),
        )}
        </div>
      </div>
    </div>
  );
}
