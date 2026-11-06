/**
 * 项目助手调度台（2026-11-06，docs/design-assistant-dispatch-desk.md §2）：这个项目里「等你的事」。
 * 三个来源全机械判定，不调 AI：人工请求（未答的）、AI 在对话里问你的话（最后一段像在问、它没在干活）、等你确认的命令。
 * 你就地回，Mesa 原路、原话转达（assistant-desk.ts）。纯逻辑，配 tests/assistant-queue.test.ts。
 */

export type DeskKind = "help" | "question" | "confirm" | "trust";

export interface DeskItem {
  /** 稳定键：同一件事在桌面与手机上同一个键（手机推送去重、按钮回传都靠它） */
  key: string;
  kind: DeskKind;
  /** 第几步（从 1 数）；对不上步骤为 null */
  step: number | null;
  /** 「第 2 步「精读」」「工作副本「x」」「项目根」 */
  where: string;
  question: string;
  /** 人工请求的选项（key + label + 后果）；其余为空 */
  options: { key: string; label: string; effect: string | null }[];
  recommend: string | null;
  detail: string[];
  /** 人工请求：来源根与这一条的 id（写回作答用） */
  helpRoot?: string;
  helpItemId?: string;
  /** 这一步的工作副本（转达用） */
  worktreePath?: string | null;
  /** 等确认 / 停在信任菜单的标签（带路、替人按菜单用） */
  tabId?: string;
  /** 信任菜单：两项原文；dispatched = 这是你经项目助手派出去的活（手机上才能点信任，2026-11-06 用户拍板） */
  trust?: { yes: string; no: string; path: string | null; dispatched: boolean };
}

export interface DeskStep {
  index: number;
  name: string;
  workspaceName: string;
  worktreePath: string | null;
}

export interface DeskHelpInput {
  root: string;
  workspaceName: string | null;
  items: {
    id: string;
    question: string;
    detail: string[];
    recommend: string | null;
    options: { key: string; label: string; effect: string | null }[];
    answer: string | null;
    sent: string | null;
  }[];
}

export interface DeskTailInput {
  step: DeskStep;
  /** AI 在这段对话里最后说的一段话 */
  text: string;
  /** 它此刻在干活 / 停在等确认（这两种不算在问你） */
  busy: boolean;
}

export interface DeskConfirmInput {
  tabId: string;
  title: string;
  step: DeskStep | null;
  /** 停在启动时的信任菜单（不是命令确认） */
  trust?: { yes: string; no: string; path: string | null; dispatched: boolean } | null;
}

/** 最后一段话像在问人：结尾是问号，或用了「要不要 / 是否 / 请确认 / 选哪 / 你希望 / 需要你」这类问法；说「已完成」一类的总结不算 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const tail = t.slice(-300);
  if (/[？?]\s*[)）」"']?\s*$/.test(tail)) return true;
  return /要不要|是否需要|是否要|请确认|请你确认|你希望|您希望|选哪|选择哪|需要你(决定|确认|拍板|提供)|等你(决定|确认)|告诉我你/.test(tail);
}

/** 一段话太长时只留结尾的问法（卡片与列表里放得下） */
export function questionExcerpt(text: string, max = 280): string {
  const t = text.trim().replace(/\n{3,}/g, "\n\n");
  if (t.length <= max) return t;
  return `…${t.slice(-max).replace(/^[^\n。！？.!?]*[\n。！？.!?]/, "").trim()}`;
}

function stepLabel(step: DeskStep): string {
  return `第 ${step.index + 1} 步「${step.name}」`;
}

export function buildDeskItems(input: {
  steps: readonly DeskStep[];
  help: readonly DeskHelpInput[];
  tails: readonly DeskTailInput[];
  confirms: readonly DeskConfirmInput[];
}): DeskItem[] {
  const out: DeskItem[] = [];
  for (const req of input.help) {
    const step = req.workspaceName ? (input.steps.find((s) => s.workspaceName === req.workspaceName) ?? null) : null;
    for (const item of req.items) {
      if (item.answer || item.sent) continue;
      out.push({
        key: `help:${req.root}:${item.id}`,
        kind: "help",
        step: step ? step.index + 1 : null,
        where: step ? stepLabel(step) : req.workspaceName ? `工作副本「${req.workspaceName}」` : "项目根",
        question: item.question,
        options: item.options,
        recommend: item.recommend,
        detail: item.detail,
        helpRoot: req.root,
        helpItemId: item.id,
        worktreePath: step?.worktreePath ?? null,
      });
    }
  }
  for (const c of input.confirms) {
    out.push({
      key: `${c.trust ? "trust" : "confirm"}:${c.tabId}`,
      kind: c.trust ? "trust" : "confirm",
      step: c.step ? c.step.index + 1 : null,
      where: c.step ? stepLabel(c.step) : `对话「${c.title}」`,
      question: c.trust
        ? `AI 刚启动，停在「是否信任这个文件夹」${c.trust.path ? `（${c.trust.path}）` : ""}，不选它就一直不干活`
        : "AI 停下来等你确认一条命令",
      options: [],
      recommend: null,
      detail: [],
      tabId: c.tabId,
      worktreePath: c.step?.worktreePath ?? null,
      ...(c.trust ? { trust: c.trust } : {}),
    });
  }
  for (const t of input.tails) {
    // 这一步已经有人工请求在等你、或停在等确认：同一件事不说两遍
    if (t.busy || !looksLikeQuestion(t.text)) continue;
    if (out.some((x) => x.step === t.step.index + 1 && x.kind !== "question")) continue;
    out.push({
      key: `question:${t.step.worktreePath ?? t.step.workspaceName}:${hash(t.text)}`,
      kind: "question",
      step: t.step.index + 1,
      where: stepLabel(t.step),
      question: questionExcerpt(t.text),
      options: [],
      recommend: null,
      detail: [],
      worktreePath: t.step.worktreePath,
    });
  }
  return out;
}

/** 转达给对话的原话：只加一行来源，不改写 */
export function relayText(text: string): string {
  return `【你在项目助手里的回复，Mesa 原话转达】\n${text.trim()}`;
}

/** 短哈希（同一句问话同一个键；不用于安全） */
function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 列表上方那一行：「等你的事 3 件：人工请求 1 · 对话里在问 1 · 等确认 1」 */
export function deskSummary(items: readonly DeskItem[]): string {
  if (items.length === 0) return "";
  const n = (k: DeskKind) => items.filter((i) => i.kind === k).length;
  const parts = [
    n("help") ? `人工请求 ${n("help")}` : "",
    n("question") ? `对话里在问 ${n("question")}` : "",
    n("confirm") ? `等确认 ${n("confirm")}` : "",
    n("trust") ? `等信任文件夹 ${n("trust")}` : "",
  ].filter(Boolean);
  return `等你的事 ${items.length} 件：${parts.join(" · ")}`;
}
