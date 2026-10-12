/** 终端标签条拖拽排序纯逻辑（tests/tab-drag.test.ts）。
 *  槽位 = 各标签拖拽开始时实测的 { left, width }（viewport 坐标，顺序 = tabs 顺序）。 */

export interface TabSlot {
  left: number;
  width: number;
}

/** 拖动位移钳制：源标签不出标签条内容范围（左缘不过首槽左缘、右缘不过末槽右缘） */
export function clampTabDragDx(
  slots: TabSlot[],
  from: number,
  rawDx: number,
): number {
  if (slots.length === 0) return 0;
  const min = slots[0].left - slots[from].left;
  const max =
    slots[slots.length - 1].left +
    slots[slots.length - 1].width -
    (slots[from].left + slots[from].width);
  return Math.min(max, Math.max(min, rawDx));
}

/** 拖拽橡胶带（apple-motion §9，2026-10-12）：越界部分阻力递增——标签在条端
 *  不再「冻住」，而是像被皮筋拉着越拖越紧；松手吸附动画（150ms 过渡）负责回弹。
 *  界内与钳制值恒等，只放宽视觉；槽位判定仍用 clampTabDragDx，语义不动。 */
export function rubberbandTabDx(
  slots: TabSlot[],
  from: number,
  rawDx: number,
): number {
  if (slots.length === 0) return 0;
  const min = slots[0].left - slots[from].left;
  const last = slots[slots.length - 1];
  const max = last.left + last.width - (slots[from].left + slots[from].width);
  if (rawDx < min) return min - rubberbandOvershoot(min - rawDx, stripWidth(slots));
  if (rawDx > max) return max + rubberbandOvershoot(rawDx - max, stripWidth(slots));
  return rawDx;
}

/** emil 公式：(overshoot·dimension·c)/(dimension + c·|overshoot|)，c = 0.55 */
function rubberbandOvershoot(overshoot: number, dimension: number): number {
  const c = 0.55;
  return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
}

function stripWidth(slots: TabSlot[]): number {
  const last = slots[slots.length - 1];
  return Math.max(1, last.left + last.width - slots[0].left);
}

/** 目标槽位判定：源中心（钳制后的 dx 换算）越过谁的中线就占谁的位。
 *  必须用 >=：钳制上限恰好让源中心到达末槽中线（等宽槽位时等号成立），
 *  严格 > 会让「拖到最右」永远差一个无穷小、永远不让位 */
export function tabDragTarget(
  slots: TabSlot[],
  from: number,
  dx: number,
): number {
  const cx = slots[from].left + slots[from].width / 2 + dx;
  let target = 0;
  for (let k = 0; k < slots.length; k++) {
    if (cx >= slots[k].left + slots[k].width / 2) target = k;
  }
  return target;
}
