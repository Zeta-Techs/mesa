/**
 * 计划模式写完方案、问「要不要开工」那一屏的纯逻辑（2026-10-26，假网关 TRIGGER_PLAN 逐家实测）。四家的样子：
 *
 * - Claude Code 2.1.308：Ready to code? / Here is Claude's plan: / ╌ 方案 ╌ / … Would you like to proceed?
 *   1. Yes, and use auto mode / 2. Yes, manually approve edits / 3. Tell Claude what to change（能直接打字的一行）
 *   没写方案文件就调时只问「Exit plan mode?」（1. Yes, and switch to default … / 2. No）
 * - CodeBuddy 2.175：Ready to code? / 方案 / ─── / Would you like to proceed? / 1. Yes / 2. No, keep planning (escape) / 3. Exit plan mode
 *   （Yes = 回到启动时的权限开工；Exit plan mode = 结束计划模式但不按方案动手，工具结果告诉模型「用户没批」）
 * - Gemini 0.65：框里 Ready to start implementation? / 方案 / 1. Yes, automatically accept edits / 2. Yes, manually accept edits /
 *   3. Type your feedback...（能直接打字的一行）。自动 = 切到 Auto-Edit（只放行改文件），手动 = Default
 * - Kimi 2.3.1：Current plan 框 / Ready to build with this plan? / 1. Approve / 2. Reject / 3. Revise
 *   （Approve = 回到启动时的权限；Revise 要先回车，出「Type feedback · ↵ submit」再打字回车）
 * - Qwen 0.25.3：? ExitPlanMode Plan: / 方案 / Would you like to proceed? / 1. Yes, restore previous mode (default) /
 *   2. Yes, and auto-accept edits / 3. Yes, and manually approve edits / 4. No, keep planning (esc)（没有写意见的那一行）
 * - OpenCode 1.19.3（plan agent + 实验性计划模式）：Plan at <方案文件> is complete. Would you like to switch to the build agent
 *   and start implementing? / 1. Yes / 2. No（每项下一行说明；没有 ❯，当前项只靠序号颜色，tui-menu colorMarkedMenu）
 *
 * 通用菜单卡只能照搬英文选项；这里认出这一屏，卡片改成「整篇方案 + 按方案开工 / 接着改方案」。选项仍照终端原文一项一项来
 * （不替人选、不造终端里没有的项），只把认得出的几种说成中文、标出开工后按哪一档权限走。
 * 改方案的意见交回去后，工具结果都是「带意见的拒绝」，留在计划模式（四家实测一致）。
 */
import type { PermissionTierId } from "./chat-permission.ts";
import type { TuiMenu } from "./tui-menu.ts";
import type { ChatMessageDto } from "./types.ts";

/** go = 开工；revise = 写意见改方案；stay = 不开工、留在计划模式；leave = 结束计划模式但不按方案动手（CodeBuddy）；other = 认不出 */
export type PlanChoiceKind = "go" | "revise" | "stay" | "leave" | "other";

export interface PlanChoice {
  /** 菜单里的第几项（按键从它算） */
  index: number;
  kind: PlanChoiceKind;
  label: string;
  /** 开工后这一段对话按哪一档走；null = 回到这家 CLI 自己的设置（或不是四档之一） */
  tier: PermissionTierId | null;
  /** 一句说明：开工后怎么问你 / 选了会怎样 */
  description: string | null;
  /** 终端原文（按钮悬停时给人对照） */
  original: string;
  /** 改方案那一行要先回车才能打字（Kimi「Revise」）；Claude / Gemini 挪过去直接打字 */
  openFirst?: boolean;
}

/** 屏上方案确认的样子：认出了标题（Ready to code? 一类），以及屏上读得到的方案原文 */
export interface PlanScreen {
  text: string | null;
}

const TIER_TEXT: Record<"ask" | "auto" | "full", { label: string; description: string }> = {
  ask: { label: "请求批准", description: "改文件、跑命令前都先问你" },
  auto: { label: "帮我批准", description: "普通操作直接做，有风险的才问你" },
  full: { label: "完全访问", description: "改文件、跑命令都不再问你" },
};
const ACCEPT_EDITS = { label: "自动改文件", description: "改文件不问，跑命令仍先问你" };
/** Qwen「Yes, restore previous mode (<模式名>)」：括号里是要回到的那个模式 */
const PREVIOUS_MODE: Record<string, "ask" | "auto" | "full" | "edits"> = {
  default: "ask",
  "auto-edit": "edits",
  autoedit: "edits",
  auto: "auto",
  yolo: "full",
};

/** 选项行尾的按键提示「(escape)」「(shift+tab)」不算名字 */
function bare(text: string): string {
  return text.replace(/\s*\((?:escape|esc|shift\s*\+\s*tab|tab)\)\s*$/i, "").trim();
}

