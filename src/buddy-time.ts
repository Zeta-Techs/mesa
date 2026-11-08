/**
 * 项目助手「小桌」跟着时间换样子（2026-11-04 用户：「白天和夜深了，小桌也可以有不同表现，盘腿睡觉」）。
 * 纯逻辑，配 tests/buddy-time.test.ts；按电脑本地时间算，面板每次打开 / 重画时现算。
 * 只管「没在问」时的样子：一提问就换成在想，答完举手，和时间无关。
 * 2026-11-08 曾改成夜深也亮台灯，同日用户改回：夜深了照旧盘腿睡觉（「睡觉的样子可以夜深了换成这个」），一问就醒。
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
  /** 空状态里的大图：白天挥手、夜深睡着，早上 / 傍晚站着 */
  greetPose: "wave" | "idle" | "sleep";
  /** 头像位（顶栏）：夜深也睡着，其余站着 */
  restPose: "idle" | "sleep";
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
      return { greetPose: "sleep", restPose: "sleep", prop: null, greeting: "夜深了，我先眯一会儿。问我就醒。" };
    default:
      return { greetPose: "wave", restPose: "idle", prop: null, greeting: "有看不懂的，问我。" };
  }
}
