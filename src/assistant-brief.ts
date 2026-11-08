/**
 * 项目助手的「现在的情况」卡与常用问题（2026-11-08 用户「全部做 按你推荐」）：全由 Mesa 按记录算，不调 AI、不花钱。
 * - briefLines：打开面板时列「现在要你看的」和「上次打开以来」的变化；没有就不出卡
 * - quickAsks：常用问题按项目状态换（出错 → 问为什么、待评审 → 先帮你过一遍、没流程 → 想做什么），不再固定三句进度问题
 * 取数在 project-assistant-run.ts gatherBriefInput，这里只算；配 tests/assistant-brief.test.ts。
 */
import type { AssistantAction } from "./project-assistant.ts";

export type BriefStepState = "idle" | "working" | "confirm" | "failed" | "review" | "saved" | "open";

export interface BriefStep {
  /** 第几步（从 1 数） */
  n: number;
  name: string;
  state: BriefStepState;
  failure?: string | null;
  mergedAt?: string | null;
  /** 核验里待你判断的条数 */
  needsHuman: number;
}

export interface BriefGoal {
  name: string;
  status: string;
  updatedAt: string;
}

export interface BriefInput {
  hasFlow: boolean;
  steps: BriefStep[];
  goals: BriefGoal[];
  /** 上次打开项目助手的时间；第一次打开为 null（只列现状，不列变化） */
  since: string | null;
}

export type BriefTone = "err" | "warn" | "ok";

export interface BriefLine {
  tone: BriefTone;
  text: string;
  /** 点了跳到原入口 */
  action?: AssistantAction;
  /** 点了带着这一句问（附 focus） */
  ask?: { question: string; focus: { title: string; detail: string } };
}

export interface QuickAsk {
  q: string;
  hint: string;
  /** 带着重点问（评审先看一遍等要只读打开文件的） */
  focus?: { title: string; detail: string };
}

const MAX_LINES = 5;

function stepLabel(s: BriefStep): string {
  return `第 ${s.n} 步「${s.name}」`;
}

function after(at: string | null | undefined, since: string | null): boolean {
  return !!at && !!since && at > since;
}

/** 评审前先看一遍的重点（面板「常用问题」与评审页「让项目助手先看一遍」同一句，只读、不判通过） */
export function reviewPrereadFocus(n: number, name: string): { title: string; detail: string } {
  return {
    title: `评审前先看一遍：第 ${n} 步「${name}」`,
    detail:
      `用户马上要评审第 ${n} 步交的东西。只读打开这一步工作副本里这一轮的改动和交付物，列出值得人看的地方：` +
      "结论缺出处或出处对不上、数字前后或与数据不一致、和上一版差别大的段落、核验里待你判断的条目、交付物缺了哪样。" +
      "每条写到文件和位置。不判断能不能通过、不打分、不替人决定采不采纳；没发现问题就直说没看出明显问题，并说明看了哪些文件。",
  };
}

export function reviewPrereadQuestion(n: number): string {
  return `第 ${n} 步交的东西，我评审时该重点看哪几处？`;
}

