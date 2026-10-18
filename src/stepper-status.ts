/** 步进器状态小字（2026-10-17 用户拍板）：大圆只有颜色，「待评审」「进行中」一眼分不清，
 *  圆下面一行小字把状态写出来。待开始不写（灰圆 + 空白已经够清楚，一排「待开始」只是噪声）；
 *  检查中是一闪而过的过渡态，也不写，免得文字跳动。
 *  进行中再按终端注意力细分：AI 在等你点确认 / 这一轮说完在等你看——这两种要你出场。 */

export type StepperStatusKey =
  | "pending"
  | "active"
  | "review"
  | "blocked"
  | "done"
  | "checking";

export type StepperAttention = "confirm" | "done" | "working" | null;

export interface StepperStatusText {
  text: string;
  /** 文字色类：与大圆状态色同族（不引入新颜色） */
  tone: string;
}

export function stepperStatusText(
  key: StepperStatusKey,
  opts: { archived?: boolean; attention?: StepperAttention } = {},
): StepperStatusText | null {
  switch (key) {
    case "pending":
      return opts.archived ? { text: "已归档", tone: "text-l4" } : null;
    case "checking":
      return null;
    case "active":
      if (opts.attention === "confirm") return { text: "等你确认", tone: "text-warn-text" };
      if (opts.attention === "done") return { text: "等你查看", tone: "text-cta" };
      return { text: "进行中", tone: "text-cta" };
    case "review":
      return { text: "待评审", tone: "text-cta-pill-text" };
    case "blocked":
      return { text: "有冲突", tone: "text-warn-text" };
    case "done":
      return { text: "已完成", tone: "text-l3" };
  }
}
