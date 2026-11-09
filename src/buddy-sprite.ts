/**
 * 项目助手「小桌」精灵图的行表（纯逻辑，配 tests/buddy-sprite.test.ts；图在 src/assets/buddy/xiaozhuo.webp）。
 * 2026-11-09 用户拍板改成出图模型孵的逐帧精灵图（借 Codex hatch-pet 的流程，见 MesaBuddy.tsx 文首）。
 * 每格 224px、8 列 × 11 行，人站在格子底部（基线 y≈214），行顺序与帧数必须和图一致——重孵后改这里。
 */
/** wait / walkRight / walkLeft 是桌宠用的（2026-11-09）：有事等你回、被拖着往右 / 往左走 */
export type BuddyPose = "idle" | "wave" | "think" | "happy" | "oops" | "sleep" | "wait" | "walkRight" | "walkLeft";
/** 桌上多放的一样东西，跟着时间换（buddy-time.ts）：早上一杯冒热气的咖啡，傍晚一盏小台灯 */
export type BuddyProp = "coffee" | "lamp" | null;

export const BUDDY_CELL = 224;
export const BUDDY_COLS = 8;
export const BUDDY_ROWS = 11;

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
  /** 安静档（桌宠默认，2026-11-09 用户「一直在动，有没有安静一点的」）放一遍后停在哪一帧：选最能说明状态的那帧（在想 = 托腮、等你 = 抬手） */
  calmHold: number;
}

/** 动作档：lively = 一直循环（项目助手面板、桌宠「活泼」）；calm = 换状态时放一遍、停在说明状态的那帧，隔一阵眨一下；still = 不动，停在那帧 */
export type BuddyMotion = "lively" | "calm" | "still";

/** 安静档隔多久再动一下（毫秒）：35–50 秒之间随机，几只小桌不会同时眨眼 */
export function calmPause(rand: number): number {
  return 35_000 + Math.round(Math.max(0, Math.min(1, rand)) * 15_000);
}

// 平常站着：第一帧停久一点，眨眼和轻晃隔一会儿才来一次，不抢眼
const IDLE = [1800, 160, 160, 120, 160, 260];

const ROWS: Record<BuddyPose, BuddyRow> = {
  idle: { index: 0, durations: IDLE, repeat: null, after: "rest", hold: 0, calmHold: 0 },
  // 打招呼挥两遍，然后站着
  wave: { index: 1, durations: [160, 160, 160, 320], repeat: 2, after: "rest", hold: 0, calmHold: 0 },
  // 在想：托腮、抬眼，问着就一直想
  think: { index: 2, durations: [220, 200, 200, 260, 200, 320], repeat: null, after: "rest", hold: 0, calmHold: 3 },
  // 答完蹦一下
  happy: { index: 3, durations: [120, 130, 160, 130, 260], repeat: 1, after: "rest", hold: 0, calmHold: 0 },
  // 出错：垂头丧气一遍，停在最后那帧（皱眉）
  oops: { index: 4, durations: [140, 140, 140, 160, 220, 160, 140, 240], repeat: 1, after: "hold", hold: 7, calmHold: 7 },
  // 夜深盘腿睡：慢慢一起一伏，z 一个比一个大
  sleep: { index: 5, durations: [520, 420, 420, 420, 420, 620], repeat: null, after: "rest", hold: 0, calmHold: 0 },
  // 有事等你：歪头、手抬到肩，问一句「轮到你了？」，等着就一直这样；第一帧停久一点免得一直晃
  wait: { index: 8, durations: [1200, 150, 150, 150, 150, 260], repeat: null, after: "rest", hold: 0, calmHold: 3 },
  // 被拖着走：左走是右走的镜像
  walkRight: { index: 9, durations: [110, 110, 110, 110, 110, 110, 110, 110], repeat: null, after: "rest", hold: 0, calmHold: 0 },
  walkLeft: { index: 10, durations: [110, 110, 110, 110, 110, 110, 110, 110], repeat: null, after: "rest", hold: 0, calmHold: 0 },
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
 * 画在页面上取格子的哪一块：大图取整格；≤40px（顶栏头像）只裁掉格子四周的空白、整个人都在
 * （2026-11-09 用户截图：原先只取半身，盘腿睡时人坐得低，脸被切掉一半）。x/y/w/h 是精灵图像素，width/height 是页面像素。
 */
export function buddyClip(size: number): { x: number; y: number; w: number; h: number; width: number; height: number } {
  if (size > 40) return { x: 0, y: 0, w: BUDDY_CELL, h: BUDDY_CELL, width: size, height: size };
  // 所有帧合起来的范围是 x 15–216、y 8–216（跳到最高、台灯、热气都算上），四周各留一两像素
  const x = 12;
  const y = 6;
  const w = 206;
  const h = 212;
  return { x, y, w, h, width: Math.round((size * w) / h), height: size };
}
