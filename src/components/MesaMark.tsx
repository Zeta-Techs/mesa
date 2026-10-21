import { useId } from "react";

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
  typing = false,
  inline = false,
  className = "",
}: {
  /** 浅色主题：光标用深一档的琥珀，白底上才压得住 */
  light: boolean;
  /** 出现时光标闪三下后停住（有界脉冲，不做无限闪烁） */
  blink?: boolean;
  /** 生成中：光标像插入符一样一直亮灭（聊天「正在回复」那一行用；停了就撤掉） */
  typing?: boolean;
  /** 跟 12px 小字同排时用：光标按小字号做视觉补偿（加宽加厚），否则缩到 10px 高只剩一个句点大小 */
  inline?: boolean;
  className?: string;
}) {
  // 多个聊天标签可能同时挂着字标：滤镜 id 每个实例各一份
  const glowId = `mesa-mark-glow-${useId().replace(/:/g, "")}`;
  const amber = mesaAmber(light);
  // 光标矩形（与图标源同值 120×60）；小字号版加宽加厚到 250×100，viewBox 跟着往右放
  const cw = inline ? 250 : 120;
  const ch = inline ? 100 : 60;
  return (
    <svg
      viewBox={`232 284 ${588 + cw} 456`}
      overflow="visible"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <filter id={glowId} x="-60%" y="-120%" width="220%" height="340%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
      </defs>
      <path
        d="M232 740 V284 H356 L512 512 L668 284 H792 V740 H672 V474 L548 652 H476 L352 474 V740 Z"
        fill="currentColor"
      />
      <g className={typing ? "ccode-caret-blink" : blink ? "animate-pulse-brief" : undefined}>
        {/* 浅色底上余辉发脏，只在深色底保留 */}
        {!light && (
          <rect x="820" y={740 - ch} width={cw} height={ch} rx="6" fill={amber} opacity="0.45" filter={`url(#${glowId})`} />
        )}
        <rect x="820" y={740 - ch} width={cw} height={ch} rx={inline ? 14 : 6} fill={amber} />
      </g>
    </svg>
  );
}
