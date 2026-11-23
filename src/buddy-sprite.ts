/**
 * 项目助手与桌宠形象的纯数据与时序规则（配 tests/buddy-sprite.test.ts）。
 * 2026-11-20 用户拍板替换旧卡通贴纸「小桌」（xiaozhuo.webp 已移除），提供两套纯矢量形象在设置页切换：
 * - cat（默认）：13×10 极简双色像素黑猫（单色猫身 + 品牌琥珀眼），极简可爱、无白贴纸边；
 * - monolith：无底座精工仪（OLED 黑屏 + 琥珀光标眼神，干活态仅底槽单轨扫描不晃眼）。
 */

export type BuddyStyle = "cat" | "monolith";
export const DEFAULT_BUDDY_STYLE: BuddyStyle = "cat";

export function normalizeBuddyStyle(value?: string | null): BuddyStyle {
  return value === "monolith" ? "monolith" : DEFAULT_BUDDY_STYLE;
}

/** wait / walkRight / walkLeft 是桌宠用的：有事等你回、被拖着往右 / 往左走 */
export type BuddyPose = "idle" | "wave" | "think" | "happy" | "oops" | "sleep" | "wait" | "walkRight" | "walkLeft";
/** 保留时段道具类型签名以兼容 buddy-time.ts / desk-pet.ts（像素黑猫与 Monolith 不堆砌桌面杂物） */
export type BuddyProp = "coffee" | "lamp" | null;

export const CAT_COLS = 13;
export const CAT_ROWS = 10;

export interface BuddyRow {
  /** 每帧停多久（毫秒），长度即帧数 */
  durations: number[];
  /** 放几遍；null = 一直循环 */
  repeat: number | null;
  /** 放完之后：rest = 回到平常待机，hold = 停在 hold 帧不动 */
  after: "rest" | "hold";
  hold: number;
  /** 安静档（桌宠默认）放一遍后停在哪一帧 */
  calmHold: number;
}

/** 动作档：lively = 一直循环（项目助手面板、桌宠「活泼」）；calm = 换状态时放一遍停在 calmHold，隔 35–50 秒再动一下；still = 不动 */
export type BuddyMotion = "lively" | "calm" | "still";

/** 安静档隔多久再动一下（毫秒）：35–50 秒之间随机 */
export function calmPause(rand: number): number {
  return 35_000 + Math.round(Math.max(0, Math.min(1, rand)) * 15_000);
}

const WALK_RIGHT_FRAMES: readonly (readonly string[])[] = [
  [
    ".............",
    ".....M...M...",
    ".....MM.MM...",
    ".....MMMMM...",
    ".....MMAMA...",
    ".M...MMMMM...",
    "..MMMMMMMM...",
    "...MMMMMMM...",
    "..MM....MM...",
    ".............",
  ],
  [
    ".............",
    ".....M...M...",
    ".....MM.MM...",
    ".....MMMMM...",
    ".....MMAMA...",
    "..M..MMMMM...",
    "..MMMMMMMM...",
    "...MMMMMMM...",
    "....MM.MM....",
    ".............",
  ],
];

function mirrorGrid(grid: readonly string[]): string[] {
  return grid.map((row) => [...row].reverse().join(""));
}

/**
 * 13×10 极简像素黑猫逐帧矩阵（M=猫身, A=琥珀眼, H=高光琥珀/星点, B=闭眼微暗琥珀, E=出错低饱和红眼, .=透明）。
 * 纯双色剪影，深浅主题和沉浸黑下均无需描边即可清晰立住。
 */
