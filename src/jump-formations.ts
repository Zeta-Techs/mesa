/**
 * 聊天「回到最新」浮钮生成中的三枚琥珀光标：队形表与换队规则（2026-10-26 用户：「变换的节奏可以慢一点，队形随机」）。
 * 每枚光标就是 M▁ 里那道横光标；队形里一枚要么是横光标（caret，6×3），要么收成圆点（dot）。
 * 组件（MesaThinkingDots）每隔一拍随机换一个队形，三枚各自滑到新位置——谁去哪格按总路程最短分配，
 * 换队时三枚不互相穿过。纯逻辑，node --test 直接单测。
 */

export interface Slot {
  /** 相对圆钮中心的位移（px） */
  x: number;
  y: number;
  /** 横光标还是圆点 */
  shape: "caret" | "dot";
}

export interface Formation {
  id: string;
  slots: readonly [Slot, Slot, Slot];
}

const c = (x: number, y: number): Slot => ({ x, y, shape: "caret" });
const d = (x: number, y: number): Slot => ({ x, y, shape: "dot" });

/** 第一个是起手式（一行），减弱动态效果时也停在它 */
export const FORMATIONS: readonly Formation[] = [
  // 一行字：光标的本来样子
  { id: "row", slots: [c(-8, 0), c(0, 0), c(8, 0)] },
  // 三颗圆点、顶上一颗：在想
  { id: "triangle", slots: [d(-5, 2.5), d(0, -4), d(5, 2.5)] },
  // 倒三角
  { id: "valley", slots: [d(-5, -2.5), d(0, 4), d(5, -2.5)] },
  // 竖着叠三道：一段话写出来了
  { id: "stack", slots: [c(0, -5), c(0, 0), c(0, 5)] },
  // 往右上走的台阶：一行接一行往上长
  { id: "stairs", slots: [c(-6, 4), c(0, 0), c(6, -4)] },
  // 竖排圆点：⋮
  { id: "column", slots: [d(0, -5.5), d(0, 0), d(0, 5.5)] },
  // 两道在上、一道在下偏左：像写到下一行的开头
  { id: "wrap", slots: [c(-4, -3), c(4, -3), c(-4, 3)] },
];

/** 随机挑下一个队形，不和当前的重复；rand ∈ [0, 1) */
export function pickNextFormation(currentId: string, rand: number): Formation {
  const pool = FORMATIONS.filter((f) => f.id !== currentId);
  const i = Math.min(pool.length - 1, Math.floor(rand * pool.length));
  return pool[i];
}

const PERMS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/**
 * 三枚光标（当前位置 from[i]）各去目标队形的哪一格：返回 out[i] = 第 i 枚去的格。
 * 取总路程（距离平方和）最小的分配——平方和最小的配对两两线段不相交，换队时三枚不互相穿过
 */
export function assignSlots(
  from: readonly { x: number; y: number }[],
  to: readonly Slot[],
): Slot[] {
  let best = PERMS[0];
  let bestCost = Infinity;
  for (const p of PERMS) {
    let cost = 0;
    for (let i = 0; i < 3; i++) {
      const dx = from[i].x - to[p[i]].x;
      const dy = from[i].y - to[p[i]].y;
      cost += dx * dx + dy * dy;
    }
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = p;
    }
  }
  return best.map((j) => to[j]);
}
