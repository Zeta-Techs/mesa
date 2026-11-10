/**
 * 项目助手的动作分级（2026-11-06 docs/design-assistant-dispatch-desk.md §1 第 2–3 条）：唯一真源，桌面与手机共用。
 * - auto 不用你点：回答、总结、把等你的事收进列表；
 * - tap 你点一下就生效：答人工请求、给会话留话 / 转达、派出派活单、记规矩、答它的追问——手机上点一下就算人批准过一次；
 * - desktop 只在桌面：确认执行命令、评审采纳、写回项目、删除、跳到某一页、拆成几路、开商量对话、报告给开发者、
 *   发补料单（2026-11-06：要在补料单弹窗里看清退回到哪、勾补完后接着跟进的步骤，可能还要恢复工作副本）。
 * 桌宠（2026-11-09，desk-pet.ts）与手机同档：auto / tap 就地办，desktop 档只给「去看看」。
 * 纯逻辑，配 tests/assistant-ops.test.ts。
 */
import type { AssistantActionKind } from "./project-assistant";

export type OpTier = "auto" | "tap" | "desktop";
export type OpChannel = "desktop" | "phone";

export type AssistantOp =
  | "answer"
  | "queue"
  | "help_answer"
  | "relay"
  | "dispatch"
  | "remember"
  | "clarify_answer"
  /** 信任 Mesa 自建的隔离副本 / 工作副本（只限你经项目助手派出去的活；2026-11-06 用户拍板放到手机上点） */
  | "trust_folder"
  | "confirm_command"
  | "adopt_review"
  | "write_back"
  | "delete"
  | "navigate"
  | "split"
  | "discuss"
  | "report"
  | "rework"
  | "grant_once";

export const OP_TIERS: Readonly<Record<AssistantOp, OpTier>> = {
  answer: "auto",
  queue: "auto",
  help_answer: "tap",
  relay: "tap",
  dispatch: "tap",
  remember: "tap",
  clarify_answer: "tap",
  trust_folder: "tap",
  // 定时任务被授权范围拦下：放宽重跑这一次（只下一次，2026-11-08）；以后都放宽只在桌面改授权
  grant_once: "tap",
  confirm_command: "desktop",
  adopt_review: "desktop",
  write_back: "desktop",
  delete: "desktop",
  navigate: "desktop",
  split: "desktop",
  discuss: "desktop",
  report: "desktop",
  rework: "desktop",
};

export function opAllowed(op: AssistantOp, channel: OpChannel): boolean {
  return channel === "desktop" || OP_TIERS[op] !== "desktop";
}

/** 回答里的动作标记 → 动作：留话是转达，其余都是跳到桌面某一页或开桌面上的东西 */
export function actionOp(kind: AssistantActionKind): AssistantOp {
  switch (kind) {
    case "mail":
      return "relay";
    case "split":
      return "split";
    case "discuss":
    case "consult":
      return "discuss";
    case "report":
      return "report";
    default:
      return "navigate";
  }
}

/** 手机上碰到只在桌面的动作时回的一句 */
export function desktopOnlyNote(what: string): string {
  return `「${what}」要在电脑上的 Mesa 里处理，手机上做不了。`;
}
