/**
 * 聊天输入框上几个小弹层往哪边开（纯逻辑，tests/popover-side.test.ts）。2026-10-18 用户：弹层应该往下弹——
 * 开聊前输入框在屏幕中间，下面空着；开聊后输入框贴底，下面放不下，只能往上。规则：下面放得下就往下，
 * 否则上面放得下往上，两边都放不下挑空间大的一边。
 */
/**
 * 弹层能占的上下边界：窗口高度（从 0 起），或 clipBounds 量出来的可见区。2026-10-22 用户截图：模型菜单往上开时顶出了
 * 运行页、被顶栏盖住——原先按整个窗口算，可弹层挂在会裁切它的容器里（运行页区域在顶栏下面），容器上沿才是边
 */
export type PopoverBounds = number | { top: number; bottom: number };

function edges(bounds: PopoverBounds): { top: number; bottom: number } {
  return typeof bounds === "number" ? { top: 0, bottom: bounds } : bounds;
}

export function pickPopoverSide(
  anchor: { top: number; bottom: number },
  bounds: PopoverBounds,
  menuHeight: number,
  gap = 8,
): "above" | "below" {
  const b = edges(bounds);
  const below = b.bottom - anchor.bottom - gap;
  const above = anchor.top - b.top - gap;
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
  bounds: PopoverBounds,
  side: "above" | "below",
  cap: number,
  gap = 8,
  margin = 12,
): number {
  const b = edges(bounds);
  const space = side === "below" ? b.bottom - anchor.bottom - gap : anchor.top - b.top - gap;
  return Math.max(0, Math.min(cap, space - margin));
}

/** 弹层（挂在 el 里、absolute 定位）真正看得见的上下边：窗口与每个会裁切它的祖先（overflow 不是 visible）取交集 */
export function clipBounds(el: Element | null): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const st = getComputedStyle(p);
    if (st.overflowX === "visible" && st.overflowY === "visible") continue;
    const r = p.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}