/** 一项选项说成什么：认不出的照原文 */
export function planChoice(original: string, index: number): PlanChoice {
  const text = bare(original);
  const base = { index, original: text };
  if (/^(?:Yes\b|Approve\b)/i.test(text)) {
    const clear = /clear context/i.test(text);
    let tier: "ask" | "auto" | "full" | null = null;
    let mode: { label: string; description: string } | null = null;
    const previous = /restore previous mode \(([\w-]+)\)/i.exec(text)?.[1]?.toLowerCase();
    if (previous && PREVIOUS_MODE[previous]) {
      const m = PREVIOUS_MODE[previous];
      if (m === "edits") mode = ACCEPT_EDITS;
      else tier = m;
    } else if (/bypass permissions/i.test(text)) tier = "full";
    else if (/\bauto mode\b/i.test(text)) tier = "auto";
    else if (/manually (?:approve|accept)|ask each time|switch to default/i.test(text)) tier = "ask";
    else if (/accept edits/i.test(text)) mode = ACCEPT_EDITS;
    if (tier) mode = TIER_TEXT[tier];
    const head = clear ? "清空上下文再开工" : "按方案开工";
    const tail = clear ? "先清掉这段对话的上下文，只带着方案开工" : null;
    // 只有「Yes」「Approve」（OpenCode 是「Yes」后面跟一行说明「Switch to build agent …」）：回到这家 CLI 自己的设置接着做
    const plain = /^(?:Yes|Approve)$/i.test(text) || /^Yes\b.*switch to build agent/i.test(text);
    const description = mode?.description ?? (plain ? "权限回到这家 CLI 自己的设置" : text);
    if (previous) {
      // Qwen 第一项和「手动批准」那项开工后都是请求批准，名字不能一样：这一项写「回到原来的权限」
      return {
        ...base,
        kind: "go",
        tier,
        label: `${head} · 回到原来的权限`,
        description: mode ? `原来是「${mode.label}」：${mode.description}` : text,
      };
    }
    return {
      ...base,
      kind: "go",
      tier,
      label: mode ? `${head} · ${mode.label}` : head,
      description: [description, tail].filter(Boolean).join("；") || null,
    };
  }
  if (/^(?:Tell \w+ what to change|Type your feedback|Revise)\b/i.test(text)) {
    return {
      ...base,
      kind: "revise",
      tier: null,
      label: "接着改方案",
      description: "写下要改哪里，它照着重写方案，先不动手",
      ...(/^Revise\b/i.test(text) ? { openFirst: true } : {}),
    };
  }
  if (/^Exit plan mode\b/i.test(text)) {
    return { ...base, kind: "leave", tier: null, label: "结束计划模式，先不开工", description: "不按这个方案动手，之后接着聊" };
  }
  if (/^(?:No\b|Reject\b)/i.test(text)) {
    return { ...base, kind: "stay", tier: null, label: "先不开工", description: "留在计划模式，接着讨论" };
  }
  return { ...base, kind: "other", tier: null, label: text, description: null };
}

const PLAN_QUESTION =
  /ready to execute|Exit plan mode\?|Ready to (?:code|start implementation|build with this plan)\?|switch to the build agent/i;
/** 各家「结束计划」的工具名（旁路审批带着它时认作方案确认） */
export const PLAN_EXIT_TOOLS: ReadonlySet<string> = new Set(["ExitPlanMode", "exit_plan_mode", "plan_exit"]);

/**
 * 屏上这个菜单是不是方案确认：旁路说这一问来自结束计划的工具、屏上认出了方案确认的标题、或问句就是那几种写法；
 * 并且至少有一项是开工（认不出开工项就交回通用菜单卡，免得卡上一个能开工的按钮都没有）
 */
export function isPlanMenu(menu: TuiMenu | null, approvalTool: string | null | undefined): menu is TuiMenu {
  if (!menu || menu.ask) return false;
  const asked = `${menu.question ?? ""} ${menu.detail ?? ""}`;
  const fromPlan =
    Boolean(approvalTool && PLAN_EXIT_TOOLS.has(approvalTool)) || Boolean(menu.plan) || PLAN_QUESTION.test(asked);
  return fromPlan && menu.options.some((o, i) => planChoice(o, i).kind === "go");
}

/** 卡片标题：写了方案的问「按这个方案开工吗」，没写方案只问要不要退出计划模式 */
export function planMenuTitle(menu: TuiMenu, hasPlan: boolean): string {
  if (hasPlan || !/Exit plan mode\?/i.test(menu.question ?? "")) return "方案写好了，按这个方案开工吗？";
  return "它想结束计划模式，开始动手吗？";
}

