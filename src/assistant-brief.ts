/**
 * 项目助手的「现在的情况」卡与常用问题（2026-11-08 用户「全部做 按你推荐」）：全由 Mesa 按记录算，不调 AI、不花钱。
 * - briefLines：打开面板时列「现在要你看的」和「上次打开以来」的变化；没有就不出卡
 * - quickAsks：常用问题按项目状态换（出错 → 问为什么、待评审 → 先帮你过一遍、没流程 → 想做什么），不再固定三句进度问题
 * 取数在 project-assistant-run.ts gatherBriefInput，这里只算；配 tests/assistant-brief.test.ts。
 */
import type { AssistantAction, AssistantIntent } from "./project-assistant.ts";
import { CHECK_STATUS_LABEL, checkLocation, checkSourceLabel, type CheckItem } from "./research-checks.ts";

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
  /** 前面步骤保存了新内容，这一步的工作副本还没跟进并入 */
  pendingUpstream?: boolean;
}

export interface BriefGoal {
  name: string;
  status: string;
  updatedAt: string;
  /** 目标未清理的隔离副本目录（只读先看一遍或查错时打开） */
  isolationPath?: string | null;
  /** 目标声明的交付路径（可省） */
  outputPaths?: readonly string[];
}

export interface BriefInput {
  hasFlow: boolean;
  steps: BriefStep[];
  goals: BriefGoal[];
  /** 上次打开项目助手的时间；第一次打开为 null（只列现状，不列变化） */
  since: string | null;
  /** 项目知识一条都还没有（交给 AI 的那一份是空的），且项目根有可起草的约定文件（见 hasKnowledgeSources）：提议起草几条 */
  knowledgeEmpty?: boolean;
  /** 后台跟进结果不明、已暂停等你核对的定时任务 */
  uncertainSchedules?: readonly { id: string; name: string }[];
}

export type BriefTone = "err" | "warn" | "ok";

