//! 聊天层转到终端的次数（tests/chat-handoff-log.test.ts）：哪家、为什么聊天层接不住。
//!
//! 只记计数（后端 chat_handoff_log.rs，原因闭集两端同名），用来排聊天层下一步该补什么；
//! 设置「诊断」里按次数排着看，诊断包附带同一份计数。记录失败静默——它不能挡住用户去终端。

import { invoke } from "@tauri-apps/api/core";

export const HANDOFF_REASONS = [
  "confirm_unrecognized",
  "confirm_no_state",
  "stuck_start",
  "picker",
  "user_decision",
  "user_live",
  "user_stuck",
  "user_switch",
] as const;

export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** 设置页上的说法：前四类是 Mesa 自动露出终端，后四类是用户自己点的 */
export const HANDOFF_REASON_LABEL: Record<HandoffReason, string> = {
  confirm_unrecognized: "等确认，聊天卡上认不出菜单",
  confirm_no_state: "等确认，这家没有精确状态",
  stuck_start: "启动后一直没有会话文件",
  picker: "模型 / 思考档只能在终端里选",
  user_decision: "确认卡上点了「露出 / 打开终端」",
  user_live: "点了「看实时输出」",
  user_stuck: "卡住提示里点了「露出 / 打开终端」",
  user_switch: "从聊天切到终端",
};

export function isAutoHandoff(reason: string): boolean {
  return !reason.startsWith("user_");
}

/** 等确认时露出终端：有精确状态（hooks / 旁路）却没认出菜单，和这家压根没有精确状态，是两件不同的待补项 */
export function confirmHandoffReason(
  event: "hooks_confirm" | "no_hooks_confirm",
): HandoffReason {
  return event === "hooks_confirm" ? "confirm_unrecognized" : "confirm_no_state";
}

/** 同一家同一原因 3 秒内只记一次：effect 重跑、连点不重复计 */
const DEDUP_MS = 3000;

export function shouldRecordHandoff(
  last: Map<string, number>,
  agent: string,
  reason: HandoffReason,
  now: number,
): boolean {
  const key = `${agent}\u0000${reason}`;
  const prev = last.get(key);
  if (prev !== undefined && now - prev < DEDUP_MS) return false;
  last.set(key, now);
  return true;
}

const lastRecorded = new Map<string, number>();

/** detail：细分短标识（确认卡的种类等，见 decisionKind），后端只收小写字母数字与 - _ */
export function recordChatHandoff(
  agent: string | null | undefined,
  reason: HandoffReason,
  detail?: string,
): void {
  if (!agent) return;
  if (!shouldRecordHandoff(lastRecorded, agent, reason, Date.now())) return;
  invoke("chat_handoff_record", { agent, reason, detail: detail ?? null }).catch(() => {});
}

/** 确认卡 key 的种类前缀（channel / approval / trust / ask / menu / tui-notice / tui-panel / conn） */
export function decisionKind(key: string): string {
  const kind = key.split(":", 1)[0] ?? "";
  return /^[a-z0-9_-]{1,24}$/.test(kind) ? kind : "";
}

/** 确认卡种类的说法：看「哪类卡上的按钮不够用」 */
export const DECISION_KIND_LABEL: Record<string, string> = {
  channel: "旁路审批卡",
  approval: "通用审批卡",
  trust: "信任目录卡",
  ask: "提问表单",
  menu: "终端菜单卡",
  "tui-notice": "终端提示卡",
  "tui-panel": "终端面板（/cost 等）",
  conn: "连接问题卡",
};

/** 与后端 ChatHandoffStat 对应 */
export interface ChatHandoffStat {
  agent: string;
  reason: string;
  detail: string;
  count: number;
  lastDay: string;
  versions: string[];
}

/** 合计与「自动露出」占比，设置页标题行用 */
export function handoffTotals(stats: ChatHandoffStat[]): { total: number; auto: number } {
  let total = 0;
  let auto = 0;
  for (const s of stats) {
    total += s.count;
    if (isAutoHandoff(s.reason)) auto += s.count;
  }
  return { total, auto };
}
