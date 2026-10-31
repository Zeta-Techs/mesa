import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { normalizeMenuItems, type ContextMenuItem } from "../context-menu";
import { useAnimatedDismiss } from "../exit-animation";

export type { ContextMenuItem };

/** 面板最大宽度（px，对应 max-w-80）：超长 label 截断，防止菜单被顶出屏幕 */
const MENU_MAX_WIDTH = 320;

/**
 * 轻量右键菜单：全屏 overlay + 浮动面板，
 * 点击空白 / Escape / 滚动任一发生即关闭；打开即聚焦首个可用项，↑↓/Home/End 移动。
 * alignRight 时 x 视为锚点右缘，按实际面板宽度右对齐。
 * 视觉与顶栏帮助菜单同一套：p-1 面板、行内圆角、xs 字号、13px 图标。
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
  const rows = normalizeMenuItems(items);
  // 带 confirm 的项第一次点后的「待确认」行号；Esc 先撤待确认，再按才关菜单
  const [armed, setArmed] = useState<number | null>(null);
  const armedRef = useRef(armed);
  armedRef.current = armed;
  // 图标列只在需要时出现：纯文字菜单不再留一列空白缩进
  const withLead = rows.some((it) => it.icon || it.mark);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (armedRef.current != null) setArmed(null);
      else dismiss();
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
  }, [alignRight, x, y, items.length, armed]);

  // 打开即聚焦首个可用项（键盘可直接上下选）；preventScroll 防长清单把面板滚走触发关闭
  useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, []);

  function onPanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const list = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    if (!list.length) return;
    const idx = list.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? list[0]
        : e.key === "End"
          ? list[list.length - 1]
          : e.key === "ArrowDown"
            ? list[(idx + 1 + list.length) % list.length]
            : list[(idx - 1 + list.length) % list.length];
    next.focus();
  }

  // 首帧按估算摆放（useLayoutEffect 绘制前即被实测值取代，用户看不到）
  const style = measured ?? {
    left: Math.max(
      4,
      Math.min(alignRight ? x - 176 : x, window.innerWidth - MENU_MAX_WIDTH - 8),
    ),
    top: Math.max(4, Math.min(y, window.innerHeight - rows.length * 30 - 16)),
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
        role="menu"
        onKeyDown={onPanelKeyDown}
        className={`ccode-anchor-topleft absolute min-w-44 max-w-80 rounded-md border border-field ccode-float-surface ccode-menu-surface p-1${exiting ? " ccode-exiting" : ""}`}
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 长清单（如收起态切换菜单）内部滚动：高度封顶、自身滚动不触发关闭（见 onScroll） */}
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
          {rows.map((it, i) =>
            it.separator ? (
              <div
                key={`sep-${i}`}
                className="mx-1.5 my-1 border-t border-hairline"
                role="separator"
              />
            ) : it.header ? (
              <div
                key={`head-${i}`}
                className="px-2.5 pb-0.5 pt-1.5 text-micro text-l3"
              >
                {it.header}
              </div>
            ) : (
              <button
                key={`item-${i}`}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                title={armed === i ? it.confirm?.title ?? it.title : it.title}
                aria-current={it.checked ? "true" : undefined}
                onClick={() => {
                  if (it.disabled) return;
                  if (it.confirm && armed !== i) {
                    setArmed(i);
                    return;
                  }
                  onClose();
                  it.onSelect?.();
                }}
                className={`ccode-menu-item group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs ${
                  it.disabled
                    ? "cursor-not-allowed text-l4 opacity-70"
                    : armed === i
                      ? "bg-err-text/15 font-medium text-err-text"
                      : it.danger
                      ? "text-err-text hover:bg-err-text/10 focus-visible:bg-err-text/10"
                      : it.checked
                        ? "bg-hover text-l1"
                        : "text-l2 hover:bg-hover hover:text-l1 focus-visible:bg-hover focus-visible:text-l1"
                }`}
              >
                {withLead &&
                  (it.mark ? (
                    <span
                      className="flex size-[13px] shrink-0 items-center justify-center"
                      title={it.mark === "warn" ? "待处理" : "运行中"}
                    >
                      <span
                        className={`size-1.5 rounded-full ${
                          it.mark === "warn" ? "bg-warn-text" : "bg-ok-text"
                        }`}
                      />
                    </span>
                  ) : it.icon ? (
                    <it.icon
                      size={13}
                      strokeWidth={1.8}
                      aria-hidden="true"
                      className={`shrink-0 ${
                        it.danger
                          ? "text-err-text"
                          : it.disabled
                            ? "text-l4"
                            : "text-l3 group-hover:text-l2"
                      }`}
                    />
                  ) : (
                    <span className="size-[13px] shrink-0" aria-hidden="true" />
                  ))}
                <span className="min-w-0 flex-1 truncate">
                  {armed === i ? it.confirm?.label : it.label}
                </span>
                {it.hint && (
                  <span className="shrink-0 pl-2 text-micro text-l3">
                    {it.hint}
                  </span>
                )}
                {it.checked && (
                  <Check
                    size={13}
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
