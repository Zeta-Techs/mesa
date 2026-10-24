import { RUN_CARET_LABEL, type RunCaretState } from "../run-caret";

/**
 * 运行状态光标（规则见 run-caret.ts，样式 App.css .ccode-run-caret）：M▁ 里那一道，取代绿点 / 黄点。
 * 放进 items-center 的 flex 行里就和标题字竖着居中（2026-10-24 用户：光标放在标题垂直居中的位置，原先往下挪到基线；
 * 用无头 Chrome 量过，flex 居中与中文字墨的中线只差约 0.2px，不另挪）。居中后不要夹在句子中间用（读成破折号），
 * 放行尾、状态字后面或最前；图标旁边那种绝对定位由调用方给位置
 * 旁边已经写着状态字（「2 运行中」「待确认」）的传 `decorative`，读屏不重复念
 */
export default function RunCaret({
  state,
  label,
  decorative = false,
  className = "",
}: {
  state: RunCaretState;
  /** 读屏与悬停说明；默认按状态写 */
  label?: string;
  decorative?: boolean;
  className?: string;
}) {
  const text = label ?? RUN_CARET_LABEL[state];
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": text, title: text })}
      data-state={state}
      className={`ccode-run-caret ${className}`}
    />
  );
}