export function briefLines(input: BriefInput): BriefLine[] {
  const now: BriefLine[] = [];
  const changed: BriefLine[] = [];
  for (const s of input.steps) {
    if (s.state === "failed") {
      now.push({
        tone: "err",
        text: `${stepLabel(s)}出错了${s.failure ? `：${s.failure}` : ""}`,
        ask: {
          question: `${stepLabel(s)}为什么出错？我该怎么办？`,
          focus: { title: `${stepLabel(s)}出错`, detail: s.failure ?? "" },
        },
      });
    } else if (s.state === "confirm") {
      now.push({ tone: "warn", text: `${stepLabel(s)}的 AI 在等你确认`, action: { kind: "step", step: s.n, text: "", label: `看第 ${s.n} 步` } });
    } else if (s.state === "review") {
      now.push({ tone: "warn", text: `${stepLabel(s)}做完了，等你评审、保存进项目`, action: { kind: "review", step: s.n, text: "", label: `去评审第 ${s.n} 步` } });
    } else if (s.state === "saved" && after(s.mergedAt, input.since)) {
      changed.push({ tone: "ok", text: `${stepLabel(s)}已保存进项目` });
    }
    if (s.needsHuman > 0 && s.state !== "saved") {
      now.push({
        tone: "warn",
        text: `${stepLabel(s)}的核验里有 ${s.needsHuman} 条待你判断`,
        action: { kind: "review", step: s.n, text: "", label: `去评审第 ${s.n} 步` },
      });
    }
  }
  for (const g of input.goals) {
    if (g.status === "pending_review") {
      now.push({ tone: "warn", text: `目标「${g.name}」做完了，等你验收`, action: { kind: "project", step: null, text: "", label: "去项目页" } });
    } else if (g.status === "failed" || g.status === "stopped") {
      now.push({
        tone: "err",
        text: `目标「${g.name}」${g.status === "failed" ? "没做成" : "停下了"}`,
        ask: { question: `目标「${g.name}」为什么${g.status === "failed" ? "没做成" : "停下了"}？我该怎么办？`, focus: { title: `目标「${g.name}」`, detail: "" } },
      });
    } else if (g.status === "completed" && after(g.updatedAt, input.since)) {
      changed.push({ tone: "ok", text: `目标「${g.name}」已验收完成` });
    }
  }
  // 同一步「待评审」与「核验待判断」去重：两行指向同一处评审，只留前一行
  const seen = new Set<string>();
  const merged = [...now, ...changed].filter((line) => {
    const key = line.action ? `${line.action.kind}:${line.action.step ?? ""}` : line.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merged.slice(0, MAX_LINES);
}

const FLOW_DEFAULTS: QuickAsk[] = [
  { q: "现在到哪了？", hint: "每一步走到哪、还剩什么" },
  { q: "哪里出问题了？", hint: "出错、卡住的地方，是谁的问题" },
  { q: "我下一步该做什么？", hint: "接下来该点哪里" },
];

const GOAL_DEFAULTS: QuickAsk[] = [
  { q: "目标都做到哪了？", hint: "进行中、等你验收、没做成的各有哪些" },
  { q: "哪里出问题了？", hint: "出错、卡住的地方，是谁的问题" },
  { q: "我下一步该做什么？", hint: "接下来该点哪里" },
];

const FRESH_DEFAULTS: QuickAsk[] = [
  { q: "这个项目里现在有哪些资料？", hint: "文献、数据、稿子各有什么，缺什么" },
  { q: "我想做一件事，帮我理清怎么做", hint: "说一句想做什么，它问清楚再起草派活单" },
  { q: "要写一整篇综述或论文，该怎么开始？", hint: "合适的整套流程，或先做哪几件事" },
];

/** 常用问题：先按状态给最要紧的，再用默认补齐到三个 */
export function quickAsks(input: BriefInput, limit = 3): QuickAsk[] {
  const out: QuickAsk[] = [];
  const failed = input.steps.find((s) => s.state === "failed");
  if (failed) out.push({ q: `${stepLabel(failed)}为什么出错？`, hint: "看出错原因，分清是谁的问题", focus: { title: `${stepLabel(failed)}出错`, detail: failed.failure ?? "" } });
  const review = input.steps.find((s) => s.state === "review");
  if (review) out.push({ q: reviewPrereadQuestion(review.n), hint: "它先只读过一遍，列出值得你看的地方；不判通过", focus: reviewPrereadFocus(review.n, review.name) });
  const judge = input.steps.find((s) => s.needsHuman > 0 && s.state !== "saved" && s !== review);
  if (judge) out.push({ q: `${stepLabel(judge)}核验里待我判断的是什么？`, hint: "每一条要你判断什么、依据在哪" });
  const goalReview = input.goals.find((g) => g.status === "pending_review");
  if (goalReview) out.push({ q: `目标「${goalReview.name}」做得怎么样，我验收时看哪？`, hint: "它先看一遍交的东西，列出值得你看的地方" });
  const defaults = input.hasFlow ? FLOW_DEFAULTS : input.goals.length > 0 ? GOAL_DEFAULTS : FRESH_DEFAULTS;
  for (const d of defaults) {
    if (out.length >= limit) break;
    if (!out.some((o) => o.q === d.q)) out.push(d);
  }
  return out.slice(0, limit);
}
