/**
 * 聊天输入框上几个小弹层往哪边开（纯逻辑，tests/popover-side.test.ts）。2026-10-18 用户：弹层应该往下弹——
 * 开聊前输入框在屏幕中间，下面空着；开聊后输入框贴底，下面放不下，只能往上。规则：下面放得下就往下，
 * 否则上面放得下往上，两边都放不下挑空间大的一边。
 */
export function pickPopoverSide(
  anchor: { top: number; bottom: number },
  viewportHeight: number,
  menuHeight: number,
  gap = 8,
): "above" | "below" {
  const below = viewportHeight - anchor.bottom - gap;
  const above = anchor.top - gap;
  if (below >= menuHeight) return "below";
  if (above >= menuHeight) return "above";
  return below > above ? "below" : "above";
}
