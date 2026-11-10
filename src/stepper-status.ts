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
  /** 悬停看的一句（出错了写原因） */
  title?: string;
}

export function stepperStatusText(
  key: StepperStatusKey,
  opts: {
    archived?: boolean;
    attention?: StepperAttention;
    failure?: string | null;
    /** 出错是 AI 自己在对话里说的（会话尾巴，session-tail.ts），不是运行出错退出 */
    failureFromAi?: boolean;
    /** 已完成之后上游又保存过（WorkspaceDto.staleUpstream）：写「待跟进」（综述回路 §5.1，只提醒不阻断） */
    staleUpstream?: string | null;
  } = {},
): StepperStatusText | null {
  // 出错了（2026-11-04 项目助手一期）：这一步最近一次运行出错收场、此刻又没有 AI 在干活 / 等确认时写出来，
  // 原因放悬停（run-failure.ts）。已完成、待评审、有冲突各有更要紧的下一步，不盖掉
  if (
    opts.failure &&
    key === "active" &&
    opts.attention !== "working" &&
    opts.attention !== "confirm"
  ) {
    return {
      text: "出错了",
      tone: "text-err-text",
      title: opts.failureFromAi ? `这一步的 AI 在对话里说：${opts.failure}` : `最近一次运行出错：${opts.failure}`,
    };
  }
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
      return opts.staleUpstream
        ? {
            text: "待跟进",
            tone: "text-warn-text",
            title: `「${opts.staleUpstream}」有更新，这一步可能还没用上；到这一步点「跟进更新」，或不管它直接往下走`,
          }
        : { text: "已完成", tone: "text-l3" };
  }
}
