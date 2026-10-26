import { useId, useLayoutEffect, useRef } from "react";
import type { StatusCaretMotion } from "../chat-status";

/** M 的字形（与图标源 src-tauri/icons/source/mesa-*.svg 同一条路径；包围盒 232,284 起 560×456） */
const M_PATH = "M232 740 V284 H356 L512 512 L668 284 H792 V740 H672 V474 L548 652 H476 L352 474 V740 Z";
/** 状态行里 M 用 CSS 遮罩画，好让光带的渐变连着扫过 M 和后面的字 */
const M_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="232 284 560 456"><path d="${M_PATH}"/></svg>`,
)}")`;

/** 光标的品牌琥珀：浅色底用深一档才压得住 */
function mesaAmber(light: boolean): string {
  return light ? "#e39a1c" : "#f5b83d";
}

/**
 * 只有 M▁ 里那道光标，当插入符接在聊天实时预览的最后一个字后面（2026-10-21：AI 正在往下写，
 * 光标就跟着字走，不再另起一行写「正在生成回复」）。坐在文字基线上，宽高随字号；一直亮灭，
 * 减弱动态效果时常亮（.ccode-caret-blink）。深色底带一点同色余辉，浅色底余辉发脏不加
 */
export function MesaCaret({ light, className = "" }: { light: boolean; className?: string }) {
  const amber = mesaAmber(light);
  return (
    <span
      aria-hidden="true"
      className={`ccode-caret-blink ml-[0.2em] inline-block h-[0.22em] w-[0.55em] align-baseline ${className}`}
      style={{ background: amber, boxShadow: light ? undefined : `0 0 6px ${amber}73` }}
    />
  );
}

/**
 * Mesa 光标标志的「字标」版：去掉图标底板（圆角方块、渐变、投影），只留 M 与基线上的光标。
 * 放在文字行里当字用——M 取当前文字色（随主题），光标保留品牌琥珀与荧光余辉（与图标源
 * src-tauri/icons/source/mesa-{dark,light}.svg 同值：深色底 #f5b83d、浅色底 #e39a1c）。
 * viewBox 裁到图形本身（M 与光标的包围盒），底边即基线：放进 items-baseline 的行里，
 * M 与光标正好坐在文字基线上。余辉会出包围盒，svg 设 overflow visible。
 */
export function MesaMark({
  light,
  blink = false,
  className = "",
}: {
  /** 浅色主题：光标用深一档的琥珀，白底上才压得住 */
  light: boolean;
  /** 出现时光标闪三下后停住（有界脉冲，不做无限闪烁） */
  blink?: boolean;
  className?: string;
}) {
  // 多个聊天标签可能同时挂着字标：滤镜 id 每个实例各一份
  const glowId = `mesa-mark-glow-${useId().replace(/:/g, "")}`;
  const amber = mesaAmber(light);
  return (
    <svg viewBox="232 284 708 456" overflow="visible" className={className} aria-hidden="true">
      <defs>
        <filter id={glowId} x="-60%" y="-120%" width="220%" height="340%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
      </defs>
      <path d={M_PATH} fill="currentColor" />
      <g className={blink ? "animate-pulse-brief" : undefined}>
        {/* 浅色底上余辉发脏，只在深色底保留 */}
        {!light && <rect x="820" y="680" width="120" height="60" rx="6" fill={amber} opacity="0.45" filter={`url(#${glowId})`} />}
        <rect x="820" y="680" width="120" height="60" rx="6" fill={amber} />
      </g>
    </svg>
  );
}

/**
 * 聊天生成中那一行的开头：M▁ 加这一轮在做的事（2026-10-26，设计稿 docs/design-chat-status-motion-mockup.html）。
 * 光标按阶段换动作（motion，见 chat-status statusCaretMotion）；sweep 时一道光带连着扫过 M 和字——
 * 两段共用整段的宽度作渐变坐标，各自按偏移对齐（App.css .ccode-status-lead）。字换了就重挂、淡入。
 * 光标比例同原 MesaMark 小字号版（加宽加厚到 250×100，否则 10px 高只剩一个句点）
 */
export function MesaStatusLead({
  text,
  motion,
  sweep,
}: {
  text: string | null;
  motion: StatusCaretMotion;
  sweep: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row || !sweep) return;
    const measure = () => {
      row.style.setProperty("--ccode-sweep-w", `${row.offsetWidth}px`);
      for (const el of row.querySelectorAll<HTMLElement>(".ccode-sweep")) {
        el.style.setProperty("--ccode-sweep-ox", `${el.offsetLeft}px`);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [sweep, text]);
  return (
    <span ref={ref} className="ccode-status-lead" data-sweep={sweep ? "" : undefined}>
      <span className="ccode-status-mark" aria-hidden="true">
        <span className="ccode-status-m ccode-sweep" style={{ WebkitMaskImage: M_MASK, maskImage: M_MASK }} />
        <span className="ccode-status-caret" data-motion={motion} />
      </span>
      <span aria-live="polite" className="contents">
        {text && (
          <span key={text} className="ccode-status-text ccode-sweep min-w-0 truncate">
            {text}
          </span>
        )}
      </span>
    </span>
  );
}
