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

/**
 * 弹层在选定那一边最多能有多高（2026-10-20 用户：模型菜单太长溢出界面）：锚点到窗口边缘的空间，
 * 再留出离边的余量；封顶 cap，免得大屏上一路拉到底。弹层自己按这个限高、内部滚动。
 */
export function popoverRoom(
  anchor: { top: number; bottom: number },
  viewportHeight: number,
  side: "above" | "below",
  cap: number,
  gap = 8,
  margin = 12,
): number {
  const space = side === "below" ? viewportHeight - anchor.bottom - gap : anchor.top - gap;
  return Math.max(0, Math.min(cap, space - margin));
}
