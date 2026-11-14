import { useId, useLayoutEffect, useRef } from "react";
import type { ChatStatusParts, StatusCaretMotion } from "../chat-status";

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
 * M▁ 状态字标本体（2026-11-15，设计稿 docs/design-chat-brand-status-mockup.html 方向 A）：
 * M 用 CSS 遮罩画，右侧单光标槽含微暗导轨（read 态显现）与琥珀游标（五态物理编舞：
 * thinking 柔光呼吸 / read 导轨往返扫描 / write 三拍打字推进 / cmd 终端双节拍 / steady 满格锁定）。
 * MesaStatusLead 与 ConversationView 正在进行的那一步共用同一个字标，保证全屏只出现一处 M▁ 主演。
 */
export function MesaStatusMark({
  motion,
  sweep = false,
  className = "",
}: {
  motion: StatusCaretMotion;
  sweep?: boolean;
  className?: string;
}) {
  return (
    <span className={`ccode-status-mark ${className}`} data-motion={motion} aria-hidden="true">
      <span
        className={`ccode-status-m ${sweep ? "ccode-sweep" : ""}`}
        style={{ WebkitMaskImage: M_MASK, maskImage: M_MASK }}
      />
      <span className="ccode-status-caret-slot">
        <span className="ccode-status-caret-rail" />
        <span className="ccode-status-caret" data-motion={motion} />
      </span>
    </span>
  );
}

/**
 * 聊天生成中那一行的开头：M▁ 加这一轮在做的事（2026-10-26 初版，2026-11-15 升级方向 A：光标五态编舞 + 结构化动作排版）。
 * - 传了 parts 时：动词（l3 / 等你确认琥珀）、文件名（等宽 l1 + 虚下划线）、命令（8% 等宽微胶囊）、思考摘要（· + l2）、
 *   增删行数（+N −M）分层排印，切换状态时 .ccode-status-ticker 纵轴轻翻牌（190ms）；
 * - 仅裸「思考中」或外部传纯 text（如项目助手）且开启 sweep 时：保留连贯光带扫过 M 和文字。
 */
export function MesaStatusLead({
  text,
  motion,
  sweep = false,
  parts = null,
}: {
  text: string | null;
  motion: StatusCaretMotion;
  sweep?: boolean;
  parts?: ChatStatusParts | null;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const effectiveMotion = parts?.motion ?? motion;
  const hasStructured = Boolean(
    parts && (parts.target !== null || parts.awaiting || (parts.added ?? 0) > 0 || (parts.removed ?? 0) > 0),
  );
  const plainSweep = sweep && !hasStructured;
  const displayKey = parts
    ? `${parts.verb ?? ""}|${parts.targetKind}|${parts.target ?? ""}|${parts.note ?? ""}|${parts.added ?? ""}|${parts.removed ?? ""}`
    : (text ?? "");

  useLayoutEffect(() => {
    const row = ref.current;
    if (!row || !plainSweep) return;
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
  }, [plainSweep, displayKey]);

  const plainLabel = parts ? (parts.verb ?? text) : text;

  return (
    <span ref={ref} className="ccode-status-lead" data-sweep={plainSweep ? "" : undefined}>
      <MesaStatusMark motion={effectiveMotion} sweep={plainSweep} />
      <span aria-live="polite" className="contents">
        {hasStructured && parts ? (
          <span key={displayKey} className="ccode-status-ticker">
            {parts.verb && (
              <span className={parts.awaiting ? "shrink-0 font-medium text-mesa-amber" : "ccode-status-verb shrink-0"}>
                {parts.verb}
              </span>
            )}
            {parts.targetKind === "thought" && parts.target && (
              <>
                <span className="shrink-0 text-l4" aria-hidden="true">·</span>
                <span className="ccode-status-thought min-w-0 truncate">{parts.target}</span>
              </>
            )}
            {parts.targetKind === "file" && parts.target && (
              <span className="ccode-status-file min-w-0 truncate font-mono">{parts.target}</span>
            )}
            {parts.targetKind === "cmd" && parts.target && (
              <span className="ccode-status-cmd min-w-0 truncate font-mono">{parts.target}</span>
            )}
            {parts.targetKind === "plain" && parts.target && (
              <span className="min-w-0 truncate text-l2">{parts.target}</span>
            )}
            {parts.note && <span className="shrink-0 text-l4">{parts.note}</span>}
            {(parts.added ?? 0) > 0 && (
              <span className="shrink-0 font-mono tabular-nums text-add">+{parts.added}</span>
            )}
            {(parts.removed ?? 0) > 0 && (
              <span className="shrink-0 font-mono tabular-nums text-del">−{parts.removed}</span>
            )}
          </span>
        ) : (
          plainLabel && (
            <span key={displayKey} className="ccode-status-text ccode-sweep min-w-0 truncate">
              {plainLabel}
            </span>
          )
        )}
      </span>
    </span>
  );
}
