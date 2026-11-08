/**
 * 项目助手「小桌」精灵图的行表（纯逻辑，配 tests/buddy-sprite.test.ts；图在 src/assets/buddy/xiaozhuo.webp）。
 * 2026-11-09 用户拍板改成出图模型孵的逐帧精灵图（借 Codex hatch-pet 的流程，见 MesaBuddy.tsx 文首）。
 * 每格 224px、8 列 × 8 行，人站在格子底部（基线 y≈214），行顺序与帧数必须和图一致——重孵后改这里。
 */
export type BuddyPose = "idle" | "wave" | "think" | "happy" | "oops" | "sleep";
/** 桌上多放的一样东西，跟着时间换（buddy-time.ts）：早上一杯冒热气的咖啡，傍晚一盏小台灯 */
export type BuddyProp = "coffee" | "lamp" | null;

export const BUDDY_CELL = 224;
export const BUDDY_COLS = 8;
export const BUDDY_ROWS = 8;

export interface BuddyRow {
  /** 图里第几行 */
  index: number;
  /** 每帧停多久（毫秒），长度即帧数 */
  durations: number[];
  /** 放几遍；null = 一直循环 */
  repeat: number | null;
  /** 放完之后：rest = 回到平常站着的样子，hold = 停在 hold 帧不动 */
  after: "rest" | "hold";
  hold: number;
}

// 平常站着：第一帧停久一点，眨眼和轻晃隔一会儿才来一次，不抢眼
const IDLE = [1800, 160, 160, 120, 160, 260];

const ROWS: Record<BuddyPose, BuddyRow> = {
  idle: { index: 0, durations: IDLE, repeat: null, after: "rest", hold: 0 },
  // 打招呼挥两遍，然后站着
  wave: { index: 1, durations: [160, 160, 160, 320], repeat: 2, after: "rest", hold: 0 },
  // 在想：托腮、抬眼，问着就一直想
  think: { index: 2, durations: [220, 200, 200, 260, 200, 320], repeat: null, after: "rest", hold: 0 },
  // 答完蹦一下
  happy: { index: 3, durations: [120, 130, 160, 130, 260], repeat: 1, after: "rest", hold: 0 },
  // 出错：垂头丧气一遍，停在最后那帧（皱眉）
  oops: { index: 4, durations: [140, 140, 140, 160, 220, 160, 140, 240], repeat: 1, after: "hold", hold: 7 },
  // 夜深盘腿睡：慢慢一起一伏，z 一个比一个大
  sleep: { index: 5, durations: [520, 420, 420, 420, 420, 620], repeat: null, after: "rest", hold: 0 },
};
const COFFEE: BuddyRow = { ...ROWS.idle, index: 6 };
const LAMP: BuddyRow = { ...ROWS.idle, index: 7 };

/** 姿势 + 桌上道具 → 放哪一行。道具只有站着时画（问着 / 出错 / 睡着都不带） */
export function buddyRow(pose: BuddyPose, prop: BuddyProp): BuddyRow {
  if (pose === "idle" && prop === "coffee") return COFFEE;
  if (pose === "idle" && prop === "lamp") return LAMP;
  return ROWS[pose];
}

/**
 * 画在页面上取格子的哪一块：大图取整格；≤40px（顶栏头像）只取半身——桌面到桌裙，脸才看得清，腿留给大图。
 * x/y/w/h 是精灵图像素，width/height 是页面像素。
 */
export function buddyClip(size: number): { x: number; y: number; w: number; h: number; width: number; height: number } {
  if (size > 40) return { x: 0, y: 0, w: BUDDY_CELL, h: BUDDY_CELL, width: size, height: size };
  const x = 16;
  const y = 30;
  const w = 192;
  const h = 140;
  return { x, y, w, h, width: Math.round((size * w) / h), height: size };
}
