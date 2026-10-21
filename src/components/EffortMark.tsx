import { effortValleyY } from "../effort-depth";

/**
 * 思考强度的小 M（2026-10-22，docs/design-chat-composer-mockup.html ②）：Mesa 图标里的 M，中间那道 V 随档位加深——
 * 深度 0 几乎是平的，1 就是图标原样。depth 为 null（默认档，不知道 CLI 自己用哪档）画成半透明，不装作知道。
 * 跟文字同排时当字用：颜色取 currentColor，大小随 className。
 */
export default function EffortMark({
  depth,
  className = "",
}: {
  depth: number | null;
  className?: string;
}) {
  const y = effortValleyY(depth ?? 0.45);
  return (
    <svg
      viewBox="0 0 16 14"
      width="13"
      height="12"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
      style={depth === null ? { opacity: 0.45 } : undefined}
    >
      <path
        d={`M2 13V2L8 ${y}L14 2V13`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