export interface BriefLine {
  tone: BriefTone;
  text: string;
  /** 点了跳到原入口 */
  action?: AssistantAction;
  /** 点了带着这一句问（附 focus）；label 是按钮字，默认「问问为什么」；intent 指定按哪一类问 */
  ask?: { question: string; focus: { title: string; detail: string }; label?: string; intent?: AssistantIntent };
  /** 起草项目知识这一行可以「不用了」（按项目记住，不再提） */
  kind?: "knowledge-draft";
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
/** 由清单脚本生成、与 included.json 同源的文件：先看一遍时不读（2026-11-10 HER：把 6 个文件 5600 行挨个通读，两分钟还没答） */
const GENERATED_ARTIFACT = /(^|\/)(included\.md|to-fetch\.md|[^/]*\.ris|references\.bib)$/i;

export function reviewPrereadFocus(
  n: number,
  name: string,
  where?: { worktree?: string; artifacts?: readonly string[] },
): { title: string; detail: string } {
  const read = (where?.artifacts ?? []).filter((a) => !GENERATED_ARTIFACT.test(a));
  const skipped = (where?.artifacts ?? []).filter((a) => GENERATED_ARTIFACT.test(a));
  return {
    title: `评审前先看一遍：第 ${n} 步「${name}」`,
    detail:
      `用户马上要评审第 ${n} 步交的东西。只读打开这一步${where?.worktree ? `工作副本（${where.worktree}）` : "工作副本"}里的交付物，列出值得人看的地方：` +
      "结论缺出处或出处对不上、数字前后或与数据不一致、和上一版差别大的段落、核验里待你判断的条目、交付物缺了哪样。" +
      "每条写到文件和位置。不判断能不能通过、不打分、不替人决定采不采纳；没发现问题就直说没看出明显问题，并说明看了哪些文件。" +
      `读法（两分钟内答完）：${read.length ? `只看 ${read.join("、")}，` : ""}最多打开 5 个文件；先读主报告开头的验收摘要，再用搜索定位可疑处，不整份通读；` +
      `大的 JSON 只搜关键字段${skipped.length ? `；${skipped.join("、")} 由脚本从清单生成，不读` : "；脚本生成的清单、RIS、bib 不读"}；不读 PDF。`,
  };
}

/**
 * 问「这一轮怎么样」（2026-11-11 大纲核对）：在评审页问、或问题里点名了某一步时，项目助手只读打开这一步的主要产物，
 * 对着这一步的核验项（含 Mesa 核对）逐条解释、判断要不要改、说清下一步点哪；要改时起草派活单、给一段能贴进评审意见的话。
 * 不判通过、不替人拍板。核验项原样带进来：Mesa 核对的是数出来的事实，Claude Code 只读时跑不了脚本，不要它自己再数
 */
export function reviewRoundFocus(
  n: number,
  name: string,
  where: { worktree?: string; artifacts?: readonly string[] },
  checks: readonly CheckItem[],
): { title: string; detail: string } {
  const read = (where.artifacts ?? []).filter((a) => !GENERATED_ARTIFACT.test(a));
  const flagged = [...checks].filter((c) => c.status !== "passed").sort((a, b) => Number(a.status !== "blocked") - Number(b.status !== "blocked"));
  const lines = flagged.slice(0, 16).map((c) => {
    const at = checkLocation(c);
    const detail = c.evidence?.detail ? `：${c.evidence.detail.slice(0, 220)}` : "";
    return `- [${CHECK_STATUS_LABEL[c.status]}·${checkSourceLabel(c)}] ${c.title}${at ? `（${at}）` : ""}${detail}`;
  });
  return {
    title: `这一轮怎么样：第 ${n} 步「${name}」`,
    detail:
      `用户在问第 ${n} 步这一轮做得怎么样。只读打开这一步${where.worktree ? `工作副本（${where.worktree}）` : "工作副本"}里的主要产物` +
      `${read.length ? `（${read.join("、")}）` : ""}，用搜索定位到下面各项说的位置核对，最多打开 5 个文件，不整份通读、不读 PDF。\n` +
      (lines.length
        ? `这一步的核验项（「Mesa 核对」是 Mesa 按大纲、笔记索引、引文库、纳入清单数出来的，当事实用，不用你再数；「AI 判断」只是另一家的意见）：\n${lines.join("\n")}` +
          (flagged.length > lines.length ? `\n（另有 ${flagged.length - lines.length} 项没列出，在评审页核验清单里）` : "")
        : "这一步现在没有拦下或待你判断的核验项；照样看一遍主要产物，没看出问题就直说，并说明看了哪些文件。") +
      "\n回答：先一句结论（几处必须改、几处要你定）；再逐条讲每个核验项是什么、要不要改、为什么（拦下的必须改；待你判断的说清两种选择的后果，不替人选）；" +
      "然后说下一步去哪点（评审页「写意见退回修改…」、步骤卡「补文献…」、改完的「提交并保存进项目」）。" +
      "要改的写一张派活单交给这一步（交给：第 N 步），「要做」一条一行、写到文件和位置、能直接照做；" +
      "另给一段能原样贴进评审意见框、配合「退回修改」用的文字（放在引用块里）。不判能不能通过、不打分。",
  };
}

export function reviewPrereadQuestion(n: number): string {
  return `第 ${n} 步交的东西，我评审时该重点看哪几处？`;
}

/** 目标待验收时「先看一遍」的只读重点：进目标隔离副本核对产出文件，列出值得人看的地方，不判能不能验收通过 */
export function goalReviewPrereadFocus(
  name: string,
  where?: { isolationPath?: string | null; outputs?: readonly string[] },
): { title: string; detail: string } {
  const read = (where?.outputs ?? []).filter((a) => !GENERATED_ARTIFACT.test(a));
  const skipped = (where?.outputs ?? []).filter((a) => GENERATED_ARTIFACT.test(a));
  return {
    title: `验收前先看一遍：目标「${name}」`,
    detail:
      `用户马上要验收目标「${name}」交的东西。只读打开这个目标${where?.isolationPath ? `隔离副本（${where.isolationPath}）` : "隔离副本"}里的产出文件，列出值得人看的地方：` +
      "结论缺出处或出处对不上、数字前后或与数据不一致、要求做的事漏了哪项、产出文件缺了哪样。" +
      "每条写到文件和位置。不判断能不能验收通过、不打分、不替人决定写不写回；没发现问题就直说没看出明显问题，并说明看了哪些文件。" +
      `读法（两分钟内答完）：${read.length ? `优先看 ${read.join("、")}，` : ""}最多打开 5 个文件；先看主要报告或产出摘要，再用搜索定位可疑处，不整份通读；` +
      `大的 JSON 只搜关键字段${skipped.length ? `；${skipped.join("、")} 由脚本从清单生成，不读` : "；脚本生成的清单、RIS、bib 不读"}；不读 PDF。`,
  };
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
    if (s.pendingUpstream && s.state !== "failed" && s.state !== "confirm" && s.state !== "review") {
      now.push({
        tone: "warn",
        text: `${stepLabel(s)}有前面步骤新保存的内容待跟进`,
        action: { kind: "step", step: s.n, text: "", label: `看第 ${s.n} 步` },
      });
    }
  }
  for (const u of input.uncertainSchedules ?? []) {
    now.push({
      tone: "warn",
      text: `定时任务「${u.name}」上次后台跟进结果不明已暂停，等你核对`,
      action: { kind: "project", step: null, text: "schedule", label: "去定时任务核对" },
    });
  }
  for (const g of input.goals) {
    if (g.status === "pending_review") {
      now.push({ tone: "warn", text: `目标「${g.name}」做完了，等你验收`, action: { kind: "project", step: null, text: "", label: "去项目页" } });
    } else if (g.status === "failed" || g.status === "stopped") {
      now.push({
        tone: "err",
        text: `目标「${g.name}」${g.status === "failed" ? "没做成" : "停下了"}`,
        ask: {
          question: `目标「${g.name}」为什么${g.status === "failed" ? "没做成" : "停下了"}？我该怎么办？`,
          focus: { title: `目标「${g.name}」`, detail: g.isolationPath ? `这个目标的工作副本：${g.isolationPath}` : "" },
        },
      });
    } else if (g.status === "completed" && after(g.updatedAt, input.since)) {
      changed.push({ tone: "ok", text: `目标「${g.name}」已验收完成` });
    }
  }
  // 同一步「待评审」与「核验待判断」去重：两行指向同一处评审，只留前一行
  const seen = new Set<string>();
  const merged = [...now, ...changed].filter((line) => {
    const key = line.action ? `${line.action.kind}:${line.action.step ?? ""}:${line.action.text}` : line.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const out = merged.slice(0, MAX_LINES);
  // 新项目一条项目知识都没有（2026-11-08，学 Copilot 第一次用时提议生成仓库指令）：提议从项目文件里起草，人逐条点了才记
  if (input.knowledgeEmpty) {
    out.push({
      tone: "ok",
      kind: "knowledge-draft",
      text: "还没有项目知识（每一步 AI 都照办的规矩），可以从项目里的 README、写作规范一类文件起草几条",
      ask: { question: KNOWLEDGE_DRAFT_QUESTION, focus: knowledgeDraftFocus(), label: "起草几条", intent: "project" },
    });
  }
  return out;
}

/** 项目根有没有能起草项目知识的约定文件（2026-11-09 HER 实测：只有 papers/、notes/ 的项目也提议起草，点了答「一条也没找到」）。
 *  项目规则（档案卡 settings）每次派活本来就写进任务书，不算来源；只看顶层的 README / CLAUDE / AGENTS / CONTRIBUTING / 写作规范一类 */
export function hasKnowledgeSources(topLevelNames: readonly string[]): boolean {
  return topLevelNames.some((name) => /^(readme|claude|agents|contributing|style[-_ ]?(sheet|guide)|写作规范|课题组规范)(\.[a-z]+)?$/i.test(name.trim()));
}

export const KNOWLEDGE_DRAFT_QUESTION = "从这个项目里起草几条项目知识";

/** 起草项目知识的重点：只读找文件里明确写着的长期约定，一条一块 :::记下，最多五块，不编 */
export function knowledgeDraftFocus(): { title: string; detail: string } {
  return {
    title: "起草项目知识",
    detail:
      "用户请你从这个项目里起草几条项目知识：以后每一步干活的 AI 都要照办的长期约定。只读打开 README、项目规则文件（CLAUDE.md、AGENTS.md 一类）、" +
      "已有的写作规范或笔记说明，挑出文件里明确写着、长期成立的约定（术语和缩写写法、引用格式、数据处理口径、导师或课题组的要求、明确不做的方法）。" +
      "每条单独一块 :::记下，最多五块；每块第一行写「依据：文件名」，第二行写规矩正文。只写文件里写着的，推断不出依据的不要编；一次性的安排、进度不算。" +
      "什么也没找到就直说，并建议用户以后在项目助手里说「以后都……」时点「记进项目知识」。",
  };
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
  if (goalReview) {
    out.push({
      q: `目标「${goalReview.name}」做得怎么样，我验收时看哪？`,
      hint: "它先只读过一遍，列出值得你看的地方；不判通过",
      focus: goalReviewPrereadFocus(goalReview.name, { isolationPath: goalReview.isolationPath, outputs: goalReview.outputPaths }),
    });
  }
  const defaults = input.hasFlow ? FLOW_DEFAULTS : input.goals.length > 0 ? GOAL_DEFAULTS : FRESH_DEFAULTS;
  for (const d of defaults) {
    if (out.length >= limit) break;
    if (!out.some((o) => o.q === d.q)) out.push(d);
  }
  return out.slice(0, limit);
}

/** 聊了多少轮该提议整理一次（不含派活进展；「不用」也算处理过） */
export const SUMMARY_EVERY = 10;

/** 上次整理（或点了「不用」）以来的问答轮数够了没有；lastAt 是那时最后一轮的时间 */
export function summaryDue(turns: readonly { at: string; echoOf?: string | null }[], lastAt: string | null, every = SUMMARY_EVERY): boolean {
  const qa = turns.filter((t) => !t.echoOf && (!lastAt || t.at > lastAt));
  return qa.length >= every;
}

export const SUMMARY_QUESTION = "把这一阵我们定下的事整理一下";

/** 整理这一阵定下的事的重点：附上最近这些轮的问答摘要（只带问题和回答开头），值得以后照办的起草成 :::记下，人逐条点 */
export function summaryFocus(turns: readonly { at: string; question: string; answer: string; echoOf?: string | null }[], lastAt: string | null): { title: string; detail: string } {
  const qa = turns.filter((t) => !t.echoOf && (!lastAt || t.at > lastAt)).slice(-16);
  const lines = qa.map((t) => `- 问：${t.question.replace(/\s+/g, " ").slice(0, 120)}\n  答：${t.answer.replace(/:::[\s\S]*?:::/g, "").replace(/\s+/g, " ").slice(0, 200)}`);
  return {
    title: "整理这一阵定下的事",
    detail:
      `下面是最近 ${qa.length} 轮问答的摘要。先用三五句话说这一阵定下了什么、还悬着什么；再把其中以后每一步都要照办的决定或偏好` +
      "（不是一次性的安排、不是进度）起草成 :::记下，一条一块、最多五块，快照「项目知识」里已经有的不重复。没有值得记的就直说。\n" +
      lines.join("\n"),
  };
}

/** 评审页此刻打开的是哪一步（WorkspaceReviewView 打开时设、关掉时清）：项目助手问「这轮怎么样」「帮我看看」时默认看这一步 */
export interface ReviewingStep {
  projectRoot: string;
  n: number;
  name: string;
  worktree: string;
  artifacts: readonly string[];
}

let reviewing: ReviewingStep | null = null;

export function setReviewingStep(step: ReviewingStep | null): void {
  reviewing = step;
}

export function reviewingStep(): ReviewingStep | null {
  return reviewing;
}
