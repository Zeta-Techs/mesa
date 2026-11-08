/**
 * 项目助手「小桌」跟着时间换样子（2026-11-04 用户：「白天和夜深了，小桌也可以有不同表现，盘腿睡觉」）。
 * 纯逻辑，配 tests/buddy-time.test.ts；按电脑本地时间算，面板每次打开 / 重画时现算。
 * 只管「没在问」时的样子：一提问就换成在想，答完举手，和时间无关。
 * 2026-11-08 夜深不再睡觉（用户「全部做 按你推荐」）：研究生常在深夜用，睡着读起来像「现在不可用」，改成亮着台灯陪着；
 * 睡觉的姿势仍留在 MesaBuddy（pose="sleep"），要改回只动这里。
 */
export type BuddyDayPart = "morning" | "day" | "evening" | "night";

/** 早上 6–11 点、傍晚 18–22 点、夜深 22 点到早上 6 点，其余是白天 */
export function buddyDayPart(hour: number): BuddyDayPart {
  if (hour >= 22 || hour < 6) return "night";
  if (hour < 11) return "morning";
  if (hour >= 18) return "evening";
  return "day";
}

export interface BuddyMood {
  /** 空状态里的大图：白天挥手，其余站着 */
  greetPose: "wave" | "idle";
  /** 头像位（顶栏）：站着 */
  restPose: "idle";
  /** 桌上多放的一样东西 */
  prop: "coffee" | "lamp" | null;
  /** 空状态的开场白 */
  greeting: string;
}

export function buddyMood(part: BuddyDayPart): BuddyMood {
  switch (part) {
    case "morning":
      return { greetPose: "idle", restPose: "idle", prop: "coffee", greeting: "早。有看不懂的，问我。" };
    case "evening":
      return { greetPose: "idle", restPose: "idle", prop: "lamp", greeting: "忙了一天了，有看不懂的，问我。" };
    case "night":
      return { greetPose: "idle", restPose: "idle", prop: "lamp", greeting: "这么晚还在忙。有看不懂的，问我。" };
    default:
      return { greetPose: "wave", restPose: "idle", prop: null, greeting: "有看不懂的，问我。" };
  }
}
