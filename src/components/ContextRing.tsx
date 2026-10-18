import { useState } from "react";
import { createPortal } from "react-dom";

/**
 * 上下文用量圆环（docs/design-chat-layer.md §4.4）：上一轮输入占模型上下文窗口的比例，≥80% 变 warn。
 * 聊天输入框（模型芯片左边）与终端底栏右区共用；终端底栏走 xterm 调色板，所以颜色可传进来。
 * 说明用自绘浮层（2026-10-18 用户：鼠标放上去什么都不显示——原生 title 在桌面窗口里不可靠，
 * 底栏右区又是 overflow-hidden，浮层挂到 body 上按圆环位置定位）。
 */
export function contextFmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return String(n);
}

function compactHint(agentId: string): string {
  return agentId === "claude-code" || agentId === "codex"
    ? "快满时 AI 会自动压缩；也可以输入 /compact 手动压缩"
    : "快满时 AI 会自动压缩";
}

export default function ContextRing({
  ratio,
  used,
  window: win,
  agentId,
  color,
  warnColor,
  trackColor = "var(--color-field)",
  className = "",
}: {
  ratio: number;
  used: number;
  window: number;
  agentId: string;
  /** 不传 = 主题灰（text-l3 / 橙色 warn） */
  color?: string;
  warnColor?: string;
  trackColor?: string;
  className?: string;
}) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const warn = ratio >= 0.8;
  const stroke = warn ? warnColor : color;
  const pct = Math.round(ratio * 100);
  // 浮层右缘对齐圆环右缘、底边在圆环上方 6px（用 translate 往左上挪，不依赖视口高度）
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const show = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setTip({ x: rect.right + 4, y: rect.top - 6 });
  };
  return (
    <span
      tabIndex={0}
      className={`inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-md outline-none ${
        stroke ? "" : warn ? "text-warn-text" : "text-l3"
      } ${className}`}
      style={stroke ? { color: stroke } : undefined}
      aria-label={`上下文已用 ${pct}%（${contextFmtTokens(used)} / ${contextFmtTokens(win)}）`}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setTip(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setTip(null)}
    >
      {tip &&
        typeof document !== "undefined" &&
        createPortal(
          // 定位挂外层（translate 往左上挪）；内层才是浮层皮肤——ccode-float-surface 的入场动画会改 transform，
          // 两者放在同一个元素上，入场那 150ms 浮层会先出现在错位置再跳回来
          <div
            className="pointer-events-none fixed z-70"
            style={{ left: tip.x, top: tip.y, transform: "translate(-100%, -100%)" }}
          >
            <div
              role="tooltip"
              className="ccode-float-surface w-max max-w-[16rem] rounded-lg border border-field px-2.5 py-2 text-xs shadow-lg"
            >
              <div className={warn ? "text-warn-text" : "text-l1"}>上下文已用 {pct}%</div>
              <div className="mt-0.5 tabular-nums text-l3">
                {contextFmtTokens(used)} / {contextFmtTokens(win)} tokens
              </div>
              <div className="mt-1 leading-[18px] text-l4">{compactHint(agentId)}</div>
            </div>
          </div>,
          document.body,
        )}
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={r} fill="none" stroke={trackColor} strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${c * ratio} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 8 8)"
        />
      </svg>
    </span>
  );
}