// 方案确认的标题行：Claude「Here is Claude's plan:」、CodeBuddy「Ready to code?」、Gemini「Ready to start implementation?」、
// Qwen「? ExitPlanMode Plan: ←」；Kimi 是方案框的上沿「┌ plan: <文件名> ───┐」
const SCREEN_HEADER = /^(?:Here is \w+'s plan:|Ready to code\?|Ready to start implementation\?|\?\s*ExitPlanMode Plan:.*)$/i;
const KIMI_BOX_TOP = /^┌\s*plan:/i;
const RULE = /^[─━═▔▁]{8,}$/;
const DASHED = /^[╌┄┈╍┅┉]{8,}$/;
const OPTION_LINE = /^(?:[❯›>▶●]\s*)?\d+[.)]\s/;
const STOP_LINE =
  /^(?:Would you like to proceed\?|Ready to build with this plan\?|Claude has written up a plan|o open full plan in editor)/i;

/** 去掉方框左右竖边与右侧滚动条（Gemini 整个画在 │ 框里，Kimi 方案框 │ … │） */
function strip(line: string): string {
  return line
    .replace(/[\s█▐▌]+$/, "")
    .replace(/\s*[│┃]$/, "")
    .replace(/^\s*[│┃]\s?/, "");
}

/**
 * 屏上方案确认的标题与方案原文（旁路、会话文件都给不出方案时的兜底）。方案长过一屏时只读得到屏上那一截；
 * 读出来的是终端排过版的字（标题的 # 已经没了），卡片按原样分行显示、不当 Markdown 排
 */
export function screenPlan(lines: readonly string[], menu?: TuiMenu | null): PlanScreen | null {
  const rows = lines.map(strip);
  // 取最后一个标题：Claude 先「Ready to code?」再「Here is Claude's plan:」，方案在后者下面
  let h = -1;
  rows.forEach((r, i) => {
    if (SCREEN_HEADER.test(r.trim()) || KIMI_BOX_TOP.test(r.trim())) h = i;
  });
  if (h < 0) return null;
  // 方案里常有编号清单，长得和选项一样：只在碰到菜单第一项（Gemini 方案和选项在同一个框里）时停
  const first = menu?.options[0]?.slice(0, 16) ?? null;
  const isFirstOption = (t: string) => {
    const m = OPTION_LINE.exec(t);
    return Boolean(m && first && t.slice(m[0].length).trimStart().startsWith(first));
  };
  const body: string[] = [];
  let i = h + 1;
  while (i < rows.length && (!rows[i].trim() || DASHED.test(rows[i].trim()))) i++;
  for (; i < rows.length; i++) {
    const t = rows[i].trim();
    if (DASHED.test(t) || RULE.test(t) || /^[└╰]/.test(t) || isFirstOption(t) || STOP_LINE.test(t)) break;
    body.push(rows[i].replace(/^ /, "").trimEnd());
  }
  while (body.length && !body[body.length - 1].trim()) body.pop();
  // 去掉共同缩进（CodeBuddy 方案整体缩进两格）
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99);
  const text = body
    .map((l) => l.slice(Math.min(pad, l.length - l.trimStart().length)))
    .join("\n")
    .trim();
  return { text: text || null };
}

/** 方案文件：…/plans/<名>.md（Claude、CodeBuddy、Gemini、Kimi 都放在一个 plans 目录里） */
const PLAN_FILE = /[\\/]plans[\\/][^\\/]+\.md$/i;

/**
 * 这一轮最近的方案原文（旁路没给时的兜底），从最后一条用户发言之后往回找：
 * ① 结束计划的调用参数里带 plan（Claude 2.1.308 会话文件里 CLI 补进去的）；
 * ② 往方案文件里写的那一次（Write / write_file 的 content；CodeBuddy 只有 REPL，从 JS 代码里的 Write({ … content: "…" }) 取）
 */
export function latestPlanText(messages: readonly ChatMessageDto[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.blocks.some((b) => b.kind === "text")) return null;
    for (let k = m.blocks.length - 1; k >= 0; k--) {
      const b = m.blocks[k];
      if (b.kind !== "tool_use") continue;
      const text = planFromCall(b.toolName ?? "", b.text);
      if (text) return text;
    }
  }
  return null;
}

function planFromCall(name: string, raw: string): string | null {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  if (name === "ExitPlanMode" || name === "exit_plan_mode") return str(input.plan);
  if (/^(?:Write|write_file|write|WriteFile)$/.test(name)) {
    const path = str(input.file_path) ?? str(input.path) ?? str(input.filePath);
    return path && PLAN_FILE.test(path) ? str(input.content) : null;
  }
  if (name === "REPL") {
    const code = str(input.code);
    if (!code || !/\bWrite\s*\(/.test(code)) return null;
    const path = /file_path\s*:\s*("(?:[^"\\]|\\.)*")/.exec(code);
    const content = /content\s*:\s*("(?:[^"\\]|\\.)*")/.exec(code);
    if (!path || !content) return null;
    try {
      return PLAN_FILE.test(JSON.parse(path[1]) as string) ? str(JSON.parse(content[1])) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 意见写进改方案那一行：一行，不带控制字符（回车会把它交出去） */
export function planFeedbackText(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}