export const CAT_FRAMES: Record<BuddyPose, readonly (readonly string[])[]> = {
  idle: [
    // 0: 端坐 + 竖尾
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MAMMAM.....",
      "..MMMMMM...M.",
      "...MMMMMM..M.",
      "..MMMMMMMM.M.",
      "..MMMMMMMMM..",
      "..MM....MM...",
      ".............",
    ],
    // 1: 轻晃尾巴
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MAMMAM.....",
      "..MMMMMM..M..",
      "...MMMMMM..M.",
      "..MMMMMMMM.M.",
      "..MMMMMMMMM..",
      "..MM....MM...",
      ".............",
    ],
    // 2: 柔和眨眼
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MBMMBM.....",
      "..MMMMMM...M.",
      "...MMMMMM..M.",
      "..MMMMMMMM.M.",
      "..MMMMMMMMM..",
      "..MM....MM...",
      ".............",
    ],
    // 3: 回到轻晃尾
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MAMMAM.....",
      "..MMMMMM..M..",
      "...MMMMMM..M.",
      "..MMMMMMMM.M.",
      "..MMMMMMMMM..",
      "..MM....MM...",
      ".............",
    ],
  ],
  wave: [
    // 抬起一只小前爪打招呼
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MHMMHM.....",
      "..MMMMMM...M.",
      ".M.MMMMMM..M.",
      "..MMMMMMMM.M.",
      "..MMMMMMMMM..",
      "........MM...",
      ".............",
    ],
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MAMMAM.....",
      ".M.MMMMM..M..",
      "..MMMMMMMM.M.",
      "..MMMMMMMM.M.",
      "..MMMMMMMMM..",
      "........MM...",
      ".............",
    ],
  ],
  think: [
    // 干活中：盯住身旁跳动的琥珀小光标
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM..H..",
      "..MAMMAM.....",
      "..MMMMMM..M..",
      "...MMMMMM.M..",
      "..MMMMMMMMM..",
      "..MMMMMMMM...",
      "..MM....MM...",
      ".............",
    ],
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM...H.",
      "..MAMMAM.....",
      "..MMMMMM...M.",
      "...MMMMMM..M.",
      "..MMMMMMMM.M.",
      "..MMMMMMMMM..",
      "..MM....MM...",
      ".............",
    ],
  ],
  wait: [
    // 等你拍板：眼睛亮起 + 头顶小琥珀星
    [
      "..M....M..H..",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MHMMHM.....",
      "..MMMMMM...M.",
      "...MMMMMM..M.",
      "..MMMMMMMM.M.",
      "..MMMMMMMMM..",
      "..MM....MM...",
      ".............",
    ],
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MHMMHM.....",
      "..MMMMMM..M..",
      "...MMMMMM.M..",
      "..MMMMMMMMM..",
      "..MMMMMMMM...",
      "..MM....MM...",
      ".............",
    ],
  ],
  happy: [
    // 完成：开心轻蹦 1px
    [
      ".............",
      "..M....M..H..",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MHMMHM...M.",
      "..MMMMMM..M..",
      "...MMMMMMMM..",
      "..MM....MM...",
      ".............",
      ".............",
    ],
    [
      "..M....M.....",
      "..MM..MM.....",
      "..MMMMMM.....",
      "..MHMMHM.....",
      "..MMMMMM...M.",
      "...MMMMMM..M.",
      "..MMMMMMMM.M.",
      "..MMMMMMMMM..",
      "..MM....MM...",
      ".............",
    ],
  ],
  oops: [
    // 出错：双色飞机耳压平 + 低饱和红眼
    [
      ".............",
      ".MM....MM....",
      "..MMMMMM.....",
      "..MEMMEM.....",
      "..MMMMMM.....",
      "...MMMMMM....",
      "..MMMMMMMM...",
      "..MMMMMMMMMM.",
      "..MM....MM...",
      ".............",
    ],
    [
      ".............",
      ".MM....MM....",
      "..MMMMMM.....",
      "..MEMMEM.....",
      "..MMMMMM.....",
      "...MMMMMM....",
      "..MMMMMMMM...",
      "..MMMMMMMMM..",
      "..MM....MM...",
      ".............",
    ],
  ],
  sleep: [
    // 深夜：蜷成一小团安静睡觉
    [
      ".............",
      ".............",
      ".............",
      ".............",
      "..M..M.......",
      ".MMMMMMMMM...",
      ".MBMMBMMMMM..",
      ".MMMMMMMMMM..",
      "..MMMMMMMM...",
      ".............",
    ],
    [
      ".............",
      ".........H...",
      ".............",
      ".............",
      "..M..M.......",
      ".MMMMMMMMM...",
      ".MBMMBMMMMM..",
      ".MMMMMMMMMM..",
      "..MMMMMMMM...",
      ".............",
    ],
  ],
  walkRight: WALK_RIGHT_FRAMES,
  walkLeft: WALK_RIGHT_FRAMES.map(mirrorGrid),
};

const ROWS: Record<BuddyPose, BuddyRow> = {
  idle: { durations: [2200, 460, 170, 460], repeat: null, after: "rest", hold: 0, calmHold: 0 },
  wave: { durations: [220, 240], repeat: 2, after: "rest", hold: 0, calmHold: 0 },
  think: { durations: [480, 480], repeat: null, after: "rest", hold: 0, calmHold: 0 },
  happy: { durations: [220, 260], repeat: 2, after: "rest", hold: 0, calmHold: 0 },
  oops: { durations: [220, 320], repeat: 1, after: "hold", hold: 1, calmHold: 1 },
  sleep: { durations: [950, 950], repeat: null, after: "rest", hold: 0, calmHold: 0 },
  wait: { durations: [1100, 360], repeat: null, after: "rest", hold: 0, calmHold: 0 },
  walkRight: { durations: [160, 160], repeat: null, after: "rest", hold: 0, calmHold: 0 },
  walkLeft: { durations: [160, 160], repeat: null, after: "rest", hold: 0, calmHold: 0 },
};

/** 姿势 → 帧时序与安静档停帧规则（保留 _prop 参数以兼容既有调用方） */
export function buddyRow(pose: BuddyPose, _prop: BuddyProp = null): BuddyRow {
  return ROWS[pose];
}
