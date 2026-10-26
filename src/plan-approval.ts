/**
 * Claude 计划模式出完方案、问「要不要开工」那一屏的纯逻辑（2026-10-26，假网关实测 Claude Code 2.1.308）：
 *
 *   Ready to code? / Here is Claude's plan: / ╌╌ 方案全文 ╌╌ /
 *   Claude has written up a plan and is ready to execute. Would you like to proceed?
 *   ❯ 1. Yes, and use auto mode
 *     2. Yes, manually approve edits
 *     3. Tell Claude what to change
 *        shift+tab to approve with this feedback
 *
 * 通用菜单卡只能照搬英文选项、把方案参数摊成 JSON；这里认出这一屏，卡片改成「整篇方案 + 按方案开工 / 接着改方案」。
 * 选项仍照终端原文一项一项来（不替人选、不造终端里没有的项），只把认得出的几种说成中文、标出开工后按哪一档权限走。
 * 「Tell Claude what to change」是能直接打字的一行：挪过去、打字、回车 = 不开工，把意见交回去接着改方案
 * （实测工具结果是「The user doesn't want to proceed … the user said: <意见>」）。
 * 没写方案文件就调 ExitPlanMode 时只问「Exit plan mode?」（1. Yes, and switch to default … / 2. No），同样认。
 */
import type { PermissionTierId } from "./chat-permission.ts";
import type { TuiMenu } from "./tui-menu.ts";
import type { ChatMessageDto } from "./types.ts";

export type PlanChoiceKind = "go" | "revise" | "stay" | "other";

export interface PlanChoice {
  /** 菜单里的第几项（按键从它算） */
  index: number;
  kind: PlanChoiceKind;
  label: string;
  /** 开工后这一段对话按哪一档走（认不出、或不是四档之一时为 null） */
  tier: PermissionTierId | null;
  /** 一句说明：开工后怎么问你 / 选了会怎样 */
  description: string | null;
  /** 终端原文（按钮悬停时给人对照） */
  original: string;
}

const TIER_TEXT: Record<"ask" | "auto" | "full", { label: string; description: string }> = {
  ask: { label: "请求批准", description: "改文件、跑命令前都先问你" },
  auto: { label: "帮我批准", description: "普通操作直接做，有风险的才问你" },
  full: { label: "完全访问", description: "改文件、跑命令都不再问你" },
};

/** 一项选项说成什么：认不出的照原文 */
export function planChoice(original: string, index: number): PlanChoice {
  const text = original.trim();
  const base = { index, original: text };
  if (/^Yes\b/i.test(text)) {
    const clear = /clear context/i.test(text);
    let tier: "ask" | "auto" | "full" | null = null;
    let mode: { label: string; description: string } | null = null;
    if (/bypass permissions/i.test(text)) tier = "full";
    else if (/\bauto mode\b/i.test(text)) tier = "auto";
    else if (/manually approve|ask each time|switch to default/i.test(text)) tier = "ask";
    else if (/accept edits/i.test(text)) mode = { label: "自动改文件", description: "改文件不问，跑命令仍先问你" };
    if (tier) mode = TIER_TEXT[tier];
    const head = clear ? "清空上下文再开工" : "按方案开工";
    const tail = clear ? "先清掉这段对话的上下文，只带着方案开工" : null;
    return {
      ...base,
      kind: "go",
      tier,
      label: mode ? `${head} · ${mode.label}` : head,
      description: [mode?.description ?? (mode ? null : text), tail].filter(Boolean).join("；") || null,
    };
  }
  if (/^Tell Claude what to change/i.test(text)) {
    return { ...base, kind: "revise", tier: null, label: "接着改方案", description: "写下要改哪里，它照着重写方案，先不动手" };
  }
  if (/^No\b/i.test(text)) {
    return { ...base, kind: "stay", tier: null, label: "先不开工", description: "留在计划模式，接着讨论" };
  }
  return { ...base, kind: "other", tier: null, label: text, description: null };
}

/**
 * 屏上这个菜单是不是方案确认：旁路说这一问来自 ExitPlanMode，或问句就是那两种写法；
 * 并且至少有一项是开工（认不出开工项就交回通用菜单卡，免得卡上一个能开工的按钮都没有）
 */
export function isPlanMenu(menu: TuiMenu | null, approvalTool: string | null | undefined): menu is TuiMenu {
  if (!menu || menu.ask) return false;
  const asked = `${menu.question ?? ""} ${menu.detail ?? ""}`;
  const fromPlan =
    approvalTool === "ExitPlanMode" || /ready to execute|Exit plan mode\?/i.test(asked);
  return fromPlan && menu.options.some((o, i) => planChoice(o, i).kind === "go");
}

/** 卡片标题：写了方案的问「按这个方案开工吗」，没写方案只问要不要退出计划模式 */
export function planMenuTitle(menu: TuiMenu, hasPlan: boolean): string {
  if (hasPlan || /written up a plan|ready to execute/i.test(menu.question ?? "")) return "方案写好了，按这个方案开工吗？";
  return "它想结束计划模式，开始动手吗？";
}

/**
 * 这一轮最近的方案原文（旁路没给时的兜底）：最后一条用户发言之后、最近一次 ExitPlanMode 调用参数里的 plan。
 * Claude 2.1.308 会话文件里这条调用带 plan / planFilePath（CLI 补进去的，模型的参数里没有）
 */
export function latestPlanText(messages: readonly ChatMessageDto[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.blocks.some((b) => b.kind === "text")) return null;
    for (let k = m.blocks.length - 1; k >= 0; k--) {
      const b = m.blocks[k];
      if (b.kind !== "tool_use" || b.toolName !== "ExitPlanMode") continue;
      try {
        const plan = (JSON.parse(b.text) as { plan?: unknown }).plan;
        return typeof plan === "string" && plan.trim() ? plan : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 意见写进「Tell Claude what to change」那一行：一行，不带控制字符（回车会把它交出去） */
export function planFeedbackText(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}
